import { Prisma, type PrismaClient, type UploadTaskKind } from "@prisma/client";
import type { Logger } from "../../logging.js";
import { ResultEnvelope } from "../../contracts/envelope.js";
import { type MangaRecord } from "../../contracts/records.js";
import { Manifest } from "../../contracts/manifest.js";
import { uploadedChapterColumns } from "../md/chapterRows.js";
import type { DiscordEmbedInput } from "../md/webhook.js";
import {
  foundChaptersEmbed,
  noUpdatesEmbed,
  runErrorEmbed,
  untrackedMangaEmbeds,
  updatesEmbeds,
  type UntrackedMangaLike,
} from "../md/webhookEmbeds.js";
import { chapterFromRecord, type Chapter, type MdApi, type MdChapter } from "../md/types.js";
import { ExtensionConfigStore } from "../store/extensionConfig.js";
import { ResultStore } from "../store/results.js";
import { SettingsStore, type RemovalMode } from "../store/settings.js";
import { UploadTaskStore, uploadDedupeKey } from "../store/uploadTasks.js";
import {
  aggregateChapterIds,
  backfillVolumes,
  decideForManga,
  findDuplicateChapters,
  formatTitle,
  mdChapterMangaId,
  type OverrideOptionsLike,
} from "./dedupe.js";

/**
 * Turns committed result envelopes into MangaDex work.
 *
 * Runs entirely inside the core: workers never learn MangaDex credentials, they
 * only report what a publisher currently offers, and every upload/edit/delete
 * decision is made here against the live MangaDex state.
 *
 * Processing a run twice is harmless and expected. Task enqueueing is ON
 * CONFLICT DO NOTHING on (kind, dedupeKey), bookkeeping is upserts, and the run
 * only flips to PROCESSED at the end, so a crash mid-run replays cleanly.
 */

interface ClaimedRun {
  id: string;
  extension: string;
  bundleSha256: string;
  kind: "UPDATE" | "CLEAN" | "FORCE";
  /**
   * MangaDex title ids this run was deliberately limited to, empty for a run
   * over the whole catalogue.
   *
   * The distinction is not cosmetic and cannot be inferred from the envelopes.
   * `allChapters` means "this is everything the publisher has"; on a scoped run
   * it means "this is everything the publisher has FOR THESE TITLES", and is
   * silent about the rest. The catalogue-wide removal passes read silence as
   * absence, so running them against a scoped snapshot would unpublish every
   * title the run never asked about.
   */
  scopeMangaIds: string[];
}

export interface MergedResults {
  updatedChapters: Chapter[];
  /** null when any segment declined to publish a full listing. */
  allChapters: Chapter[] | null;
  untrackedManga: MangaRecord[];
  /**
   * As reported by the workers. Advisory only: the database is the source of
   * truth and processRun replaces these before use, because a worker runs a
   * pinned bundle whose view of configuration can be arbitrarily stale.
   */
  trackedMangadexIds: string[];
  overrideOptions: OverrideOptionsLike;
  languages: string[];
  groupId: string | null;
}

export interface RunProcessorOptions {
  /** Safety valve so one tick cannot monopolise the process. */
  maxRunsPerTick?: number;
  /**
   * Where the per-manga update report goes. Optional: the processor's job is
   * to decide what to upload, and it must keep doing that when Discord is not
   * configured or is failing.
   */
  notifier?: { enabled: boolean; send(embeds: DiscordEmbedInput[]): Promise<void> };
}

