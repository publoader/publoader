import type { ScheduledLoad } from "../processor/uploadSchedule.js";
import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type UploadTask,
  type UploadTaskKind,
  type UploadTaskState,
} from "@prisma/client";
import {
  encodeSortCursor,
  numberKeys,
  numericTextKeys,
  plainKey,
  sortedBy,
  textKeys,
  timeKeys,
  type OrderKey,
  type SortColumns,
  type SortRequest,
} from "./ordering.js";

/**
 * Central MangaDex work queues, replacing the Mongo `to_upload` / `to_edit` /
 * `to_delete` / `to_unavailable` collections.
 *
 * Insertion keeps the old `$setOnInsert` semantics via a unique
 * (kind, dedupe_key) constraint plus ON CONFLICT DO NOTHING, so re-processing a
 * run can never enqueue the same chapter twice. Draining uses the same SKIP
 * LOCKED lease pattern as jobs.
 *
 * The operator half follows jobs.ts: every mutation is one statement, or one
 * transaction, whose WHERE clause names the expected prior state. Zero rows
 * affected means the caller lost the race and must report a refusal. There is no
 * read-then-write anywhere, and nothing here can touch a LEASED row.
 */

export const UPLOAD_TASK_KINDS = ["UPLOAD", "EDIT", "DELETE", "UNAVAILABLE", "RESTORE"] as const;
export const UPLOAD_TASK_STATES = ["PENDING", "LEASED", "DONE", "FAILED", "DEAD_LETTER"] as const;

/** States an operator may retry back into the queue. */
export const RETRYABLE_STATES = ["FAILED", "DEAD_LETTER"] as const satisfies readonly UploadTaskState[];

/**
 * States a row may be deleted from without an extra flag. DONE is deliberately
 * absent: a DONE row is half of the double-upload guard (the other half being
 * `upload_logs`), so dropping one re-arms the processor to enqueue that chapter
 * again. Callers must pass `includeCompleted`.
 */
export const REMOVABLE_STATES = ["PENDING", "FAILED", "DEAD_LETTER"] as const satisfies readonly UploadTaskState[];

/**
 * Hard ceiling on one bulk mutation. Bulk means "an operator clicked
 * select-all", not "migrate the queue".
 */
export const BULK_CAP = 1000;
/** Same idea for a whole-queue purge, which is expected to be larger. */
export const PURGE_CAP = 5000;

export function uploadDedupeKey(chapter: {
  chapterId?: string | null;
  chapterNumber?: string | null;
  chapterLanguage?: string | null;
}): string {
  return `${chapter.chapterId ?? ""}|${chapter.chapterNumber ?? ""}|${chapter.chapterLanguage ?? ""}`;
}

/**
 * The dedupe key for a hand-built task, derived exactly as the producers do:
 * `uploadDedupeKey` for UPLOAD and the MangaDex chapter id for every other kind.
 * Returning null rather than a degenerate key stops a chapter with no identity
 * from occupying the `||` slot.
 */
export function taskDedupeKey(
  kind: UploadTaskKind,
  chapter: {
    chapterId?: string | null;
    chapterNumber?: string | null;
    chapterLanguage?: string | null;
    mdChapterId?: string | null;
  },
): string | null {
  if (kind === "UPLOAD") {
    const key = uploadDedupeKey(chapter);
    return key === "||" ? null : key;
  }
  return chapter.mdChapterId ?? null;
}

/** Filter shared by the list, bulk-mutation and purge paths. */
export interface UploadTaskFilter {
  kinds?: readonly UploadTaskKind[];
  states?: readonly UploadTaskState[];
  /** Case-insensitive substring over `dedupe_key`. */
  dedupeKey?: string;
  /**
   * Case-insensitive substring over the chapter payload: series name, chapter
   * title, chapter number, and both MangaDex ids. Applies to every path the
   * filter reaches, purge included.
   */
  q?: string;
  attemptMin?: number;
  attemptMax?: number;
  /** Exact match on the payload's `extensionName`. */
  extension?: string;
  /** Exact match on the payload's `chapterLanguage`. */
  language?: string;
}

/**
 * Which chapter a queue row is about.
 *
 * The `chapter` payload is absent from every list projection: it is
 * worker-supplied, carries the page-artifact ids and (for EDIT) a whole
 * before/after pair, and is read once by the uploader. Without it a row is a
 * bare dedupe key, which for EDIT, DELETE and UNAVAILABLE is a MangaDex UUID.
 * These are the fields that make such a row readable as a chapter.
 */
export interface UploadTaskIdentity {
  extension: string | null;
  mangaName: string | null;
  mdMangaId: string | null;
  mdChapterId: string | null;
  chapterNumber: string | null;
  chapterVolume: string | null;
  chapterTitle: string | null;
  chapterLanguage: string | null;
}

/** A queue row without its `chapter` payload: what list views return. */
export interface UploadTaskRow {
  id: string;
  kind: string;
  dedupeKey: string;
  state: string;
  attempt: number;
  maxAttempts: number;
  notBefore: Date;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  identity: UploadTaskIdentity;
}

/**
 * A queue row read as the chapter it will act on. Every chapter field is
 * nullable because the payload is whatever the extension produced.
 *
 * `identity` is dropped rather than inherited: this row carries every one of
 * those fields flat, and a nested copy would be a shape `listChapters` does not
 * select, which `$queryRaw` cannot catch.
 */
export interface QueuedChapterRow extends Omit<UploadTaskRow, "identity"> {
  /** 1-based place in the claim order across everything matching the filter. */
  position: number;
  extension: string | null;
  mangaName: string | null;
  mdMangaId: string | null;
  mangaId: string | null;
  mdChapterId: string | null;
  chapterId: string | null;
  chapterNumber: string | null;
  chapterVolume: string | null;
  chapterTitle: string | null;
  chapterLanguage: string | null;
  chapterUrl: string | null;
  /** The MangaDex PUT body an EDIT task carries; null for other kinds. */
  editPayload: Record<string, unknown> | null;
  pageCount: number;
}

