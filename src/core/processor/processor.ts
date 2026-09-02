import { Prisma, type PrismaClient, type UploadTaskKind } from "@prisma/client";
import type { Logger } from "../../logging.js";
import { ResultEnvelope } from "../../contracts/envelope.js";
import { type MangaRecord } from "../../contracts/records.js";
import { Manifest } from "../../contracts/manifest.js";
import { chapterFromMdChapter, uploadedChapterColumns } from "../md/chapterRows.js";
import type { DiscordEmbedInput } from "../md/webhook.js";
import {
  foundChaptersEmbed,
  noUpdatesEmbed,
  runErrorEmbed,
  untrackedMangaEmbeds,
  updatesEmbeds,
  type UntrackedMangaLike,
} from "../md/webhookEmbeds.js";
import { chapterFromRecord, uploaderId, type Chapter, type MdApi, type MdChapter } from "../md/types.js";
import { ChapterCollisionStore, type CollisionRecord } from "../store/chapterCollisions.js";
import { ExtensionConfigStore } from "../store/extensionConfig.js";
import { ResultStore } from "../store/results.js";
import { activeTrackedTitles } from "../store/trackedManga.js";
import { AuditLog, SettingsStore, type RemovalMode } from "../store/settings.js";
import { UploadTaskStore, uploadDedupeKey } from "../store/uploadTasks.js";
import { intervalMsOf, planUploadSchedule, summariseSchedule } from "./uploadSchedule.js";
import {
  aggregateChapterIds,
  backfillVolumes,
  decideForManga,
  findDuplicateChapters,
  formatTitle,
  mdChapterMangaId,
  type NumberCollision,
  type OverrideOptionsLike,
} from "./dedupe.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * Which pass decided a removal.
 *
 * Recorded on every audited removal because the passes fail in different ways
 * and the distinction is invisible afterwards: `duplicates` hard-deletes
 * whatever the removal mode, `no-longer-listed` acts on the publisher's
 * catalogue, and the two untracked passes act on a series leaving the tracked
 * map entirely. "132 chapters were deleted" is not an answerable complaint
 * without it.
 */
export type RemovalPass =
  | "no-longer-listed"
  | "duplicates"
  | "manga-untracked"
  | "manga-without-external-chapters";