export class RunProcessor {
  private readonly results: ResultStore;
  private readonly tasks: UploadTaskStore;
  private readonly settings: SettingsStore;
  private readonly config: ExtensionConfigStore;
  /** manga id to title. */
  private readonly mangaNames = new Map<string, string>();
  /** Per-run aggregate cache: volume backfill and the dupe sweep share it. */
  private aggregates = new Map<string, unknown>();
  private readonly maxRunsPerTick: number;
  private readonly notifier: { enabled: boolean; send(embeds: DiscordEmbedInput[]): Promise<void> } | null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly md: MdApi,
    private readonly log: Logger,
    options: RunProcessorOptions = {},
  ) {
    this.results = new ResultStore(prisma);
    this.tasks = new UploadTaskStore(prisma);
    this.settings = new SettingsStore(prisma);
    this.config = new ExtensionConfigStore(prisma);
    this.maxRunsPerTick = options.maxRunsPerTick ?? 10;
    this.notifier = options.notifier ?? null;
  }

  /**
   * The per-manga update report, sent where the plan is decided rather than
   * after a successful upload: a channel that only hears about completed
   * uploads cannot tell "nothing new" from "the uploader is stuck".
   *
   * Failures are swallowed with a warning so a Discord outage cannot fail a run
   * whose real work already succeeded.
   */
  private async reportUpdates(
    extension: string,
    mangaId: string,
    decision: { toUpload: Chapter[]; toEdit: { chapter: Chapter }[]; skipped: Chapter[] },
  ): Promise<void> {
    if (!this.notifier?.enabled) return;
    // Nothing decided means nothing to say; a per-manga heartbeat would drown
    // the channel.
    if (decision.toUpload.length === 0 && decision.toEdit.length === 0) return;

    try {
      await this.notifier.send(
        updatesEmbeds({
          extensionName: extension,
          mangaTitle: this.mangaNames.get(mangaId) ?? mangaId,
          mdMangaId: mangaId,
          chapters: decision.toUpload,
          skipped: decision.skipped.length,
          edited: decision.toEdit.length,
        }),
      );
    } catch (err) {
      this.log.warn({ err, extension, mangaId }, "could not send the update webhook");
    }
  }

  /**
   * The run-level embeds per extension: the untracked series it found, and
   * either "Found N chapters" or "No new updates found". Swallows failures for
   * the same reason reportUpdates does.
   */
  private async reportRunSummary(
    extension: string,
    untracked: readonly UntrackedMangaLike[],
    updatedCount: number,
  ): Promise<void> {
    if (!this.notifier?.enabled) return;
    try {
      const embeds = [
        ...untrackedMangaEmbeds(extension, untracked),
        updatedCount > 0 ? foundChaptersEmbed(extension, updatedCount) : noUpdatesEmbed(extension),
      ];
      await this.notifier.send(embeds);
    } catch (err) {
      this.log.warn({ err, extension }, "could not send the run summary webhook");
    }
  }

  /** `Error in extensions.{name}`, red, with the exception in a code fence. */
  private async reportRunError(extension: string, err: unknown): Promise<void> {
    if (!this.notifier?.enabled) return;
    try {
      await this.notifier.send([runErrorEmbed(extension, err)]);
    } catch (sendErr) {
      // Never let the error reporter mask the error it was reporting.
      this.log.warn({ err: sendErr, extension }, "could not send the run error webhook");
    }
  }

  /** Process every run currently waiting in INGESTING. Returns the count. */
  async tick(): Promise<number> {
    const attempted = new Set<string>();
    let processed = 0;

    for (let i = 0; i < this.maxRunsPerTick; i++) {
      const run = await this.claimRun(attempted);
      if (!run) break;
      attempted.add(run.id);

      try {
        await this.processRun(run);
        processed++;
      } catch (err) {
        // Deliberately left in INGESTING: the next tick retries, and every
        // effect this run may already have had is idempotent.
        this.log.error({ err, runId: run.id, extension: run.extension }, "run processing failed");
        // A run that keeps failing is otherwise silent in Discord: it never
        // reaches the "Found N chapters" line, and the absence reads as "no
        // updates today".
        await this.reportRunError(run.extension, err);
      }
    }
    return processed;
  }

  /**
   * Claim the least-recently-touched INGESTING run. FOR UPDATE SKIP LOCKED
   * plus bumping updated_at means concurrent processors pick different runs;
   * it is a soft claim rather than a lease, which is safe precisely because
   * processing is idempotent.
   */
  private async claimRun(exclude: Set<string>): Promise<ClaimedRun | null> {
    const excluded = exclude.size > 0 ? [...exclude] : ["00000000-0000-0000-0000-000000000000"];
    const rows = await this.prisma.$queryRaw<ClaimedRun[]>(Prisma.sql`
      WITH candidate AS (
        SELECT id FROM runs
        WHERE state = 'INGESTING' AND id <> ALL(${excluded}::text[])
        ORDER BY updated_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE runs r
      SET updated_at = now()
      FROM candidate
      WHERE r.id = candidate.id
      RETURNING r.id, r.extension, r.bundle_sha256 AS "bundleSha256", r.kind,
                r.scope_manga_ids AS "scopeMangaIds"
    `);
    return rows[0] ?? null;
  }

  async processRun(run: ClaimedRun): Promise<void> {
    const log = this.log.child({ runId: run.id, extension: run.extension });
    this.aggregates = new Map();

    const { envelopes, missingJobs } = await this.loadEnvelopes(run.id, log);

    // A clean run decides what to DELETE from a "the publisher no longer has
    // this" premise. Acting on a partial view would remove chapters that a
    // missing segment would have vouched for, so refuse and stay in INGESTING.
    if (missingJobs > 0 && run.kind === "CLEAN") {
      log.error({ missingJobs }, "clean run is missing committed segments; refusing to process");
      return;
    }
    if (envelopes.length === 0) {
      log.warn("no committed envelopes for run; nothing to process");
      await this.markProcessed(run.id, log);
      return;
    }

    const merged = mergeEnvelopes(envelopes, run.extension);
    // Configuration authority lives in the database, not in worker output.
    // Override options come from extension_configs, and the tracked-manga set
    // is the union of what the database knows (including titles auto-created
    // since this run started) with what the worker reported.
    merged.overrideOptions = await this.loadOverrideOptions(run.extension);
    merged.trackedMangadexIds = await this.authoritativeTrackedIds(
      run.extension,
      merged.trackedMangadexIds,
    );

    const manifest = await this.loadManifest(run.bundleSha256);
    const groupId = merged.groupId ?? manifest?.mangadex_group_id ?? null;
    if (!groupId) {
      log.error("no mangadex group id in envelopes or manifest; cannot process run");
      return;
    }
    const removalMode: RemovalMode =
      manifest?.chapter_removal_mode ?? (await this.settings.getRemovalMode());

    await this.persistUntrackedManga(run.extension, merged.untrackedManga, log);

    const scope = new Set(run.scopeMangaIds);
    const scoped = scope.size > 0;

    // Without this the channel only hears about individual uploads, which says
    // nothing on a run that found nothing.
    //
    // Except on a scoped run: "no updates from mangaplus" is a claim about the
    // extension's sweep, and an operator probing one series has not made it.
    // The removals this run queues still announce themselves as they upload.
    if (scoped) {
      log.info(
        { scope: [...scope], updated: merged.updatedChapters.length },
        "scoped run: not announcing a run summary for a probe of part of the catalogue",
      );
    } else {
      await this.reportRunSummary(run.extension, merged.untrackedManga, merged.updatedChapters.length);
    }

    const updatedByManga = groupByMdManga(merged.updatedChapters);
    const allByManga = merged.allChapters === null ? null : groupByMdManga(merged.allChapters);
    const trackedIds = new Set(merged.trackedMangadexIds);

    // The scope is included even where it has no updates: a removal queued for
    // a dormant title still prints the title's name on its card, and an
    // unresolved name would put a blank there.
    await this.resolveMangaNames([...new Set([...updatedByManga.keys(), ...scope])]);
    applyMangaNames(updatedByManga, this.mangaNames);
    if (allByManga) applyMangaNames(allByManga, this.mangaNames);

    // Every MangaDex chapter seen this run, keyed by manga.
    const chaptersOnMdByManga = new Map<string, MdChapter[]>();
    const totals = { upload: 0, edit: 0, skip: 0, remove: 0 };

    // Normally the manga worth visiting are the ones with updates: with no new
    // chapter there is nothing to upload, and a run that reported no snapshot
    // has nothing to remove either.
    //
    // A scoped run is the exception, and it is the whole point of one. "Is this
    // series still on the publisher?" is asked precisely about series that have
    // published nothing lately, and the answer lives in `allChapters`, not in
    // the updates. Visiting the scope regardless is what lets a re-check of a
    // dormant title find the chapters that were pulled from under it.
    const visiting: [string, Chapter[]][] = [...updatedByManga];
    if (scoped) {
      for (const mangaId of scope) {
        if (!updatedByManga.has(mangaId)) visiting.push([mangaId, []]);
      }
    }

    for (const [mangaId, updatedChapters] of visiting) {
      const chaptersOnMd = await this.md.chaptersForManga(mangaId, groupId);
      for (const mdChapter of chaptersOnMd) {
        const owner = mdChapterMangaId(mdChapter) ?? mangaId;
        const bucket = chaptersOnMdByManga.get(owner);
        if (bucket) bucket.push(mdChapter);
        else chaptersOnMdByManga.set(owner, [mdChapter]);
      }

      backfillVolumes(updatedChapters, await this.aggregateFor(mangaId, groupId));

      const decision = decideForManga({
        mangadexMangaId: mangaId,
        updatedChapters,
        allMangaChapters: allByManga === null ? null : (allByManga.get(mangaId) ?? []),
        chaptersOnMd,
        // Uploads happen asynchronously off the UploadTask queue, so nothing has
        // been posted to MangaDex by the time this run is processed.
        postedMdUpdates: [],
        overrideOptions: merged.overrideOptions,
        languages: merged.languages,
        groupId,
        cleanDb: run.kind === "CLEAN",
      });

      for (const chapter of decision.toUpload) {
        await this.tasks.enqueue("UPLOAD", uploadDedupeKey(chapter), chapter);
      }
      for (const edit of decision.toEdit) {
        await this.tasks.enqueue("EDIT", edit.mdChapterId, {
          ...edit.chapter,
          oldInfo: edit.oldInfo,
          payload: edit.payload,
        });
      }
      await this.enqueueRemovals(decision.toRemove, mangaId, run.extension, groupId, removalMode);
      await this.recordUploaded(
        [...decision.toEdit.map((edit) => edit.chapter), ...decision.skipped],
        run.extension,
      );

      totals.upload += decision.toUpload.length;
      totals.edit += decision.toEdit.length;
      totals.skip += decision.skipped.length;
      totals.remove += decision.toRemove.length;

      if (decision.skippedDifferentId.length > 0) {
        log.debug(
          { mangaId, count: decision.skippedDifferentId.length },
          "chapters already uploaded under their master id (same override)",
        );
      }
      log.info(
        {
          mangaId,
          mangaName: this.mangaNames.get(mangaId) ?? null,
          upload: decision.toUpload.length,
          edit: decision.toEdit.length,
          skipped: decision.skipped.length,
          remove: decision.toRemove.length,
        },
        "manga processed",
      );
    }

    // "Untracked" is derived from the union of every segment's tracked ids, so
    // a segment that never committed could make a perfectly tracked manga look
    // orphaned. Only run the pass on a complete picture — and a scoped run is
    // never a complete picture by construction.
    if (scoped) {
      log.info(
        { scope: [...scope] },
        "scoped run: skipping the catalogue-wide cleanup passes, which this run's snapshot cannot support",
      );
    } else if (missingJobs === 0) {
      totals.remove += await this.removeUntrackedManga(
        chaptersOnMdByManga,
        trackedIds,
        run.extension,
        groupId,
        removalMode,
        log,
      );
    } else {
      log.warn({ missingJobs }, "skipping untracked-manga cleanup: incomplete segment coverage");
    }

    if (!scoped && run.kind === "CLEAN" && allByManga !== null) {
      totals.remove += await this.removeMangaWithoutExternalChapters(
        merged.trackedMangadexIds,
        allByManga,
        run.extension,
        groupId,
        removalMode,
        log,
      );
    }

    const dupes = await this.deleteDuplicates(
      run,
      merged,
      // Same reason: on a scoped run the tracked-id fallback below would walk
      // the whole catalogue looking for duplicates the run never looked at.
      scoped ? new Map(visiting) : updatedByManga,
      groupId,
      log,
    );

    log.info({ ...totals, dupes }, "run processed");
    await this.markProcessed(run.id, log);
  }

  // -- envelope loading -----------------------------------------------------

  private async loadEnvelopes(
    runId: string,
    log: Logger,
  ): Promise<{ envelopes: ResultEnvelope[]; missingJobs: number }> {
    const jobs = await this.prisma.job.findMany({
      where: { runId },
      orderBy: { segmentIndex: "asc" },
    });

    const envelopes: ResultEnvelope[] = [];
    let missingJobs = 0;
    for (const job of jobs) {
      const submission = await this.results.committedForJob(job.id);
      if (!submission) {
        missingJobs++;
        log.warn({ jobId: job.id, segmentKey: job.segmentKey }, "job has no committed envelope");
        continue;
      }
      const parsed = ResultEnvelope.safeParse(submission.envelope);
      if (!parsed.success) {
        // Ingestion already validated this, so a failure here means the stored
        // row was tampered with or the schema moved under us.
        missingJobs++;
        log.error({ jobId: job.id }, "committed envelope no longer parses");
        continue;
      }
      envelopes.push(parsed.data);
    }
    return { envelopes, missingJobs };
  }

  private async loadManifest(bundleSha256: string): Promise<Manifest | null> {
    const bundle = await this.prisma.bundle.findUnique({ where: { sha256: bundleSha256 } });
    if (!bundle) return null;
    const parsed = Manifest.safeParse(bundle.manifest);
    return parsed.success ? parsed.data : null;
  }

  // -- configuration (database is the source of truth) ----------------------

  /**
   * Override options as the operator has them, not as the worker reported them.
   * A worker's copy of the config can be arbitrarily old, and override options
   * decide what counts as a duplicate and which languages may stay on MangaDex,
   * so taking them from worker output would let a compromised worker steer
   * deletions.
   *
   * The three relations the decision logic reads are typed tables, so a row
   * that exists is one the write path already accepted and nothing needs
   * validating here.
   */
  private async loadOverrideOptions(extension: string): Promise<OverrideOptionsLike> {
    return this.config.loadForProcessor(extension);
  }

  /**
   * The tracked MangaDex manga for this extension: everything in tracked_manga
   * plus whatever the worker reported. The union matters in both directions:
   * the database may hold titles auto-created after the worker started, and the
   * worker may know of manga not recorded yet. Anything missing from this set
   * is treated as untracked and its chapters removed, so it errs towards
   * including too much.
   */
  private async authoritativeTrackedIds(
    extension: string,
    reportedByWorkers: string[],
  ): Promise<string[]> {
    const rows = await this.prisma.trackedManga.findMany({
      where: { extension },
      select: { mdMangaId: true },
      distinct: ["mdMangaId"],
    });
    return [...new Set([...rows.map((row) => row.mdMangaId), ...reportedByWorkers])];
  }

  /**
   * Untracked manga are queued for the title service, which creates the
   * MangaDex title and records it in tracked_manga. Anything already tracked
   * for this extension is dropped: the worker only knows the manga has no
   * MangaDex id in ITS config copy, which is exactly the state a
   * just-auto-created title leaves behind.
   */
  private async persistUntrackedManga(
    extension: string,
    untracked: MangaRecord[],
    log: Logger,
  ): Promise<void> {
    if (untracked.length === 0) return;

    const mangaIds = [...new Set(untracked.map((manga) => manga.mangaId))];
    const tracked = await this.prisma.trackedManga.findMany({
      where: { extension, mangaId: { in: mangaIds } },
      select: { mangaId: true },
    });
    const trackedIds = new Set(tracked.map((row) => row.mangaId));

    const rows = untracked
      .filter((manga) => !trackedIds.has(manga.mangaId))
      .map((manga) => ({
        extension,
        mangaId: manga.mangaId,
        mangaName: manga.mangaName,
        mangaLanguage: manga.mangaLanguage,
        mangaUrl: manga.mangaUrl,
        state: "NEW" as const,
      }));
    if (rows.length === 0) {
      log.info({ untracked: untracked.length }, "all untracked manga are already tracked");
      return;
    }

    // skipDuplicates on (extension, mangaId, mangaLanguage): a manga already
    // queued keeps its existing row, including any state the title service
    // has moved it to.
    const created = await this.prisma.untrackedManga.createMany({ data: rows, skipDuplicates: true });
    log.info(
      { reported: untracked.length, queued: created.count },
      "queued untracked manga for title creation",
    );
  }

  // -- MangaDex helpers -----------------------------------------------------

  private async aggregateFor(mangaId: string, groupId: string): Promise<unknown> {
    const cached = this.aggregates.get(mangaId);
    if (cached !== undefined) return cached;
    const aggregate = await this.md.mangaAggregate(mangaId, groupId);
    this.aggregates.set(mangaId, aggregate);
    return aggregate;
  }

  /** Titles for manga ids we have not seen before. */
  private async resolveMangaNames(ids: string[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => id && !this.mangaNames.has(id));
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const manga = await this.md.mangaByIds(chunk);
      for (const entry of manga) this.mangaNames.set(entry.id, formatTitle(entry));
    }
  }

  // -- writes ---------------------------------------------------------------

  /**
   * The canonical record of what this extension has on MangaDex. Chapters
   * without an md chapter id are skipped: there is nothing to key them on.
   */
  private async recordUploaded(chapters: Chapter[], extension: string): Promise<void> {
    for (const chapter of chapters) {
      if (!chapter.mdChapterId) continue;

      // The run's extension is authoritative over whatever the envelope named.
      const columns = { ...uploadedChapterColumns(chapter), extension };
      await this.prisma.uploadedChapter.upsert({
        where: { mdChapterId: chapter.mdChapterId },
        create: { mdChapterId: chapter.mdChapterId, ...columns },
        update: columns,
      });

      // uploaded_ids is insert-only: the FIRST MangaDex chapter an extension
      // chapter id mapped to is the one that stays recorded.
      if (chapter.chapterId) {
        await this.prisma.uploadedId.upsert({
          where: { extension_chapterId: { extension, chapterId: chapter.chapterId } },
          create: { extension, chapterId: chapter.chapterId, mdChapterId: chapter.mdChapterId },
          update: {},
        });
      }
    }
  }

  /**
   * Route chapters that should leave MangaDex to either the hard-delete queue
   * or the "replace with an unavailable card" queue, and drop them from the
   * uploaded bookkeeping so nothing re-queues them later.
   */
  private async enqueueRemovals(
    mdChapters: MdChapter[],
    mdMangaId: string,
    extension: string,
    groupId: string,
    mode: RemovalMode,
  ): Promise<void> {
    if (mdChapters.length === 0) return;
    const kind: UploadTaskKind = mode === "delete" ? "DELETE" : "UNAVAILABLE";
    const mangaName = this.mangaNames.get(mdMangaId) ?? null;

    for (const mdChapter of mdChapters) {
      await this.tasks.enqueue(
        kind,
        mdChapter.id,
        chapterFromMdChapter(mdChapter, { mdMangaId, extension, groupId, mangaName, mode }),
      );
      await this.prisma.uploadedChapter.deleteMany({ where: { mdChapterId: mdChapter.id } });
    }
  }

  private async markProcessed(runId: string, log: Logger): Promise<void> {
    const done = await this.prisma.run.updateMany({
      where: { id: runId, state: "INGESTING" },
      data: { state: "PROCESSED", completedAt: new Date() },
    });
    if (done.count !== 1) log.warn("run was no longer INGESTING when processing finished");
  }

  // -- cleanup passes -------------------------------------------------------

  /**
   * Chapters published under our group for a manga the extension no longer
   * tracks. The candidate set is small in practice, because every manga reached
   * here came from the extension's own updates.
   */
  private async removeUntrackedManga(
    chaptersOnMdByManga: Map<string, MdChapter[]>,
    trackedIds: Set<string>,
    extension: string,
    groupId: string,
    mode: RemovalMode,
    log: Logger,
  ): Promise<number> {
    const untracked = [...chaptersOnMdByManga.keys()].filter((id) => !trackedIds.has(id));
    if (untracked.length === 0) return 0;

    log.info({ untracked }, "manga on MangaDex under our group that the extension no longer tracks");
    await this.resolveMangaNames(untracked);

    let removed = 0;
    for (const mangaId of untracked) {
      const mdChapters = chaptersOnMdByManga.get(mangaId) ?? [];
      await this.enqueueRemovals(mdChapters, mangaId, extension, groupId, mode);
      removed += mdChapters.length;
    }
    return removed;
  }

  /**
   * Clean runs only: tracked manga for which the publisher listed no chapters
   * at all, but which still have chapters on MangaDex under our group.
   */
  private async removeMangaWithoutExternalChapters(
    trackedIds: string[],
    allByManga: Map<string, Chapter[]>,
    extension: string,
    groupId: string,
    mode: RemovalMode,
    log: Logger,
  ): Promise<number> {
    const candidates = [...new Set(trackedIds)].filter((id) => !allByManga.has(id));
    if (candidates.length === 0) return 0;

    let removed = 0;
    const removedFrom: string[] = [];
    for (const mangaId of candidates) {
      const mdChapters = await this.md.chaptersForManga(mangaId, groupId);
      if (mdChapters.length === 0) continue;
      await this.resolveMangaNames([mangaId]);
      await this.enqueueRemovals(mdChapters, mangaId, extension, groupId, mode);
      removed += mdChapters.length;
      removedFrom.push(mangaId);
    }
    if (removedFrom.length > 0) {
      log.info({ manga: removedFrom }, "removing chapters on MangaDex but no longer on the publisher");
    }
    return removed;
  }

  /**
   * Duplicates are always hard-deleted, whatever the removal mode: an
   * "unavailable" card on a duplicate would leave the duplicate in place.
   */
  private async deleteDuplicates(
    run: ClaimedRun,
    merged: MergedResults,
    updatedByManga: Map<string, Chapter[]>,
    groupId: string,
    log: Logger,
  ): Promise<number> {
    const mangaIds =
      run.scopeMangaIds.length > 0
        ? run.scopeMangaIds
        : run.kind === "CLEAN"
          ? merged.trackedMangadexIds
          : updatedByManga.size > 0
            ? [...updatedByManga.keys()]
            : merged.trackedMangadexIds;

    const languages = new Set(merged.languages);
    const multiChapters = merged.overrideOptions.multi_chapters ?? {};
    let deleted = 0;

    for (const mangaId of new Set(mangaIds)) {
      const chapterIds = aggregateChapterIds(await this.aggregateFor(mangaId, groupId));
      if (chapterIds.length === 0) continue;

      const chapters = await this.md.chaptersByIds([...new Set(chapterIds)]);
      // The aggregate request cannot filter by language, so the filter is
      // applied to the fetched chapters.
      const inLanguage =
        languages.size > 0
          ? chapters.filter((c) => languages.has(c.attributes.translatedLanguage))
          : chapters;


      const dupes = findDuplicateChapters(inLanguage, { groupId, multiChapters });
      if (dupes.length === 0) continue;

      log.info({ mangaId, dupes: dupes.map((c) => c.id) }, "found duplicate chapters to delete");
      await this.resolveMangaNames([mangaId]);
      await this.enqueueRemovals(dupes, mangaId, run.extension, groupId, "delete");
      deleted += dupes.length;
    }
    return deleted;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Segments of one run cover disjoint sets of manga, so their chapter lists
 * concatenate. `allChapters` is the exception: it means "this is everything
 * the publisher has", and a single segment that declined to answer makes the
 * merged view incomplete, which would turn the removal passes into mass
 * deletions. Any null therefore collapses the whole thing to null.
 */
export function mergeEnvelopes(envelopes: ResultEnvelope[], extension: string): MergedResults {
  const updatedChapters: Chapter[] = [];
  const allChapters: Chapter[] = [];
  let allChaptersComplete = true;
  const untrackedManga = new Map<string, MangaRecord>();
  const trackedMangadexIds = new Set<string>();
  let overrideOptions: OverrideOptionsLike = {};
  let languages: string[] = [];
  let groupId: string | null = null;

  for (const envelope of envelopes) {
    for (const record of envelope.updatedChapters) {
      updatedChapters.push(chapterFromRecord(record, extension));
    }
    if (envelope.allChapters === null) {
      allChaptersComplete = false;
    } else {
      for (const record of envelope.allChapters) {
        allChapters.push(chapterFromRecord(record, extension));
      }
    }
    for (const manga of envelope.untrackedManga) untrackedManga.set(manga.mangaId, manga);
    for (const id of envelope.trackedMangadexIds) trackedMangadexIds.add(id);

    // Identical across segments of a run; first non-empty wins.
    if (Object.keys(envelope.overrideOptions).length > 0 && Object.keys(overrideOptions).length === 0) {
      overrideOptions = envelope.overrideOptions as OverrideOptionsLike;
    }
    if (envelope.extensionLanguages.length > 0 && languages.length === 0) {
      languages = envelope.extensionLanguages;
    }
    groupId ??= envelope.mangadexGroupId;
  }

  return {
    updatedChapters,
    allChapters: allChaptersComplete ? allChapters : null,
    untrackedManga: [...untrackedManga.values()],
    trackedMangadexIds: [...trackedMangadexIds],
    overrideOptions,
    languages,
    groupId,
  };
}

/** Chapters without a MangaDex manga id are dropped. */
function groupByMdManga(chapters: Chapter[]): Map<string, Chapter[]> {
  const sorted = new Map<string, Chapter[]>();
  for (const chapter of chapters) {
    const mdMangaId = chapter.mdMangaId;
    if (!mdMangaId || mdMangaId === "None") continue;
    const bucket = sorted.get(mdMangaId);
    if (bucket) bucket.push(chapter);
    else sorted.set(mdMangaId, [chapter]);
  }
  return sorted;
}

/** The MangaDex title wins over whatever the extension called the manga. */
function applyMangaNames(byManga: Map<string, Chapter[]>, names: Map<string, string>): void {
  for (const [mangaId, chapters] of byManga) {
    const name = names.get(mangaId);
    if (!name) continue;
    for (const chapter of chapters) chapter.mangaName = name;
  }
}

/**
 * The md-chapter to Chapter conversion for removals. `unavailableAt` rides
 * along on the queued JSON for the unavailable worker, which stamps it on the
 * generated chapter card.
 *
 * `chapterTimestamp` and `chapterExpire` are null: removal is queue-driven and
 * the uploaded row is deleted outright, so a sentinel date would only mislead.
 */
export function chapterFromMdChapter(
  mdChapter: MdChapter,
  context: {
    mdMangaId: string;
    extension: string;
    groupId: string;
    mangaName: string | null;
    mode: RemovalMode;
  },
): Chapter & { unavailableAt?: string } {
  const attrs = mdChapter.attributes;
  const now = new Date().toISOString();

  const chapter: Chapter & { unavailableAt?: string } = {
    chapterLookup: now,
    chapterTimestamp: null,
    chapterExpire: null,
    chapterLanguage: attrs.translatedLanguage,
    chapterNumber: attrs.chapter,
    chapterTitle: attrs.title,
    chapterVolume: attrs.volume,
    chapterId: null,
    chapterUrl: attrs.externalUrl,
    mdChapterId: mdChapter.id,
    mangaId: null,
    mdMangaId: context.mdMangaId,
    mdGroupId: context.groupId,
    mangaName: context.mangaName,
    mangaUrl: null,
    extensionName: context.extension,
    imageArtifacts: [],
  };
  if (context.mode === "unavailable") chapter.unavailableAt = now;
  return chapter;
}
