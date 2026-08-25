import { Prisma, type PrismaClient } from "@prisma/client";
import type { Logger } from "../../logging.js";
import type { AuditLog } from "../store/settings.js";
import type { MdEntity, MdExtendedApi } from "./client.js";
// The carded predicate lives in md/types.js beside the `pages` attribute it
// reads: this sweep, the removal pass and duplicate detection must all give the
// same answer, and they did not while each owned its own idea of it.
import { isCardedAttributes } from "./types.js";
import { formatTitle } from "../processor/dedupe.js";
import {
  chapterIdFromUrl,
  learnChapterIdRule,
  type ChapterIdUrlRule,
} from "./chapterIdFromUrl.js";

/**
 * Rebuild the chapter archives from what MangaDex actually holds.
 *
 * `unavailable_chapters` and `deleted_chapters` are written only by the upload
 * task workers (taskWorkers.ts), at the moment those workers act. That makes
 * them a log of actions rather than a description of the catalogue, and the two
 * come apart whenever the log is incomplete: a database restored without them,
 * a migration, work done before the tables existed. MangaDex still carries the
 * evidence; nothing here was reading it back.
 *
 * WHAT "MARKED UNAVAILABLE" LOOKS LIKE ON MANGADEX. An external chapter, the
 * only kind this platform publishes, normally has no pages at all: the reader
 * follows `externalUrl` to the publisher. Marking one unavailable replaces that
 * with a card, and the card is a page. So:
 *
 *     externalUrl && pages > 0   ->  carries our card, i.e. marked unavailable
 *     externalUrl && pages === 0 ->  live
 *
 * On the live group that separates without a single ambiguous case: 112 carded
 * chapters, every one with exactly one page, against 6108 live ones with none.
 * The `externalUrl` of a carded chapter is no help on its own; the card flow
 * repoints it at the series or domain root rather than clearing it, which is
 * why the page count is the signal and the URL is not.
 *
 * Three passes, and they are not variations of one thing:
 *
 *   discover   Walk our groups' chapters on MangaDex and archive the carded
 *              ones. This CANNOT be expressed as a sweep of `uploaded_chapters`:
 *              on a database whose upload history is younger than the
 *              catalogue, the carded chapters have no row there at all.
 *              Measured on the live deployment, the overlap was zero. So the
 *              archive row is seeded from the MangaDex record itself.
 *
 *   adopt      The same walk's LIVE chapters, the ones with no row of ours,
 *              recorded into `uploaded_chapters`. See "adoption" below; this is
 *              the pass that makes the catalogue visible rather than only the
 *              parts of it that have gone wrong.
 *
 *   reconcile  Sweep `uploaded_chapters` for rows MangaDex no longer has, and
 *              archive those as deleted. Deletions can only be found this way
 *              round: a chapter that is gone cannot be enumerated, so the only
 *              evidence is our own memory of having uploaded it.
 *
 * ADOPTION, AND WHY THE GAP IS NOT COSMETIC. `uploaded_chapters` is a log of
 * uploads this platform performed, seeded once from the previous deployment's
 * Mongo `uploaded` collection. That collection never held the whole catalogue,
 * so most of what our groups have on MangaDex — uploaded by the predecessor,
 * years of it — has no row here. On the live deployment that is ~500 rows
 * against 6220 chapters MangaDex holds for the mangaplus group.
 *
 * The rows are missing from more than the dashboard. `uploaded_ids` is what
 * routes/worker.ts hands an extension as `postedChapterIds`, and an extension
 * uses it to decide it has nothing to fetch (mangaplus's `latest-chapter-posted`
 * skip). Every chapter with no id recorded is a detail call the extension makes
 * again on every run, for a chapter that was uploaded long ago.
 *
 * So adoption writes both: the `uploaded_chapters` row from the MangaDex
 * record, and an `uploaded_ids` row whenever the publisher's own chapter id can
 * be recovered from the URL (chapterIdFromUrl.ts, which measures the
 * URL-to-id relationship off the extension's existing rows rather than
 * assuming one). Where it cannot be recovered the row is still written, with a
 * NULL `chapter_id`: visibility restored, and nothing guessed.
 *
 * Adoption never touches a chapter we already have a row for, in any of the
 * three tables. It is `createMany`-with-skipDuplicates, not an upsert: a
 * chapter this platform actually uploaded carries publisher-side identifiers
 * that MangaDex has never known about, and a sweep must not overwrite them
 * with the less-informed version.
 *
 * Separately reported and never archived: chapters MangaDex itself refuses to
 * serve while they still have no card. That is MangaDex hiding a chapter rather
 * than us having marked it, so it is not an archive row; it is a list of
 * chapters that arguably want an UNAVAILABLE task, which is an operator's call.
 *
 * Both passes are idempotent. An id already in an archive keeps the timestamp
 * it already has: that instant is when the change was first seen, and a later
 * sweep does not know better.
 */