/** Enough of a row to explain why a mutation refused it. */
export interface UploadTaskStateRow {
  id: string;
  kind: string;
  dedupeKey: string;
  state: string;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  updatedAt: Date;
}

export type ReorderMode = "front" | "back" | "sequence" | "defer";

/**
 * Keyset position in the queue's own ordering. Offset paging cannot be used
 * here: the uploader mutates `not_before` constantly, so page 2 of an offset
 * scan silently skips or repeats rows as the queue drains.
 */
export interface TaskCursor {
  notBefore: Date;
  createdAt: Date;
  id: string;
}

/**
 * Which end of the queue a page starts from.
 *
 * `asc` is the claim order: what the uploader runs next, and what a reorder is
 * checked against. `desc` is the same total ordering reversed, so the most
 * recently queued work is on the first page — what a reader watching a queue
 * fill up wants, and what the dashboard asks for.
 *
 * Only the direction changes. The keyset stays (not_before, created_at, id) and
 * the cursor encoding is identical, so a page boundary means the same thing
 * either way; the comparison flips with the ORDER BY, which is what keeps
 * paging correct while the uploader mutates not_before underneath.
 *
 * `position` in listChapters is deliberately NOT reversed: it is the row's
 * place in the claim order out of everything matching, and "3rd from the end"
 * would answer a question nobody asked.
 */
export type TaskSort = "asc" | "desc";

/**
 * The columns the queue's two listings can be ordered by, under the names the
 * console's headers carry.
 *
 * Distinct from `TaskSort`, which reverses the queue's own ordering and is the
 * only thing that can be said about the claim order. These order the whole
 * filtered set by something else entirely, because that is what a click on a
 * column header means; `position` in the chapters listing stays the claim
 * order's numbering either way, so a sorted page still says where each row
 * stands in the queue.
 */
export const TASK_SORTS = [
  "kind",
  "state",
  "chapter",
  "dedupeKey",
  "attempts",
  "notBefore",
  "lastError",
] as const;

export const QUEUED_CHAPTER_SORTS = [
  "position",
  "kind",
  "series",
  "chapter",
  "volume",
  "title",
  "language",
  "due",
  "state",
] as const;

/**
 * The Chapter column shows a series and a number together, so it orders by
 * both: by series alone it would look sorted while scattering each title's
 * chapters, which is the one thing a reader of that column is looking for.
 */
const TASK_SORT_COLUMNS: SortColumns = {
  kind: textKeys(Prisma.sql`t.kind::text`),
  state: textKeys(Prisma.sql`t.state::text`),
  chapter: [
    ...textKeys(Prisma.sql`t.chapter->>'mangaName'`),
    ...numericTextKeys(Prisma.sql`t.chapter->>'chapterNumber'`),
  ],
  dedupeKey: textKeys(Prisma.sql`t.dedupe_key`),
  attempts: numberKeys(Prisma.sql`t.attempt`),
  notBefore: timeKeys(Prisma.sql`t.not_before`),
  lastError: textKeys(Prisma.sql`t.last_error`),
};

const QUEUED_CHAPTER_SORT_COLUMNS: SortColumns = {
  position: plainKey(Prisma.sql`o.position`, "numeric"),
  kind: textKeys(Prisma.sql`o.kind`),
  series: textKeys(Prisma.sql`o."mangaName"`),
  chapter: numericTextKeys(Prisma.sql`o."chapterNumber"`),
  volume: numericTextKeys(Prisma.sql`o."chapterVolume"`),
  title: textKeys(Prisma.sql`o."chapterTitle"`),
  language: textKeys(Prisma.sql`o."chapterLanguage"`),
  due: timeKeys(Prisma.sql`o."notBefore"`),
  state: textKeys(Prisma.sql`o.state`),
};

/** The tiebreak that makes each of the above a total order. */
const TASK_ID: OrderKey = { sql: Prisma.sql`t.id`, cast: "text", dir: "follow" };
const QUEUED_CHAPTER_ID: OrderKey = { sql: Prisma.sql`o.id`, cast: "text", dir: "follow" };

