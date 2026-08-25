import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../src/logging.js";
import { RunProcessor } from "../../src/core/processor/processor.js";
import type { MdApi, MdChapter } from "../../src/core/md/types.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * A run that deliberately looked at only part of the catalogue.
 *
 * Removal detection is a comparison: what the publisher lists now, against what
 * MangaDex holds under our group. A whole-catalogue run's `allChapters` means
 * "this is everything the publisher has", and two passes read a tracked title's
 * absence from it as "the publisher dropped this title" — which is right, there,
 * and catastrophically wrong for a run that only ever asked about one series.
 *
 * So the property under test is not "a scoped run finds the removed chapters",
 * though that is here too. It is that a scoped run CANNOT touch a title it did
 * not ask about, and the control case proves the guard is load-bearing rather
 * than decorative: the same envelope, unscoped, unpublishes the other title.
 */
describe.skipIf(!dbReady())("scoped runs", () => {
  const prisma = testPrisma();
  const log = createLogger("test-scoped-run", "error");

  const GROUP = "0a0a0a0a-0000-4000-8000-00000000000a";
  const SERIES_A = "11111111-0000-4000-8000-000000000001";
  const SERIES_B = "22222222-0000-4000-8000-000000000002";
  const BUNDLE = "a".repeat(64);

  beforeEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await closeDb();
  });

  /** One MangaDex chapter of ours, as `chaptersForManga` reports it. */
  function mdChapter(id: string, externalUrl: string | null): MdChapter {
    return {
      id,
      type: "chapter",
      attributes: {
        title: "A chapter",
        volume: null,
        chapter: "1",
        translatedLanguage: "en",
        externalUrl,
        version: 1,
        createdAt: "2026-01-01T00:00:00+00:00",
        updatedAt: "2026-01-01T00:00:00+00:00",
        publishAt: "2026-01-01T00:00:00+00:00",
        readableAt: "2026-01-01T00:00:00+00:00",
        pages: 0,
      },
      relationships: [
        { id: GROUP, type: "scanlation_group" },
        // Which manga a chapter belongs to is read off the relationship, so it
        // has to be here for the removal pass to bucket it.
        { id: externalUrl?.includes("/b/") ? SERIES_B : SERIES_A, type: "manga" },
      ],
    } as unknown as MdChapter;
  }

  /**
   * A MangaDex holding two chapters of each series. Only `chaptersForManga` and
   * `mangaByIds` are reached on this path; the rest throw rather than return
   * something plausible, so a pass that starts calling them fails loudly.
   */
  function fakeMd(): MdApi {
    const holdings: Record<string, MdChapter[]> = {
      [SERIES_A]: [
        mdChapter("aaaa1111-0000-4000-8000-000000000001", "https://publisher.example/a/1"),
        mdChapter("aaaa2222-0000-4000-8000-000000000002", "https://publisher.example/a/2"),
      ],
      [SERIES_B]: [
        mdChapter("bbbb1111-0000-4000-8000-000000000001", "https://publisher.example/b/1"),
        mdChapter("bbbb2222-0000-4000-8000-000000000002", "https://publisher.example/b/2"),
      ],
    };
    const unreached = (name: string) => () => {
      throw new Error(`${name} should not be reached on this path`);
    };
    return {
      chaptersForManga: async (mangaId: string) => holdings[mangaId] ?? [],
      chaptersByIds: async () => [],
      mangaByIds: async (ids: string[]) =>
        ids.map((id) => ({ id, type: "manga", attributes: { title: { en: `Series ${id.slice(0, 1)}` } }, relationships: [] })) as unknown as ReturnType<MdApi["mangaByIds"]> extends Promise<infer T> ? T : never,
      mangaById: unreached("mangaById"),
      searchManga: unreached("searchManga"),
      mangaAggregate: async () => ({ volumes: {} }),
    } as unknown as MdApi;
  }

  /**
   * A run whose single job committed an envelope listing `stillListed` as the
   * publisher's entire current catalogue.
   */
  async function runWithEnvelope(opts: {
    scopeMangaIds: string[];
    stillListed: { mdMangaId: string; mangaId: string; chapterId: string; url: string }[];
  }) {
    for (const [mangaId, mdMangaId] of [
      ["series-a", SERIES_A],
      ["series-b", SERIES_B],
    ]) {
      await prisma.trackedManga.create({
        data: { extension: "testext", mangaId: mangaId!, mdMangaId: mdMangaId! },
      });
    }

    const run = await prisma.run.create({
      data: {
        idempotencyKey: `run:${randomUUID()}`,
        extension: "testext",
        extensionVersion: "1.0.0",
        bundleSha256: BUNDLE,
        kind: "CLEAN",
        state: "INGESTING",
        segmentsTotal: 1,
        scopeMangaIds: opts.scopeMangaIds,
      },
    });
    const job = await prisma.job.create({
      data: {
        idempotencyKey: `job:${randomUUID()}`,
        runId: run.id,
        extension: "testext",
        extensionVersion: "1.0.0",
        bundleSha256: BUNDLE,
        kind: "CLEAN",
        segmentIndex: 0,
        segmentTotal: 1,
        segmentKey: "scope:1",
        state: "SUCCEEDED",
      },
    });

    const chapters = opts.stillListed.map((entry) => ({
      chapterLookup: null,
      chapterTimestamp: null,
      chapterExpire: null,
      chapterLanguage: "en",
      chapterNumber: "1",
      chapterTitle: "A chapter",
      chapterVolume: null,
      chapterId: entry.chapterId,
      chapterUrl: entry.url,
      mdChapterId: null,
      mangaId: entry.mangaId,
      mdMangaId: entry.mdMangaId,
      mdGroupId: GROUP,
      mangaName: "A series",
      mangaUrl: null,
      extensionName: "testext",
      imageArtifacts: [],
    }));

    await prisma.resultSubmission.create({
      data: {
        idempotencyKey: `res:${job.id}:0`,
        jobId: job.id,
        attempt: 0,
        leaseId: randomUUID(),
        workerId: "worker-1",
        state: "COMMITTED",
        envelope: {
          envelopeVersion: 1,
          jobId: job.id,
          leaseId: randomUUID(),
          segmentKey: "scope:1",
          extension: "testext",
          bundleSha256: BUNDLE,
          idempotencyKey: `res:${job.id}:0`,
          status: "ok",
          error: null,
          // On a clean run the extension has no posted ids to exclude, so what
          // it still lists is reported in both arrays. `allChapters` is the one
          // removal is computed from.
          updatedChapters: chapters,
          allChapters: chapters,
          untrackedManga: [],
          trackedMangadexIds: [SERIES_A, SERIES_B],
          mangadexGroupId: GROUP,
          overrideOptions: {},
          extensionLanguages: ["en"],
          stats: {},
        },
      },
    });

    return { run, job };
  }

  const queuedFor = async () =>
    (
      await prisma.uploadTask.findMany({
        where: { kind: { in: ["UNAVAILABLE", "DELETE"] } },
        select: { kind: true, dedupeKey: true },
      })
    ).map((task) => `${task.kind}:${task.dedupeKey}`);

  /** Series A lost its second chapter; series B was never asked about. */
  const A_LOST_ONE = [
    {
      mdMangaId: SERIES_A,
      mangaId: "series-a",
      chapterId: "a1",
      url: "https://publisher.example/a/1",
    },
  ];

  it("marks what the publisher dropped, for the series it asked about", async () => {
    const { run } = await runWithEnvelope({
      scopeMangaIds: [SERIES_A],
      stillListed: A_LOST_ONE,
    });

    const processor = new RunProcessor(prisma, fakeMd(), log);
    await processor.processRun({
      id: run.id,
      extension: "testext",
      bundleSha256: BUNDLE,
      kind: "CLEAN",
      scopeMangaIds: [SERIES_A],
    });

    // The chapter the publisher no longer lists, and only that one.
    expect(await queuedFor()).toEqual(["UNAVAILABLE:aaaa2222-0000-4000-8000-000000000002"]);
  });

  /**
   * The failure this whole mechanism exists to prevent. Series B is tracked,
   * has chapters on MangaDex, and is absent from a snapshot that never claimed
   * to cover it.
   */
  it("cannot touch a series it did not ask about", async () => {
    const { run } = await runWithEnvelope({
      scopeMangaIds: [SERIES_A],
      stillListed: A_LOST_ONE,
    });

    const processor = new RunProcessor(prisma, fakeMd(), log);
    await processor.processRun({
      id: run.id,
      extension: "testext",
      bundleSha256: BUNDLE,
      kind: "CLEAN",
      scopeMangaIds: [SERIES_A],
    });

    const queued = await queuedFor();
    expect(queued.filter((key) => key.includes("bbbb"))).toEqual([]);
  });

  /**
   * The control. Same envelope, no scope: now the snapshot IS a claim about the
   * whole catalogue, and series B's absence from it correctly reads as "the
   * publisher dropped it". If this ever stops queuing B's chapters, the test
   * above has stopped proving anything.
   */
  it("still unpublishes an absent series when the run did claim to cover everything", async () => {
    const { run } = await runWithEnvelope({ scopeMangaIds: [], stillListed: A_LOST_ONE });

    const processor = new RunProcessor(prisma, fakeMd(), log);
    await processor.processRun({
      id: run.id,
      extension: "testext",
      bundleSha256: BUNDLE,
      kind: "CLEAN",
      scopeMangaIds: [],
    });

    const queued = await queuedFor();
    expect(queued.filter((key) => key.includes("bbbb")).sort()).toEqual([
      "UNAVAILABLE:bbbb1111-0000-4000-8000-000000000001",
      "UNAVAILABLE:bbbb2222-0000-4000-8000-000000000002",
    ]);
  });

  /**
   * A scoped run visits its series even with nothing to upload. Normally the
   * per-manga pass only runs for manga that reported an update, which is
   * exactly wrong here: "has this dormant series been pulled?" is asked about
   * series that have published nothing for months.
   */
  it("visits a scoped series that reported no updates at all", async () => {
    const { run } = await runWithEnvelope({ scopeMangaIds: [SERIES_A], stillListed: [] });
    // Nothing listed anywhere: the publisher has dropped series A entirely.
    const processor = new RunProcessor(prisma, fakeMd(), log);
    await processor.processRun({
      id: run.id,
      extension: "testext",
      bundleSha256: BUNDLE,
      kind: "CLEAN",
      scopeMangaIds: [SERIES_A],
    });

    const queued = await queuedFor();
    expect(queued.sort()).toEqual([
      "UNAVAILABLE:aaaa1111-0000-4000-8000-000000000001",
      "UNAVAILABLE:aaaa2222-0000-4000-8000-000000000002",
    ]);
    // And still nothing belonging to the series it never asked about.
    expect(queued.filter((key) => key.includes("bbbb"))).toEqual([]);
  });

  it("marks the run processed either way", async () => {
    const { run } = await runWithEnvelope({ scopeMangaIds: [SERIES_A], stillListed: A_LOST_ONE });
    const processor = new RunProcessor(prisma, fakeMd(), log);
    await processor.processRun({
      id: run.id,
      extension: "testext",
      bundleSha256: BUNDLE,
      kind: "CLEAN",
      scopeMangaIds: [SERIES_A],
    });
    const after = await prisma.run.findUnique({ where: { id: run.id } });
    expect(after?.state).toBe("PROCESSED");
  });
});
