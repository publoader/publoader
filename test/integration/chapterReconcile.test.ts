import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createLogger } from "../../src/logging.js";
import { ChapterReconciler } from "../../src/core/md/chapterReconcile.js";
import type { MdChapterDetail, MdEntity, MdExtendedApi } from "../../src/core/md/client.js";
import type { AuditLog } from "../../src/core/store/settings.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Rebuilding the chapter archives from what MangaDex holds.
 *
 * The properties worth proving are the ones that cost real data when they
 * regress, and each needs a live postgres because the archives' `md_chapter_id`
 * unique constraints and the move-between-tables transaction are the system
 * under test:
 *
 *  - "marked unavailable" is `externalUrl && pages > 0`, an external chapter
 *    carrying our card. Both halves are load-bearing: pages alone would sweep
 *    in natively hosted chapters, and externalUrl alone describes every chapter
 *    we have ever published, live ones included;
 *  - a carded chapter is archived even when it has NO uploaded_chapters row.
 *    This is the case the obvious implementation gets wrong: on a database
 *    younger than the catalogue the overlap is zero, so a sweep of our own
 *    table finds nothing at all;
 *  - a live external chapter (no pages) is left alone however MangaDex is
 *    behaving, including when MangaDex has stopped serving it; that is
 *    MangaDex hiding a chapter rather than us having marked one, so it is
 *    reported and never archived;
 *  - deletion rests on a 404 and never on absence from a list, because it is
 *    the irreversible direction;
 *  - re-running keeps the instant already recorded, so a sweep cannot rewrite
 *    the history it is meant to preserve.
 */