export function encodeTaskCursor(row: TaskCursor): string {
  const raw = `${row.notBefore.toISOString()}|${row.createdAt.toISOString()}|${row.id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/** Null for anything unparseable; the caller answers 400 rather than guessing. */
export function decodeTaskCursor(raw: string): TaskCursor | null {
  const parts = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (parts.length !== 3) return null;
  const [notBefore, createdAt, id] = parts as [string, string, string];
  const a = new Date(notBefore);
  const b = new Date(createdAt);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { notBefore: a, createdAt: b, id };
}

/**
 * Millisecond offsets from the mode's anchor, one per id in the order given.
 * Reordering is expressed purely as `not_before` (see `UploadTaskStore.reorder`),
 * so position is arithmetic on an instant. Steps are 1 ms apart, which postgres
 * stores exactly.
 */
export function reorderOffsetsMs(mode: Exclude<ReorderMode, "defer">, count: number): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    // front: strictly before the anchor (the earliest other pending row), in
    // order. back: strictly after it. sequence: from the group's own earliest
    // instant, so the group keeps its place and only its internal order moves.
    if (mode === "front") offsets.push(-(count - i));
    else if (mode === "back") offsets.push(i + 1);
    else offsets.push(i);
  }
  return offsets;
}

export class UploadTaskStore {
  constructor(private readonly prisma: PrismaClient) {}

  /** Enqueue if absent. Returns true when a new task row was created. */
  /**
   * `opts.notBefore` dates the row into the future, which is how a run spreads
   * a backlog instead of making every chapter due at once (see
   * processor/uploadSchedule.ts). Omitted, the column default `now()` applies
   * and the task is claimable immediately, as it always was.
   *
   * DO NOTHING is what makes a future date stick: a later run that decides the
   * same chapter again leaves the existing row, and its date, alone. Nothing
   * here can pull a scheduled task forward — `requeueForChapter` and `reorder`
   * are the deliberate ways to do that.
   */
  async enqueue(
    kind: UploadTaskKind,
    dedupeKey: string,
    chapter: unknown,
    opts: { notBefore?: Date; spacingSeconds?: number } = {},
  ): Promise<boolean> {
    const spacing = opts.spacingSeconds ?? 0;
    // The queue's tail plus a gap, so a new row lands behind what is already
    // waiting rather than on top of it. `max()` over no rows is NULL and
    // `greatest` ignores NULLs, which is exactly the empty-queue case: nothing
    // to queue behind, so the row is due now.
    //
    // An explicit `notBefore` still wins: a spread run has already decided
    // where its chapters go, and pacing them a second time here would move work
    // the planner deliberately placed.
    const paced =
      spacing > 0
        ? Prisma.sql`greatest(now(), (SELECT max(not_before) FROM upload_tasks
                                      WHERE kind = ${kind}::"UploadTaskKind" AND state = 'PENDING')
                                     + make_interval(secs => ${spacing}))`
        : Prisma.sql`now()`;

    const res = await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO upload_tasks (id, kind, dedupe_key, chapter, state, not_before, created_at, updated_at)
      VALUES (${randomUUID()}, ${kind}::"UploadTaskKind", ${dedupeKey},
              ${JSON.stringify(chapter)}::jsonb, 'PENDING',
              coalesce(${opts.notBefore ?? null}::timestamptz, ${paced}), now(), now())
      ON CONFLICT (kind, dedupe_key) DO NOTHING
    `);
    return res === 1;
  }

  /**
   * Queue a chapter action an operator asked for, superseding a settled row.
   *
   * `enqueue` cannot serve this: its ON CONFLICT DO NOTHING keeps the processor
   * idempotent, but it also means the (kind, dedupe_key) slot is occupied
   * forever once the task completes, so a second operator action on the same
   * chapter would silently do nothing.
   *
   * A settled row is therefore reset in place: same slot, new payload, PENDING,
   * fresh attempt budget, due now. Which states count as settled is the safety
   * property, and it lives in the WHERE clause of the one statement:
   *
   *  - LEASED is excluded because an uploader is mid-flight against MangaDex.
   *  - PENDING is excluded because the work is already queued, and saying so is
   *    a better answer than a silent rewrite.
   *
   * Both come back as null; the caller reads the row afterwards purely to name
   * the state in its refusal.
   *
   * UPLOAD is not accepted, by type and at runtime: resetting a DONE UPLOAD row
   * removes half of the double-upload guard (see REMOVABLE_STATES).
   */
  async requeueForChapter(
    kind: Exclude<UploadTaskKind, "UPLOAD">,
    dedupeKey: string,
    chapter: unknown,
    opts: { maxAttempts?: number } = {},
  ): Promise<{ task: UploadTaskRow; superseded: boolean } | null> {
    if (kind === ("UPLOAD" as UploadTaskKind)) {
      throw new Error("requeueForChapter does not accept UPLOAD: it would re-arm a double upload");
    }
    const rows = await this.prisma.$queryRaw<(UploadTaskRow & { inserted: boolean })[]>(Prisma.sql`
      INSERT INTO upload_tasks (id, kind, dedupe_key, chapter, state, attempt, max_attempts,
                                not_before, created_at, updated_at)
      VALUES (${randomUUID()}, ${kind}::"UploadTaskKind", ${dedupeKey},
              ${JSON.stringify(chapter)}::jsonb, 'PENDING', 0,
              coalesce(${opts.maxAttempts ?? null}::int, 5), now(), now(), now())
      ON CONFLICT (kind, dedupe_key) DO UPDATE
        SET chapter = EXCLUDED.chapter, state = 'PENDING', attempt = 0,
            max_attempts = EXCLUDED.max_attempts, not_before = now(),
            lease_id = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = now()
        WHERE upload_tasks.state IN ('DONE', 'FAILED', 'DEAD_LETTER')
      -- xmax is 0 on a freshly inserted tuple and carries the updating
      -- transaction id on one that took the DO UPDATE branch: the only way to
      -- tell "queued" from "requeued" without a second statement.
      RETURNING id, kind::text AS kind, dedupe_key AS "dedupeKey", state::text AS state,
                attempt, max_attempts AS "maxAttempts", not_before AS "notBefore",
                lease_id AS "leaseId", lease_expires_at AS "leaseExpiresAt",
                last_error AS "lastError", created_at AS "createdAt",
                updated_at AS "updatedAt", (xmax = 0) AS inserted
    `);
    const row = rows[0];
    if (!row) return null;
    const { inserted, ...task } = row;
    return { task, superseded: !inserted };
  }

  /**
   * Every queue row for one dedupe key, across kinds. For a chapter that key is
   * `mdChapterId`, so this answers "is anything already queued against this
   * chapter?".
   */
  async forDedupeKey(dedupeKey: string): Promise<UploadTaskRow[]> {
    return this.forDedupeKeys([dedupeKey]);
  }

  /**
   * The same question for many chapters in one query, which is what a bulk
   * action's dry run asks; one chapter at a time would make the preview slower
   * than the operation it previews.
   */
  async forDedupeKeys(dedupeKeys: readonly string[]): Promise<UploadTaskRow[]> {
    if (dedupeKeys.length === 0) return [];
    return this.prisma.$queryRaw<UploadTaskRow[]>(Prisma.sql`
      SELECT ${TASK_COLUMNS} FROM upload_tasks t
      WHERE t.dedupe_key = ANY(${[...dedupeKeys]}::text[])
      ORDER BY t.updated_at DESC
    `);
  }

  /** Claim one due task of the given kind (SKIP LOCKED lease). */
  async claim(
    kind: UploadTaskKind,
    leaseTtlSeconds: number,
    /**
     * Extensions to skip over. A held task stays PENDING with its date intact,
     * so this hides work rather than changing it and un-pausing needs no
     * repair. Empty means claim anything, which is the behaviour this was
     * added on top of.
     */
    pausedExtensions: readonly string[] = [],
  ): Promise<UploadTask | null> {
    const leaseId = randomUUID();
    // `<> ALL` rather than `NOT IN`: a NULL extensionName makes `NOT IN` return
    // NULL and the row vanishes from the queue, which would strand any task
    // whose payload predates that field.
    const notPaused =
      pausedExtensions.length > 0
        ? Prisma.sql`AND coalesce(chapter ->> 'extensionName', '') <> ALL(${pausedExtensions as string[]}::text[])`
        : Prisma.empty;
    const rows = await this.prisma.$queryRaw<UploadTask[]>(Prisma.sql`
      WITH candidate AS (
        SELECT id FROM upload_tasks
        WHERE kind = ${kind}::"UploadTaskKind" AND state = 'PENDING' AND not_before <= now()
        ${notPaused}
        ORDER BY not_before ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE upload_tasks t
      SET state = 'LEASED', lease_id = ${leaseId},
          lease_expires_at = now() + make_interval(secs => ${leaseTtlSeconds}),
          attempt = t.attempt + 1, updated_at = now()
      FROM candidate WHERE t.id = candidate.id
      RETURNING t.id, t.kind, t.dedupe_key AS "dedupeKey", t.chapter, t.state,
        t.attempt, t.max_attempts AS "maxAttempts", t.not_before AS "notBefore",
        t.lease_id AS "leaseId", t.lease_expires_at AS "leaseExpiresAt",
        t.last_error AS "lastError", t.created_at AS "createdAt",
        t.updated_at AS "updatedAt"
    `);
    return rows[0] ?? null;
  }

  async completeDone(taskId: string, leaseId: string): Promise<boolean> {
    const res = await this.prisma.uploadTask.updateMany({
      where: { id: taskId, leaseId, state: "LEASED" },
      data: { state: "DONE" },
    });
    return res.count === 1;
  }

  async fail(taskId: string, leaseId: string, message: string, retryDelaySeconds: number): Promise<"requeued" | "dead_letter" | "rejected"> {
    const task = await this.prisma.uploadTask.findUnique({ where: { id: taskId } });
    if (!task) return "rejected";
    if (task.attempt >= task.maxAttempts) {
      const res = await this.prisma.uploadTask.updateMany({
        where: { id: taskId, leaseId, state: "LEASED" },
        data: { state: "DEAD_LETTER", lastError: message.slice(0, 4000) },
      });
      return res.count === 1 ? "dead_letter" : "rejected";
    }
    const res = await this.prisma.uploadTask.updateMany({
      where: { id: taskId, leaseId, state: "LEASED" },
      data: {
        state: "PENDING",
        lastError: message.slice(0, 4000),
        notBefore: new Date(Date.now() + retryDelaySeconds * 1000),
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    return res.count === 1 ? "requeued" : "rejected";
  }

  /** Sweeper for crashed uploader processes. */
  async sweepExpired(): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      UPDATE upload_tasks
      SET state = 'PENDING', lease_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE state = 'LEASED' AND lease_expires_at < now()
    `);
  }

  async depths(): Promise<{ kind: string; state: string; count: number }[]> {
    const rows = await this.prisma.$queryRaw<{ kind: string; state: string; count: bigint }[]>(
      Prisma.sql`SELECT kind::text, state::text, count(*) FROM upload_tasks GROUP BY kind, state`,
    );
    return rows.map((r) => ({ kind: r.kind, state: r.state, count: Number(r.count) }));
  }

  // ---------------------------------------------------------------- operator

  /**
   * What is already dated into each release bucket, for the upload scheduler.
   *
   * The point is a budget shared across extensions: without this every run
   * plans against an empty calendar, so `perDay` becomes a per-run quota and
   * the real ceiling is `perDay × runs × extensions`. Reading the queue back
   * makes a bucket fill once.
   *
   * `DONE` and `LEASED` count alongside `PENDING` because the cap is about how
   * much reaches MangaDex in a window, and work already uploaded in this
   * window spent that budget just as surely as work still waiting. Buckets
   * before the current one are not read: they are spent and unreachable.
   *
   * Bucket arithmetic is done in SQL against the same absolute grid the
   * planner uses (`floor(epoch_ms / intervalMs)`), so the two agree on
   * boundaries without passing a bucket list back and forth.
   */
  async scheduledLoad(
    intervalMs: number,
    now: Date = new Date(),
    /**
     * Count only this extension's rows, for a per-extension budget. Omitted,
     * every extension's work counts against one shared pool.
     */
    extension?: string,
    /**
     * Which queue's allowance is being counted. The five queues do not share
     * one: they reach MangaDex through different endpoints at different costs,
     * so an upload backlog must not spend the budget an edit needs.
     */
    kind: UploadTaskKind = "UPLOAD",
  ): Promise<ScheduledLoad> {
    const fromBucket = Math.floor(now.getTime() / intervalMs);
    const rows = await this.prisma.$queryRaw<{ bucket: bigint; manga: string; n: bigint }[]>(
      Prisma.sql`
        SELECT floor(extract(epoch FROM not_before) * 1000 / ${intervalMs})::bigint AS bucket,
               coalesce(chapter->>'mdMangaId', chapter->>'mangaId', '') AS manga,
               count(*)::bigint AS n
        FROM upload_tasks
        WHERE kind = ${kind}::"UploadTaskKind" AND state IN ('PENDING', 'LEASED', 'DONE')
          AND not_before >= to_timestamp(${(fromBucket * intervalMs) / 1000})
          ${extension === undefined ? Prisma.empty : Prisma.sql`AND chapter->>'extensionName' = ${extension}`}
        GROUP BY 1, 2
      `,
    );

    const total = new Map<number, number>();
    const perManga = new Map<number, Map<string, number>>();
    for (const row of rows) {
      const bucket = Number(row.bucket);
      const n = Number(row.n);
      total.set(bucket, (total.get(bucket) ?? 0) + n);
      let byManga = perManga.get(bucket);
      if (byManga === undefined) {
        byManga = new Map<string, number>();
        perManga.set(bucket, byManga);
      }
      byManga.set(row.manga, (byManga.get(row.manga) ?? 0) + n);
    }
    return { total, perManga };
  }

  /**
   * One page of the queue in the order it will actually drain, plus the total
   * matching the filter.
   *
   * `not_before ASC` is the claim query's ordering, so this answers "what runs
   * next?" rather than "what changed last?". `created_at, id` are appended only
   * to make the ordering total, which keyset paging requires.
   */
  async list(
    filter: UploadTaskFilter,
    opts: { limit: number; cursor?: TaskCursor | null; sort?: TaskSort; column?: SortRequest | null },
  ): Promise<{ tasks: UploadTaskRow[]; total: number; nextCursor: string | null }> {
    const descending = opts.sort === "desc";
    const parts = taskWhere(filter);

    // A column sort replaces the claim order rather than refining it. The claim
    // order answers "what runs next"; a header click asks a different question
    // about the same rows, and answering both at once answers neither.
    const sorted = sortedBy(TASK_SORT_COLUMNS, opts.column, TASK_ID);
    if (sorted) {
      const after = sorted.order.after(sorted.after);
      if (after) parts.push(after);
    } else if (opts.cursor) {
      const position = Prisma.sql`(${opts.cursor.notBefore}, ${opts.cursor.createdAt}, ${opts.cursor.id})`;
      parts.push(
        descending
          ? Prisma.sql`(t.not_before, t.created_at, t.id) < ${position}`
          : Prisma.sql`(t.not_before, t.created_at, t.id) > ${position}`,
      );
    }
    // One row beyond the page, so "is there a next page?" needs no second count.
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<(UploadTaskRow & Record<string, unknown>)[]>(Prisma.sql`
        SELECT ${TASK_COLUMNS}, ${TASK_IDENTITY}${sorted ? Prisma.sql`, ${sorted.order.select}` : Prisma.empty}
        FROM upload_tasks t
        ${combine(parts)}
        ORDER BY ${
          sorted
            ? sorted.order.orderBy
            : descending
              ? Prisma.sql`t.not_before DESC, t.created_at DESC, t.id DESC`
              : Prisma.sql`t.not_before ASC, t.created_at ASC, t.id ASC`
        }
        LIMIT ${opts.limit + 1}
      `),
      this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT count(*) AS total FROM upload_tasks t ${combine(taskWhere(filter))}
      `),
    ]);

    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const more = rows.length > opts.limit && last !== undefined;
    return {
      // Minted before the sort keys are stripped off the row they are read from.
      nextCursor: !more
        ? null
        : sorted
          ? encodeSortCursor(sorted.name, sorted.dir, sorted.order.cursorOf(last))
          : encodeTaskCursor(last),
      tasks: sorted ? page.map((row) => sorted.order.strip(row)) : page,
      total: Number(counted[0]?.total ?? 0),
    };
  }

  /**
   * The same page as `list`, but as chapters rather than queue rows: the series,
   * number, volume, title and language the uploader is about to send, with the
   * row's position in the claim order.
   *
   * The position comes from a window function over the whole filtered set in the
   * claim query's ordering, so "3rd" means third out of everything matching, not
   * third on this page. Paging stays keyset for the reason `list` documents.
   */
  async listChapters(
    filter: UploadTaskFilter,
    opts: { limit: number; cursor?: TaskCursor | null; sort?: TaskSort; column?: SortRequest | null },
  ): Promise<{ chapters: QueuedChapterRow[]; total: number; nextCursor: string | null }> {
    const descending = opts.sort === "desc";
    const parts = taskWhere(filter);
    const page: Prisma.Sql[] = [];

    // Applied outside the CTE, like the cursor it replaces: `position` is a
    // window over the claim order across everything matching the filter, so
    // narrowing inside the CTE would renumber the rows to the page.
    const sorted = sortedBy(QUEUED_CHAPTER_SORT_COLUMNS, opts.column, QUEUED_CHAPTER_ID);
    if (sorted) {
      const after = sorted.order.after(sorted.after);
      if (after) page.push(after);
    } else if (opts.cursor) {
      const position = Prisma.sql`(${opts.cursor.notBefore}, ${opts.cursor.createdAt}, ${opts.cursor.id})`;
      page.push(
        descending
          ? Prisma.sql`(o."notBefore", o."createdAt", o.id) < ${position}`
          : Prisma.sql`(o."notBefore", o."createdAt", o.id) > ${position}`,
      );
    }

    const rows = await this.prisma.$queryRaw<(QueuedChapterRow & Record<string, unknown>)[]>(Prisma.sql`
      WITH ordered AS (
        SELECT ${TASK_COLUMNS},
               row_number() OVER (ORDER BY t.not_before ASC, t.created_at ASC, t.id ASC) AS position,
               t.chapter ->> 'mangaName' AS "mangaName",
               t.chapter ->> 'mdMangaId' AS "mdMangaId",
               t.chapter ->> 'mangaId' AS "mangaId",
               t.chapter ->> 'mdChapterId' AS "mdChapterId",
               t.chapter ->> 'chapterId' AS "chapterId",
               t.chapter ->> 'chapterNumber' AS "chapterNumber",
               t.chapter ->> 'chapterVolume' AS "chapterVolume",
               t.chapter ->> 'chapterTitle' AS "chapterTitle",
               t.chapter ->> 'chapterLanguage' AS "chapterLanguage",
               t.chapter ->> 'chapterUrl' AS "chapterUrl",
               t.chapter ->> 'extensionName' AS "extension",
               -- The fields an EDIT task will change, so the list can show them
               -- without a second fetch per row.
               CASE WHEN jsonb_typeof(t.chapter -> 'payload') = 'object'
                    THEN t.chapter -> 'payload' END AS "editPayload",
               coalesce(jsonb_array_length(
                 CASE WHEN jsonb_typeof(t.chapter -> 'imageArtifacts') = 'array'
                      THEN t.chapter -> 'imageArtifacts' ELSE '[]'::jsonb END
               ), 0) AS "pageCount"
        FROM upload_tasks t
        ${combine(parts)}
      )
      SELECT o.*${sorted ? Prisma.sql`, ${sorted.order.select}` : Prisma.empty} FROM ordered o
      ${combine(page)}
      ORDER BY ${
        sorted
          ? sorted.order.orderBy
          : descending
            ? Prisma.sql`o."notBefore" DESC, o."createdAt" DESC, o.id DESC`
            : Prisma.sql`o."notBefore" ASC, o."createdAt" ASC, o.id ASC`
      }
      LIMIT ${opts.limit + 1}
    `);

    const counted = await this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      SELECT count(*) AS total FROM upload_tasks t ${combine(taskWhere(filter))}
    `);

    const wanted = rows.slice(0, opts.limit);
    const last = wanted[wanted.length - 1];
    const more = rows.length > opts.limit && last !== undefined;
    return {
      nextCursor: !more
        ? null
        : sorted
          ? encodeSortCursor(sorted.name, sorted.dir, sorted.order.cursorOf(last))
          : encodeTaskCursor(last),
      chapters: wanted.map((row) => ({
        ...(sorted ? sorted.order.strip(row) : row),
        position: Number(row.position),
      })),
      total: Number(counted[0]?.total ?? 0),
    };
  }

  /** One row including its `chapter` payload: the detail/edit view. */
  async get(id: string): Promise<(UploadTaskRow & { chapter: unknown }) | null> {
    const rows = await this.prisma.$queryRaw<(UploadTaskRow & { chapter: unknown })[]>(Prisma.sql`
      SELECT ${TASK_COLUMNS}, ${TASK_IDENTITY}, t.chapter FROM upload_tasks t WHERE t.id = ${id}
    `);
    return rows[0] ?? null;
  }

  /**
   * Current state of specific ids, for explaining a refusal. Only ever read
   * after a guarded mutation reported fewer rows than asked for, never before
   * one.
   */
  async statesOf(ids: readonly string[]): Promise<Map<string, UploadTaskStateRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<UploadTaskStateRow[]>(Prisma.sql`
      SELECT t.id, t.kind::text AS kind, t.dedupe_key AS "dedupeKey", t.state::text AS state,
             t.lease_id AS "leaseId", t.lease_expires_at AS "leaseExpiresAt",
             t.updated_at AS "updatedAt"
      FROM upload_tasks t WHERE t.id = ANY(${[...ids]}::text[])
    `);
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Ids matching a filter, in queue order, capped. Backs `{filter: …}` bulk calls. */
  async idsMatching(filter: UploadTaskFilter, cap: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT t.id FROM upload_tasks t ${combine(taskWhere(filter))}
      ORDER BY t.not_before ASC, t.created_at ASC, t.id ASC
      LIMIT ${cap}
    `);
    return rows.map((row) => row.id);
  }

  async countMatching(filter: UploadTaskFilter): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      SELECT count(*) AS total FROM upload_tasks t ${combine(taskWhere(filter))}
    `);
    return Number(rows[0]?.total ?? 0);
  }

  /** Per kind+state counts for a filter: the depth breakdown a purge reports. */
  async breakdown(filter: UploadTaskFilter): Promise<{ kind: string; state: string; count: number }[]> {
    const rows = await this.prisma.$queryRaw<{ kind: string; state: string; count: bigint }[]>(Prisma.sql`
      SELECT t.kind::text AS kind, t.state::text AS state, count(*) AS count
      FROM upload_tasks t ${combine(taskWhere(filter))}
      GROUP BY t.kind, t.state ORDER BY t.kind, t.state
    `);
    return rows.map((row) => ({ kind: row.kind, state: row.state, count: Number(row.count) }));
  }

  /**
   * FAILED/DEAD_LETTER to PENDING with a fresh attempt budget, due now. The
   * budget resets because the operator is asserting the cause is fixed. LEASED
   * rows cannot match the WHERE clause, so a worker's task is untouchable by
   * construction rather than by a check.
   */
  async retryMany(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE upload_tasks
      SET state = 'PENDING', attempt = 0, not_before = now(),
          lease_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ANY(${[...ids]}::text[])
        AND state = ANY(${[...RETRYABLE_STATES]}::text[]::"UploadTaskState"[])
      RETURNING id
    `);
    return rows.map((row) => row.id);
  }

  /**
   * Delete rows outright. Returns what went rather than a count, since these
   * rows do not exist afterwards to look up.
   */
  async removeMany(
    ids: readonly string[],
    opts: { includeCompleted: boolean },
  ): Promise<{ id: string; kind: string; dedupeKey: string; state: string }[]> {
    if (ids.length === 0) return [];
    const states = opts.includeCompleted ? [...REMOVABLE_STATES, "DONE"] : [...REMOVABLE_STATES];
    return this.prisma.$queryRaw<{ id: string; kind: string; dedupeKey: string; state: string }[]>(Prisma.sql`
      DELETE FROM upload_tasks
      WHERE id = ANY(${[...ids]}::text[])
        AND state = ANY(${states}::text[]::"UploadTaskState"[])
      RETURNING id, kind::text AS kind, dedupe_key AS "dedupeKey", state::text AS state
    `);
  }

  /**
   * Whole-queue delete by filter, capped. LEASED is excluded in the statement
   * itself, not by the caller's filter, so no combination of inputs can reach a
   * row a worker owns; DONE likewise needs `includeCompleted`.
   *
   * The inner SELECT applies the cap, since `DELETE … LIMIT` is not valid SQL.
   */
  async purge(
    filter: UploadTaskFilter,
    opts: { includeCompleted: boolean; cap: number },
  ): Promise<{ id: string; kind: string; dedupeKey: string; state: string }[]> {
    const states = opts.includeCompleted ? [...REMOVABLE_STATES, "DONE"] : [...REMOVABLE_STATES];
    const parts = taskWhere(filter);
    parts.push(Prisma.sql`t.state = ANY(${states}::text[]::"UploadTaskState"[])`);
    return this.prisma.$queryRaw<{ id: string; kind: string; dedupeKey: string; state: string }[]>(Prisma.sql`
      DELETE FROM upload_tasks
      WHERE id IN (
        SELECT t.id FROM upload_tasks t ${combine(parts)}
        ORDER BY t.not_before ASC, t.created_at ASC, t.id ASC
        LIMIT ${opts.cap}
      )
      RETURNING id, kind::text AS kind, dedupe_key AS "dedupeKey", state::text AS state
    `);
  }

  /**
   * Reprioritise PENDING rows by rewriting `not_before`.
   *
   * `not_before` is used rather than a priority column because the claim query
   * already reads `WHERE state = 'PENDING' AND not_before <= now() ORDER BY
   * not_before ASC`, making it both the readiness gate and the sort key. A
   * separate priority column would leave two fields deciding order, with no good
   * answer for a backing-off task carrying a high priority.
   *
   * Every mode is one statement whose WHERE names PENDING, so a row leased
   * between the operator's click and this update is simply not returned. The
   * anchor is a scalar subquery inside that statement rather than a prior SELECT,
   * which keeps the whole thing atomic.
   */
  /**
   * Re-space the whole pending queue so it drains at a fixed rate.
   *
   * `reorder` cannot express this. Every one of its modes assigns the listed
   * rows one instant — `defer` moves them all by the same amount, `front` and
   * `back` stack them at one end — so a queue that is already bunched stays
   * bunched, just somewhere else. Pacing needs a distinct `not_before` per row,
   * which is a rank over the queue rather than arithmetic on an id list.
   *
   * The rank is `not_before, created_at, id`: the claim order, so re-spacing
   * preserves the order the queue is already in rather than inventing one. The
   * first row keeps `now()`, so this paces the queue without delaying its head.
   *
   * PENDING only, which is what keeps this off a row the uploader is mid-way
   * through: a LEASED task has a worker holding it and its date means nothing.
   */
  async restagger(gapSeconds: number, kind: UploadTaskKind = "UPLOAD"): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE upload_tasks t
      SET not_before = now() + make_interval(secs => r.rn * ${gapSeconds}), updated_at = now()
      FROM (
        SELECT id, row_number() OVER (ORDER BY not_before, created_at, id) - 1 AS rn
        FROM upload_tasks
        WHERE kind = ${kind}::"UploadTaskKind" AND state = 'PENDING'
      ) r
      WHERE t.id = r.id AND t.state = 'PENDING'
      RETURNING t.id
    `);
    return rows.length;
  }

  async reorder(
    ids: readonly string[],
    mode: ReorderMode,
    deferSeconds = 0,
  ): Promise<{ id: string; notBefore: Date }[]> {
    if (ids.length === 0) return [];
    const idArray = [...ids];

    if (mode === "defer") {
      // Relative to now() for a row already due, so deferring a long-overdue task
      // by 60s means "in a minute" rather than a minute after a date that passed.
      return this.prisma.$queryRaw<{ id: string; notBefore: Date }[]>(Prisma.sql`
        UPDATE upload_tasks
        SET not_before = greatest(not_before, now()) + make_interval(secs => ${deferSeconds}),
            updated_at = now()
        WHERE id = ANY(${idArray}::text[]) AND state = 'PENDING'
        RETURNING id, not_before AS "notBefore"
      `);
    }

    const offsets = reorderOffsetsMs(mode, idArray.length);
    const pairs = Prisma.join(
      idArray.map((id, index) => Prisma.sql`(${id}::text, ${(offsets[index] ?? 0) / 1000}::double precision)`),
      ", ",
    );
    // front/back anchor on the rest of the queue and are clamped to now(), so
    // "front" is due immediately even when every other pending row is backing
    // off into the future. sequence anchors on the listed rows themselves, which
    // makes it a relative reordering rather than a queue jump.
    const anchor =
      mode === "front"
        ? Prisma.sql`SELECT least(coalesce(min(not_before), now()), now()) AS at
                     FROM upload_tasks WHERE state = 'PENDING' AND NOT (id = ANY(${idArray}::text[]))`
        : mode === "back"
          ? Prisma.sql`SELECT greatest(coalesce(max(not_before), now()), now()) AS at
                       FROM upload_tasks WHERE state = 'PENDING' AND NOT (id = ANY(${idArray}::text[]))`
          : Prisma.sql`SELECT coalesce(min(not_before), now()) AS at
                       FROM upload_tasks WHERE state = 'PENDING' AND id = ANY(${idArray}::text[])`;

    return this.prisma.$queryRaw<{ id: string; notBefore: Date }[]>(Prisma.sql`
      WITH anchor AS (${anchor})
      UPDATE upload_tasks t
      SET not_before = anchor.at + make_interval(secs => v.secs), updated_at = now()
      FROM (VALUES ${pairs}) AS v(id, secs), anchor
      WHERE t.id = v.id AND t.state = 'PENDING'
      RETURNING t.id, t.not_before AS "notBefore"
    `);
  }

  /**
   * Enqueue a hand-built task, returning the row or null when the unique
   * (kind, dedupe_key) constraint already holds one. Same INSERT … ON CONFLICT
   * DO NOTHING as `enqueue`; the caller turns null into a 409 naming the existing
   * task.
   */
  async createManual(
    kind: UploadTaskKind,
    dedupeKey: string,
    chapter: unknown,
    opts: { notBefore?: Date; maxAttempts?: number } = {},
  ): Promise<UploadTaskRow | null> {
    const rows = await this.prisma.$queryRaw<UploadTaskRow[]>(Prisma.sql`
      INSERT INTO upload_tasks (id, kind, dedupe_key, chapter, state, attempt, max_attempts,
                                not_before, created_at, updated_at)
      VALUES (${randomUUID()}, ${kind}::"UploadTaskKind", ${dedupeKey},
              ${JSON.stringify(chapter)}::jsonb, 'PENDING', 0,
              coalesce(${opts.maxAttempts ?? null}::int, 5),
              coalesce(${opts.notBefore ?? null}::timestamptz, now()), now(), now())
      ON CONFLICT (kind, dedupe_key) DO NOTHING
      RETURNING id, kind::text AS kind, dedupe_key AS "dedupeKey", state::text AS state,
                attempt, max_attempts AS "maxAttempts", not_before AS "notBefore",
                lease_id AS "leaseId", lease_expires_at AS "leaseExpiresAt",
                last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt",
                ${TASK_IDENTITY}
    `);
    return rows[0] ?? null;
  }

  /**
   * Correct a task that has not run yet.
   *
   * `expectedUpdatedAt` is optimistic concurrency: the caller read the row to
   * merge a partial chapter patch and to derive the new dedupe key in the one
   * place that logic lives (`taskDedupeKey`), so the write pins the version it
   * read. Anything that touched the row in between leaves this at zero rows,
   * which the caller reports as losing the race instead of clobbering.
   *
   * Throws P2002 on a dedupe-key collision, which the caller turns into a 409.
   */
  async patchPending(
    id: string,
    patch: {
      chapter: unknown;
      dedupeKey: string;
      notBefore?: Date;
      maxAttempts?: number;
      expectedUpdatedAt: Date;
    },
  ): Promise<boolean> {
    const res = await this.prisma.uploadTask.updateMany({
      where: { id, state: "PENDING", updatedAt: patch.expectedUpdatedAt },
      data: {
        chapter: patch.chapter as Prisma.InputJsonValue,
        dedupeKey: patch.dedupeKey,
        ...(patch.notBefore ? { notBefore: patch.notBefore } : {}),
        ...(patch.maxAttempts === undefined ? {} : { maxAttempts: patch.maxAttempts }),
      },
    });
    return res.count === 1;
  }
}

// ------------------------------------------------------------------ internals

/** Every column except `chapter`, aliased to the Prisma field names. */
const TASK_COLUMNS = Prisma.sql`t.id, t.kind::text AS kind, t.dedupe_key AS "dedupeKey",
  t.state::text AS state, t.attempt, t.max_attempts AS "maxAttempts",
  t.not_before AS "notBefore", t.lease_id AS "leaseId",
  t.lease_expires_at AS "leaseExpiresAt", t.last_error AS "lastError",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"`;

