import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { registerQueueRoutes } from "../../src/core/api/routes/queues.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Full operator control of the upload queues.
 *
 * The properties worth proving here are the ones that cost real damage when
 * they regress, and none of them can be checked without a live postgres;
 * SKIP LOCKED claims, a unique (kind, dedupe_key) constraint and guarded
 * single-statement updates are the system under test:
 *
 *  - a LEASED row is refused by EVERY mutating path, and is left byte-identical;
 *  - a purge dry-run writes nothing at all, audit rows included;
 *  - a reorder changes what `claim` actually hands out next, not merely a column;
 *  - hand-enqueueing a duplicate is refused by the constraint that makes double
 *    uploads impossible;
 *  - deleting a DONE row, half of that same guard, needs an explicit flag;
 *  - and the sharpest verb, manual add, is out of a CONTRIBUTOR's reach.
 */
describe.skipIf(!dbReady())("queue management endpoints", () => {
  const prisma = testPrisma();
  const ADMIN_TOKEN = "test-admin-token-0123456789";
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN,
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-queues", "error");
  let app: FastifyInstance;
  let ctx: AppContext;
  const root = { authorization: `Bearer ${ADMIN_TOKEN}` };

  /**
   * server.ts is owned by another module's integrator, so these routes may or
   * may not be wired into `buildServer` yet. Probe a throwaway instance and
   * register them by hand only when they are absent; registering twice would
   * throw on duplicate routes, and skipping when they are wired would test a
   * different server than production runs. Routes inside `app.register(…)` do
   * not exist until the plugin boots, hence the ready-then-check.
   */
  async function buildApp(): Promise<FastifyInstance> {
    const probe = buildServer(ctx);
    await probe.ready();
    if (probe.hasRoute({ method: "GET", url: "/api/v1/admin/queues/tasks" })) return probe;
    await probe.close();
    const fresh = buildServer(ctx);
    registerQueueRoutes(fresh, ctx);
    await fresh.ready();
    return fresh;
  }

  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.apiToken.deleteMany({});
    ctx = buildContext(prisma, config, log);
    app = await buildApp();
    expect(app.hasRoute({ method: "GET", url: "/api/v1/admin/queues/tasks" })).toBe(true);
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  /** A scoped `pa_…` credential carrying exactly `scopes`. */
  async function mint(scopes: string[]): Promise<Record<string, string>> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tokens",
      headers: root,
      payload: { name: `queues-${scopes.join("-")}`, scopes },
    });
    expect(res.statusCode).toBe(201);
    return { authorization: `Bearer ${res.json().token}` };
  }

  let seq = 0;
  const task = (overrides: Record<string, unknown> = {}) =>
    prisma.uploadTask.create({
      data: {
        kind: "UPLOAD",
        dedupeKey: `ext-chapter-${(seq += 1)}|${seq}|en`,
        chapter: { chapterNumber: String(seq), chapterLanguage: "en" },
        ...overrides,
      },
    });

  /** A LEASED row with a live lease; the thing nothing here may touch. */
  const LEASE_ID = "11111111-1111-4111-8111-111111111111";
  const leasedTask = (overrides: Record<string, unknown> = {}) =>
    task({
      state: "LEASED",
      leaseId: LEASE_ID,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attempt: 1,
      ...overrides,
    });

  /** A chapter payload complete enough for taskWorkers to execute an UPLOAD. */
  const uploadChapter = (overrides: Record<string, unknown> = {}) => ({
    chapterId: "src-4001",
    chapterNumber: "12",
    chapterLanguage: "en",
    chapterTitle: "Hand-queued",
    mdMangaId: "9a1b1c1d-0000-4000-8000-000000000000",
    mdGroupId: "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
    mangaName: "Test Series",
    extensionName: "queuetest",
    ...overrides,
  });

  const csrf = { "x-requested-with": "publoader-dash" };

  /** A logged-in session cookie for a fresh account with `role`. */
  async function sessionAs(role: "OWNER" | "ADMIN" | "CONTRIBUTOR", email: string): Promise<Record<string, string>> {
    await ctx.adminUsers.ensureOwner("owner@example.com");
    const password = "correct-horse-battery-staple";
    if (role === "OWNER") {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/admin/session",
        payload: { token: ADMIN_TOKEN, actor: "ardax" },
      });
      const value = login.cookies.find((c) => c.name === "publoader_session")!.value;
      return { cookie: `publoader_session=${value}`, ...csrf };
    }
    const user = await ctx.adminUsers.invite(email, role);
    await ctx.adminUsers.setPassword(user.id, password);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    const value = login.cookies.find((c) => c.name === "publoader_session")!.value;
    return { cookie: `publoader_session=${value}`, ...csrf };
  }

  // ---- list ----

  it("lists the queue in claim order with filters, a total, and a summary", async () => {
    const later = await task({ notBefore: new Date(Date.now() + 60_000) });
    const soon = await task({ notBefore: new Date(Date.now() - 60_000) });
    const dead = await task({ kind: "EDIT", state: "DEAD_LETTER", attempt: 5, lastError: "md said no" });
    await task({ kind: "DELETE", state: "DONE" });

    const all = await app.inject({ method: "GET", url: "/api/v1/admin/queues/tasks", headers: root });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(4);
    expect(all.json().order).toBe("notBefore,createdAt,id");
    // Claim order, not recency: `soon` is due before `later`, whatever their
    // created_at. This is the ordering a reorder rewrites, which is why the list
    // has to use it rather than `updated_at DESC`.
    const ids = all.json().tasks.map((t: { id: string }) => t.id);
    expect(ids.indexOf(soon.id)).toBeLessThan(ids.indexOf(later.id));
    // The payload is large and worker-supplied; the list view omits it.
    expect(all.json().tasks[0].chapter).toBeUndefined();
    expect(all.json().summary).toEqual(
      expect.arrayContaining([
        { kind: "EDIT", state: "DEAD_LETTER", count: 1 },
        { kind: "DELETE", state: "DONE", count: 1 },
      ]),
    );

    const byState = await app.inject({
      method: "GET",
      url: "/api/v1/admin/queues/tasks?kind=EDIT&state=DEAD_LETTER",
      headers: root,
    });
    expect(byState.json().total).toBe(1);
    expect(byState.json().tasks[0].id).toBe(dead.id);
    // The summary stays global so a narrow filter cannot hide a backing-up queue.
    expect(byState.json().summary.length).toBeGreaterThan(1);

    // Repeated params are a one-or-more set.
    const twoKinds = await app.inject({
      method: "GET",
      url: "/api/v1/admin/queues/tasks?kind=EDIT&kind=DELETE",
      headers: root,
    });
    expect(twoKinds.json().total).toBe(2);

    const bySubstring = await app.inject({
      method: "GET",
      url: `/api/v1/admin/queues/tasks?dedupeKey=${encodeURIComponent(dead.dedupeKey.slice(4, 14))}`,
      headers: root,
    });
    expect(bySubstring.json().total).toBe(1);

    const byAttempt = await app.inject({
      method: "GET",
      url: "/api/v1/admin/queues/tasks?attemptMin=1",
      headers: root,
    });
    expect(byAttempt.json().total).toBe(1);
    expect(byAttempt.json().tasks[0].id).toBe(dead.id);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/queues/tasks?state=NOPE",
          headers: root,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/queues/tasks?attemptMin=9&attemptMax=2",
          headers: root,
        })
      ).statusCode,
    ).toBe(400);
  });

  /**
   * A queue row has to name the chapter it is about.
   *
   * `taskDedupeKey` returns the bare MangaDex chapter UUID for EDIT, DELETE and
   * UNAVAILABLE, so before `identity` the only column identifying those rows was
   * an opaque id; "what is scheduled to be marked unavailable?" could not be
   * answered from the list at all, only by opening rows one at a time. The
   * payload itself must still stay server-side, which is the pair of properties
   * asserted here.
   */
  it("names the chapter on every listed row without shipping the payload", async () => {
    await task({
      kind: "UNAVAILABLE",
      dedupeKey: "8f14e45f-ce49-4f7a-9f11-000000000001",
      chapter: {
        mdChapterId: "8f14e45f-ce49-4f7a-9f11-000000000001",
        mdMangaId: "9a1b1c1d-0000-4000-8000-000000000000",
        mangaName: "Blue Lock",
        chapterNumber: "12",
        chapterVolume: "3",
        chapterTitle: "The Awakening",
        chapterLanguage: "en",
        extensionName: "mangaplus",
        // A sidecar the uploader reads and the list must not leak.
        unavailableAt: "2026-08-05T00:00:00.000Z",
      },
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/admin/queues/tasks", headers: root });
    expect(res.statusCode).toBe(200);
    const [row] = res.json().tasks;
    expect(row.identity).toEqual({
      extension: "mangaplus",
      mangaName: "Blue Lock",
      mdMangaId: "9a1b1c1d-0000-4000-8000-000000000000",
      mdChapterId: "8f14e45f-ce49-4f7a-9f11-000000000001",
      chapterNumber: "12",
      chapterVolume: "3",
      chapterTitle: "The Awakening",
      chapterLanguage: "en",
    });
    expect(row.chapter).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain("unavailableAt");
  });

  /** A payload with none of the identity keys must not break the projection. */
  it("returns a null-valued identity rather than failing on a bare payload", async () => {
    await task({ chapter: {} });
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/queues/tasks", headers: root });
    expect(res.statusCode).toBe(200);
    expect(res.json().tasks[0].identity).toEqual({
      extension: null,
      mangaName: null,
      mdMangaId: null,
      mdChapterId: null,
      chapterNumber: null,
      chapterVolume: null,
      chapterTitle: null,
      chapterLanguage: null,
    });
  });

  it("filters by extension, language and a chapter substring", async () => {
    const target = await task({
      kind: "UNAVAILABLE",
      dedupeKey: "aaaaaaaa-0000-4000-8000-000000000001",
      chapter: {
        mdChapterId: "aaaaaaaa-0000-4000-8000-000000000001",
        mangaName: "Blue Lock",
        chapterTitle: "The Awakening",
        chapterNumber: "12",
        chapterLanguage: "en",
        extensionName: "mangaplus",
      },
    });
    await task({
      kind: "UNAVAILABLE",
      dedupeKey: "bbbbbbbb-0000-4000-8000-000000000002",
      chapter: {
        mdChapterId: "bbbbbbbb-0000-4000-8000-000000000002",
        mangaName: "Other Series",
        chapterNumber: "3",
        chapterLanguage: "es",
        extensionName: "comikey",
      },
    });

    const only = async (query: string) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/admin/queues/tasks?${query}`,
        headers: root,
      });
      expect(res.statusCode).toBe(200);
      return res.json();
    };

    expect((await only("extension=mangaplus")).total).toBe(1);
    expect((await only("extension=mangaplus")).tasks[0].id).toBe(target.id);
    // Exact, not a prefix: a substring match here would make "mangaplus" also
    // select a hypothetical "mangaplus-jp" and quietly widen a bulk verb.
    expect((await only("extension=manga")).total).toBe(0);
    expect((await only("language=es")).total).toBe(1);

    // One substring box over series, title, number and both MangaDex ids.
    expect((await only("q=blue%20lock")).tasks[0].id).toBe(target.id);
    expect((await only("q=awakening")).tasks[0].id).toBe(target.id);
    expect((await only("q=aaaaaaaa")).tasks[0].id).toBe(target.id);
    expect((await only("q=nothing-matches-this")).total).toBe(0);

    // Payload predicates AND with the column ones rather than replacing them.
    expect((await only("extension=mangaplus&state=FAILED")).total).toBe(0);
  });

  /**
   * The filters must narrow the destructive verbs too, not just the read.
   *
   * They live in `FilterShape`, which every bulk endpoint spreads, so "purge the
   * failed mangaplus rows" is one call. If that composition ever broke, the
   * failure mode is a purge that deletes another extension's queue.
   */
  it("narrows a purge by payload, and audits the filter that was used", async () => {
    for (const ext of ["mangaplus", "comikey"]) {
      await task({
        state: "FAILED",
        dedupeKey: `${ext}-fail`,
        chapter: { mangaName: "Blue Lock", extensionName: ext, chapterLanguage: "en" },
      });
    }

    const purge = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/purge",
      headers: root,
      payload: { extension: "mangaplus", dryRun: false, confirm: true },
    });
    expect(purge.statusCode).toBe(200);
    expect(purge.json().deleted).toBe(1);

    const left = await prisma.uploadTask.findMany({ select: { dedupeKey: true } });
    expect(left.map((r) => r.dedupeKey)).toEqual(["comikey-fail"]);

    // The audit row is the only surviving record of a purge, so it has to carry
    // the narrowing keys; logging just {kind, state} would describe a far wider
    // deletion than the one that ran.
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "queue.purge" },
      orderBy: { createdAt: "desc" },
    });
    expect((event.detail as { filter: Record<string, unknown> }).filter).toEqual({
      extension: "mangaplus",
    });
  });

  it("pages with a cursor, and refuses a cursor it did not issue", async () => {
    for (let i = 0; i < 5; i++) await task({ notBefore: new Date(Date.now() - (10 - i) * 1000) });

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/admin/queues/tasks?limit=2",
      headers: root,
    });
    expect(first.json().tasks).toHaveLength(2);
    expect(first.json().total).toBe(5);
    expect(first.json().nextCursor).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/admin/queues/tasks?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: root,
    });
    expect(second.json().tasks).toHaveLength(2);
    // Disjoint pages, still in claim order.
    const firstIds = first.json().tasks.map((t: { id: string }) => t.id);
    const secondIds = second.json().tasks.map((t: { id: string }) => t.id);
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);

    const last = await app.inject({
      method: "GET",
      url: `/api/v1/admin/queues/tasks?limit=2&cursor=${encodeURIComponent(second.json().nextCursor)}`,
      headers: root,
    });
    expect(last.json().tasks).toHaveLength(1);
    expect(last.json().nextCursor).toBeNull();

    const bad = await app.inject({
      method: "GET",
      url: "/api/v1/admin/queues/tasks?cursor=not-a-cursor",
      headers: root,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("returns one task with its chapter payload for the edit view", async () => {
    const row = await task({ chapter: uploadChapter() });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admin/queues/tasks/${row.id}`,
      headers: root,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.chapter).toMatchObject({ chapterNumber: "12", mdGroupId: expect.any(String) });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/queues/tasks/00000000-0000-4000-8000-000000000000",
          headers: root,
        })
      ).statusCode,
    ).toBe(404);
  });

  // ---- retry ----

  it("retries a failed task with a fresh budget, single and in bulk", async () => {
    const failed = await task({ state: "FAILED", attempt: 4, lastError: "md 503" });
    const dead = await task({ state: "DEAD_LETTER", attempt: 5 });
    const done = await task({ state: "DONE" });

    const single = await app.inject({
      method: "POST",
      url: `/api/v1/admin/queues/tasks/${failed.id}/retry`,
      headers: root,
    });
    expect(single.statusCode).toBe(200);
    expect(single.json()).toMatchObject({ ok: true, outcome: "retried" });
    const after = await prisma.uploadTask.findUniqueOrThrow({ where: { id: failed.id } });
    // The budget resets because the operator asserts the cause is fixed.
    expect(after).toMatchObject({ state: "PENDING", attempt: 0, leaseId: null });
    expect(after.notBefore.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await prisma.auditEvent.count({ where: { action: "queue.retry" } })).toBe(1);

    // Already PENDING: a conflict, not a silent no-op.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/admin/queues/tasks/${failed.id}/retry`,
      headers: root,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().outcome).toBe("wrong_state");
    expect(again.json().error).toContain("PENDING");

    // Bulk: one result per requested id, whatever happened to each.
    const bulk = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/retry",
      headers: root,
      payload: { ids: [dead.id, done.id, "00000000-0000-4000-8000-000000000000"] },
    });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.json()).toMatchObject({ requested: 3, changed: 1, refused: 2 });
    const byId = Object.fromEntries(
      (bulk.json().results as { id: string; outcome: string }[]).map((r) => [r.id, r.outcome]),
    );
    expect(byId[dead.id]).toBe("retried");
    expect(byId[done.id]).toBe("wrong_state");
    expect(byId["00000000-0000-4000-8000-000000000000"]).toBe("not_found");
    expect((await prisma.uploadTask.findUniqueOrThrow({ where: { id: done.id } })).state).toBe("DONE");
  });

  it("retries by filter, selecting only the rows a retry can move", async () => {
    const failed = await task({ state: "FAILED", attempt: 3 });
    const dead = await task({ state: "DEAD_LETTER", attempt: 5 });
    const pending = await task({ state: "PENDING" });
    const otherKind = await task({ kind: "DELETE", state: "FAILED", attempt: 2 });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/retry",
      headers: root,
      payload: { filter: { kind: "UPLOAD" } },
    });
    expect(res.statusCode).toBe(200);
    // A filter names a set, so it is intersected with the retryable states
    // rather than producing a pile of "this row is PENDING" refusals.
    expect(res.json()).toMatchObject({ requested: 2, changed: 2, refused: 0 });
    for (const id of [failed.id, dead.id]) {
      expect((await prisma.uploadTask.findUniqueOrThrow({ where: { id } })).attempt).toBe(0);
    }
    expect((await prisma.uploadTask.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe("PENDING");
    expect((await prisma.uploadTask.findUniqueOrThrow({ where: { id: otherKind.id } })).state).toBe("FAILED");

    const bothOrNeither = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/retry",
      headers: root,
      payload: { ids: [failed.id], filter: { kind: "UPLOAD" } },
    });
    expect(bothOrNeither.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/queues/retry", headers: root, payload: {} })).statusCode).toBe(400);
  });

  // ---- remove ----

  it("removes rows only with confirm, and never a DONE row by accident", async () => {
    const pending = await task({ state: "PENDING" });
    const done = await task({ state: "DONE" });

    const unconfirmed = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/queues/tasks/${pending.id}`,
      headers: root,
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toContain("confirm");
    expect(await prisma.uploadTask.count({ where: { id: pending.id } })).toBe(1);

    // "false" as a query word must not read as true; this is the flag guarding
    // a permanent delete.
    const lying = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/queues/tasks/${pending.id}?confirm=false`,
      headers: root,
    });
    expect(lying.statusCode).toBe(400);
    expect(await prisma.uploadTask.count({ where: { id: pending.id } })).toBe(1);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/queues/tasks/${pending.id}`,
      headers: root,
      payload: { confirm: true },
    });
    expect(removed.statusCode).toBe(200);
    // The response names what went: these rows no longer exist to look up.
    expect(removed.json().deleted).toMatchObject({ id: pending.id, kind: "UPLOAD", state: "PENDING" });
    expect(await prisma.uploadTask.count({ where: { id: pending.id } })).toBe(0);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "queue.remove" } });
    expect(event.subject).toBe(pending.id);

    // A DONE row is half of the double-upload guard: refused, with the flag named.
    const refused = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/queues/tasks/${done.id}`,
      headers: root,
      payload: { confirm: true },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().hint).toContain("includeCompleted");
    expect(refused.json().hint).toContain("double-upload");
    expect(await prisma.uploadTask.count({ where: { id: done.id } })).toBe(1);

    const forced = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/queues/tasks/${done.id}`,
      headers: root,
      payload: { confirm: true, includeCompleted: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().warning).toContain("re-enqueue");
    expect(await prisma.uploadTask.count({ where: { id: done.id } })).toBe(0);
  });

  it("removes in bulk and reports each row's fate", async () => {
    const a = await task({ state: "PENDING" });
    const b = await task({ state: "DEAD_LETTER" });
    const done = await task({ state: "DONE" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/remove",
      headers: root,
      payload: { ids: [a.id, b.id, done.id], confirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toHaveLength(2);
    expect(res.json().refused).toBe(1);
    expect(await prisma.uploadTask.count()).toBe(1);

    const unconfirmed = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/remove",
      headers: root,
      payload: { ids: [done.id] },
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(await prisma.uploadTask.count()).toBe(1);
  });

  // ---- purge ----

  it("purges nothing until told twice, and never a LEASED row", async () => {
    for (let i = 0; i < 3; i++) await task({ state: "DEAD_LETTER" });
    await task({ state: "PENDING" });
    const leased = await leasedTask();
    const done = await task({ state: "DONE" });
    const before = await prisma.uploadTask.count();

    // A first call with no flags at all is a dry run: that default IS the safety
    // property.
    const dry = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/purge",
      headers: root,
      payload: { state: "DEAD_LETTER" },
    });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, matched: 3, wouldDelete: 3 });
    expect(dry.json().sample).toHaveLength(3);
    expect(dry.json().breakdown).toEqual([{ kind: "UPLOAD", state: "DEAD_LETTER", count: 3 }]);
    // Nothing written; not one row, and not an audit event either. A dry run
    // reports an intention, so even the log stays untouched.
    expect(await prisma.uploadTask.count()).toBe(before);
    expect(await prisma.auditEvent.count({ where: { action: { startsWith: "queue." } } })).toBe(0);

    // dryRun: false alone is not enough.
    const halfArmed = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/purge",
      headers: root,
      payload: { state: "DEAD_LETTER", dryRun: false },
    });
    expect(halfArmed.statusCode).toBe(400);
    expect(halfArmed.json().error).toContain("confirm");
    expect(await prisma.uploadTask.count()).toBe(before);

    const live = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/purge",
      headers: root,
      payload: { state: "DEAD_LETTER", dryRun: false, confirm: true },
    });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ dryRun: false, deleted: 3, remaining: 0 });
    expect(await prisma.uploadTask.count()).toBe(before - 3);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "queue.purge" } });
    // The ids are the only surviving record that those rows existed.
    expect((event.detail as { rows: unknown[] }).rows).toHaveLength(3);

    // An unfiltered purge takes the queue but leaves the leased row and the DONE
    // row standing.
    const everything = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/purge",
      headers: root,
      payload: { dryRun: false, confirm: true },
    });
    expect(everything.statusCode).toBe(200);
    const survivors = await prisma.uploadTask.findMany({ select: { id: true, state: true } });
    expect(survivors.map((row) => row.id).sort()).toEqual([leased.id, done.id].sort());
    expect(await prisma.uploadTask.findUniqueOrThrow({ where: { id: leased.id } })).toMatchObject({
      state: "LEASED",
      leaseId: LEASE_ID,
    });

    // Asking for a protected state is a 400 that says why, not a cheerful zero.
    const protectedOnly = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/purge",
      headers: root,
      payload: { state: "LEASED", dryRun: false, confirm: true },
    });
    expect(protectedOnly.statusCode).toBe(400);
    expect(protectedOnly.json().error).toContain("LEASED");
    const doneOnly = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/purge",
      headers: root,
      payload: { state: "DONE", dryRun: false, confirm: true },
    });
    expect(doneOnly.statusCode).toBe(400);
    expect(doneOnly.json().error).toContain("includeCompleted");
    expect(await prisma.uploadTask.count({ where: { id: done.id } })).toBe(1);
  });

  it("counts protected rows in a dry run instead of hiding them", async () => {
    await task({ state: "PENDING" });
    await leasedTask();

    const dry = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/purge",
      headers: root,
      payload: { kind: "UPLOAD" },
    });
    // matched is what the operator's filter selects; wouldDelete is what may go.
    expect(dry.json()).toMatchObject({ matched: 2, wouldDelete: 1, protectedRows: 1 });
  });

  // ---- enqueue pacing ----

  it("dates a newly queued row behind the queue's tail rather than on top of it", async () => {
    // The gap this closes: re-spacing fixes the rows that exist, and the next
    // run used to pile straight back on top of them.
    await ctx.uploadTasks.enqueue("UPLOAD", "paced-a|1|en", { chapterNumber: "1" }, { spacingSeconds: 60 });
    await ctx.uploadTasks.enqueue("UPLOAD", "paced-b|2|en", { chapterNumber: "2" }, { spacingSeconds: 60 });
    await ctx.uploadTasks.enqueue("UPLOAD", "paced-c|3|en", { chapterNumber: "3" }, { spacingSeconds: 60 });

    const rows = await prisma.uploadTask.findMany({
      where: { dedupeKey: { startsWith: "paced-" } },
      orderBy: { notBefore: "asc" },
    });
    expect(rows).toHaveLength(3);
    const times = rows.map((r) => r.notBefore.getTime());
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(59_000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(59_000);
  });

  it("makes the first row of an empty queue due now", async () => {
    // `max()` over no rows is NULL and `greatest` ignores NULLs, so there is
    // nothing to queue behind and pacing must not push the first row out.
    const before = Date.now();
    await ctx.uploadTasks.enqueue("UPLOAD", "solo|1|en", { chapterNumber: "1" }, { spacingSeconds: 600 });

    const row = await prisma.uploadTask.findFirstOrThrow({ where: { dedupeKey: "solo|1|en" } });
    expect(row.notBefore.getTime()).toBeLessThanOrEqual(before + 5_000);

    // ...and it is genuinely claimable, not merely dated in the past.
    expect((await ctx.uploadTasks.claim("UPLOAD", 60))?.id).toBe(row.id);
  });

  it("paces only against its own kind, and not at all without a gap", async () => {
    // An EDIT backlog must not push an UPLOAD into next week: the queues drain
    // independently, so their tails are unrelated.
    await ctx.uploadTasks.enqueue("EDIT", "md-chapter-1", { chapterNumber: "1" }, { spacingSeconds: 3600 });
    await ctx.uploadTasks.enqueue("EDIT", "md-chapter-2", { chapterNumber: "2" }, { spacingSeconds: 3600 });

    const at = Date.now();
    await ctx.uploadTasks.enqueue("UPLOAD", "unpaced|1|en", { chapterNumber: "1" }, { spacingSeconds: 3600 });
    const upload = await prisma.uploadTask.findFirstOrThrow({ where: { dedupeKey: "unpaced|1|en" } });
    expect(upload.notBefore.getTime()).toBeLessThanOrEqual(at + 5_000);

    // No gap at all is the old behaviour, unchanged.
    await ctx.uploadTasks.enqueue("UPLOAD", "nogap|2|en", { chapterNumber: "2" });
    const plain = await prisma.uploadTask.findFirstOrThrow({ where: { dedupeKey: "nogap|2|en" } });
    expect(plain.notBefore.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  // ---- per-queue budgets ----

  it("counts each queue's day against its own allowance, not a shared one", async () => {
    // The property that matters: an upload backlog must not spend the budget an
    // edit needs. Both queues get rows in the same bucket; each must see only
    // its own.
    const DAY = 24 * 3600 * 1000;
    await task({ kind: "UPLOAD", chapter: { mdMangaId: "m1" } });
    await task({ kind: "UPLOAD", chapter: { mdMangaId: "m1" } });
    await task({ kind: "UPLOAD", chapter: { mdMangaId: "m1" } });
    await task({ kind: "EDIT", chapter: { mdMangaId: "m1" } });

    const uploads = await ctx.uploadTasks.scheduledLoad(DAY, new Date(), undefined, "UPLOAD");
    const edits = await ctx.uploadTasks.scheduledLoad(DAY, new Date(), undefined, "EDIT");

    const total = (load: { total: Map<number, number> }) =>
      [...load.total.values()].reduce((a, b) => a + b, 0);
    expect(total(uploads)).toBe(3);
    expect(total(edits)).toBe(1);

    // And the default is UPLOAD, so existing callers keep their meaning.
    expect(total(await ctx.uploadTasks.scheduledLoad(DAY))).toBe(3);
  });

  it("resolves a queue's schedule from its own override, falling back to the global", async () => {
    await ctx.settings.setUploadSchedule({ spacingSeconds: 30 });
    await ctx.settings.setUploadScheduleKind("EDIT", { spacingSeconds: 5 });

    // The queue with an override uses it; every other queue follows the global.
    expect((await ctx.settings.getUploadSchedule(undefined, "EDIT")).spacingSeconds).toBe(5);
    expect((await ctx.settings.getUploadSchedule(undefined, "UPLOAD")).spacingSeconds).toBe(30);
    expect((await ctx.settings.getUploadSchedule(undefined, "DELETE")).spacingSeconds).toBe(30);
    // Asking without a kind is still the plain global.
    expect((await ctx.settings.getUploadSchedule()).spacingSeconds).toBe(30);

    // Clearing puts the queue back on the global.
    await ctx.settings.setUploadScheduleKind("EDIT", null);
    expect((await ctx.settings.getUploadSchedule(undefined, "EDIT")).spacingSeconds).toBe(30);
  });

  it("lets an extension override beat a queue's own pace", async () => {
    // Narrowest wins: pinning one publisher's pace means it for that
    // publisher's work, whichever queue the work lands in.
    await ctx.settings.setUploadSchedule({ spacingSeconds: 30 });
    await ctx.settings.setUploadScheduleKind("EDIT", { spacingSeconds: 5 });
    await ctx.settings.setUploadScheduleOverride("comikey", { spacingSeconds: 900 });

    expect((await ctx.settings.getUploadSchedule("comikey", "EDIT")).spacingSeconds).toBe(900);
    expect((await ctx.settings.getUploadSchedule("mangaplus", "EDIT")).spacingSeconds).toBe(5);
  });

  it("edits one queue's pace over the API and leaves the others alone", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/upload-schedule/kinds/DELETE",
      headers: root,
      payload: { spacingSeconds: 120 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "DELETE", cleared: false });
    expect(res.json().effective.spacingSeconds).toBe(120);

    const read = await app.inject({
      method: "GET",
      url: "/api/v1/admin/upload-schedule",
      headers: root,
    });
    expect(read.json().kinds).toEqual({ DELETE: { spacingSeconds: 120 } });
    expect(read.json().queueKinds).toContain("RESTORE");

    // An empty body clears rather than pinning the numbers on screen.
    const cleared = await app.inject({
      method: "POST",
      url: "/api/v1/admin/upload-schedule/kinds/DELETE",
      headers: root,
      payload: {},
    });
    expect(cleared.json()).toMatchObject({ cleared: true });
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/admin/upload-schedule",
      headers: root,
    });
    expect(after.json().kinds).toEqual({});
  });

  it("refuses a queue name that is not a queue", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/upload-schedule/kinds/NOPE",
      headers: root,
      payload: { spacingSeconds: 10 },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---- restagger ----

  it("gives every pending row its own time, in the order the queue already had", async () => {
    // All three due at once: the state a pulled-forward queue is in, and the
    // one the uploader drains back to back.
    const at = new Date(Date.now() - 60_000);
    const first = await task({ notBefore: at });
    const second = await task({ notBefore: at });
    const third = await task({ notBefore: at });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/restagger",
      headers: root,
      payload: { gapSeconds: 60 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ moved: 3, gapSeconds: 60, spansSeconds: 120 });

    const rows = await prisma.uploadTask.findMany({
      where: { id: { in: [first.id, second.id, third.id] } },
      orderBy: { notBefore: "asc" },
    });
    // Distinct times, a minute apart, and the claim order preserved.
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id, third.id]);
    const times = rows.map((r) => r.notBefore.getTime());
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(59_000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(59_000);

    // The head is not delayed: pacing a queue should not stall its front.
    const claimed = await ctx.uploadTasks.claim("UPLOAD", 60);
    expect(claimed?.id).toBe(first.id);
    expect(await prisma.auditEvent.count({ where: { action: "queue.restagger" } })).toBe(1);
  });

  it("leaves a leased row alone while re-spacing the rest", async () => {
    const a = await task({ notBefore: new Date(Date.now() - 30_000) });
    await task({ notBefore: new Date(Date.now() - 20_000) });

    // `a` is now LEASED, so a worker is mid-way through it and its date means
    // nothing; re-spacing must not touch it.
    const leased = await ctx.uploadTasks.claim("UPLOAD", 300);
    expect(leased?.id).toBe(a.id);
    const before = await prisma.uploadTask.findUniqueOrThrow({ where: { id: a.id } });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/restagger",
      headers: root,
      payload: { gapSeconds: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ moved: 1 });

    const after = await prisma.uploadTask.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.notBefore.getTime()).toBe(before.notBefore.getTime());
    expect(after.state).toBe("LEASED");
  });

  it("refuses a gap that is not a positive number of seconds", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/restagger",
      headers: root,
      payload: { gapSeconds: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---- reorder ----

  it("moves a task to the front of the queue the uploader actually claims from", async () => {
    const first = await task({ notBefore: new Date(Date.now() - 30_000) });
    const second = await task({ notBefore: new Date(Date.now() - 20_000) });
    const third = await task({ notBefore: new Date(Date.now() - 10_000) });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/reorder",
      headers: root,
      payload: { ids: [third.id], mode: "front" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: "front", moved: 1, refused: 0 });

    // The claim is the assertion: reordering that did not change what comes out
    // of the queue would be a column update and nothing more.
    const claimed = await ctx.uploadTasks.claim("UPLOAD", 60);
    expect(claimed?.id).toBe(third.id);
    expect(await prisma.auditEvent.count({ where: { action: "queue.reorder" } })).toBe(1);

    // ...and the rest kept their relative order behind it.
    const next = await ctx.uploadTasks.claim("UPLOAD", 60);
    expect(next?.id).toBe(first.id);
    const after = await ctx.uploadTasks.claim("UPLOAD", 60);
    expect(after?.id).toBe(second.id);
  });

  it("reorders a group among itself, sends rows to the back, and defers them", async () => {
    const a = await task({ notBefore: new Date(Date.now() - 30_000) });
    const b = await task({ notBefore: new Date(Date.now() - 20_000) });
    const c = await task({ notBefore: new Date(Date.now() - 10_000) });

    // sequence: the group keeps its slot in the queue, its internal order flips.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/reorder",
      headers: root,
      payload: { ids: [c.id, b.id, a.id], mode: "sequence" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ordered.map((row: { id: string }) => row.id)).toEqual([c.id, b.id, a.id]);
    expect((await ctx.uploadTasks.claim("UPLOAD", 60))?.id).toBe(c.id);

    // back: behind every other pending row.
    const backwards = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/reorder",
      headers: root,
      payload: { ids: [b.id], mode: "back" },
    });
    expect(backwards.statusCode).toBe(200);
    const [rowA, rowB] = await Promise.all([
      prisma.uploadTask.findUniqueOrThrow({ where: { id: a.id } }),
      prisma.uploadTask.findUniqueOrThrow({ where: { id: b.id } }),
    ]);
    expect(rowB.notBefore.getTime()).toBeGreaterThan(rowA.notBefore.getTime());

    // defer: pushed into the future, so it is no longer claimable at all.
    const deferred = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/reorder",
      headers: root,
      payload: { ids: [a.id], mode: "defer", deferSeconds: 3600 },
    });
    expect(deferred.statusCode).toBe(200);
    expect(
      (await prisma.uploadTask.findUniqueOrThrow({ where: { id: a.id } })).notBefore.getTime(),
    ).toBeGreaterThan(Date.now() + 3_000_000);
    // Only `b` is left due, and `a` is not handed out despite being oldest.
    expect((await ctx.uploadTasks.claim("UPLOAD", 60))?.id).toBe(b.id);
    expect(await ctx.uploadTasks.claim("UPLOAD", 60)).toBeNull();

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/queues/reorder",
          headers: root,
          payload: { ids: [a.id], mode: "defer" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("reorders only PENDING rows", async () => {
    const dead = await task({ state: "DEAD_LETTER" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/reorder",
      headers: root,
      payload: { ids: [dead.id], mode: "front" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ moved: 0, refused: 1 });
    expect(res.json().results[0]).toMatchObject({ outcome: "wrong_state", state: "DEAD_LETTER" });
  });

  // ---- the LEASED invariant, on every mutating path ----

  it("refuses to touch a LEASED task from any endpoint, and leaves it identical", async () => {
    const leased = await leasedTask();
    const snapshot = await prisma.uploadTask.findUniqueOrThrow({ where: { id: leased.id } });

    const calls: { name: string; res: Awaited<ReturnType<typeof app.inject>> }[] = [
      {
        name: "retry",
        res: await app.inject({
          method: "POST",
          url: `/api/v1/admin/queues/tasks/${leased.id}/retry`,
          headers: root,
        }),
      },
      {
        name: "delete",
        res: await app.inject({
          method: "DELETE",
          url: `/api/v1/admin/queues/tasks/${leased.id}`,
          headers: root,
          payload: { confirm: true, includeCompleted: true },
        }),
      },
      {
        name: "patch",
        res: await app.inject({
          method: "PATCH",
          url: `/api/v1/admin/queues/tasks/${leased.id}`,
          headers: root,
          payload: { notBefore: new Date().toISOString() },
        }),
      },
    ];
    for (const { name, res } of calls) {
      expect(res.statusCode, `${name} must refuse a LEASED row`).toBe(409);
      // The refusal names the lease, so an operator can correlate with the
      // uploader's logs instead of guessing who owns the row.
      expect(res.json().error, `${name} must name the lease`).toContain(LEASE_ID);
    }

    for (const [path, payload] of [
      ["/api/v1/admin/queues/retry", { ids: [leased.id] }],
      ["/api/v1/admin/queues/remove", { ids: [leased.id], confirm: true, includeCompleted: true }],
      ["/api/v1/admin/queues/reorder", { ids: [leased.id], mode: "front" }],
    ] as const) {
      const res = await app.inject({ method: "POST", url: path, headers: root, payload });
      expect(res.statusCode, `${path} bulk`).toBe(200);
      const result = res.json().results[0];
      expect(result.outcome, `${path} bulk outcome`).toBe("leased");
      expect(result.leaseId).toBe(LEASE_ID);
      expect(result.reason).toContain("requeue-stale");
    }

    // Byte-identical: no half-applied change from any of the seven refusals.
    expect(await prisma.uploadTask.findUniqueOrThrow({ where: { id: leased.id } })).toEqual(snapshot);
  });

  // ---- manual add ----

  it("queues a task by hand, deriving the dedupe key the processor would", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/tasks",
      headers: root,
      payload: { kind: "UPLOAD", chapter: uploadChapter() },
    });
    expect(res.statusCode).toBe(201);
    // Same rule as processor.ts: chapterId|chapterNumber|chapterLanguage.
    expect(res.json().task).toMatchObject({
      kind: "UPLOAD",
      state: "PENDING",
      dedupeKey: "src-4001|12|en",
      attempt: 0,
    });

    const row = await prisma.uploadTask.findUniqueOrThrow({ where: { id: res.json().task.id } });
    // Written through chapterToTaskPayload, so it is the shape the uploader reads:
    // every canonical key present, imageArtifacts set.
    expect(row.chapter).toMatchObject({ mdMangaId: expect.any(String), imageArtifacts: [] });
    expect((row.chapter as Record<string, unknown>)["chapterVolume"]).toBeNull();

    // The full payload is in the audit detail: this is a manual write to
    // MangaDex and the log must reconstruct exactly what was asked for.
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "queue.task_create" } });
    expect((event.detail as { chapter: Record<string, unknown> }).chapter).toMatchObject({
      chapterId: "src-4001",
    });

    // A duplicate is refused by the constraint that makes a double upload
    // impossible, and the refusal names the row already holding the slot.
    const dupe = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/tasks",
      headers: root,
      payload: { kind: "UPLOAD", chapter: uploadChapter() },
    });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().existing.id).toBe(res.json().task.id);
    expect(dupe.json().dedupeKey).toBe("src-4001|12|en");
    expect(await prisma.uploadTask.count()).toBe(1);

    // Same chapter, different kind: a different slot, so this is allowed.
    const asDelete = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/tasks",
      headers: root,
      payload: {
        kind: "DELETE",
        chapter: uploadChapter({ mdChapterId: "7c2b9e10-0000-4000-8000-000000000001" }),
      },
    });
    expect(asDelete.statusCode).toBe(201);
    expect(asDelete.json().task.dedupeKey).toBe("7c2b9e10-0000-4000-8000-000000000001");
  });

  it("rejects a hand-built task the uploader could not execute", async () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/v1/admin/queues/tasks", headers: root, payload });

    // Every one of these corresponds to a TaskError that would otherwise be
    // discovered after the task was claimed; for UPLOAD, after a MangaDex
    // upload session was already open.
    const noManga = await post({ kind: "UPLOAD", chapter: uploadChapter({ mdMangaId: null }) });
    expect(noManga.statusCode).toBe(422);
    expect(noManga.json().problems.join()).toContain("mdMangaId");

    const noGroup = await post({ kind: "UPLOAD", chapter: uploadChapter({ mdGroupId: null }) });
    expect(noGroup.statusCode).toBe(422);
    expect(noGroup.json().problems.join()).toContain("mdGroupId");

    const noChapterId = await post({ kind: "DELETE", chapter: { mangaName: "x" } });
    expect(noChapterId.statusCode).toBe(422);
    expect(noChapterId.json().problems.join()).toContain("mdChapterId");

    const editNoPayload = await post({
      kind: "EDIT",
      chapter: { mdChapterId: "7c2b9e10-0000-4000-8000-000000000002" },
    });
    expect(editNoPayload.statusCode).toBe(422);
    expect(editNoPayload.json().problems.join()).toContain("payload");

    const editOk = await post({
      kind: "EDIT",
      chapter: {
        mdChapterId: "7c2b9e10-0000-4000-8000-000000000002",
        payload: { title: "Fixed title" },
      },
    });
    expect(editOk.statusCode).toBe(201);
    // The EDIT sidecar survived: stripping it would make the task unexecutable.
    const stored = await prisma.uploadTask.findUniqueOrThrow({ where: { id: editOk.json().task.id } });
    expect((stored.chapter as Record<string, unknown>)["payload"]).toEqual({ title: "Fixed title" });

    // A page artifact that does not exist fails the task mid-upload otherwise.
    const ghostPages = await post({
      kind: "UPLOAD",
      chapter: uploadChapter({
        chapterId: "src-4002",
        imageArtifacts: ["3f3f3f3f-0000-4000-8000-000000000000"],
      }),
    });
    expect(ghostPages.statusCode).toBe(422);
    expect(ghostPages.json().problems.join()).toContain("artifact store");

    expect(await prisma.uploadTask.count()).toBe(1);
  });

  it("keeps hand-enqueueing out of a contributor's reach", async () => {
    const contributor = await sessionAs("CONTRIBUTOR", "curator@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/tasks",
      headers: contributor,
      payload: { kind: "UPLOAD", chapter: uploadChapter() },
    });
    // Refused on the role, before the scope check; this endpoint can create a
    // real chapter on MangaDex, so it sits at ADMIN-or-above.
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("admin role or above");
    expect(await prisma.uploadTask.count()).toBe(0);

    // An ADMIN session is allowed through.
    const admin = await sessionAs("ADMIN", "admin@example.com");
    const allowed = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/tasks",
      headers: admin,
      payload: { kind: "UPLOAD", chapter: uploadChapter() },
    });
    expect(allowed.statusCode).toBe(201);
  });

  // ---- edit a queued task ----

  it("corrects a pending task, recomputing the dedupe key when identity moves", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/tasks",
      headers: root,
      payload: { kind: "UPLOAD", chapter: uploadChapter() },
    });
    const id = created.json().task.id as string;

    // A shallow merge: one field fixed without restating the payload.
    const titled = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/queues/tasks/${id}`,
      headers: root,
      payload: { chapter: { chapterTitle: "Corrected" }, maxAttempts: 9 },
    });
    expect(titled.statusCode).toBe(200);
    expect(titled.json()).toMatchObject({ ok: true, dedupeKeyChanged: false });
    expect(titled.json().task).toMatchObject({ maxAttempts: 9, dedupeKey: "src-4001|12|en" });
    expect((titled.json().task.chapter as Record<string, unknown>)["chapterTitle"]).toBe("Corrected");
    // The untouched fields are still there.
    expect((titled.json().task.chapter as Record<string, unknown>)["mdGroupId"]).toBeTruthy();

    // Changing an identity field moves the row's dedupe slot with it.
    const renumbered = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/queues/tasks/${id}`,
      headers: root,
      payload: { chapter: { chapterNumber: "13" } },
    });
    expect(renumbered.statusCode).toBe(200);
    expect(renumbered.json()).toMatchObject({ dedupeKeyChanged: true });
    expect(renumbered.json().task.dedupeKey).toBe("src-4001|13|en");
    expect(await prisma.auditEvent.count({ where: { action: "queue.task_edit" } })).toBe(2);

    // ...but not onto a slot another task holds.
    const other = await app.inject({
      method: "POST",
      url: "/api/v1/admin/queues/tasks",
      headers: root,
      payload: { kind: "UPLOAD", chapter: uploadChapter({ chapterNumber: "20" }) },
    });
    expect(other.statusCode).toBe(201);
    const collide = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/queues/tasks/${id}`,
      headers: root,
      payload: { chapter: { chapterNumber: "20" } },
    });
    expect(collide.statusCode).toBe(409);
    expect(collide.json().existing.id).toBe(other.json().task.id);
    expect(
      (await prisma.uploadTask.findUniqueOrThrow({ where: { id } })).dedupeKey,
    ).toBe("src-4001|13|en");

    // An edit that would make the task unexecutable is refused too.
    const broken = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/queues/tasks/${id}`,
      headers: root,
      payload: { chapter: { mdGroupId: null } },
    });
    expect(broken.statusCode).toBe(422);
    expect(broken.json().problems.join()).toContain("mdGroupId");

    const nothing = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/queues/tasks/${id}`,
      headers: root,
      payload: {},
    });
    expect(nothing.statusCode).toBe(400);
  });

  it("edits only a PENDING task", async () => {
    const done = await task({ state: "DONE" });
    const dead = await task({ state: "DEAD_LETTER" });

    const onDone = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/queues/tasks/${done.id}`,
      headers: root,
      payload: { maxAttempts: 3 },
    });
    expect(onDone.statusCode).toBe(409);
    expect(onDone.json().error).toContain("DONE");

    const onDead = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/queues/tasks/${dead.id}`,
      headers: root,
      payload: { maxAttempts: 3 },
    });
    expect(onDead.statusCode).toBe(409);
    // The way forward is named rather than left to be guessed.
    expect(onDead.json().error).toContain("retry it first");

    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/admin/queues/tasks/00000000-0000-4000-8000-000000000000",
          headers: root,
          payload: { maxAttempts: 3 },
        })
      ).statusCode,
    ).toBe(404);
  });

  // ---- authorization ----

  it("confines every endpoint to the scope it declares", async () => {
    const stats = await mint(["stats:read"]);
    const runsRead = await mint(["runs:read"]);
    const runsWrite = await mint(["runs:write"]);
    const pending = await task({ state: "PENDING" });

    for (const url of ["/api/v1/admin/queues", "/api/v1/admin/queues/tasks"]) {
      const res = await app.inject({ method: "GET", url, headers: stats });
      expect(res.statusCode, `${url} for stats:read`).toBe(403);
      expect(res.json().error).toMatch(/^missing scope: /);
    }

    // runs:read may look at every queue and change none of them.
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/queues", headers: runsRead })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/queues/tasks", headers: runsRead })).statusCode,
    ).toBe(200);
    for (const [method, url, payload] of [
      ["POST", `/api/v1/admin/queues/tasks/${pending.id}/retry`, {}],
      ["POST", "/api/v1/admin/queues/purge", { dryRun: false, confirm: true }],
      ["POST", "/api/v1/admin/queues/reorder", { ids: [pending.id], mode: "front" }],
      ["DELETE", `/api/v1/admin/queues/tasks/${pending.id}`, { confirm: true }],
      ["PATCH", `/api/v1/admin/queues/tasks/${pending.id}`, { maxAttempts: 2 }],
      ["POST", "/api/v1/admin/queues/tasks", { kind: "UPLOAD", chapter: uploadChapter() }],
    ] as const) {
      const res = await app.inject({ method, url, headers: runsRead, payload });
      expect(res.statusCode, `${method} ${url} for runs:read`).toBe(403);
    }
    // Nothing leaked through: the row is exactly as it was.
    expect(await prisma.uploadTask.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
      state: "PENDING",
    });

    // runs:write acts on the queue, and write implies read.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/queues/reorder",
          headers: runsWrite,
          payload: { ids: [pending.id], mode: "front" },
        })
      ).statusCode,
    ).toBe(200);
    // ...but a token is never ADMIN-by-role enough for the manual-add gate?
    // It is: adminAuthHook assigns api tokens the ADMIN role, so the role gate
    // passes and the scope gate is what confines them.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/queues/tasks",
          headers: runsWrite,
          payload: { kind: "UPLOAD", chapter: uploadChapter() },
        })
      ).statusCode,
    ).toBe(201);

    // A worker credential is rejected by audience, before any scope check.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/queues/tasks",
          headers: { authorization: "Bearer pw_not-a-real-worker-token" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("names the acting principal in the audit log and demands CSRF on cookie writes", async () => {
    const dead = await task({ state: "DEAD_LETTER", attempt: 5 });
    const headers = await mint(["runs:write"]);
    await app.inject({
      method: "POST",
      url: `/api/v1/admin/queues/tasks/${dead.id}/retry`,
      headers,
    });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "queue.retry" } });
    expect(event.actor).toBe("token:queues-runs:write");

    const owner = await sessionAs("OWNER", "owner@example.com");
    const pending = await task({ state: "PENDING" });
    const bare = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/queues/tasks/${pending.id}`,
      headers: { cookie: owner.cookie! },
      payload: { confirm: true },
    });
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error).toContain("x-requested-with");
    expect(await prisma.uploadTask.count({ where: { id: pending.id } })).toBe(1);

    const dashed = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/queues/tasks/${pending.id}`,
      headers: owner,
      payload: { confirm: true },
    });
    expect(dashed.statusCode).toBe(200);
  });
});
