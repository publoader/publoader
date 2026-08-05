import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { buildContext, type AppContext } from "../../src/core/api/context.js";
import { buildServer } from "../../src/core/api/server.js";
import { closeDb, dbReady, resetDb, testPrisma } from "./db.js";

/**
 * Dashboard accounts, sessions, and asset serving. The properties under test
 * are the ones that keep a browser-reachable admin surface safe: the cookie is
 * HttpOnly/SameSite=Strict and backed by a revocable row, cookie-authed writes
 * need a header no cross-site form can set, login is rate limited, role
 * boundaries hold, and the bearer audience is untouched.
 */
describe.skipIf(!dbReady())("dashboard sessions, accounts, and assets", () => {
  const prisma = testPrisma();
  const ADMIN_TOKEN = "test-admin-token-0123456789";
  const OWNER_EMAIL = "owner@example.com";
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    ADMIN_TOKEN,
    SESSION_SECRET: "test-session-secret-0123456789abcdef",
    DASH_OWNER_EMAIL: OWNER_EMAIL,
    LOG_LEVEL: "error",
  });
  const log = createLogger("test-dashboard", "error");
  let app: FastifyInstance;
  let ctx: AppContext;

  const dash = { "x-requested-with": "publoader-dash" };
  const PASSWORD = "correct-horse-battery-staple";

  beforeEach(async () => {
    await resetDb(prisma);
    ctx = buildContext(prisma, config, log);
    app = buildServer(ctx);
    await app.ready();
    // Mirrors what services/api.ts does at startup.
    await ctx.adminUsers.ensureOwner(config.dashOwnerEmail);
  });
  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  const cookieFrom = (res: { cookies: { name: string; value: string }[] }): string => {
    const cookie = res.cookies.find((c) => c.name === "publoader_session");
    expect(cookie).toBeDefined();
    return `publoader_session=${cookie!.value}`;
  };

  /** Break-glass login: the admin token, bound to the seeded owner account. */
  async function loginWithToken(actor = "tester"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { token: ADMIN_TOKEN, actor },
    });
    expect(res.statusCode).toBe(200);
    return cookieFrom(res);
  }

  const loginWithPassword = (email: string, password: string) =>
    app.inject({ method: "POST", url: "/api/v1/admin/session", payload: { email, password } });

  // ---- seeding & login methods ----

  it("seeds an approved owner account with no credentials", async () => {
    const owner = await prisma.adminUser.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });
    expect(owner).toMatchObject({ role: "OWNER", approved: true, passwordHash: null, mangadexId: null });

    // Seeding is idempotent and repairs a demoted or unapproved owner.
    await prisma.adminUser.update({ where: { id: owner.id }, data: { role: "ADMIN", approved: false } });
    const repaired = await ctx.adminUsers.ensureOwner(OWNER_EMAIL);
    expect(repaired).toMatchObject({ id: owner.id, role: "OWNER", approved: true });
    expect(await prisma.adminUser.count()).toBe(1);
  });

  it("advertises only the login methods this deployment offers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/session/methods" });
    expect(res.statusCode).toBe(200);
    // MangaDex login needs no deployment-wide OAuth app, so it is always on
    // offer; signups stay off because no scanlation group is allowlisted.
    expect(res.json()).toMatchObject({ mangadex: true, signups: false, password: true });
  });

  // ---- MangaDex login ----

  const mangadexLogin = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/v1/admin/session/mangadex", payload });

  it("rejects a MangaDex login with no credentials at all", async () => {
    const res = await mangadexLogin({ username: "ardax" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("username and password are required");
  });

  /**
   * Nothing here reaches MangaDex: with no client stored for the account and
   * no deployment client matching the username, the request is refused before
   * a grant is attempted. That is also what tells the UI to reveal the client
   * fields.
   */
  it("asks for a personal API client when the account has none", async () => {
    const res = await mangadexLogin({ username: "somebody", password: "hunter2hunter2" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ needsClient: true });
    expect(res.json().error).toContain("personal client");
  });

  it("never reports whether a MangaDex username is known", async () => {
    const invited = await ctx.adminUsers.invite("md@example.com", "ADMIN", "invited-operator");
    expect(invited.mangadexUsername).toBe("invited-operator");

    // An invited username and an unknown one are indistinguishable from
    // outside: both stop at the same "you need a client" answer.
    const known = await mangadexLogin({ username: "invited-operator", password: "hunter2hunter2" });
    const unknown = await mangadexLogin({ username: "nobody-at-all", password: "hunter2hunter2" });
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.json()).toEqual(unknown.json());

    await prisma.adminUser.delete({ where: { id: invited.id } });
  });

  // ---- session lifecycle ----

  it("logs in with the admin token, authenticates reads and writes, and logs out", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { token: ADMIN_TOKEN, actor: "tester" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, actor: "tester", role: "OWNER", email: OWNER_EMAIL });

    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");

    const cookie = cookieFrom(res);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie } })).statusCode).toBe(200);

    const me = await app.inject({ method: "GET", url: "/api/v1/admin/session", headers: { cookie } });
    expect(me.json()).toMatchObject({ actor: "tester", role: "OWNER", hasPassword: false });

    const write = await app.inject({
      method: "POST",
      url: "/api/v1/admin/resume",
      headers: { cookie, ...dash },
      payload: {},
    });
    expect(write.statusCode).toBe(200);

    const out = await app.inject({ method: "DELETE", url: "/api/v1/admin/session", headers: { cookie, ...dash } });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");

    // Logout revokes the row, so the cookie is dead even if the browser keeps it.
    const after = await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("round-trips an email + password login after the owner sets a password", async () => {
    const cookie = await loginWithToken();
    const owner = await prisma.adminUser.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });

    const set = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${owner.id}/password`,
      headers: { cookie, ...dash },
      payload: { password: PASSWORD },
    });
    expect(set.statusCode).toBe(200);

    const login = await loginWithPassword(OWNER_EMAIL, PASSWORD);
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ role: "OWNER", email: OWNER_EMAIL });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie: cookieFrom(login) } }))
        .statusCode,
    ).toBe(200);

    const wrong = await loginWithPassword(OWNER_EMAIL, "not-the-password");
    expect(wrong.statusCode).toBe(401);
    // Same message whether the account exists or the password is wrong.
    expect(wrong.json().error).toBe("invalid email or password");
    const missing = await loginWithPassword("nobody@example.com", PASSWORD);
    expect(missing.json().error).toBe("invalid email or password");
  });

  it("rejects a correct password on an unapproved account", async () => {
    const user = await prisma.adminUser.create({
      data: { email: "pending@example.com", role: "ADMIN", approved: false },
    });
    await ctx.adminUsers.setPassword(user.id, PASSWORD);

    const login = await loginWithPassword("pending@example.com", PASSWORD);
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toContain("awaiting approval");
    expect(await prisma.adminSession.count()).toBe(0);
  });

  it("revoking a session kills it immediately", async () => {
    const cookie = await loginWithToken();
    const session = await prisma.adminSession.findFirstOrThrow();

    const list = await app.inject({ method: "GET", url: "/api/v1/admin/sessions", headers: { cookie } });
    expect(list.json().sessions).toHaveLength(1);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/sessions/${session.id}`,
      headers: { cookie, ...dash },
    });
    expect(revoke.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie } })).statusCode).toBe(401);
  });

  // ---- accounts and roles ----

  it("confines account administration to owners", async () => {
    const ownerCookie = await loginWithToken();

    const invited = await app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: { cookie: ownerCookie, ...dash },
      payload: { email: "admin@example.com", role: "ADMIN" },
    });
    expect(invited.statusCode).toBe(201);
    const adminId = invited.json().user.id;
    // The hash must never appear in an API response.
    expect(invited.json().user.passwordHash).toBeUndefined();

    await ctx.adminUsers.setPassword(adminId, PASSWORD);
    const adminCookie = cookieFrom(await loginWithPassword("admin@example.com", PASSWORD));

    // An ADMIN has full control-plane authority...
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie: adminCookie } })).statusCode,
    ).toBe(200);
    // ...but cannot see or change who else has it.
    for (const [method, url] of [
      ["GET", "/api/v1/admin/users"],
      ["GET", "/api/v1/admin/sessions"],
      ["GET", "/api/v1/admin/settings/signups"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie: adminCookie } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("owner role required");
    }
    const escalate = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${adminId}/role`,
      headers: { cookie: adminCookie, ...dash },
      payload: { role: "OWNER" },
    });
    expect(escalate.statusCode).toBe(403);

    // An ADMIN may set their own password but not somebody else's.
    const owner = await prisma.adminUser.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });
    const other = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${owner.id}/password`,
      headers: { cookie: adminCookie, ...dash },
      payload: { password: "another-long-password" },
    });
    expect(other.statusCode).toBe(403);
    const own = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${adminId}/password`,
      headers: { cookie: adminCookie, ...dash },
      payload: { password: "another-long-password" },
    });
    expect(own.statusCode).toBe(200);
  });

  it("refuses to remove the last owner and enforces the password policy", async () => {
    const cookie = await loginWithToken();
    const owner = await prisma.adminUser.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });

    const demote = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${owner.id}/role`,
      headers: { cookie, ...dash },
      payload: { role: "ADMIN" },
    });
    expect(demote.statusCode).toBe(409);
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${owner.id}`,
      headers: { cookie, ...dash },
    });
    expect(remove.statusCode).toBe(409);
    expect(remove.json().error).toContain("last owner");

    const short = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${owner.id}/password`,
      headers: { cookie, ...dash },
      payload: { password: "short" },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toContain("12 characters");
  });

  it("approves a pending account and toggles the signup gate", async () => {
    const cookie = await loginWithToken();
    const pending = await prisma.adminUser.create({
      data: { email: "new@example.com", role: "ADMIN", approved: false },
    });

    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${pending.id}/approve`,
      headers: { cookie, ...dash },
      payload: {},
    });
    expect(approve.statusCode).toBe(200);
    // Approving twice is a conflict, not a silent no-op.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${pending.id}/approve`,
      headers: { cookie, ...dash },
      payload: {},
    });
    expect(again.statusCode).toBe(409);

    const before = await app.inject({ method: "GET", url: "/api/v1/admin/settings/signups", headers: { cookie } });
    expect(before.json()).toMatchObject({ enabled: false });
    const on = await app.inject({
      method: "POST",
      url: "/api/v1/admin/settings/signups",
      headers: { cookie, ...dash },
      payload: { enabled: true },
    });
    expect(on.json()).toMatchObject({ ok: true, enabled: true });

    // The setting is on, but this deployment allowlists no scanlation group,
    // so there is nothing a self-signup could be verified against and the
    // login page must not offer it. The toggle alone can never open the door.
    const methods = await app.inject({ method: "GET", url: "/api/v1/admin/session/methods" });
    expect(methods.json()).toMatchObject({ signups: false });
    expect((await ctx.settings.getSignupsEnabled())).toBe(true);
  });

  // ---- the contributor role ----

  /** An approved account of `role` with a password, and a live session cookie. */
  async function loginAs(role: "OWNER" | "ADMIN" | "CONTRIBUTOR", email: string): Promise<string> {
    const user = await ctx.adminUsers.invite(email, role);
    await ctx.adminUsers.setPassword(user.id, PASSWORD);
    const res = await loginWithPassword(email, PASSWORD);
    expect(res.statusCode, `${role} login should succeed`).toBe(200);
    expect(res.json().role).toBe(role);
    return cookieFrom(res);
  }

  it("confines a contributor to curating the series map", async () => {
    const cookie = await loginAs("CONTRIBUTOR", "contributor@example.com");

    // What the role exists to do: see the catalogue, work the untracked queue,
    // add mappings.
    for (const url of [
      "/api/v1/admin/stats",
      "/api/v1/admin/extensions",
      "/api/v1/admin/extensions/opstest/tracked",
      "/api/v1/admin/untracked",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(res.statusCode, `contributor should read ${url}`).toBe(200);
    }

    const append = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/extensions/opstest/tracked",
      headers: { cookie, ...dash },
      payload: { mangaId: "ext-1", mdMangaId: "9a1b1c1d-0000-4000-8000-000000000000" },
    });
    expect(append.statusCode).toBe(200);

    // Everything else. A contributor is an untrusted-but-helpful human: they can
    // add facts to the map, and they cannot touch execution, credentials, other
    // people's accounts, or anything that reaches MangaDex on its own.
    // The payload is typed as an object rather than `unknown`: fastify's
    // InjectOptions.payload is a union that `unknown` does not satisfy, and
    // widening it here is what let the whole file stop type-checking.
    const forbidden: [string, string, Record<string, unknown>?][] = [
      ["POST", "/api/v1/admin/runs", { extension: "opstest", kind: "FORCE" }],
      ["POST", "/api/v1/admin/pause", {}],
      ["POST", "/api/v1/admin/resume", {}],
      ["GET", "/api/v1/admin/workers"],
      ["POST", "/api/v1/admin/enroll-tokens", {}],
      ["GET", "/api/v1/admin/audit"],
      ["GET", "/api/v1/admin/upload-tasks"],
      ["GET", "/api/v1/admin/errors"],
      ["GET", "/api/v1/admin/mangadex/auth"],
      ["GET", "/api/v1/admin/schema"],
      ["GET", "/api/v1/admin/backup"],
      ["GET", "/api/v1/admin/tokens"],
      ["GET", "/api/v1/admin/users"],
      ["POST", "/api/v1/admin/extensions/opstest/disable", {}],
    ];
    for (const [method, url, payload] of forbidden) {
      const res = await app.inject({
        method: method as "GET" | "POST",
        url,
        headers: { cookie, ...dash },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode, `contributor must not reach ${method} ${url}`).toBe(403);
    }

    // Repointing and removing an existing mapping are the two curation actions a
    // contributor must not have: both silently change where uploads go.
    const repoint = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/extensions/opstest/tracked",
      headers: { cookie, ...dash },
      payload: { mangaId: "ext-1", mdMangaId: "ffffffff-0000-4000-8000-000000000000" },
    });
    expect(repoint.statusCode).toBe(403);
    expect(repoint.json().error).toContain("tracked:write");
    const remove = await app.inject({
      method: "DELETE",
      url: "/api/v1/admin/extensions/opstest/tracked/ext-1",
      headers: { cookie, ...dash },
    });
    expect(remove.statusCode).toBe(403);

    // The mapping they added is intact and still points where they put it.
    const row = await prisma.trackedManga.findFirstOrThrow({ where: { mangaId: "ext-1" } });
    expect(row.mdMangaId).toBe("9a1b1c1d-0000-4000-8000-000000000000");
  });

  // ---- series-map paste ----

  it("reports a pasted series map line by line", async () => {
    const cookie = await loginAs("ADMIN", "curator@example.com");
    await prisma.trackedManga.createMany({
      data: [
        { extension: "opstest", mangaId: "keep", mdMangaId: "11111111-1111-4111-8111-111111111111" },
        { extension: "opstest", mangaId: "repoint", mdMangaId: "22222222-2222-4222-8222-222222222222" },
      ],
    });

    const text = [
      "external_id,mangadex_id", // header: skipped, not an error
      "brand-new, 33333333-3333-4333-8333-333333333333",
      "keep 11111111-1111-4111-8111-111111111111", // unchanged
      "repoint;44444444-4444-4444-8444-444444444444", // an ADMIN holds tracked:write
      "55555555-5555-4555-8555-555555555555 reversed", // uuid first: accepted
      "dupe,66666666-6666-4666-8666-666666666666",
      "dupe,77777777-7777-4777-8777-777777777777", // same id, different target
      "# a comment",
      "no-uuid-here,also-not-a-uuid", // reported, does not fail the batch
      "lonely", // one value only
    ].join("\n");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/extensions/opstest/tracked/batch",
      headers: { cookie, ...dash },
      payload: { text },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const outcome = (mangaId: string) =>
      body.results.filter((r: { mangaId: string }) => r.mangaId === mangaId).map((r: { outcome: string }) => r.outcome);
    expect(outcome("brand-new")).toEqual(["added"]);
    expect(outcome("keep")).toEqual(["unchanged"]);
    expect(outcome("repoint")).toEqual(["updated"]);
    expect(outcome("reversed")).toEqual(["added"]);
    // Listed twice with different targets: flagged, and the last one applied.
    expect(outcome("dupe")).toEqual(["invalid", "added"]);
    expect(
      await prisma.trackedManga.findFirstOrThrow({ where: { mangaId: "dupe" } }),
    ).toMatchObject({ mdMangaId: "77777777-7777-4777-8777-777777777777" });

    // Unparseable lines are per-line errors, not a rejected paste.
    expect(body.parseErrors.map((e: { line: number }) => e.line)).toEqual([9, 10]);
    expect(body.added).toBe(3);
    expect(body.updated).toBe(1);
    expect(body.unchanged).toBe(1);

    expect(
      await prisma.trackedManga.findFirstOrThrow({ where: { mangaId: "repoint" } }),
    ).toMatchObject({ mdMangaId: "44444444-4444-4444-8444-444444444444" });

    // A contributor pasting the same thing gets the repoint refused by row.
    const contributor = await loginAs("CONTRIBUTOR", "paster@example.com");
    const asContributor = await app.inject({
      method: "POST",
      url: "/api/v1/admin/extensions/opstest/tracked/batch",
      headers: { cookie: contributor, ...dash },
      payload: { text: "repoint,88888888-8888-4888-8888-888888888888\nfresh,99999999-9999-4999-8999-999999999999" },
    });
    expect(asContributor.statusCode).toBe(200);
    const byId = Object.fromEntries(
      asContributor.json().results.map((r: { mangaId: string; outcome: string }) => [r.mangaId, r.outcome]),
    );
    expect(byId["repoint"]).toBe("rejected_needs_write");
    expect(byId["fresh"]).toBe("added");
    expect(
      await prisma.trackedManga.findFirstOrThrow({ where: { mangaId: "repoint" } }),
    ).toMatchObject({ mdMangaId: "44444444-4444-4444-8444-444444444444" });
  });

  it("previews a paste without writing anything", async () => {
    const cookie = await loginAs("ADMIN", "previewer@example.com");
    await prisma.trackedManga.createMany({
      data: [
        { extension: "opstest", mangaId: "existing", mdMangaId: "11111111-1111-4111-8111-111111111111" },
        { extension: "opstest", mangaId: "goner", mdMangaId: "22222222-2222-4222-8222-222222222222" },
      ],
    });
    const before = await prisma.trackedManga.findMany({ orderBy: { mangaId: "asc" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/extensions/opstest/tracked/batch",
      headers: { cookie, ...dash },
      payload: {
        dryRun: true,
        text: [
          "newcomer,33333333-3333-4333-8333-333333333333",
          "existing,44444444-4444-4444-8444-444444444444",
        ].join("\n"),
        remove: ["goner"],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);

    // The preview has to answer the question the operator actually asked, which
    // includes the removals — reporting removed: 0 for a batch that will remove a
    // row is worse than not previewing at all.
    const byId = Object.fromEntries(
      body.results.map((r: { mangaId: string; outcome: string }) => [r.mangaId, r.outcome]),
    );
    expect(byId["newcomer"]).toBe("added");
    expect(byId["existing"]).toBe("updated");
    expect(byId["goner"]).toBe("removed");
    expect(body).toMatchObject({ added: 1, updated: 1, removed: 1 });

    // Nothing moved. Not the row it would add, and — the part that bites —
    // not the mapping it would repoint: a preview that repoints for real has
    // silently sent this series' uploads to a different MangaDex title.
    const after = await prisma.trackedManga.findMany({ orderBy: { mangaId: "asc" } });
    expect(after).toEqual(before);
    expect(await prisma.trackedManga.count({ where: { source: "dry-run" } })).toBe(0);
    // A preview is not an action, so it does not belong in the audit log either.
    expect(await prisma.auditEvent.count({ where: { action: "tracked_manga.batch" } })).toBe(0);
  });

  it("lets a contributor run the batch endpoint without letting it delete anything", async () => {
    // The batch route is guarded by `tracked:append`, so a contributor reaches
    // it — that is the point of the role. The refusal for a removal therefore
    // cannot come from the route guard, and lives inside applyBatch instead.
    //
    // Worth its own test because the failure mode is quiet: a batch that both
    // adds and removes answers 200 either way, so a regression here would look
    // like success while silently untracking series. The single-row DELETE path
    // 403s and is covered above; this is the other door into the same action.
    const cookie = await loginAs("CONTRIBUTOR", "batcher@example.com");
    await prisma.trackedManga.createMany({
      data: [
        { extension: "opstest", mangaId: "doomed", mdMangaId: "11111111-1111-4111-8111-111111111111" },
        { extension: "opstest", mangaId: "also-doomed", mdMangaId: "22222222-2222-4222-8222-222222222222" },
      ],
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/extensions/opstest/tracked/batch",
      headers: { cookie, ...dash },
      payload: {
        text: "brand-new,33333333-3333-4333-8333-333333333333",
        remove: ["doomed", "also-doomed"],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The append half lands; the removals are refused per row, each naming the
    // scope, so the contributor can see what to ask an operator for.
    expect(body).toMatchObject({ added: 1, removed: 0, failed: 2 });
    for (const mangaId of ["doomed", "also-doomed"]) {
      const result = body.results.find((r: { mangaId: string }) => r.mangaId === mangaId);
      expect(result.outcome).toBe("rejected_needs_write");
      expect(result.detail).toContain("tracked:write");
    }

    // The assertion that actually matters: both rows are still there.
    expect(await prisma.trackedManga.count({ where: { mangaId: { in: ["doomed", "also-doomed"] } } })).toBe(2);
    expect(await prisma.trackedManga.count({ where: { mangaId: "brand-new" } })).toBe(1);
  });

  // ---- CSRF, attribution, rate limits, forgery ----

  it("requires the CSRF header on cookie-authenticated writes but not on reads", async () => {
    const cookie = await loginWithToken();

    const noHeader = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pause",
      headers: { cookie },
      payload: { minutes: 5 },
    });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error).toContain("x-requested-with");
    expect(await prisma.setting.count({ where: { key: "pause_until" } })).toBe(0);

    const wrongValue = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pause",
      headers: { cookie, "x-requested-with": "XMLHttpRequest" },
      payload: { minutes: 5 },
    });
    expect(wrongValue.statusCode).toBe(403);

    const withHeader = await app.inject({
      method: "POST",
      url: "/api/v1/admin/pause",
      headers: { cookie, ...dash },
      payload: { minutes: 5 },
    });
    expect(withHeader.statusCode).toBe(200);
    expect(await prisma.setting.count({ where: { key: "pause_until" } })).toBe(1);

    const read = await app.inject({ method: "GET", url: "/api/v1/admin/audit", headers: { cookie } });
    expect(read.statusCode).toBe(200);
  });

  it("attributes audited actions to the logged-in operator without an x-actor header", async () => {
    const cookie = await loginWithToken("ardax");
    await app.inject({ method: "POST", url: "/api/v1/admin/resume", headers: { cookie, ...dash }, payload: {} });
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "platform.resume" },
      orderBy: { createdAt: "desc" },
    });
    expect(event.actor).toBe("user:ardax");
  });

  it("rejects a wrong token and rate limits repeated login attempts", async () => {
    const attempt = () =>
      app.inject({ method: "POST", url: "/api/v1/admin/session", payload: { token: "wrong-token", actor: "mallory" } });

    // Bucket capacity is 5; the sixth attempt inside the same minute is shed.
    for (let i = 0; i < 5; i++) {
      expect((await attempt()).statusCode).toBe(401);
    }
    expect((await attempt()).statusCode).toBe(429);
    expect(await prisma.auditEvent.count({ where: { action: "session.login.rejected" } })).toBe(5);
  });

  it("rejects forged, tampered, and expired session cookies", async () => {
    const cookie = await loginWithToken();
    const value = cookie.slice("publoader_session=".length);
    const dot = value.indexOf(".");
    const id = value.slice(0, dot);
    const secret = value.slice(dot + 1);

    for (const forged of [
      "publoader_session=not-a-cookie",
      `publoader_session=${id}.${"a".repeat(secret.length)}`,
      `publoader_session=00000000-0000-4000-8000-000000000000.${secret}`,
      // A session id alone is not a credential: only its hash is stored.
      `publoader_session=${id}.`,
    ]) {
      const res = await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie: forged } });
      expect(res.statusCode).toBe(401);
    }

    await prisma.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: { cookie } })).statusCode).toBe(401);
  });

  it("marks the cookie Secure when the proxy reports https", async () => {
    const plain = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      payload: { token: ADMIN_TOKEN, actor: "tester" },
    });
    expect(String(plain.headers["set-cookie"])).not.toContain("Secure");

    const proxied = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      headers: { "x-forwarded-proto": "https" },
      payload: { token: ADMIN_TOKEN, actor: "tester" },
    });
    expect(String(proxied.headers["set-cookie"])).toContain("Secure");
  });

  it("leaves the bearer audience unchanged and treats it as owner", async () => {
    const bearer = { authorization: `Bearer ${ADMIN_TOKEN}` };

    // No CSRF header required: a bearer token is not attached automatically.
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/admin/resume", headers: bearer, payload: {} })).statusCode,
    ).toBe(200);
    // Owner-equivalent, so it reaches the account endpoints.
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: bearer })).statusCode).toBe(200);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/stats",
          headers: { authorization: "Bearer nope-nope-nope-nope" },
        })
      ).statusCode,
    ).toBe(401);

    // A bad bearer token must not fall through to a valid cookie.
    const cookie = await loginWithToken();
    const mixed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: { cookie, authorization: "Bearer nope-nope-nope-nope" },
    });
    expect(mixed.statusCode).toBe(401);
  });

  // ---- assets ----

  it("serves the dashboard at the domain root and at /dash under a strict CSP", async () => {
    for (const url of ["/", "/dash"]) {
      const page = await app.inject({ method: "GET", url });
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.body).toContain("<title>publoader");
      expect(page.body).toContain("/dash/app.js");

      const csp = String(page.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(page.headers["x-frame-options"]).toBe("DENY");
    }

    const script = await app.inject({ method: "GET", url: "/dash/app.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("javascript");
    // No inline handlers and no innerHTML sink: the CSP would break the former,
    // and the latter is the XSS vector this dashboard avoids by rendering every
    // operator-supplied string with textContent.
    expect(script.body).not.toMatch(/\.innerHTML\s*=/);
    expect(script.body).not.toMatch(/\son[a-z]+\s*=\s*"/);

    const styles = await app.inject({ method: "GET", url: "/dash/style.css" });
    expect(styles.statusCode).toBe(200);
    expect(styles.headers["content-type"]).toContain("text/css");
  });

  it("names every operator section it can render in the no-script fallback", async () => {
    // Every view is built client-side, so a browser with scripting off sees only
    // the shell. The <noscript> block is what tells that operator which sections
    // exist — and it is derived from nothing, so it goes stale silently.
    //
    // The section labels are read out of the served app.js rather than hard-coded
    // here: the point is that the two halves agree, and pinning the list in the
    // test would just move the staleness rather than catch it.
    const page = await app.inject({ method: "GET", url: "/dash" });
    const script = await app.inject({ method: "GET", url: "/dash/app.js" });

    const registry = /const NAV = \[(.*?)\n\];/s.exec(script.body);
    expect(registry, "app.js should declare a NAV registry").not.toBeNull();
    const labels = [...registry![1]!.matchAll(/^\s{4}label: "([^"]+)"/gm)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThanOrEqual(10);

    for (const label of labels) {
      expect(page.body, `the noscript fallback should name the ${label} section`).toContain(label);
    }

    // Credential minting and account administration need the OWNER role, not a
    // scope — a wildcard api token holds users:admin but is never OWNER. Asserted
    // on the id rather than the surrounding syntax, which is what went stale when
    // the registry became objects: the regex above stopped matching anything and
    // the loop silently checked an empty list.
    for (const id of ["tokens", "users"]) {
      const entry = new RegExp(`id: "${id}",[\\s\\S]{0,400}?owner: true`).exec(registry![1]!);
      expect(entry, `${id} should still be owner-gated in NAV`).not.toBeNull();
    }

    // A tab with no endpoint wired to it renders an empty panel; these are the
    // calls behind the sections this dashboard grew for queue and session triage.
    for (const call of [
      "/whoami",
      "/upload-tasks",
      "/upload-tasks/requeue-stale",
      "/mangadex/auth",
      "/mangadex/auth/clear",
      "/tokens/scopes",
    ]) {
      expect(script.body, `${call} should be called by the dashboard`).toContain(call);
    }
  });

  it("serves a shell with the sidebar, header and dialog landmarks the SPA fills in", async () => {
    // The SPA builds every view client-side but NOT the shell: the sidebar, the
    // header's live summary row and the modal are in the served HTML so the
    // layout has its final shape before the first response lands. A rename here
    // is a silent breakage — app.js finds its mount points by id — so the ids
    // are pinned.
    const page = await app.inject({ method: "GET", url: "/dash" });
    expect(page.statusCode).toBe(200);

    for (const id of [
      "login", // the sign-in layer
      "app", // the shell
      "sidebar", // the persistent left menu
      "nav", // where the destination list is built
      "nav-collapse", // collapse to icons
      "nav-toggle", // the drawer's hamburger
      "nav-scrim",
      "summary", // the live platform state in the header
      "pause-pill",
      "sum-workers",
      "sum-jobs",
      "sum-queue",
      "sum-run",
      "profile-toggle", // signed-in identity and its menu
      "profile-menu",
      "role-badge",
      "logout",
      "page-head",
      "tabs", // in-page tabs
      "view", // the routed panel
      "modal",
      "toasts",
    ]) {
      expect(page.body, `the shell should contain #${id}`).toContain(`id="${id}"`);
    }

    // Landmarks and the keyboard entry point, which no view can supply.
    expect(page.body).toContain('<aside id="sidebar" class="sidebar" aria-label="Main">');
    expect(page.body).toContain('<header class="topbar">');
    expect(page.body).toContain('<main class="content">');
    expect(page.body).toContain('class="skip-link"');
    expect(page.body).toContain('role="tablist"');

    // Two <main> elements exist — the sign-in layer and the shell — and that is
    // only legal because exactly one of them is ever visible. Both must ship
    // hidden, or a scripting-disabled browser sees both.
    expect(page.body).toContain('<main id="login" class="login-layer" hidden>');
    expect(page.body).toContain('<div id="app" class="shell" hidden>');

    // The `hidden` attribute is how the shell shows one layer at a time, and an
    // author-origin `display` rule silently defeats it (the UA rule is
    // lower-precedence than any author declaration). This is the guard that
    // stopped the sign-in card painting over a signed-in dashboard.
    const styles = await app.inject({ method: "GET", url: "/dash/style.css" });
    expect(styles.body).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  // ---- audit filters ----

  /** Audit rows, oldest first, so an id off the first page is addressable. */
  async function seedAudit(count: number): Promise<{ id: string; action: string }[]> {
    const rows: { id: string; action: string }[] = [];
    for (let i = 0; i < count; i++) {
      const row = await prisma.auditEvent.create({
        data: {
          actor: i % 2 === 0 ? "iam@ardax.dev" : "token:discord-bot",
          action: ["run.trigger", "tracked_manga.set", "removal_mode.set"][i % 3]!,
          subject: `mangaplus:${i}`,
          detail: { index: i },
          createdAt: new Date(Date.UTC(2026, 0, 1 + i, 12, 0, 0)),
        },
      });
      rows.push({ id: row.id, action: row.action });
    }
    return rows;
  }

  const audit = async (cookie: string, query: string) =>
    app.inject({ method: "GET", url: `/api/v1/admin/audit${query}`, headers: { cookie } });

  it("resolves an audit event by id however far back it is", async () => {
    const cookie = await loginWithToken();
    const seeded = await seedAudit(30);
    const oldest = seeded[0]!;

    // The bug this fixes: the dashboard copied a permalink for a row, and
    // resolving it meant fetching the most recent page and filtering in the
    // browser. Anything pushed off that page was unreachable, and `id` was not a
    // filter at all. Prove the oldest row is findable while absent from the
    // recent page.
    const recent = await audit(cookie, "?limit=5");
    expect(recent.statusCode).toBe(200);
    expect(recent.json().events.map((e: { id: string }) => e.id)).not.toContain(oldest.id);

    const one = await audit(cookie, `?id=${oldest.id}`);
    expect(one.statusCode).toBe(200);
    expect(one.json().events).toHaveLength(1);
    expect(one.json().events[0]).toMatchObject({ id: oldest.id, subject: "mangaplus:0" });
    expect(one.json().events[0].detail).toEqual({ index: 0 });
    expect(one.json().total).toBe(1);

    // An id that does not exist is an empty result, not an error: the caller
    // cannot tell a truncated id from a deleted row any other way.
    const missing = await audit(cookie, "?id=00000000-0000-4000-8000-000000000000");
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toMatchObject({ events: [], total: 0 });
  });

  it("filters the audit log by actor, action, subject and time window", async () => {
    const cookie = await loginWithToken();
    await seedAudit(9);

    const byActor = await audit(cookie, "?actor=discord-bot");
    expect(byActor.statusCode).toBe(200);
    expect(byActor.json().events.length).toBeGreaterThan(0);
    for (const event of byActor.json().events) expect(event.actor).toContain("discord-bot");
    // Substring and case-insensitive, so a partial name typed in a hurry works.
    expect((await audit(cookie, "?actor=DISCORD")).json().total).toBe(byActor.json().total);

    const byAction = await audit(cookie, "?action=removal_mode.set");
    for (const event of byAction.json().events) expect(event.action).toBe("removal_mode.set");
    expect(byAction.json().total).toBe(3);

    const bySubject = await audit(cookie, "?subject=mangaplus:4");
    expect(bySubject.json().total).toBe(1);

    // The window is inclusive on both ends and is applied to the count as well
    // as the page, which is what makes "12 events that day" trustworthy.
    const window = await audit(
      cookie,
      "?since=2026-01-03T00:00:00.000Z&until=2026-01-05T23:59:59.000Z",
    );
    expect(window.json().total).toBe(3);
    for (const event of window.json().events) {
      expect(new Date(event.createdAt).getTime()).toBeGreaterThanOrEqual(Date.parse("2026-01-03T00:00:00Z"));
      expect(new Date(event.createdAt).getTime()).toBeLessThanOrEqual(Date.parse("2026-01-05T23:59:59Z"));
    }

    // Filters combine rather than replace one another.
    const both = await audit(cookie, "?actor=ardax&action=run.trigger");
    for (const event of both.json().events) {
      expect(event.actor).toContain("ardax");
      expect(event.action).toBe("run.trigger");
    }
    expect(both.json().total).toBeLessThanOrEqual(byAction.json().total + 3);
  });

  it("pages the audit log by offset and by cursor, and caps the limit", async () => {
    const cookie = await loginWithToken();
    const seeded = await seedAudit(12);
    const newestFirst = [...seeded].reverse().map((r) => r.id);
    // Signing in wrote its own session.login row, and it is newer than every
    // seeded one. Paging is asserted over a filter that matches only the seeded
    // rows, so the arithmetic is about paging rather than about the fixture.
    const mine = "&subject=mangaplus:";

    const first = await audit(cookie, `?limit=5${mine}`);
    expect(first.json()).toMatchObject({ total: 12, limit: 5, offset: 0 });
    expect(first.json().events.map((e: { id: string }) => e.id)).toEqual(newestFirst.slice(0, 5));
    expect(first.json().nextCursor).toBe(newestFirst[4]);

    const second = await audit(cookie, `?limit=5&offset=5${mine}`);
    expect(second.json().events.map((e: { id: string }) => e.id)).toEqual(newestFirst.slice(5, 10));

    // The cursor is the id of the last row of the previous page, and paging with
    // it must land on exactly the same rows offset would have — that is the whole
    // claim, since the cursor exists to stay correct while rows are still being
    // written.
    const cursored = await audit(cookie, `?limit=5${mine}&cursor=${first.json().nextCursor}`);
    expect(cursored.json().events.map((e: { id: string }) => e.id)).toEqual(newestFirst.slice(5, 10));
    // Offset is reported as null when a cursor drove the page, so a caller
    // cannot mistake one paging scheme for the other.
    expect(cursored.json().offset).toBeNull();

    const last = await audit(cookie, `?limit=5${mine}&cursor=${cursored.json().nextCursor}`);
    expect(last.json().events).toHaveLength(2);
    // Null on the last page, so a caller stops without an extra empty request.
    expect(last.json().nextCursor).toBeNull();

    // An unknown cursor is a client error: an empty page would read as "there is
    // nothing older", which is a different and wrong answer.
    const bogus = await audit(cookie, "?cursor=00000000-0000-4000-8000-000000000000");
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().error).toContain("unknown cursor");

    // The cap survives: limit is validated, not trusted.
    expect((await audit(cookie, "?limit=9999")).statusCode).toBe(400);
    expect((await audit(cookie, "?limit=0")).statusCode).toBe(400);
    expect((await audit(cookie, "?since=not-a-date")).statusCode).toBe(400);
  });

  it("keeps the audit filters behind audit:read", async () => {
    // The filters widen what one request can ask for, so the scope has to hold
    // for the filtered form and not merely for the unfiltered one.
    const token = await ctx.apiTokens.mint({
      name: "stats-only",
      scopes: ["stats:read"],
      createdBy: "test",
    });
    const headers = { authorization: `Bearer ${token.token}` };
    for (const query of ["", "?id=whatever", "?actor=someone", "?since=2026-01-01T00:00:00.000Z"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/admin/audit${query}`, headers });
      expect(res.statusCode, `audit${query} should need audit:read`).toBe(403);
      expect(res.json().error).toContain("audit:read");
    }
  });

  it("does not let the root mount shadow the internal endpoints", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toMatchObject({ ok: true });
    // /metrics is served only on the internal METRICS_PORT: the public
    // hostname forwards every path, so it must not exist here.
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
    // There is no root-level wildcard, so an unknown top-level path still 404s.
    expect((await app.inject({ method: "GET", url: "/not-a-page" })).statusCode).toBe(404);

    // The wildcard under /dash indexes a fixed in-memory map by basename, so no
    // path the client can spell reaches the filesystem.
    for (const url of ["/dash/%2e%2e/%2e%2e/package.json", "/dash/nested/path/style.css", "/dash/dashboard.ts"]) {
      const res = await app.inject({ method: "GET", url });
      expect([200, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain("publoader-platform");
      expect(res.body).not.toContain("registerDashboardRoutes");
    }
  });
});
