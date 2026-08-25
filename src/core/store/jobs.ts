import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, type Job, type Run } from "@prisma/client";

/**
 * Durable job store. Every state transition is a single SQL statement (or one
 * transaction) whose WHERE clause names the expected prior state; and, for
 * worker-driven transitions, the lease id. Zero rows affected = the caller
 * lost the race and must treat the transition as rejected. There is no
 * read-then-write anywhere in this file.
 *
 * State machine:
 *   PENDING -claim-> LEASED -start-> RUNNING -complete-> SUCCEEDED
 *   LEASED/RUNNING -(lease expiry | transient failure)-> PENDING (attempt+1, backoff)
 *   any retryable path with attempt >= maxAttempts -> DEAD_LETTER
 *   PERMANENT/POLICY failure -> DEAD_LETTER
 *   operator cancel: PENDING -> CANCELLED immediately; LEASED/RUNNING see
 *   cancelRequested on renew and abort.
 */

export interface RetryPolicy {
  baseSeconds: number;
  maxSeconds: number;
}

export interface JobSegment {
  index: number;
  total: number;
  key: string;
  mangaIds: string[];
}

export interface CreateRunInput {
  idempotencyKey: string;
  extension: string;
  extensionVersion: string;
  bundleSha256: string;
  kind: "UPDATE" | "CLEAN" | "FORCE";
  triggeredBy?: string;
  scheduledFor?: Date;
  timeoutSeconds?: number;
  maxAttempts?: number;
  minTrust?: "TRUSTED" | "COMMUNITY";
  requireAllSegments?: boolean;
  /** Empty/omitted = single whole-extension job. */
  segments?: JobSegment[];
  /**
   * MangaDex title ids this run is deliberately limited to. Empty = the whole
   * catalogue. Recorded on the run because the processor cannot infer it: a
   * scoped run and an unscoped one that happened to find one title's chapters
   * produce the same envelopes, and only one of them licenses the
   * catalogue-wide removal passes.
   */
  scopeMangaIds?: string[];
}

export interface ClaimedJob {
  job: Job;
  leaseId: string;
  leaseExpiresAt: Date;
}

export function backoffSeconds(attempt: number, policy: RetryPolicy): number {
  const exp = policy.baseSeconds * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, policy.maxSeconds);
  // Full jitter keeps a thundering herd of requeued jobs from synchronizing.
  return Math.floor(capped / 2 + Math.random() * (capped / 2));
}

/**
 * How recently a worker must have heartbeated to count as competition for the
 * fairness rule. Generous relative to the heartbeat interval: treating a live
 * worker as dead costs fairness, treating a dead one as live costs throughput,
 * and the second is the worse trade.
 */
const FAIRNESS_ALIVE_SECONDS = 120;

/**
 * How long after claiming a worker is asked to stand aside. Short on purpose;
 * it bounds what a heartbeating-but-wedged peer can cost the queue, since after
 * this the previous claimer is eligible again regardless.
 */
const FAIRNESS_COOLDOWN_SECONDS = 30;