/**
 * `UploadTaskIdentity`, built in the database. One JSON object rather than eight
 * aliased columns, so the shape arrives assembled and the whole `chapter`
 * payload never crosses the wire. `chapter` is unqualified on purpose: every
 * statement this is spliced into has one table in scope, including
 * `INSERT … RETURNING`, where the `t` alias does not exist.
 */
const TASK_IDENTITY = Prisma.sql`jsonb_build_object(
  'extension', chapter->>'extensionName',
  'mangaName', chapter->>'mangaName',
  'mdMangaId', chapter->>'mdMangaId',
  'mdChapterId', chapter->>'mdChapterId',
  'chapterNumber', chapter->>'chapterNumber',
  'chapterVolume', chapter->>'chapterVolume',
  'chapterTitle', chapter->>'chapterTitle',
  'chapterLanguage', chapter->>'chapterLanguage'
) AS identity`;

/**
 * Filter predicates, parameterised. The enum comparisons keep the enum type (via
 * text[] to enum[]) rather than casting the column to text, so the
 * (state, not_before) index stays usable.
 */
function taskWhere(filter: UploadTaskFilter): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (filter.kinds && filter.kinds.length > 0) {
    parts.push(Prisma.sql`t.kind = ANY(${[...filter.kinds]}::text[]::"UploadTaskKind"[])`);
  }
  if (filter.states && filter.states.length > 0) {
    parts.push(Prisma.sql`t.state = ANY(${[...filter.states]}::text[]::"UploadTaskState"[])`);
  }
  // Parameterised, so a `%` an operator types is a wildcard they meant.
  if (filter.dedupeKey) parts.push(Prisma.sql`t.dedupe_key ILIKE ${`%${filter.dedupeKey}%`}`);
  if (filter.q) {
    const needle = `%${filter.q}%`;
    // Both MangaDex ids as well as the human-readable fields: for EDIT, DELETE
    // and UNAVAILABLE the dedupe key is the chapter id, so an operator pasting a
    // uuid has nowhere else to put it.
    parts.push(Prisma.sql`(
      t.chapter ->> 'mangaName' ILIKE ${needle}
      OR t.chapter ->> 'chapterTitle' ILIKE ${needle}
      OR t.chapter ->> 'chapterNumber' ILIKE ${needle}
      OR t.chapter ->> 'mdMangaId' ILIKE ${needle}
      OR t.chapter ->> 'mdChapterId' ILIKE ${needle}
    )`);
  }
  if (filter.attemptMin !== undefined) parts.push(Prisma.sql`t.attempt >= ${filter.attemptMin}`);
  if (filter.attemptMax !== undefined) parts.push(Prisma.sql`t.attempt <= ${filter.attemptMax}`);
  // Payload predicates read `chapter` rather than a column, so they are unindexed
  // and scan. They are only ever ANDed with the indexed kind/state predicates
  // above and only reached from an operator action on a paged view, so expression
  // indexes would be permanent write cost for a query a human runs by hand.
  if (filter.extension) {
    parts.push(Prisma.sql`t.chapter->>'extensionName' = ${filter.extension}`);
  }
  if (filter.language) {
    parts.push(Prisma.sql`t.chapter->>'chapterLanguage' = ${filter.language}`);
  }
  return parts;
}

function combine(parts: Prisma.Sql[]): Prisma.Sql {
  return parts.length > 0 ? Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}` : Prisma.empty;
}