export interface MergedResults {
  updatedChapters: Chapter[];
  /** null when any segment declined to publish a full listing. */
  allChapters: Chapter[] | null;
  untrackedManga: MangaRecord[];
  /**
   * External manga ids no segment could read this run.
   *
   * The removal passes treat absence from `allChapters` as "the publisher
   * dropped it", so a title the publisher never answered about has to be held
   * out of that judgement explicitly. Without this, isolating a per-title fetch
   * failure would unpublish the title's whole back catalogue -- strictly worse
   * than the dead-lettered run the isolation was meant to prevent.
   */
  failedManga: string[];
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
  /**
   * The MangaDex user publoader uploads as. Every removal pass is gated on it.
   *
   * Omitted, nothing can be shown to belong to us and no chapter is removed:
   * the passes go quiet instead of acting on unverified ownership. That is the
   * intended direction -- a missed removal is retried on the next run; a
   * chapter deleted from somebody else's account is gone.
   */
  botUserId?: string | null;
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
  private readonly botUserId: string | null;
  private readonly audit: AuditLog;
  private readonly collisions: ChapterCollisionStore;

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
    this.audit = new AuditLog(prisma);
    this.collisions = new ChapterCollisionStore(prisma);
    this.maxRunsPerTick = options.maxRunsPerTick ?? 10;
    this.notifier = options.notifier ?? null;
    this.botUserId = options.botUserId ?? null;
    if (!this.botUserId) {
      this.log.error(
        "no MangaDex bot user id configured: every removal pass is disabled. " +
          "Set MANGADEX_BOT_USER_ID, or use a personal client id that embeds it.",
      );
    }
  }

  /**
   * Persist the number collisions a manga's decision turned up, and say so in
   * the log.
   *
   * Swallowed on failure, with a warning. This is an observation about work the
   * run has already decided to do; losing the note is worth far less than
   * failing a run whose uploads are correct.
   */
  private async recordCollisions(
    collisions: NumberCollision[],
    runId: string,
    extension: string,
    mangaId: string,
  ): Promise<void> {
    if (collisions.length === 0) return;

    const records: CollisionRecord[] = collisions.map(({ chapter, language, existing }) => ({
      extension,
      chapterId: chapter.chapterId,
      chapterUrl: chapter.chapterUrl,
      mdMangaId: chapter.mdMangaId || mangaId,
      mangaName: this.mangaNames.get(mangaId) ?? chapter.mangaName ?? null,
      chapterNumber: chapter.chapterNumber,
      chapterLanguage: language,
      existing: existing.map((mdChapter) => ({
        mdChapterId: mdChapter.id,
        chapterUrl: mdChapter.attributes.externalUrl ?? null,
        chapterTitle: mdChapter.attributes.title ?? null,
        createdAt: (mdChapter.attributes as { createdAt?: string }).createdAt ?? null,
      })),
      runId,
    }));

    try {
      await this.collisions.record(records);
      this.log.warn(
        {
          extension,
          mangaId,
          mangaName: this.mangaNames.get(mangaId) ?? mangaId,
          collisions: records.length,
          numbers: records.map((r) => `${r.chapterNumber ?? "?"} (${r.chapterLanguage})`),
        },
        "uploading onto chapter numbers our group already holds; uploads not blocked, " +
          "see the Chapters > Collisions tab",
      );
    } catch (err) {
      this.log.warn({ err, extension, mangaId }, "could not record number collisions");
    }
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

  /**
   * Carded chapters the publisher is listing again.
   *
   * Nothing else notices these. `findExtraChapters` skips anything already
   * carded -- it has to, because carding repoints `externalUrl` away from the
   * publisher's chapter, so a carded chapter looks unlisted on every later run
   * and would be re-queued forever. The cost of that exclusion is that carding
   * is one-way: once a chapter is carded, no pass ever asks about it again.
   *
   * So a chapter the publisher takes down and later re-opens keeps its card
   * indefinitely, showing readers "no longer available" over something they can
   * read. MangaPlus re-opens chapters for events routinely; a single sweep
   * found 36 in that state, against 74 carded by an actual misjudgement.
   *
   * This only REPORTS. Removing the card is a different problem and currently
   * an unsolved one -- MangaDex accepts the commit that would do it and changes
   * nothing -- so queueing restores here would just fill the dead-letter queue.
   * Naming them is what lets somebody act when that is fixed.
   */
  private async reportRevivedChapters(
    extension: string,
    listing: Chapter[] | null,
    log: Logger,
  ): Promise<void> {
    // No catalogue, no evidence: an UPDATE run's listing is null, and absence
    // from a partial one means nothing.
    if (listing === null) return;

    const listed = new Set<string>();
    for (const chapter of listing) {
      if (chapter.chapterUrl) listed.add(chapter.chapterUrl);
    }
    if (listed.size === 0) return;

    const carded = await this.prisma.unavailableChapter.findMany({
      where: { extension, chapterUrl: { not: null } },
      select: {
        mdChapterId: true,
        chapterUrl: true,
        chapterNumber: true,
        chapterLanguage: true,
        mangaName: true,
      },
    });

    const revived = carded.filter((row) => row.chapterUrl && listed.has(row.chapterUrl));
    if (revived.length === 0) return;

    log.warn(
      {
        extension,
        revived: revived.length,
        carded: carded.length,
        // Capped: the count is the alarm, and the whole list belongs in a
        // query rather than in one log line.
        sample: revived.slice(0, 20).map((row) => ({
          mdChapterId: row.mdChapterId,
          manga: row.mangaName,
          language: row.chapterLanguage,
          chapter: row.chapterNumber,
        })),
      },
      "carded chapters are listed by the publisher again; their cards are now wrong",
    );
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
      // Once per run, not once per attempt. Processing is not resumable: an
      // interrupted run stays in INGESTING and the next tick starts it again
      // from the top. A restart mid-run is ordinary -- a deploy causes one --
      // and this line re-announced the same run four times in an evening.
      //
      // The conditional update IS the claim: whoever flips it from null sends,
      // so two processors racing the same run still announce once.
      const claimed = await this.prisma.run.updateMany({
        where: { id: run.id, summaryNotifiedAt: null },
        data: { summaryNotifiedAt: new Date() },
      });
      if (claimed.count === 1) {
        await this.reportRunSummary(
          run.extension,
          merged.untrackedManga,
          merged.updatedChapters.length,
        );
      } else {
        log.info("run summary already announced; not repeating it for this attempt");
      }
    }

    const updatedByManga = groupByMdManga(merged.updatedChapters);
    const allByManga = merged.allChapters === null ? null : groupByMdManga(merged.allChapters);
    const failedMdIds = await this.failedMdMangaIds(run.extension, merged.failedManga);
    if (merged.failedManga.length > 0) {
      // Named rather than counted: a title that fails every run is a series to
      // untrack or an extension bug, and neither is visible from a bare count.
      log.warn(
        {
          failed: merged.failedManga.length,
          resolved: failedMdIds.size,
          mangaIds: merged.failedManga.slice(0, 20),
        },
        "extension could not read some titles this run; skipping their removal pass",
      );
    }
    const trackedIds = new Set(merged.trackedMangadexIds);
    // Judged once over the whole run: see `extensionPublishesPages`. Read off
    // the updates, which are the only chapters a run actually fetches — a
    // catalogue listing never carries images even for an extension whose every
    // chapter has them.
    const extensionPublishesPages = merged.updatedChapters.some(
      (chapter) => chapter.imageArtifacts.length > 0,
    );

    // Normally the manga worth visiting are the ones with updates: with no new
    // chapter there is nothing to upload, and a run that reported no snapshot
    // has nothing to remove either.
    //
    // Both exceptions are the same observation from opposite ends. "Is this
    // series still on the publisher?" is asked precisely about series that have
    // published nothing lately, so the answer lives in `allChapters` and never
    // in the updates. A title that lost half its back catalogue while gaining
    // no new chapter appears in both lists exactly as it did before, and is
    // invisible to a pass that only walks the updates.
    //
    // A scoped run covers that by visiting its scope regardless — that is the
    // whole point of one. An unscoped CLEAN run covers it by visiting every
    // title its own snapshot names: there, `allChapters` really is "everything
    // the publisher has", which is the same licence the two catalogue-wide
    // passes below run on. Without this the extension-wide re-check could only
    // ever notice a series the publisher dropped *entirely* (that case is
    // `removeMangaWithoutExternalChapters`, which keys off absence from the
    // snapshot) and would silently pass over every partial removal.
    //
    // The extra MangaDex reads are one `chaptersForManga` per title in the
    // snapshot. A CLEAN run already pays per-title MangaDex cost of the same
    // order in `deleteDuplicates`, which walks every tracked id.
    const visiting: [string, Chapter[]][] = [...updatedByManga];
    if (scoped) {
      for (const mangaId of scope) {
        if (!updatedByManga.has(mangaId)) visiting.push([mangaId, []]);
      }
    } else if (run.kind === "CLEAN" && allByManga !== null) {
      for (const mangaId of allByManga.keys()) {
        if (!updatedByManga.has(mangaId)) visiting.push([mangaId, []]);
      }
    }

    // Names are resolved over everything that will be visited, not just what
    // had updates: a removal queued for a dormant title still prints the
    // title's name on its card, and an unresolved name would put a blank there.
    await this.resolveMangaNames([
      ...new Set([...visiting.map(([mangaId]) => mangaId), ...scope]),
    ]);
    applyMangaNames(updatedByManga, this.mangaNames);
    if (allByManga) applyMangaNames(allByManga, this.mangaNames);

    // Every MangaDex chapter seen this run, keyed by manga.
    const chaptersOnMdByManga = new Map<string, MdChapter[]>();
    // `visited` is the one that answers "did the re-check actually look at this
    // catalogue, or just at the handful of series with new chapters?" — a
    // question the per-manga lines below cannot answer once they are quiet.
    const totals = { visited: 0, upload: 0, edit: 0, skip: 0, remove: 0, unfetchable: 0 };
    /** Every chapter this run decided to upload, queued after the loop. */
    const pendingUploads: Chapter[] = [];

    for (const [mangaId, updatedChapters] of visiting) {
      const chaptersOnMd = await this.md.chaptersForManga(mangaId, groupId);
      for (const mdChapter of chaptersOnMd) {
        const owner = mdChapterMangaId(mdChapter) ?? mangaId;
        const bucket = chaptersOnMdByManga.get(owner);
        if (bucket) bucket.push(mdChapter);
        else chaptersOnMdByManga.set(owner, [mdChapter]);
      }

      // A title the run could not read gets null, the same "no removal
      // information" this passes for a run that published no catalogue at all.
      // Letting it fall through to `?? []` would say the publisher holds
      // nothing for this series and unpublish every chapter of it, on the
      // strength of a request that failed.
      const allMangaChapters =
        allByManga === null || failedMdIds.has(mangaId)
          ? null
          : (allByManga.get(mangaId) ?? []);

      // Both arrays, because on a CLEAN run `decideCandidates` uploads chapters
      // that are in the listing and not in the updates, and backfilling only
      // the updates left exactly those with no volume.
      const needVolumes = [...updatedChapters, ...(allMangaChapters ?? [])];
      backfillVolumes(needVolumes, await this.aggregateFor(mangaId, groupId));
      // Our own group's aggregate is empty for a title we are uploading to for
      // the first time, and some publishers (comikey, for one) expose no volume
      // metadata at all, so those chapters would go up with no volume forever.
      // Everyone else's chapter-to-volume mapping for the same work is the best
      // remaining evidence, so fall back to the unscoped aggregate — but only
      // for what is still missing, and only when something still is, to keep
      // this off the hot path for the titles that were already answered.
      if (needVolumes.some((chapter) => chapter.chapterVolume === null)) {
        backfillVolumes(needVolumes, await this.aggregateFor(mangaId, ""));
      }

      const decision = decideForManga({
        mangadexMangaId: mangaId,
        updatedChapters,
        allMangaChapters,
        chaptersOnMd,
        // Uploads happen asynchronously off the UploadTask queue, so nothing has
        // been posted to MangaDex by the time this run is processed.
        postedMdUpdates: [],
        overrideOptions: merged.overrideOptions,
        languages: merged.languages,
        groupId,
        cleanDb: run.kind === "CLEAN",
        extensionPublishesPages,
        botUserId: this.botUserId,
      });

      // Recorded, not acted on. These uploads go ahead exactly as decided; the
      // row is so a person can see that a number we were about to publish was
      // already taken, which is the only signal that would have caught the
      // comikey re-upload while the url check was quietly returning false.
      await this.recordCollisions(decision.numberCollisions, run.id, run.extension, mangaId);

      // Held rather than queued here: the release schedule caps how many
      // chapters a day takes across every series, which cannot be decided one
      // series at a time. Queued together once the loop has seen them all.
      pendingUploads.push(...decision.toUpload);
      for (const edit of decision.toEdit) {
        await this.tasks.enqueue(
          "EDIT",
          edit.mdChapterId,
          {
            ...edit.chapter,
            oldInfo: edit.oldInfo,
            payload: edit.payload,
          },
          // The EDIT queue's own pace, read per kind: an edit is one PUT and
          // has no reason to crawl at the rate an image upload needs, nor to
          // spend the allowance the upload queue is counting.
          { spacingSeconds: await this.spacingFor("EDIT", run.extension) },
        );
      }
      await this.enqueueRemovals(
        decision.toRemove,
        mangaId,
        run.extension,
        groupId,
        removalMode,
        "no-longer-listed",
      );
      await this.recordUploaded(
        [...decision.toEdit.map((edit) => edit.chapter), ...decision.skipped],
        run.extension,
      );

      totals.visited += 1;
      totals.upload += decision.toUpload.length;
      totals.edit += decision.toEdit.length;
      totals.skip += decision.skipped.length;
      totals.remove += decision.toRemove.length;
      totals.unfetchable += decision.missingWithoutPages.length;

      // The one thing a clean run can find but not fix. Logged per manga at
      // warn because "the publisher has 12 chapters we never published, and
      // this run could not publish them either" is not a detail an operator
      // should have to go looking for.
      if (decision.missingWithoutPages.length > 0) {
        log.warn(
          {
            mangaId,
            mangaName: this.mangaNames.get(mangaId) ?? null,
            count: decision.missingWithoutPages.length,
            chapters: decision.missingWithoutPages.slice(0, 20).map((c) => c.chapterNumber),
          },
          "publisher lists chapters we have not published, but this run fetched no pages for them",
        );
      }

      if (decision.skippedDifferentId.length > 0) {
        log.debug(
          { mangaId, count: decision.skippedDifferentId.length },
          "chapters already uploaded under their master id (same override)",
        );
      }
      // An unscoped CLEAN run now visits every title in the snapshot, and most
      // of them decide nothing. Logging all of those at info would bury the
      // handful that did decide something under a page of zeroes, so a quiet
      // visit drops to debug; the run summary still counts it under `visited`.
      const decided =
        decision.toUpload.length +
          decision.toEdit.length +
          decision.toRemove.length +
          decision.missingWithoutPages.length >
        0;
      log[decided ? "info" : "debug"](
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

    // Queue the run's uploads, spread across days when there are enough of them
    // to matter. A routine run is well under the caps and every chapter comes
    // out due now, exactly as before; a backlog is dated forward instead of
    // landing on MangaDex all at once. Either way every chapter is queued here
    // and none is recomputed later: a future-dated row is an ordinary PENDING
    // task waiting for its date.
    if (pendingUploads.length > 0) {
      // Only a CLEAN run spreads. A routine UPDATE is the day's handful of new
      // chapters and the whole reason to run it is to publish them promptly;
      // dating those forward buys nothing (they are already under any sane cap)
      // and costs the thing the schedule was never meant to touch. Backlogs —
      // an operator tracking a batch of series, the first run after an outage —
      // arrive via CLEAN, which is what the cap exists for.
      //
      // FORCE is deliberately immediate too: it is an operator saying "do this
      // now", and a cap that defers it would be answering a different question.
      // A priority extension's routine updates are due now, whatever is queued
      // ahead of them and whatever the day's budget has already been spent on.
      // Not honoured for a clean run: that run IS a backlog, and spreading it
      // is the point (see `getUploadPriorityExtensions`).
      const prioritised =
        run.kind !== "CLEAN" &&
        (await this.settings.getUploadPriorityExtensions()).includes(run.extension);

      const spread = run.kind === "CLEAN";

      // Whose 50 a day it is. `global` is one pool for the platform, which is
      // what protects MangaDex's feed — the feed does not care which extension
      // a chapter came from, and five extensions each spending 50 is 250 a day
      // against a cap that reads 50. `extension` gives each its own allowance,
      // for when one publisher's backlog should not hold up another's routine
      // updates. The scope picks both the settings and the load it counts, so
      // the two can never disagree about which pool is being filled.
      const scope = spread ? await this.settings.getUploadBudgetScope() : null;
      const budgetOf = scope === "extension" ? run.extension : undefined;
      const schedule = spread ? await this.settings.getUploadSchedule(budgetOf, "UPLOAD") : null;

      if (schedule === null) {
        // Not spread, but still paced. "Immediate" means this run's chapters
        // are not held back for days by the per-day cap; it does not mean the
        // uploader should fire them off back to back, which is the one thing
        // `spacingSeconds` exists to stop. Each row queues behind the tail.
        const spacingSeconds = await this.spacingFor("UPLOAD", run.extension);
        for (const chapter of pendingUploads) {
          // An explicit `notBefore` beats the pacing tail inside `enqueue`, so
          // this is what "ignore the queue" is: no chaining behind anyone.
          await this.tasks.enqueue(
            "UPLOAD",
            uploadDedupeKey(chapter),
            chapter,
            prioritised ? { notBefore: new Date() } : { spacingSeconds },
          );
        }
        log.info(
          {
            queued: pendingUploads.length,
            kind: run.kind,
            spacingSeconds: prioritised ? 0 : spacingSeconds,
            prioritised,
          },
          prioritised
            ? "queued this run's uploads as due now: extension has upload priority"
            : "queued this run's uploads, paced but not spread",
        );
      } else {
        const scheduled = planUploadSchedule(
          pendingUploads,
          schedule,
          new Date(),
          // What every other extension and every earlier run already put in
          // each bucket, so this run fills what is left rather than starting
          // the calendar over.
          await this.tasks.scheduledLoad(intervalMsOf(schedule), new Date(), budgetOf, "UPLOAD"),
        );
        const shape = summariseSchedule(scheduled);

        for (const { chapter, notBefore } of scheduled) {
          await this.tasks.enqueue("UPLOAD", uploadDedupeKey(chapter), chapter, { notBefore });
        }

        if (shape.deferred > 0) {
          log.info(
            {
              queued: scheduled.length,
              immediate: shape.immediate,
              deferred: shape.deferred,
              days: shape.days,
              lastRelease: shape.lastDate,
              scope,
              perDay: schedule.perDay,
              perMangaPerDay: schedule.perMangaPerDay,
              spacingSeconds: schedule.spacingSeconds,
            },
            "spreading this run's uploads over several days",
          );
        } else {
          log.debug({ queued: scheduled.length }, "queued this run's uploads, all due now");
        }
      }
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

    await this.reportRevivedChapters(run.extension, merged.allChapters, log);

    if (!scoped && run.kind === "CLEAN" && allByManga !== null) {
      await this.rearmRecheckCooldowns(run.extension, log);
    }

    log.info({ ...totals, dupes }, "run processed");
    await this.markProcessed(run.id, log);
  }

  /**
   * Roll expired cooldowns forward, so a paused series is re-examined on a
   * schedule instead of drifting until somebody remembers it.
   *
   * A due series is one whose `recheckAfter` has passed: it rejoins the lease
   * map, this run fetches it like any other, and this is where it goes quiet
   * again for another `cooldownDays`. That cycle is the whole reason the pause
   * is a cooldown and not a boolean -- "this free prefix will never grow" is a
   * claim about a publisher's future, and the recheck is what would notice if
   * Comikey widened a prefix from one chapter to five.
   *
   * Three conditions, each load-bearing:
   *
   *   CLEAN      only a clean run re-derives a series from the publisher's full
   *              listing. An update run may legitimately skip it -- every new
   *              extension narrows by a change signal -- so re-arming on one
   *              would restart the cooldown on the strength of a look that
   *              never happened.
   *   unscoped   a scoped run is an operator probing one series, not the
   *              periodic sweep the cooldown is counting down to.
   *   allChapters present
   *              a clean run that refused to claim a complete catalogue (a
   *              region-narrowed view, a shrunken catalogue, an unreadable
   *              series) did not perform the re-derivation either.
   *
   * `cooldownDays` NULL is left alone: that is a one-shot pause, and it has now
   * expired for good.
   */
  private async rearmRecheckCooldowns(extension: string, log: Logger): Promise<void> {
    const now = new Date();
    const due = await this.prisma.trackedManga.findMany({
      where: { extension, recheckAfter: { not: null, lte: now }, cooldownDays: { not: null } },
      select: { id: true, mangaId: true, cooldownDays: true },
    });
    if (due.length === 0) return;

    // Measured from now rather than from the old `recheckAfter`, so a cooldown
    // that came due while runs were paused does not immediately come due again
    // for every interval it slept through.
    for (const row of due) {
      await this.prisma.trackedManga.update({
        where: { id: row.id },
        data: { recheckAfter: new Date(now.getTime() + row.cooldownDays! * DAY_MS) },
      });
    }
    log.info(
      { extension, rearmed: due.length, series: due.slice(0, 20).map((r) => r.mangaId) },
      "re-armed recheck cooldowns for series this clean run covered",
    );
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
      select: { mdMangaId: true, recheckAfter: true },
    });

    // Paused series are excluded here, and this is the half of the pause that
    // is load-bearing rather than merely thrifty: see activeTrackedTitles for
    // why filtering only the lease map would withdraw chapters instead of
    // skipping series.
    return activeTrackedTitles(rows, reportedByWorkers);
  }

  /**
   * The MangaDex titles behind the external ids a run could not read.
   *
   * `failedManga` carries the publisher's own ids, because that is all an
   * extension knows; the removal passes work in MangaDex ids. Resolving through
   * `tracked_manga` rather than the worker's reported map keeps this consistent
   * with every other mapping decision, which is DB-authoritative -- and the
   * worker's copy can be stale precisely when a title is behaving oddly.
   *
   * An external id with no mapping resolves to nothing and is dropped: it has
   * no MangaDex title, so there is no removal pass for it to protect.
   */
  private async failedMdMangaIds(extension: string, failedManga: string[]): Promise<Set<string>> {
    if (failedManga.length === 0) return new Set();
    const rows = await this.prisma.trackedManga.findMany({
      where: { extension, mangaId: { in: failedManga } },
      select: { mdMangaId: true },
      distinct: ["mdMangaId"],
    });
    return new Set(rows.map((row) => row.mdMangaId));
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
    // Keyed by group as well as manga: the volume backfill asks for the
    // unscoped aggregate too, and a manga-only key would hand the dupe sweep
    // every group's chapter ids and queue other people's uploads for deletion.
    const key = `${mangaId} ${groupId}`;
    const cached = this.aggregates.get(key);
    if (cached !== undefined) return cached;
    const aggregate = await this.md.mangaAggregate(mangaId, groupId);
    this.aggregates.set(key, aggregate);
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
  /**
   * One queue's gap between consecutive tasks.
   *
   * Per kind because the five queues are not interchangeable work: an UPLOAD
   * opens a MangaDex session and pushes images, an UNAVAILABLE is a single PUT.
   * Pacing them from one number makes the cheap queues crawl at the expensive
   * one's rate, or drags the expensive one up to theirs. Each kind reads its
   * own setting and, in `enqueue`, chains onto its own queue's tail, so a
   * 2,000-chapter upload backlog cannot push a handful of edits behind it.
   */
  private async spacingFor(kind: UploadTaskKind, extension: string): Promise<number> {
    return (await this.settings.getUploadSchedule(extension, kind)).spacingSeconds;
  }

  private async enqueueRemovals(
    mdChapters: MdChapter[],
    mdMangaId: string,
    extension: string,
    groupId: string,
    mode: RemovalMode,
    pass: RemovalPass,
  ): Promise<void> {
    if (mdChapters.length === 0) return;
    const kind: UploadTaskKind = mode === "delete" ? "DELETE" : "UNAVAILABLE";
    const mangaName = this.mangaNames.get(mdMangaId) ?? null;

    // Read once for the batch rather than per chapter: a removal pass can be
    // hundreds of rows and the setting cannot change underneath one loop.
    const spacingSeconds = await this.spacingFor(kind, extension);

    for (const mdChapter of mdChapters) {
      await this.tasks.enqueue(
        kind,
        mdChapter.id,
        chapterFromMdChapter(mdChapter, { mdMangaId, extension, groupId, mangaName, mode }),
        { spacingSeconds },
      );
      await this.prisma.uploadedChapter.deleteMany({ where: { mdChapterId: mdChapter.id } });
    }

    // Audited here, where the decision is made, not where the task runs.
    //
    // Until now only operator-initiated bulk actions wrote audit rows, so the
    // destructive path that runs unattended was the one with no trail: 132
    // chapters were removed in a single session with nothing recording which
    // pass chose them, on what evidence, or who had uploaded them. After the
    // fact that is unanswerable -- a deleted chapter 404s on MangaDex, so even
    // its uploader cannot be recovered. One row per chapter rather than a
    // summary, because "why was THIS chapter removed?" is the question actually
    // asked, and it is a lookup by subject.
    //
    // Never allowed to fail the run: losing an audit row is bad, failing a run
    // that has already queued its work and deleted its bookkeeping rows is
    // worse, and would replay the removals on the next attempt.
    try {
      await this.audit.recordMany(
        mdChapters.map((mdChapter) => ({
          actor: `processor:${extension}`,
          action: mode === "delete" ? "chapter.delete.auto" : "chapter.unavailable.auto",
          subject: mdChapter.id,
          detail: {
            pass,
            mode,
            kind,
            extension,
            mdMangaId,
            mangaName,
            chapter: mdChapter.attributes.chapter,
            language: mdChapter.attributes.translatedLanguage,
            externalUrl: mdChapter.attributes.externalUrl,
            // The question that could not be answered retrospectively when
            // publoader was found queueing other people's chapters.
            uploaderId: uploaderId(mdChapter),
            botUserId: this.botUserId,
          },
        })),
      );
    } catch (error) {
      this.log.warn({ error, mdMangaId, pass }, "could not write removal audit rows");
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
      await this.enqueueRemovals(
        mdChapters,
        mangaId,
        extension,
        groupId,
        mode,
        "manga-untracked",
      );
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
      await this.enqueueRemovals(
        mdChapters,
        mangaId,
        extension,
        groupId,
        mode,
        "manga-without-external-chapters",
      );
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


      const dupes = findDuplicateChapters(inLanguage, {
        groupId,
        multiChapters,
        botUserId: this.botUserId,
      });
      if (dupes.length === 0) continue;

      log.info({ mangaId, dupes: dupes.map((c) => c.id) }, "found duplicate chapters to delete");
      await this.resolveMangaNames([mangaId]);
      await this.enqueueRemovals(dupes, mangaId, run.extension, groupId, "delete", "duplicates");
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
  const failedManga = new Set<string>();
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
    // Unioned, never intersected: if any segment could not read a title, the
    // run as a whole has no trustworthy answer for it. Segments do not overlap,
    // so in practice at most one ever reports a given id.
    for (const mangaId of envelope.failedManga) failedManga.add(mangaId);

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
    failedManga: [...failedManga],
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