export class JobStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly retry: RetryPolicy = { baseSeconds: 60, maxSeconds: 3600 },
  ) {}

  /**
   * Idempotently create a run and its jobs. A duplicate idempotency key
   * returns the existing run untouched (`created: false`): safe under
   * scheduler crash/restart and under concurrent duplicate schedulers.
   */
  async createRun(input: CreateRunInput): Promise<{ run: Run; created: boolean }> {
    const existing = await this.prisma.run.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) return { run: existing, created: false };

    const segments: JobSegment[] =
      input.segments && input.segments.length > 0
        ? input.segments
        : [{ index: 0, total: 1, key: "whole", mangaIds: [] }];

    try {
      const run = await this.prisma.$transaction(async (tx) => {
        const run = await tx.run.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            extension: input.extension,
            extensionVersion: input.extensionVersion,
            bundleSha256: input.bundleSha256,
            kind: input.kind,
            segmentsTotal: segments.length,
            requireAllSegments: input.requireAllSegments ?? true,
            scopeMangaIds: input.scopeMangaIds ?? [],
            triggeredBy: input.triggeredBy ?? null,
            scheduledFor: input.scheduledFor ?? null,
            state: "PENDING",
          },
        });
        await tx.job.createMany({
          data: segments.map((seg) => ({
            idempotencyKey: `job:${input.idempotencyKey}:${seg.index}/${seg.total}`,
            runId: run.id,
            extension: input.extension,
            extensionVersion: input.extensionVersion,
            bundleSha256: input.bundleSha256,
            kind: input.kind,
            segmentIndex: seg.index,
            segmentTotal: seg.total,
            segmentKey: seg.key,
            segmentMangaIds: seg.mangaIds,
            minTrust: input.minTrust ?? "COMMUNITY",
            timeoutSeconds: input.timeoutSeconds ?? 3600,
            maxAttempts: input.maxAttempts ?? 3,
          })),
        });
        return run;
      });
      return { run, created: true };
    } catch (err) {
      // Unique violation on the run key: a concurrent creator won; return theirs.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const run = await this.prisma.run.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (run) return { run, created: false };
      }
      throw err;
    }
  }

  /**
   * Atomically claim one runnable job for a worker. FOR UPDATE SKIP LOCKED
   * guarantees two concurrent claimers can never select the same row; the
   * lease id returned is required for every later transition on this attempt.
   */
  async claim(
    workerId: string,
    opts: {
      extensions?: string[];
      trust: "TRUSTED" | "COMMUNITY";
      leaseTtlSeconds: number;
    },
  ): Promise<ClaimedJob | null> {
    const leaseId = randomUUID();
    const extFilter =
      opts.extensions && opts.extensions.length > 0
        ? Prisma.sql`AND extension = ANY(${opts.extensions}::text[])`
        : Prisma.empty;
    // COMMUNITY workers may only take COMMUNITY jobs; TRUSTED take anything.
    const trustFilter =
      opts.trust === "TRUSTED" ? Prisma.empty : Prisma.sql`AND min_trust = 'COMMUNITY'`;

    const rows = await this.prisma.$queryRaw<Job[]>(Prisma.sql`
      WITH candidate AS (
        SELECT id FROM jobs
        WHERE state = 'PENDING'
          AND not_before <= now()
          AND cancel_requested = false
          -- Fairness: do not hand consecutive jobs to the same worker.
          --
          -- Workers pull, so without this whichever host polls first takes
          -- everything; systematically the fastest or least loaded one. That
          -- defeats the reason to run several: publishers rate-limit per source
          -- IP, and one worker doing all the scraping is one IP doing it.
          --
          -- Three guards stop it becoming a stall. It applies only when another
          -- worker is actually ALIVE, so a single-worker fleet is unaffected and
          -- takes jobs back to back. It applies only for a short window after the
          -- previous claim, so a peer that is heartbeating but wedged costs one
          -- cooldown per job instead of blocking until its heartbeat goes stale.
          -- And it is a predicate inside this SELECT rather than a separate
          -- statement, because two workers running check-then-claim independently
          -- can both pass the check.
          AND (
            (
              SELECT count(*) FROM workers
              WHERE status = 'ACTIVE'
                AND last_heartbeat_at > now() - make_interval(secs => ${FAIRNESS_ALIVE_SECONDS})
            ) <= 1
            OR NOT EXISTS (
              SELECT 1 FROM jobs prev
              WHERE prev.leased_at = (SELECT max(leased_at) FROM jobs WHERE leased_at IS NOT NULL)
                AND prev.lease_worker_id = ${workerId}
                AND prev.leased_at > now() - make_interval(secs => ${FAIRNESS_COOLDOWN_SECONDS})
            )
          )
          -- A disabled extension is unloaded, not merely unscheduled: whatever
          -- was already queued for it must stop being handed out too. Enforcing
          -- it in the claim (rather than only when creating runs) means the
          -- guarantee holds for jobs created before the extension was disabled,
          -- and for manual runs, without a sweep to race against.
          AND extension NOT IN (SELECT extension FROM disabled_extensions)
          ${extFilter}
          ${trustFilter}
        ORDER BY not_before ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE jobs j
      SET state = 'LEASED',
          lease_id = ${leaseId},
          lease_worker_id = ${workerId},
          lease_expires_at = now() + make_interval(secs => ${opts.leaseTtlSeconds}),
          -- Read by the fairness predicate above. Separate from lease_expires_at
          -- because that is claim-time plus the TTL, so it only orders claims
          -- correctly while the TTL never changes.
          leased_at = now(),
          attempt = j.attempt + 1,
          updated_at = now()
      FROM candidate
      WHERE j.id = candidate.id
      RETURNING j.id, j.idempotency_key AS "idempotencyKey", j.run_id AS "runId",
        j.extension, j.extension_version AS "extensionVersion",
        j.bundle_sha256 AS "bundleSha256", j.kind,
        j.segment_index AS "segmentIndex", j.segment_total AS "segmentTotal",
        j.segment_key AS "segmentKey", j.segment_manga_ids AS "segmentMangaIds",
        j.min_trust AS "minTrust", j.state, j.attempt,
        j.max_attempts AS "maxAttempts", j.not_before AS "notBefore",
        j.timeout_seconds AS "timeoutSeconds", j.lease_id AS "leaseId",
        j.lease_worker_id AS "leaseWorkerId", j.lease_expires_at AS "leaseExpiresAt",
        j.cancel_requested AS "cancelRequested", j.error_class AS "errorClass",
        j.last_error AS "lastError", j.created_at AS "createdAt",
        j.updated_at AS "updatedAt"
    `);

    const job = rows[0];
    if (!job) return null;

    // Mark the parent run as executing (first claim wins; harmless if racing).
    await this.prisma.run.updateMany({
      where: { id: job.runId, state: "PENDING" },
      data: { state: "EXECUTING", startedAt: new Date() },
    });

    return { job, leaseId, leaseExpiresAt: job.leaseExpiresAt as Date };
  }

  /** LEASED -> RUNNING, gated on the lease id. */
  async start(jobId: string, leaseId: string): Promise<boolean> {
    const res = await this.prisma.job.updateMany({
      where: { id: jobId, leaseId, state: "LEASED" },
      data: { state: "RUNNING" },
    });
    return res.count === 1;
  }

  /**
   * Renew a live lease. Returns the cancellation flag so a running worker
   * learns it should abort; null = lease no longer valid (expired/reassigned)
   * and the worker MUST stop working on the job.
   */
  async renew(
    jobId: string,
    leaseId: string,
    leaseTtlSeconds: number,
  ): Promise<{ cancelRequested: boolean; leaseExpiresAt: Date } | null> {
    const rows = await this.prisma.$queryRaw<
      { cancelRequested: boolean; leaseExpiresAt: Date }[]
    >(Prisma.sql`
      UPDATE jobs
      SET lease_expires_at = now() + make_interval(secs => ${leaseTtlSeconds}),
          updated_at = now()
      WHERE id = ${jobId} AND lease_id = ${leaseId}
        AND state IN ('LEASED', 'RUNNING')
        AND lease_expires_at > now()
      RETURNING cancel_requested AS "cancelRequested",
                lease_expires_at AS "leaseExpiresAt"
    `);
    return rows[0] ?? null;
  }

  /** RUNNING/LEASED -> SUCCEEDED, gated on the lease id. */
  async complete(jobId: string, leaseId: string): Promise<boolean> {
    const res = await this.prisma.job.updateMany({
      where: { id: jobId, leaseId, state: { in: ["LEASED", "RUNNING"] } },
      data: { state: "SUCCEEDED", errorClass: null, lastError: null },
    });
    return res.count === 1;
  }

  /**
   * Report a failed attempt.
   *
   * TRANSIENT and POLICY errors requeue with backoff until maxAttempts;
   * PERMANENT dead-letters immediately.
   *
   * POLICY retries rather than dead-lettering at once because the envelope comes
   * from a worker, and a hostile or broken one can fail policy on demand.
   * Dead-lettering immediately would let any single worker kill every job it
   * could lease. Retrying costs one attempt and routes around the bad worker,
   * since the next attempt is very likely leased elsewhere. A genuinely bad
   * bundle still dead-letters, it just takes maxAttempts.
   */
  async fail(
    jobId: string,
    leaseId: string,
    errorClass: "TRANSIENT" | "PERMANENT" | "POLICY",
    message: string,
  ): Promise<"requeued" | "dead_letter" | "rejected"> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return "rejected";
    const truncated = message.slice(0, 8000);

    if (errorClass === "PERMANENT" || job.attempt >= job.maxAttempts) {
      const res = await this.prisma.job.updateMany({
        where: { id: jobId, leaseId, state: { in: ["LEASED", "RUNNING"] } },
        data: {
          state: "DEAD_LETTER",
          errorClass,
          lastError: truncated,
          leaseId: null,
          leaseWorkerId: null,
          leaseExpiresAt: null,
        },
      });
      return res.count === 1 ? "dead_letter" : "rejected";
    }

    const notBefore = new Date(Date.now() + backoffSeconds(job.attempt, this.retry) * 1000);
    const res = await this.prisma.job.updateMany({
      where: { id: jobId, leaseId, state: { in: ["LEASED", "RUNNING"] } },
      data: {
        state: "PENDING",
        errorClass,
        lastError: truncated,
        notBefore,
        leaseId: null,
        leaseWorkerId: null,
        leaseExpiresAt: null,
      },
    });
    return res.count === 1 ? "requeued" : "rejected";
  }

  /**
   * Sweeper: recover jobs whose lease expired without completion. Retryable
   * ones return to PENDING with backoff; exhausted ones dead-letter. Both
   * paths clear the stale lease, so the previous holder can no longer renew
   * or complete; its late submission is superseded at ingestion.
   */
  async sweepExpiredLeases(): Promise<{ requeued: Job[]; deadLettered: Job[] }> {
    const requeued = await this.prisma.$queryRaw<Job[]>(Prisma.sql`
      WITH expired AS (
        SELECT id, attempt FROM jobs
        WHERE state IN ('LEASED', 'RUNNING') AND lease_expires_at < now()
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs j
      SET state = 'PENDING',
          error_class = 'TRANSIENT',
          last_error = 'lease expired (worker crash, disconnect, or overrun)',
          not_before = now() + make_interval(secs => ${this.retry.baseSeconds}),
          lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
          updated_at = now()
      FROM expired
      WHERE j.id = expired.id AND expired.attempt < j.max_attempts
      RETURNING j.id, j.extension, j.run_id AS "runId", j.attempt,
                j.state, j.segment_key AS "segmentKey"
    `);

    const deadLettered = await this.prisma.$queryRaw<Job[]>(Prisma.sql`
      WITH expired AS (
        SELECT id, attempt FROM jobs
        WHERE state IN ('LEASED', 'RUNNING') AND lease_expires_at < now()
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs j
      SET state = 'DEAD_LETTER',
          error_class = 'TRANSIENT',
          last_error = 'lease expired; attempts exhausted',
          lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
          updated_at = now()
      FROM expired
      WHERE j.id = expired.id AND expired.attempt >= j.max_attempts
      RETURNING j.id, j.extension, j.run_id AS "runId", j.attempt,
                j.state, j.segment_key AS "segmentKey"
    `);

    return { requeued, deadLettered };
  }

  /**
   * Request cancellation. PENDING jobs cancel immediately; live leases keep
   * the flag and the worker aborts on its next renew.
   */
  async cancel(jobId: string): Promise<"cancelled" | "flagged" | "rejected"> {
    const immediate = await this.prisma.job.updateMany({
      where: { id: jobId, state: "PENDING" },
      data: { state: "CANCELLED", cancelRequested: true },
    });
    if (immediate.count === 1) return "cancelled";
    const flagged = await this.prisma.job.updateMany({
      where: { id: jobId, state: { in: ["LEASED", "RUNNING"] } },
      data: { cancelRequested: true },
    });
    return flagged.count === 1 ? "flagged" : "rejected";
  }

  /**
   * Stop all outstanding work for one extension; the "unload" half of
   * enable/disable.
   *
   * Queued jobs are cancelled outright; jobs a worker is already running are
   * flagged, and the worker aborts on its next lease renewal (see the renew
   * response's `cancelRequested`). An operator pulling a misbehaving extension
   * wants it stopped now, not after the queue drains.
   */
  async cancelAllForExtension(extension: string): Promise<{ cancelled: number; flagged: number }> {
    const cancelled = await this.prisma.job.updateMany({
      where: { extension, state: "PENDING" },
      data: { state: "CANCELLED", cancelRequested: true },
    });
    const flagged = await this.prisma.job.updateMany({
      where: { extension, state: { in: ["LEASED", "RUNNING"] } },
      data: { cancelRequested: true },
    });
    return { cancelled: cancelled.count, flagged: flagged.count };
  }

  /**
   * Kill one run and everything it has outstanding.
   *
   * Distinct from `cancel(jobId)`, which is graceful: it flags a running job and
   * lets the worker finish its current step. This is the operator saying "stop
   * this run now", usually because it is doing something wrong, so every
   * non-terminal job goes straight to CANCELLED rather than being asked nicely.
   *
   * That is safe in flight for two reasons already built into the system:
   *
   *  - `cancel_requested = true` is set on every job, and `claim` filters on it,
   *    so nothing can be re-leased even after the lease sweeper requeues an
   *    abandoned job to PENDING;
   *  - ingest's lease-validity gate only accepts envelopes for a job in LEASED or
   *    RUNNING, so a worker that finishes the work anyway has its envelope
   *    superseded instead of committed. A killed run cannot produce late writes.
   *
   * The run itself is set to CANCELLED directly. `advanceRuns` only ever moves
   * runs out of PENDING/EXECUTING, so it cannot resurrect this one; and it
   * would otherwise have landed the run in DEAD_LETTER, which reads as a failure
   * rather than a decision.
   *
   * Returns null when the run does not exist, and "rejected" when it has already
   * finished; cancelling a PROCESSED run would be a lie, its work is done.
   */
  async cancelRun(
    runId: string,
  ): Promise<{ result: "cancelled" | "rejected"; jobsCancelled: number; previousState: string } | null> {
    const run = await this.prisma.run.findUnique({ where: { id: runId } });
    if (!run) return null;

    const TERMINAL = ["PROCESSED", "FAILED", "DEAD_LETTER", "CANCELLED"];
    if (TERMINAL.includes(run.state)) {
      return { result: "rejected", jobsCancelled: 0, previousState: run.state };
    }

    const jobs = await this.prisma.job.updateMany({
      where: { runId, state: { in: ["PENDING", "LEASED", "RUNNING"] } },
      data: { state: "CANCELLED", cancelRequested: true },
    });
    await this.prisma.run.updateMany({
      // Guarded on the state we read, so two operators cancelling at once do not
      // both count as the one that did it.
      where: { id: runId, state: run.state },
      data: { state: "CANCELLED", completedAt: new Date() },
    });

    return { result: "cancelled", jobsCancelled: jobs.count, previousState: run.state };
  }

  /**
   * Kill every run that has not finished, optionally for one extension.
   *
   * The blunt instrument, for when something is wrong across the board and
   * cancelling runs one id at a time is not fast enough.
   */
  async cancelActiveRuns(extension?: string): Promise<{ runs: number; jobs: number }> {
    const active = await this.prisma.run.findMany({
      where: {
        state: { in: ["PENDING", "EXECUTING", "INGESTING"] },
        ...(extension ? { extension } : {}),
      },
      select: { id: true },
    });
    let jobs = 0;
    let runs = 0;
    for (const { id } of active) {
      const outcome = await this.cancelRun(id);
      if (outcome?.result === "cancelled") {
        runs += 1;
        jobs += outcome.jobsCancelled;
      }
    }
    return { runs, jobs };
  }

  /** Same, for every job pinned to one bundle; used when a bundle is yanked. */
  async cancelAllForBundle(sha256: string): Promise<{ cancelled: number; flagged: number }> {
    const cancelled = await this.prisma.job.updateMany({
      where: { bundleSha256: sha256, state: "PENDING" },
      data: { state: "CANCELLED", cancelRequested: true },
    });
    const flagged = await this.prisma.job.updateMany({
      where: { bundleSha256: sha256, state: { in: ["LEASED", "RUNNING"] } },
      data: { cancelRequested: true },
    });
    return { cancelled: cancelled.count, flagged: flagged.count };
  }

  /**
   * Operator replay of a dead-lettered job: back to PENDING with fresh budget.
   *
   * The parent run is revived in the same transaction. `advanceRuns` only moves
   * a run out of PENDING/EXECUTING, so a run that already reached DEAD_LETTER is
   * terminal: replaying its job alone would let the job succeed and then sit
   * there, with the run never advancing to INGESTING and the chapters never
   * uploaded, while the API answered `{ok: true}`.
   */
  async replayDeadLetter(jobId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.job.findUnique({ where: { id: jobId } });
      if (!job || job.state !== "DEAD_LETTER") return false;

      const res = await tx.job.updateMany({
        where: { id: jobId, state: "DEAD_LETTER" },
        data: {
          state: "PENDING",
          attempt: 0,
          notBefore: new Date(),
          errorClass: null,
          lastError: null,
          cancelRequested: false,
        },
      });
      if (res.count !== 1) return false;

      await tx.run.updateMany({
        where: { id: job.runId, state: { in: ["DEAD_LETTER", "FAILED", "CANCELLED"] } },
        data: { state: "EXECUTING", completedAt: null, error: null },
      });
      return true;
    });
  }

  /**
   * Advance run state when all jobs reached a terminal state. Returns runs
   * newly moved to INGESTING (all succeeded) so the processor can pick them
   * up, plus runs newly failed/dead-lettered.
   */
  async advanceRuns(): Promise<{ readyRunIds: string[] }> {
    const ready = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE runs r
      SET state = 'INGESTING', updated_at = now()
      WHERE r.state IN ('PENDING', 'EXECUTING')
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.run_id = r.id AND j.state NOT IN ('SUCCEEDED')
        )
      RETURNING r.id
    `);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE runs r
      SET state = 'DEAD_LETTER', updated_at = now(), completed_at = now()
      WHERE r.state IN ('PENDING', 'EXECUTING')
        AND EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.run_id = r.id AND j.state IN ('DEAD_LETTER', 'CANCELLED')
        )
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.run_id = r.id
            AND j.state NOT IN ('SUCCEEDED', 'DEAD_LETTER', 'CANCELLED')
        )
    `);
    return { readyRunIds: ready.map((r) => r.id) };
  }
}
