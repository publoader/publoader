import type { PrismaClient, Bundle } from "@prisma/client";
import type { Logger } from "../../logging.js";
import { Manifest } from "../../contracts/manifest.js";
import { metrics } from "../../metrics.js";
import { JobStore } from "../store/jobs.js";
import { BundleStore } from "../store/bundles.js";
import { SettingsStore, AuditLog } from "../store/settings.js";
import { UploadTaskStore } from "../store/uploadTasks.js";
import { computeSegments, dueSlot, effectiveSchedules, slotId } from "./slots.js";
import type { DiscordEmbedInput } from "../md/webhook.js";
import { runStartedEmbed } from "../md/webhookEmbeds.js";
import type { RepoSyncResult } from "../webhooks/autoSync.js";

const LAST_TICK_KEY = "scheduler_last_tick";
const GITHUB_SYNC_LAST_KEY = "github_auto_sync_last";
/** How often the repos are polled. The push webhook covers the fast path;
 * this only has to catch what it missed, so it is deliberately slow. */
const GITHUB_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The scheduling loop: turns due schedule slots into durable runs+jobs, and
 * sweeps expired leases. Every action is CAS/idempotent, so running more than
 * one scheduler replica is safe (harmless racing), and a crashed scheduler
 * resumes exactly where the persisted last-tick left off.
 */
export class SchedulerService {
  private readonly jobs: JobStore;
  private readonly bundles: BundleStore;
  private readonly settings: SettingsStore;
  private readonly uploadTasks: UploadTaskStore;
  private readonly audit: AuditLog;