export interface ReconcileOptions {
  /** Classify and report, write nothing. */
  dryRun: boolean;
  /** Restrict to these extensions; empty means every group we know of. */
  extensions?: string[];
  /** Skip the uploaded_chapters sweep (the slow half on a large table). */
  skipDeleted?: boolean;
  /** Skip adoption: report the untracked chapters, record none of them. */
  skipAdopt?: boolean;
  /** Skip archiving the carded chapters: report them, move none of them. */
  skipUnavailable?: boolean;
  /** Who asked, for the audit trail. */
  actor: string;
}

export interface ReconcileGroup {
  extension: string;
  groupId: string;
  /** Chapters MangaDex holds for this group. */
  total: number;
  /** Of those, the ones carrying one of our cards. */
  carded: number;
  /** Of those, the ones we had not already archived. */
  recorded: number;
  /** Uncarded chapters MangaDex will not serve. Reported, never archived. */
  hiddenOnMangadex: number;
  /** Of `total`, the ones MangaDex serves uncarded: the live catalogue. */
  live: number;
  /** Of those, the ones no table of ours holds a row for. */
  untracked: number;
  /** Of those, the ones written into `uploaded_chapters` by this run. */
  adopted: number;
  /** …of which also recovered a publisher chapter id into `uploaded_ids`. */
  adoptedWithId: number;
  /**
   * How the publisher's chapter id sits inside this extension's chapter URLs,
   * measured off its existing rows. NULL when its own history does not agree on
   * an answer, in which case adopted rows carry no `chapter_id`.
   */
  idRule: ChapterIdUrlRule | null;
}

export interface ReconcileReport {
  dryRun: boolean;
  groups: ReconcileGroup[];
  /** Carded chapters found across every group. */
  unavailableFound: number;
  /** …of which newly written (the rest were already archived). */
  unavailableRecorded: number;
  /** Live chapters on MangaDex that no table of ours holds a row for. */
  untrackedFound: number;
  /** …of which adopted into `uploaded_chapters`. */
  adoptedRecorded: number;
  /** …of which also recovered a publisher chapter id into `uploaded_ids`. */
  idsRecorded: number;
  /** uploaded_chapters rows examined by the deletion sweep. */
  scanned: number;
  /**
   * Rows the deletion sweep did not have to ask MangaDex about, because the
   * group walk had already seen the chapter. Adoption makes the table large
   * enough that this matters: without it the sweep is one HTTP call per row.
   */
  skippedByGroupWalk: number;
  deletedFound: number;
  deletedRecorded: number;
  /**
   * Chapters MangaDex will not serve that carry no card of ours; MangaDex
   * hiding a chapter rather than us having marked it. Never archived: these are
   * candidates for an UNAVAILABLE task, which is an operator's decision.
   */
  hiddenOnMangadex: string[];
}

export interface ReconcileDeps {
  prisma: PrismaClient;
  md: MdExtendedApi;
  log: Logger;
  audit: AuditLog;
}

/** uploaded_chapters rows held in memory at once while sweeping. */
const ROW_BATCH = 100;

/** Ids per `IN (…)` when asking which chapters we already hold. */
const READ_BATCH = 100;

/** Rows per `createMany` during adoption. */
const WRITE_BATCH = 500;

/**
 * Rows read when measuring an extension's URL-to-id relationship.
 *
 * A ceiling rather than the whole table: the relationship is a property of the
 * publisher's URL shape, so a few hundred genuine examples settle it as firmly
 * as a few thousand would, and the disagreement threshold in chapterIdFromUrl
 * is a share rather than a count.
 */
const SAMPLE_LIMIT = 500;

/**
 * `extra.adopted` on a row this pass inferred off MangaDex rather than
 * uploaded.
 *
 * Both the write and the query that excludes those rows from the id-rule
 * evidence read it from here: two spellings of the same string would leave
 * every adopted row voting on the rule that produced it.
 */