describe.skipIf(!dbReady())("chapter reconciliation", () => {
  const prisma = testPrisma();
  const log = createLogger("test-reconcile", "error");
  const GROUP = "33333333-3333-4333-8333-333333333333";
  const MANGA = "22222222-2222-4222-8222-222222222222";

  const audited: { action: string; detail: unknown }[] = [];
  const audit = {
    record: async (_actor: string, action: string, _target: string, detail: unknown) => {
      audited.push({ action, detail });
    },
  } as unknown as AuditLog;

  const chapterId = (n: number): string =>
    `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

  /** A live external chapter: publisher link, no pages of its own. */
  const entity = (id: string, attributes: Record<string, unknown> = {}): MdEntity => ({
    id,
    type: "chapter",
    attributes: {
      chapter: "7",
      title: "Seven",
      translatedLanguage: "en",
      externalUrl: "https://publisher.example/ch/7",
      pages: 0,
      ...attributes,
    },
    relationships: [{ id: MANGA, type: "manga" }],
  });

  /**
   * The same chapter after being marked unavailable: the card is its one page,
   * and the link has been repointed at the series root rather than cleared,
   * which is exactly why the page count, not the URL, is the signal.
   */
  const carded = (id: string, attributes: Record<string, unknown> = {}): MdEntity =>
    entity(id, { externalUrl: "https://publisher.example/", pages: 1, ...attributes });

  /**
   * A MangaDex that holds `all` for the group, serves `served`, and 404s
   * anything in `gone`. `byId` overrides what the single-chapter endpoint says,
   * which is the only thing the uploaded-row sweep consults.
   */
  function fakeMd(opts: {
    all: MdEntity[];
    served: string[];
    gone?: string[];
    byId?: Record<string, Record<string, unknown>>;
  }): MdExtendedApi {
    return {
      chapterAvailabilityForGroup: async () => ({
        all: new Map(opts.all.map((e) => [e.id, e])),
        served: new Set(opts.served),
      }),
      chapterById: async (id: string) => {
        if ((opts.gone ?? []).includes(id)) return null;
        return {
          id,
          attributes: {
            volume: null,
            chapter: "7",
            title: null,
            translatedLanguage: "en",
            externalUrl: "https://publisher.example/ch/7",
            pages: 0,
            version: 1,
            createdAt: "",
            ...(opts.byId?.[id] ?? {}),
          },
          relationships: [],
        } as unknown as MdChapterDetail;
      },
      // Adoption fills `manga_name` so an adopted row is readable in the
      // dashboard rather than another bare UUID.
      mangaByIds: async (ids: string[]) =>
        ids.map((id) => ({
          id,
          attributes: { title: { en: "Test Series" }, altTitles: [], originalLanguage: "ja" },
        })),
    } as unknown as MdExtendedApi;
  }

  const seedUploaded = async (mdChapterId: string, extra?: Prisma.InputJsonValue) =>
    prisma.uploadedChapter.create({
      data: {
        mdChapterId,
        extension: "mangaplus",
        mdGroupId: GROUP,
        chapterId: "src-7",
        chapterUrl: "https://publisher.example/ch/7",
        chapterNumber: "7",
        ...(extra ? { extra } : {}),
      },
    });

  beforeEach(async () => {
    await resetDb(prisma);
    audited.length = 0;
  });
  afterAll(async () => {
    await closeDb();
  });

  it("archives a carded chapter that has no uploaded_chapters row", async () => {
    // One uploaded row exists purely so the group is discoverable; the carded
    // chapter itself is NOT in uploaded_chapters, which is the real-world case
    // a sweep of our own table cannot see.
    await seedUploaded(chapterId(1));
    const orphan = chapterId(99);
    const md = fakeMd({
      all: [entity(chapterId(1)), carded(orphan)],
      served: [chapterId(1), orphan],
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.unavailableFound).toBe(1);
    expect(report.unavailableRecorded).toBe(1);
    const row = await prisma.unavailableChapter.findUnique({ where: { mdChapterId: orphan } });
    expect(row).not.toBeNull();
    expect(row?.mdGroupId).toBe(GROUP);
    expect(row?.mdMangaId).toBe(MANGA);
    expect(row?.extension).toBe("mangaplus");
    // The MangaDex record is the only description of a chapter we never had a
    // row for, so it has to survive on the archive row.
    expect((row?.extra as Record<string, unknown>)["mdAttributes"]).toMatchObject({ pages: 1 });
  });

  it("needs both halves of the signature: pages alone and a link alone are not enough", async () => {
    await seedUploaded(chapterId(1));
    const liveExternal = chapterId(90);
    const nativeWithPages = chapterId(91);
    const md = fakeMd({
      all: [
        entity(chapterId(1)),
        // Still readable at the publisher: pages 0.
        entity(liveExternal),
        // Pages, but no publisher link: a natively hosted chapter, not our card.
        entity(nativeWithPages, { externalUrl: null, pages: 12 }),
      ],
      served: [chapterId(1), liveExternal, nativeWithPages],
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.unavailableFound).toBe(0);
    expect(await prisma.unavailableChapter.count()).toBe(0);
  });

  it("reports a live chapter MangaDex has stopped serving without archiving it", async () => {
    await seedUploaded(chapterId(1));
    const hidden = chapterId(89);
    const md = fakeMd({
      // Uncarded and unserved: MangaDex is hiding it, we have not marked it.
      all: [entity(chapterId(1)), entity(hidden)],
      served: [chapterId(1)],
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.hiddenOnMangadex).toEqual([hidden]);
    expect(report.unavailableRecorded).toBe(0);
    expect(await prisma.unavailableChapter.count()).toBe(0);
    expect(report.groups[0]?.hiddenOnMangadex).toBe(1);
  });

  it("writes nothing on a dry run but reports the same counts", async () => {
    await seedUploaded(chapterId(1));
    const md = fakeMd({
      all: [entity(chapterId(1)), carded(chapterId(97))],
      served: [chapterId(1), chapterId(97)],
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: true,
      actor: "tester",
    });

    expect(report.unavailableRecorded).toBe(1);
    expect(await prisma.unavailableChapter.count()).toBe(0);
    expect(await prisma.uploadedChapter.count()).toBe(1);
    // A dry run is not an event.
    expect(audited).toHaveLength(0);
  });

  it("archives a carded chapter found through its uploaded row", async () => {
    const known = chapterId(5);
    await seedUploaded(known);
    const md = fakeMd({
      all: [],
      served: [],
      byId: { [known]: { externalUrl: "https://publisher.example/", pages: 1 } },
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.unavailableRecorded).toBe(1);
    // The publisher-side identifiers come from our row, not from MangaDex,
    // which has never known about them.
    const row = await prisma.unavailableChapter.findUnique({ where: { mdChapterId: known } });
    expect(row?.chapterId).toBe("src-7");
    expect(row?.chapterUrl).toBe("https://publisher.example/ch/7");
    expect(await prisma.uploadedChapter.count()).toBe(0);
  });

  it("archives a deletion only on a 404, and moves the row out of uploaded", async () => {
    const gone = chapterId(2);
    await seedUploaded(gone, { images: ["artifact-1"] });
    const md = fakeMd({ all: [], served: [], gone: [gone] });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.deletedRecorded).toBe(1);
    const row = await prisma.deletedChapter.findUnique({ where: { mdChapterId: gone } });
    expect(row?.chapterId).toBe("src-7");
    expect(row?.extra).toMatchObject({ images: ["artifact-1"] });
    expect(await prisma.uploadedChapter.findUnique({ where: { mdChapterId: gone } })).toBeNull();
  });

  it("keeps the instant it first recorded when run again", async () => {
    await seedUploaded(chapterId(1));
    const orphan = chapterId(96);
    const md = fakeMd({
      all: [entity(chapterId(1)), carded(orphan)],
      served: [chapterId(1), orphan],
    });
    const reconciler = new ChapterReconciler({ prisma, md, log, audit });

    await reconciler.run({ dryRun: false, actor: "tester" });
    const first = await prisma.unavailableChapter.findUnique({ where: { mdChapterId: orphan } });

    const second = await reconciler.run({ dryRun: false, actor: "tester" });
    const after = await prisma.unavailableChapter.findUnique({ where: { mdChapterId: orphan } });

    // Still found, but not recorded again, and the timestamp is untouched.
    expect(second.unavailableFound).toBe(1);
    expect(second.unavailableRecorded).toBe(0);
    expect(after?.unavailableAt.toISOString()).toBe(first?.unavailableAt.toISOString());
  });

  it("never resurrects a deleted chapter as merely unavailable", async () => {
    const gone = chapterId(4);
    await prisma.deletedChapter.create({ data: { mdChapterId: gone, extension: "mangaplus" } });
    await seedUploaded(chapterId(1));
    const md = fakeMd({
      all: [entity(chapterId(1)), carded(gone)],
      served: [chapterId(1), gone],
    });

    const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
      dryRun: false,
      actor: "tester",
    });

    expect(report.unavailableRecorded).toBe(0);
    expect(await prisma.unavailableChapter.count()).toBe(0);
    expect(await prisma.deletedChapter.count()).toBe(1);
  });

  /**
   * Adopting the live catalogue.
   *
   * `uploaded_chapters` is a log of uploads this platform performed, seeded
   * once from the previous deployment's Mongo. On the live database that is a
   * few hundred rows against 6220 chapters MangaDex holds for the group, and
   * the gap is not only a gap in the dashboard: `uploaded_ids` is what reaches
   * an extension as `postedChapterIds`, so an untracked chapter is one the
   * extension re-fetches on every run, forever.
   */
  describe("adopting live chapters MangaDex holds and we do not", () => {
    /** A live chapter at its own publisher URL, so ids are distinguishable. */
    const atUrl = (id: string, sourceId: string): MdEntity =>
      entity(id, { externalUrl: `https://publisher.example/ch/${sourceId}`, chapter: sourceId });

    /**
     * Enough genuine (id, url) pairs for the URL-to-id relationship to be
     * measurable. Below this the recovery refuses, which is its own test.
     */
    const seedHistory = async (count: number): Promise<string[]> => {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const mdId = chapterId(200 + i);
        ids.push(mdId);
        await prisma.uploadedChapter.create({
          data: {
            mdChapterId: mdId,
            extension: "mangaplus",
            mdGroupId: GROUP,
            chapterId: `${1000 + i}`,
            chapterUrl: `https://publisher.example/ch/${1000 + i}`,
          },
        });
      }
      return ids;
    };

    it("records a live chapter it has no row for, from the MangaDex record", async () => {
      await seedUploaded(chapterId(1));
      const orphan = chapterId(50);
      const md = fakeMd({
        all: [entity(chapterId(1)), atUrl(orphan, "4242")],
        served: [chapterId(1), orphan],
      });

      const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
        dryRun: false,
        actor: "tester",
      });

      expect(report.untrackedFound).toBe(1);
      expect(report.adoptedRecorded).toBe(1);
      const row = await prisma.uploadedChapter.findUnique({ where: { mdChapterId: orphan } });
      expect(row?.extension).toBe("mangaplus");
      expect(row?.mdGroupId).toBe(GROUP);
      expect(row?.mdMangaId).toBe(MANGA);
      expect(row?.chapterUrl).toBe("https://publisher.example/ch/4242");
      expect(row?.chapterNumber).toBe("4242");
      // Readable in the dashboard rather than another bare UUID.
      expect(row?.mangaName).toBe("Test Series");
      // Provenance: nothing else distinguishes a row we inferred off MangaDex
      // from one we wrote because we performed the upload.
      expect(row?.extra).toMatchObject({ adopted: "mangadex-reconcile" });
    });

    it("recovers the publisher chapter id, which is the half the extension needs", async () => {
      await seedHistory(10);
      const orphan = chapterId(50);
      const md = fakeMd({
        all: [atUrl(orphan, "4242")],
        served: [orphan],
      });

      const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
        dryRun: false,
        actor: "tester",
      });

      expect(report.idsRecorded).toBe(1);
      expect(report.groups[0]?.idRule?.segments).toBe(1);
      const row = await prisma.uploadedChapter.findUnique({ where: { mdChapterId: orphan } });
      expect(row?.chapterId).toBe("4242");
      // The row that actually reaches the extension as postedChapterIds.
      const posted = await prisma.uploadedId.findUnique({
        where: { extension_chapterId: { extension: "mangaplus", chapterId: "4242" } },
      });
      expect(posted?.mdChapterId).toBe(orphan);
    });

    it("still records the chapter when no id can be recovered, and says so", async () => {
      // One historical row is not enough evidence to read anything off a URL,
      // so the chapter becomes visible without anything being guessed.
      await seedUploaded(chapterId(1));
      const orphan = chapterId(50);
      const md = fakeMd({ all: [entity(chapterId(1)), atUrl(orphan, "4242")], served: [chapterId(1), orphan] });

      const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
        dryRun: false,
        actor: "tester",
      });

      expect(report.groups[0]?.idRule).toBeNull();
      expect(report.adoptedRecorded).toBe(1);
      expect(report.idsRecorded).toBe(0);
      const row = await prisma.uploadedChapter.findUnique({ where: { mdChapterId: orphan } });
      expect(row?.chapterId).toBeNull();
      expect(await prisma.uploadedId.count()).toBe(0);
    });

    it("never overwrites a row this platform actually uploaded", async () => {
      // Our row carries publisher-side identifiers MangaDex has never known
      // about. A sweep that upserted would replace them with the less-informed
      // version, which is worse than not running at all.
      const known = chapterId(1);
      await seedUploaded(known);
      const md = fakeMd({ all: [atUrl(known, "9999")], served: [known] });

      const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
        dryRun: false,
        actor: "tester",
      });

      expect(report.untrackedFound).toBe(0);
      expect(report.adoptedRecorded).toBe(0);
      const row = await prisma.uploadedChapter.findUnique({ where: { mdChapterId: known } });
      expect(row?.chapterId).toBe("src-7");
      expect(row?.extra).toBeNull();
    });

    it("does not adopt a chapter it has already archived", async () => {
      await seedUploaded(chapterId(1));
      const gone = chapterId(60);
      const marked = chapterId(61);
      await prisma.deletedChapter.create({ data: { mdChapterId: gone, extension: "mangaplus" } });
      await prisma.unavailableChapter.create({
        data: { mdChapterId: marked, extension: "mangaplus" },
      });
      // MangaDex serves both as ordinary live chapters; our archives say
      // otherwise, and adopting them back into `uploaded` would quietly undo
      // the archiving this same command exists to do.
      const md = fakeMd({
        all: [entity(chapterId(1)), atUrl(gone, "1"), atUrl(marked, "2")],
        served: [chapterId(1), gone, marked],
      });

      const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
        dryRun: false,
        actor: "tester",
      });

      expect(report.untrackedFound).toBe(0);
      expect(await prisma.uploadedChapter.findUnique({ where: { mdChapterId: gone } })).toBeNull();
      expect(await prisma.uploadedChapter.findUnique({ where: { mdChapterId: marked } })).toBeNull();
    });

    it("counts the gap on a dry run without writing anything", async () => {
      await seedHistory(10);
      const md = fakeMd({
        all: [atUrl(chapterId(50), "1"), atUrl(chapterId(51), "2")],
        served: [chapterId(50), chapterId(51)],
      });

      const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
        dryRun: true,
        actor: "tester",
      });

      expect(report.untrackedFound).toBe(2);
      expect(report.adoptedRecorded).toBe(2);
      expect(await prisma.uploadedChapter.count()).toBe(10);
      expect(await prisma.uploadedId.count()).toBe(0);
    });

    it("reports the gap but records none of it under skipAdopt", async () => {
      await seedHistory(10);
      const md = fakeMd({ all: [atUrl(chapterId(50), "1")], served: [chapterId(50)] });

      const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
        dryRun: false,
        skipAdopt: true,
        actor: "tester",
      });

      expect(report.untrackedFound).toBe(1);
      expect(report.adoptedRecorded).toBe(0);
      expect(await prisma.uploadedChapter.count()).toBe(10);
    });

    it("measures the id rule only from rows it did not adopt itself", async () => {
      // Otherwise one early mis-parse becomes its own evidence: the adopted
      // rows outnumber the genuine ones within a run or two, and the rule can
      // never be corrected by the history that disagrees with it.
      for (let i = 0; i < 20; i += 1) {
        await prisma.uploadedChapter.create({
          data: {
            mdChapterId: chapterId(300 + i),
            extension: "mangaplus",
            mdGroupId: GROUP,
            chapterId: `wrong-${i}`,
            chapterUrl: `https://publisher.example/ch/wrong-${i}`,
            extra: { adopted: "mangadex-reconcile" },
          },
        });
      }
      const md = fakeMd({ all: [atUrl(chapterId(50), "1")], served: [chapterId(50)] });

      const report = await new ChapterReconciler({ prisma, md, log, audit }).run({
        dryRun: true,
        actor: "tester",
      });

      // Twenty adopted rows would have been ample evidence had they counted.
      expect(report.groups[0]?.idRule).toBeNull();
    });

    it("does not re-ask MangaDex about rows the group walk already answered", async () => {
      // The deletion sweep costs one HTTP call per row it cannot rule out.
      // Adoption can leave the table thousands of rows larger, so the walk's
      // own answer has to be reused rather than re-purchased.
      await seedUploaded(chapterId(1));
      const asked: string[] = [];
      const md = fakeMd({ all: [entity(chapterId(1)), atUrl(chapterId(50), "1")], served: [chapterId(1), chapterId(50)] });
      const counting = {
        ...md,
        chapterById: async (id: string) => {
          asked.push(id);
          return md.chapterById(id);
        },
      } as unknown as MdExtendedApi;

      const report = await new ChapterReconciler({ prisma, md: counting, log, audit }).run({
        dryRun: false,
        actor: "tester",
      });

      expect(asked).toEqual([]);
      expect(report.skippedByGroupWalk).toBe(2);
      expect(report.deletedRecorded).toBe(0);
    });

    it("is safe to run twice: the second pass finds nothing left to adopt", async () => {
      await seedHistory(10);
      const md = fakeMd({ all: [atUrl(chapterId(50), "4242")], served: [chapterId(50)] });
      const reconciler = new ChapterReconciler({ prisma, md, log, audit });

      const first = await reconciler.run({ dryRun: false, actor: "tester" });
      const second = await reconciler.run({ dryRun: false, actor: "tester" });

      expect(first.adoptedRecorded).toBe(1);
      expect(second.untrackedFound).toBe(0);
      expect(second.adoptedRecorded).toBe(0);
      expect(await prisma.uploadedChapter.count()).toBe(11);
      expect(await prisma.uploadedId.count()).toBe(1);
    });
  });
});