  /**
   * Where the "run started" notice goes. Optional for the same reason the
   * processor's is: scheduling must keep working when Discord is not configured
   * or is down.
   */
  private readonly notifier: { enabled: boolean; send(embeds: DiscordEmbedInput[]): Promise<void> } | null;
  /**
   * Runs one GitHub poll. Injected rather than built here so the scheduler
   * core keeps no GitHub dependency, and so tests drive it without a network.
   * Absent means the deployment has no repos configured.
   */
  private readonly autoSync: (() => Promise<RepoSyncResult[]>) | null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: Logger,
    retry: { baseSeconds: number; maxSeconds: number },
    options: {
      notifier?: { enabled: boolean; send(embeds: DiscordEmbedInput[]): Promise<void> };
      autoSync?: () => Promise<RepoSyncResult[]>;
    } = {},
  ) {
    this.jobs = new JobStore(prisma, retry);
    this.bundles = new BundleStore(prisma);
    this.settings = new SettingsStore(prisma);
    this.uploadTasks = new UploadTaskStore(prisma);
    this.audit = new AuditLog(prisma);
    this.notifier = options.notifier ?? null;
    this.autoSync = options.autoSync ?? null;
  }

  /** One scheduler tick. Exposed for tests; the service loop calls it forever. */
  async tick(now = new Date()): Promise<void> {
    if (await this.settings.isPaused()) {
      this.log.debug("scheduler paused; skipping slot creation");
    } else {
      // Isolated deliberately. Slot creation touches bundles, manifests and
      // settings, so it has plenty of ways to throw; letting it abort the tick
      // also skipped the lease sweeper and run advancement below, which is how
      // a single bad manifest could quietly stop the whole queue; visible only
      // as one log line every 30 seconds. Recovery work must not depend on
      // scheduling work succeeding.
      try {
        await this.createDueRuns(now);
      } catch (err) {
        this.log.error({ err }, "creating due runs failed; continuing with sweep and advance");
      }
    }

    const { requeued, deadLettered } = await this.jobs.sweepExpiredLeases();
    for (const job of requeued) {
      metrics.leaseExpiries.inc({ extension: job.extension });
      metrics.jobsRequeued.inc({ extension: job.extension, reason: "lease_expired" });
      this.log.warn({ jobId: job.id, runId: job.runId, attempt: job.attempt }, "lease expired; job requeued");
    }
    for (const job of deadLettered) {
      metrics.jobsDeadLettered.inc({ extension: job.extension });
      this.log.error({ jobId: job.id, runId: job.runId }, "lease expired; attempts exhausted; dead-lettered");
    }

    await this.jobs.advanceRuns();
    const sweptTasks = await this.uploadTasks.sweepExpired();
    if (sweptTasks > 0) {
      this.log.warn({ count: sweptTasks }, "requeued expired upload-task leases");
    }

    // Last, and isolated: publishing extension code is the least urgent thing
    // this tick does and the most likely to be slow (a 32 MB archive per changed
    // repo), so it must not be able to delay or abort the queue work above.
    try {
      await this.maybeSyncGithub(now);
    } catch (err) {
      this.log.error({ err }, "github auto-sync failed");
    }
  }

  /**
   * Poll GitHub for changed extensions, at most once per SYNC_INTERVAL_MS.
   *
   * Rate-limited by a persisted timestamp rather than a timer so that restarts
   * do not reset the clock; a crash-looping scheduler must not turn into a
   * GitHub API hammer.
   */
  private async maybeSyncGithub(now: Date): Promise<void> {
    if (!this.autoSync) return;
    if (!(await this.settings.getGithubAutoSync())) return;

    const lastRaw = await this.settings.getSetting(GITHUB_SYNC_LAST_KEY);
    const last = lastRaw ? Date.parse(lastRaw) : 0;
    if (Number.isFinite(last) && now.getTime() - last < GITHUB_SYNC_INTERVAL_MS) return;
    // Written BEFORE the work, so a sync that throws or hangs still holds the
    // interval open rather than retrying on every tick.
    await this.settings.setSetting(GITHUB_SYNC_LAST_KEY, now.toISOString());

    const results = await this.autoSync();
    for (const result of results) {
      const published = result.outcomes.filter((o) => o.status === "published");
      if (published.length > 0) {
        this.log.info(
          { repo: result.repo, commit: result.commit, extensions: published.map((o) => o.extension) },
          "github auto-sync published new extension bundles",
        );
        await this.audit.record("scheduler", "github.autosync", result.repo, {
          commit: result.commit,
          published: published.map((o) => ({ extension: o.extension, version: o.version })),
        });
      }
      if (result.status === "failed") {
        this.log.warn({ repo: result.repo, detail: result.detail }, "github auto-sync had failures");
      }
    }
  }

  private async createDueRuns(now: Date): Promise<void> {
    const lastTickRaw = await this.settings.getSetting(LAST_TICK_KEY);
    // First boot: look back one minute only; never storm through history.
    const lastTick = lastTickRaw ? new Date(lastTickRaw) : new Date(now.getTime() - 60_000);

    const bundles = await this.bundles.listLatest();
    const manifests = bundles
      .map((b) => {
        const parsed = Manifest.safeParse(b.manifest);
        return parsed.success ? { manifest: parsed.data, bundle: b } : null;
      })
      .filter((x): x is { manifest: Manifest; bundle: Bundle } => x !== null);

    const overrides = await this.settings.getScheduleOverrides();
    const disabled = await this.settings.listDisabled();
    const schedules = effectiveSchedules(
      manifests.map((m) => m.manifest),
      overrides,
      disabled,
    );

    for (const schedule of schedules) {
      const due = dueSlot(schedule, lastTick, now);
      if (!due) continue;
      const entry = manifests.find((m) => m.manifest.name === schedule.extension);
      if (!entry) continue;
      // The kind is part of the key, so an extension scheduled for both an
      // update and a clean at the same minute gets one of each, while two
      // slots that agree on minute AND kind still collapse to a single run,
      // which is what makes a duplicated slot harmless.
      await this.createRunForExtension(entry.manifest, entry.bundle, {
        idempotencyKey: `sched:${schedule.extension}:${slotId(due)}:${schedule.kind}`,
        kind: schedule.kind,
        triggeredBy: "scheduler",
        scheduledFor: due,
      });
    }

    await this.settings.setSetting(LAST_TICK_KEY, now.toISOString());
  }

  /** Shared by the scheduler and the admin run-now endpoint. */
  async createRunForExtension(
    manifest: Manifest,
    bundle: Bundle,
    opts: {
      idempotencyKey: string;
      kind: "UPDATE" | "CLEAN" | "FORCE";
      triggeredBy: string;
      scheduledFor?: Date;
      /**
       * Limit the run to these titles: external manga ids for the worker to
       * fetch, and the MangaDex ids they map to for the processor to trust the
       * snapshot about. Both, because the two halves of the system address a
       * series by different names and neither can derive the other's.
       */
      scope?: { mangaIds: string[]; mdMangaIds: string[] };
    },
  ): Promise<{ runId: string; created: boolean; segments: number }> {
    let segments: ReturnType<typeof computeSegments> = [];
    // A scoped run is one job over a named subset, never partitioned: the
    // subset is already small, and its whole purpose is that the processor can
    // tell "these titles and no others" from "the whole catalogue".
    if (opts.scope) {
      segments = [
        {
          index: 0,
          total: 1,
          key: `scope:${opts.scope.mangaIds.length}`,
          mangaIds: [...opts.scope.mangaIds],
        },
      ];
    } else if (manifest.partition && opts.kind !== "CLEAN") {
      // CLEAN runs are all-or-nothing over the full catalogue; never partition
      // them; a missing segment must not read as "chapters were removed".
      // The DB (TrackedManga) is the source of truth for the tracked catalogue;
 // bundle data files only seed it at publish time.
      const tracked = await this.prisma.trackedManga.findMany({
        where: { extension: manifest.name },
        select: { namespace: true, mangaId: true },
      });
      // `segmentMangaIds` is a flat list of external ids on the wire, so it
      // cannot name WHICH catalogue an id belongs to. For an extension with more
      // than one, `709` is ambiguous; it would either segment two different
      // series as one or send the same id to two workers. Running the whole job
      // unpartitioned is slower and correct; guessing is neither.
      const namespaces = new Set(tracked.map((t) => t.namespace));
      if (namespaces.size > 1 || (namespaces.size === 1 && !namespaces.has(""))) {
        this.log.warn(
          { extension: manifest.name, namespaces: [...namespaces] },
          "extension has namespaced tracked ids; running unpartitioned because " +
            "segmentMangaIds cannot express a namespace",
        );
      } else {
        segments = computeSegments(
          manifest.name,
          opts.idempotencyKey,
          tracked.map((t) => t.mangaId),
          {
            maxSegments: manifest.partition.maxSegments,
            minMangaPerSegment: manifest.partition.minMangaPerSegment,
          },
        );
      }
    }

    const { run, created } = await this.jobs.createRun({
      idempotencyKey: opts.idempotencyKey,
      extension: manifest.name,
      extensionVersion: manifest.version,
      bundleSha256: bundle.sha256,
      kind: opts.kind,
      triggeredBy: opts.triggeredBy,
      scheduledFor: opts.scheduledFor,
      timeoutSeconds: manifest.timeout_seconds,
      maxAttempts: manifest.max_attempts,
      minTrust: manifest.min_trust,
      segments,
      scopeMangaIds: opts.scope?.mdMangaIds ?? [],
    });
    if (created) {
      metrics.jobsCreated.inc(
        { extension: manifest.name, kind: opts.kind },
        Math.max(1, segments.length),
      );
      this.log.info(
        { runId: run.id, extension: manifest.name, kind: opts.kind, segments: Math.max(1, segments.length) },
        "run created",
      );
      await this.audit.record("scheduler", "run.create", run.id, {
        extension: manifest.name,
        kind: opts.kind,
        idempotencyKey: opts.idempotencyKey,
        ...(opts.scope ? { scope: opts.scope } : {}),
      });
      // Each extension is announced as it begins. Only on
      // `created`: createRun is idempotent by key, and a duplicate trigger must
      // not produce a second "started" that implies a second run.
      //
      // A scoped run is not announced at all: "Reading data from mangaplus"
      // describes the extension's sweep of its catalogue, and an operator
      // checking one series has not started one.
      if (!opts.scope) await this.reportRunStarted(manifest.name);
    }
    return { runId: run.id, created, segments: Math.max(1, segments.length) };
  }

  /**
   * `Reading data from {extension}`: the run has begun.
   *
   * Swallows failures; a Discord outage must not stop runs being scheduled,
   * which is the one thing this service exists to do.
   */
  private async reportRunStarted(extension: string): Promise<void> {
    if (!this.notifier?.enabled) return;
    try {
      await this.notifier.send([runStartedEmbed(extension)]);
    } catch (err) {
      this.log.warn({ err, extension }, "could not send the run started webhook");
    }
  }

}