const ADOPTED_MARKER = "mangadex-reconcile";

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class ChapterReconciler {
  /** Measured once per extension per run; the table it reads does not move under us. */
  private readonly idRules = new Map<string, ChapterIdUrlRule | null>();

  constructor(private readonly deps: ReconcileDeps) {}

  async run(options: ReconcileOptions): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      dryRun: options.dryRun,
      groups: [],
      unavailableFound: 0,
      unavailableRecorded: 0,
      untrackedFound: 0,
      adoptedRecorded: 0,
      idsRecorded: 0,
      scanned: 0,
      skippedByGroupWalk: 0,
      deletedFound: 0,
      deletedRecorded: 0,
      hiddenOnMangadex: [],
    };

    // Every chapter id a group walk saw, so the deletion sweep can skip the
    // rows it has already proved MangaDex holds. Adoption is what makes this
    // worth carrying: it can leave the table thousands of rows larger, and the
    // sweep costs one HTTP call per row it cannot rule out.
    const seenOnMd = new Set<string>();

    for (const { extension, groupId } of await this.groups(options.extensions ?? [])) {
      report.groups.push(await this.discoverGroup(extension, groupId, options, report, seenOnMd));
    }
    if (!options.skipDeleted) await this.sweepUploaded(options, report, seenOnMd);

    if (!options.dryRun) {
      await this.deps.audit.record(options.actor, "chapters.reconcile", "mangadex", {
        unavailable: report.unavailableRecorded,
        adopted: report.adoptedRecorded,
        ids: report.idsRecorded,
        deleted: report.deletedRecorded,
        groups: report.groups.map((group) => group.groupId),
      });
    }
    return report;
  }

  /**
   * The (extension, group) pairs to ask about, taken from the chapter tables
   * rather than from configuration.
   *
   * An extension's group id lives in its manifest or its override options, both
   * of which describe what the *next* run will do. What has actually been
   * uploaded is the honest answer to "whose chapters are ours", it needs no
   * plumbing to stay current, and an extension that has never uploaded anything
   * has nothing to reconcile in the first place.
   */
  private async groups(extensions: string[]): Promise<{ extension: string; groupId: string }[]> {
    const rows = await this.deps.prisma.uploadedChapter.findMany({
      where: {
        mdGroupId: { not: null },
        ...(extensions.length > 0 ? { extension: { in: extensions } } : {}),
      },
      distinct: ["extension", "mdGroupId"],
      select: { extension: true, mdGroupId: true },
    });
    const pairs = new Map<string, { extension: string; groupId: string }>();
    for (const row of rows) {
      if (!row.mdGroupId) continue;
      pairs.set(`${row.extension} ${row.mdGroupId}`, {
        extension: row.extension,
        groupId: row.mdGroupId,
      });
    }
    return [...pairs.values()];
  }

  /**
   * Walk one group's chapters on MangaDex: archive the carded ones, and adopt
   * the live ones we have no row for.
   */
  private async discoverGroup(
    extension: string,
    groupId: string,
    options: ReconcileOptions,
    report: ReconcileReport,
    seenOnMd: Set<string>,
  ): Promise<ReconcileGroup> {
    const { all, served } = await this.deps.md.chapterAvailabilityForGroup(groupId);

    const carded: [string, MdEntity][] = [];
    const live: [string, MdEntity][] = [];
    let hiddenOnMangadex = 0;
    for (const [id, entity] of all) {
      seenOnMd.add(id);
      if (isCardedAttributes(entity.attributes ?? {})) {
        carded.push([id, entity]);
        continue;
      }
      // Uncarded and MangaDex will not serve it: hidden by MangaDex, not by us.
      if (!served.has(id)) {
        hiddenOnMangadex += 1;
        report.hiddenOnMangadex.push(id);
        continue;
      }
      live.push([id, entity]);
    }
    this.deps.log.info(
      { extension, groupId, total: all.size, carded: carded.length, live: live.length, hiddenOnMangadex },
      "group measured",
    );

    // The carded chapters are still classified under `skipUnavailable` — they
    // have to be, or they would fall through to adoption as ordinary live
    // chapters — but nothing is counted or written for them. A caller that has
    // asked for one pass should not have the other's numbers reported back as
    // work it is about to do.
    let recorded = 0;
    if (!options.skipUnavailable) {
      for (const [mdChapterId, entity] of carded) {
        report.unavailableFound += 1;
        if (await this.alreadyArchived(mdChapterId)) continue;
        recorded += 1;
        report.unavailableRecorded += 1;
        if (!options.dryRun) await this.archiveUnavailable(mdChapterId, extension, groupId, entity);
      }
    }

    const adoption = await this.adoptLive(extension, groupId, live, options, report);

    return {
      extension,
      groupId,
      total: all.size,
      carded: carded.length,
      recorded,
      hiddenOnMangadex,
      live: live.length,
      ...adoption,
    };
  }

  /**
   * Record the live chapters of one group that no table of ours knows about.
   *
   * The counting half runs even under `--skip-adopt` and under a dry run: "how
   * much of the catalogue are we blind to" is the question this pass exists to
   * answer, and it is worth answering without writing anything.
   */
  private async adoptLive(
    extension: string,
    groupId: string,
    live: [string, MdEntity][],
    options: ReconcileOptions,
    report: ReconcileReport,
  ): Promise<{
    untracked: number;
    adopted: number;
    adoptedWithId: number;
    idRule: ChapterIdUrlRule | null;
  }> {
    const missing = await this.withoutRows(live.map(([id]) => id));
    const candidates = live.filter(([id]) => missing.has(id));
    report.untrackedFound += candidates.length;

    const idRule = await this.idRuleFor(extension);
    if (options.skipAdopt || candidates.length === 0) {
      return { untracked: candidates.length, adopted: 0, adoptedWithId: 0, idRule };
    }

    // Skipped on a dry run: they are MangaDex calls and database reads that
    // only ever fill columns of rows a dry run will not write.
    const mangaNames = options.dryRun ? new Map<string, string>() : await this.mangaNames(candidates);
    const publisherMangaIds = options.dryRun
      ? new Map<string, string>()
      : await this.publisherMangaIds(extension, candidates);

    const rows: Prisma.UploadedChapterCreateManyInput[] = [];
    const ids: Prisma.UploadedIdCreateManyInput[] = [];
    // uploaded_ids is unique on (extension, chapterId) and createMany's
    // skipDuplicates cannot see collisions *within* its own batch, so the same
    // recovered id appearing twice in one group has to be dropped here.
    const claimed = new Set<string>();

    for (const [mdChapterId, entity] of candidates) {
      const attrs = entity.attributes ?? {};
      const str = (key: string): string | null => {
        const value = attrs[key];
        return typeof value === "string" && value !== "" ? value : null;
      };
      const chapterUrl = str("externalUrl");
      const mdMangaId = entity.relationships?.find((rel) => rel.type === "manga")?.id ?? null;
      const timestamp = str("readableAt") ?? str("publishAt");
      const chapterId = chapterUrl && idRule ? chapterIdFromUrl(chapterUrl, idRule) : null;

      rows.push({
        mdChapterId,
        extension,
        chapterId,
        chapterUrl,
        chapterNumber: str("chapter"),
        chapterTitle: str("title"),
        chapterVolume: str("volume"),
        chapterLanguage: str("translatedLanguage"),
        chapterTimestamp: timestamp ? new Date(timestamp) : null,
        mangaId: mdMangaId ? (publisherMangaIds.get(mdMangaId) ?? null) : null,
        mangaName: mdMangaId ? (mangaNames.get(mdMangaId) ?? null) : null,
        mdMangaId,
        mdGroupId: groupId,
        // Provenance. Nothing else distinguishes a row this platform wrote
        // because it performed the upload from one it inferred off MangaDex,
        // and the two are not equally trustworthy: the inferred row has no
        // publisher-side manga URL and may have no chapter id.
        extra: { adopted: ADOPTED_MARKER } as Prisma.InputJsonValue,
      });
      if (chapterId !== null && !claimed.has(chapterId)) {
        claimed.add(chapterId);
        ids.push({ extension, chapterId, mdChapterId });
      }
    }

    // A dry run reports what it would write, as the archiving pass above does.
    // The counts can only be exact for `uploaded_chapters`, whose ids were just
    // checked; `uploaded_ids` may hold some of these already, so its dry-run
    // number is an upper bound and the applied number is the truth.
    let adopted = rows.length;
    let adoptedWithId = ids.length;
    if (!options.dryRun) {
      adopted = 0;
      adoptedWithId = 0;
      for (const batch of chunk(rows, WRITE_BATCH)) {
        const written = await this.deps.prisma.uploadedChapter.createMany({
          data: batch,
          skipDuplicates: true,
        });
        adopted += written.count;
      }
      for (const batch of chunk(ids, WRITE_BATCH)) {
        // skipDuplicates, never upsert: uploaded_ids is insert-only, and the
        // first MangaDex chapter an extension id mapped to is the one that
        // stays recorded (see Processor.recordUploaded).
        const written = await this.deps.prisma.uploadedId.createMany({
          data: batch,
          skipDuplicates: true,
        });
        adoptedWithId += written.count;
      }
    }

    report.adoptedRecorded += adopted;
    report.idsRecorded += adoptedWithId;
    this.deps.log.info(
      { extension, groupId, untracked: candidates.length, adopted, adoptedWithId, idRule },
      "live chapters adopted",
    );
    return { untracked: candidates.length, adopted, adoptedWithId, idRule };
  }

  /**
   * Of these MangaDex chapter ids, the ones no table of ours holds.
   *
   * All three tables are consulted, not just `uploaded_chapters`: a chapter we
   * have already archived as unavailable or deleted is tracked, and adopting it
   * back into the live table would undo the archiving pass that just ran.
   */
  private async withoutRows(mdChapterIds: string[]): Promise<Set<string>> {
    const missing = new Set(mdChapterIds);
    for (const batch of chunk(mdChapterIds, READ_BATCH)) {
      const where = { mdChapterId: { in: batch } };
      const select = { mdChapterId: true } as const;
      const [uploaded, unavailable, deleted] = await Promise.all([
        this.deps.prisma.uploadedChapter.findMany({ where, select }),
        this.deps.prisma.unavailableChapter.findMany({ where, select }),
        this.deps.prisma.deletedChapter.findMany({ where, select }),
      ]);
      for (const rows of [uploaded, unavailable, deleted]) {
        for (const row of rows) missing.delete(row.mdChapterId);
      }
    }
    return missing;
  }

  /**
   * The URL-to-chapter-id rule this extension's own rows demonstrate.
   *
   * Only rows this platform wrote from an actual upload are evidence, so
   * previously adopted rows are excluded: their `chapter_id` came from this
   * same rule, and feeding it back in would let one early mistake confirm
   * itself forever.
   */
  private async idRuleFor(extension: string): Promise<ChapterIdUrlRule | null> {
    const cached = this.idRules.get(extension);
    if (cached !== undefined) return cached;

    // Raw SQL for the `extra` test, and not as a style choice. Prisma's JSON
    // path filter compiles to `extra->'adopted' = …`, which is SQL NULL rather
    // than false both when `extra` is NULL and when the key is simply absent;
    // negating it then yields NULL, and NULL does not pass a WHERE clause. So
    // `NOT { path: ["adopted"] }` silently excludes every ordinary row — which
    // is all of them — and the rule can never be measured. `->>` with a
    // COALESCE says what was meant: anything that is not an adopted row.
    const samples = await this.deps.prisma.$queryRaw<
      { chapterId: string; chapterUrl: string }[]
    >(Prisma.sql`
      SELECT chapter_id AS "chapterId", chapter_url AS "chapterUrl"
      FROM uploaded_chapters
      WHERE extension = ${extension}
        AND chapter_id IS NOT NULL
        AND chapter_url IS NOT NULL
        AND COALESCE(extra->>'adopted', '') <> ${ADOPTED_MARKER}
      LIMIT ${SAMPLE_LIMIT}
    `);
    const rule = learnChapterIdRule(samples);
    this.idRules.set(extension, rule);
    return rule;
  }

  /** MangaDex titles for the manga these chapters belong to, formatted as the processor formats them. */
  private async mangaNames(candidates: [string, MdEntity][]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const [, entity] of candidates) {
      const mangaId = entity.relationships?.find((rel) => rel.type === "manga")?.id;
      if (mangaId) ids.add(mangaId);
    }
    const names = new Map<string, string>();
    for (const batch of chunk([...ids], READ_BATCH)) {
      for (const manga of await this.deps.md.mangaByIds(batch)) {
        names.set(manga.id, formatTitle(manga));
      }
    }
    return names;
  }

  /**
   * Publisher-side manga ids, recovered from the tracking map where it answers
   * without ambiguity.
   *
   * `tracked_manga` is unique on the EXTERNAL side only: many external ids may
   * point at one MangaDex title, and mangaplus routinely does that, one id per
   * language edition. Reversing the map is therefore only sound where exactly
   * one external id claims the title; anything else stays NULL rather than
   * picking whichever row came back first.
   */
  private async publisherMangaIds(
    extension: string,
    candidates: [string, MdEntity][],
  ): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const [, entity] of candidates) {
      const mangaId = entity.relationships?.find((rel) => rel.type === "manga")?.id;
      if (mangaId) ids.add(mangaId);
    }
    const counts = new Map<string, string[]>();
    for (const batch of chunk([...ids], READ_BATCH)) {
      const rows = await this.deps.prisma.trackedManga.findMany({
        where: { extension, mdMangaId: { in: batch } },
        select: { mangaId: true, mdMangaId: true },
      });
      for (const row of rows) {
        const seen = counts.get(row.mdMangaId) ?? [];
        seen.push(row.mangaId);
        counts.set(row.mdMangaId, seen);
      }
    }
    const resolved = new Map<string, string>();
    for (const [mdMangaId, external] of counts) {
      const unique = new Set(external);
      const only = unique.size === 1 ? [...unique][0] : undefined;
      if (only !== undefined) resolved.set(mdMangaId, only);
    }
    return resolved;
  }

  /**
   * Walk `uploaded_chapters` and archive the rows MangaDex no longer has.
   *
   * Carded chapters are handled here too, for the rows the group pass could not
   * reach: a chapter whose group id we never recorded still has a row, and it
   * should not be missed just because it cannot be grouped.
   *
   * Rows the group walk already saw are skipped outright. The walk enumerated
   * MangaDex's own answer to "which chapters does this group have", so those
   * rows cannot be deletions, and their cardedness was decided there. That is
   * the difference between one HTTP call and thousands once adoption has filled
   * the table in.
   */
  private async sweepUploaded(
    options: ReconcileOptions,
    report: ReconcileReport,
    seenOnMd: Set<string>,
  ): Promise<void> {
    let cursor: string | undefined;

    for (;;) {
      const rows = await this.deps.prisma.uploadedChapter.findMany({
        where: options.extensions?.length ? { extension: { in: options.extensions } } : {},
        orderBy: { id: "asc" },
        take: ROW_BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]?.id;
      report.scanned += rows.length;

      for (const row of rows) {
        if (seenOnMd.has(row.mdChapterId)) {
          report.skippedByGroupWalk += 1;
          continue;
        }
        // One read per row rather than a batched collection lookup: the page
        // count decides everything here, and only the single-chapter endpoint
        // is authoritative for both halves of the question: it answers 404 for
        // a deletion, and carries `pages` for a card.
        const detail = await this.deps.md.chapterById(row.mdChapterId);
        if (detail === null) {
          report.deletedFound += 1;
          if (await this.alreadyArchived(row.mdChapterId)) continue;
          report.deletedRecorded += 1;
          if (!options.dryRun) await this.archiveDeleted(row);
          continue;
        }
        const attributes = detail.attributes as unknown as Record<string, unknown>;
        if (isCardedAttributes(attributes)) {
          report.unavailableFound += 1;
          if (await this.alreadyArchived(row.mdChapterId)) continue;
          report.unavailableRecorded += 1;
          if (!options.dryRun) {
            await this.archiveUnavailable(row.mdChapterId, row.extension, row.mdGroupId, {
              id: row.mdChapterId,
              attributes,
              relationships: detail.relationships,
            });
          }
        }
      }
    }
  }

  /**
   * True when the chapter is already in either archive.
   *
   * Both are checked, not just the one about to be written: a chapter recorded
   * as deleted must not be resurrected as merely unavailable, and a chapter
   * already marked unavailable keeps the instant it was first seen.
   */
  private async alreadyArchived(mdChapterId: string): Promise<boolean> {
    const [unavailable, deleted] = await Promise.all([
      this.deps.prisma.unavailableChapter.findUnique({
        where: { mdChapterId },
        select: { id: true },
      }),
      this.deps.prisma.deletedChapter.findUnique({ where: { mdChapterId }, select: { id: true } }),
    ]);
    return unavailable !== null || deleted !== null;
  }

  /**
   * Write the archive row for a chapter MangaDex will not serve.
   *
   * The columns come from the MangaDex record, because for a discovered chapter
   * that is the only description of it we have. `extra.mdAttributes` keeps the
   * raw attributes for the same reason taskWorkers does: it is the last
   * surviving answer to what the chapter looked like, and MangaDex stops being
   * able to answer once it drops the chapter entirely.
   */
  private async archiveUnavailable(
    mdChapterId: string,
    extension: string | null,
    groupId: string | null,
    entity: MdEntity,
  ): Promise<void> {
    const attrs = entity.attributes ?? {};
    const str = (key: string): string | null => {
      const value = attrs[key];
      return typeof value === "string" && value !== "" ? value : null;
    };
    const mdMangaId = entity.relationships?.find((rel) => rel.type === "manga")?.id ?? null;
    const uploaded = await this.deps.prisma.uploadedChapter.findUnique({ where: { mdChapterId } });
    const timestamp = str("readableAt") ?? str("publishAt");

    await this.deps.prisma.$transaction(async (tx) => {
      await tx.unavailableChapter.upsert({
        where: { mdChapterId },
        create: {
          mdChapterId,
          // Our own row wins where it exists: it carries the publisher-side
          // identifiers (chapterId, mangaId, the source URLs) that MangaDex has
          // never known about and that nothing else can reconstruct.
          extension: uploaded?.extension ?? extension,
          chapterId: uploaded?.chapterId ?? null,
          chapterUrl: uploaded?.chapterUrl ?? str("externalUrl"),
          chapterNumber: uploaded?.chapterNumber ?? str("chapter"),
          chapterTitle: uploaded?.chapterTitle ?? str("title"),
          chapterVolume: uploaded?.chapterVolume ?? str("volume"),
          chapterLanguage: uploaded?.chapterLanguage ?? str("translatedLanguage"),
          chapterTimestamp: uploaded?.chapterTimestamp ?? (timestamp ? new Date(timestamp) : null),
          chapterExpire: uploaded?.chapterExpire ?? null,
          chapterLookup: uploaded?.chapterLookup ?? null,
          mangaId: uploaded?.mangaId ?? null,
          mangaName: uploaded?.mangaName ?? null,
          mangaUrl: uploaded?.mangaUrl ?? null,
          mdMangaId: uploaded?.mdMangaId ?? mdMangaId,
          mdGroupId: uploaded?.mdGroupId ?? groupId,
          extra: { ...(asRecord(uploaded?.extra) ?? {}), mdAttributes: attrs } as Prisma.InputJsonValue,
        },
        update: {},
      });
      await tx.uploadedChapter.deleteMany({ where: { mdChapterId } });
    });
  }

  /** Archive a chapter MangaDex 404s, carrying our row across unchanged. */
  private async archiveDeleted(row: {
    mdChapterId: string;
    extension: string;
    chapterId: string | null;
    chapterUrl: string | null;
    chapterNumber: string | null;
    chapterTitle: string | null;
    chapterVolume: string | null;
    chapterLanguage: string | null;
    chapterTimestamp: Date | null;
    chapterExpire: Date | null;
    chapterLookup: Date | null;
    mangaId: string | null;
    mangaName: string | null;
    mangaUrl: string | null;
    mdMangaId: string | null;
    mdGroupId: string | null;
    extra: unknown;
  }): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.deletedChapter.upsert({
        where: { mdChapterId: row.mdChapterId },
        create: {
          mdChapterId: row.mdChapterId,
          extension: row.extension,
          chapterId: row.chapterId,
          chapterUrl: row.chapterUrl,
          chapterNumber: row.chapterNumber,
          chapterTitle: row.chapterTitle,
          chapterVolume: row.chapterVolume,
          chapterLanguage: row.chapterLanguage,
          chapterTimestamp: row.chapterTimestamp,
          chapterExpire: row.chapterExpire,
          chapterLookup: row.chapterLookup,
          mangaId: row.mangaId,
          mangaName: row.mangaName,
          mangaUrl: row.mangaUrl,
          mdMangaId: row.mdMangaId,
          mdGroupId: row.mdGroupId,
          ...(asRecord(row.extra) ? { extra: asRecord(row.extra) as object } : {}),
        },
        update: {},
      });
      await tx.uploadedChapter.deleteMany({ where: { mdChapterId: row.mdChapterId } });
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
