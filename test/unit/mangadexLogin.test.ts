import { describe, expect, it, vi } from "vitest";
import type { AdminUser } from "@prisma/client";
import {
  fetchMangadexIdentity,
  mangadexPasswordGrant,
  matchMangadexIdentity,
  parseGroupIds,
  type MangadexIdentity,
  type MangadexMatchDeps,
} from "../../src/core/api/mangadexLogin.js";

const GROUP = "11111111-2222-3333-4444-555555555555";
const OTHER_GROUP = "99999999-8888-7777-6666-555555555555";
const MD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const user = (over: Partial<AdminUser> = {}): AdminUser =>
  ({
    id: "u1",
    email: "op@example.com",
    displayName: null,
    role: "ADMIN",
    approved: true,
    passwordHash: null,
    mangadexId: null,
    mangadexUsername: null,
    mdClientId: null,
    mdClientSecret: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as AdminUser;

const identity = (over: Partial<MangadexIdentity> = {}): MangadexIdentity => ({
  id: MD_ID,
  username: "ardax",
  roles: ["ROLE_USER"],
  groupIds: [],
  ...over,
});

const deps = (over: Partial<MangadexMatchDeps> = {}): MangadexMatchDeps => ({
  byMangadexId: vi.fn(async () => null),
  byMangadexUsername: vi.fn(async () => null),
  bindMangadex: vi.fn(async (id: string, mangadexId: string, username: string) =>
    user({ id, mangadexId, mangadexUsername: username }),
  ),
  createFromMangadex: vi.fn(async (opts: { mangadexId: string; username: string }) =>
    user({ id: "new", mangadexId: opts.mangadexId, mangadexUsername: opts.username, approved: false }),
  ),
  signupsEnabled: vi.fn(async () => true),
  allowedGroupIds: new Set<string>(),
  ...over,
});

describe("matchMangadexIdentity", () => {
  it("signs in an account already bound to the MangaDex UUID", async () => {
    const d = deps({
      byMangadexId: vi.fn(async () => user({ mangadexId: MD_ID, mangadexUsername: "ardax" })),
    });
    await expect(matchMangadexIdentity(identity(), d)).resolves.toMatchObject({ outcome: "login" });
    expect(d.bindMangadex).not.toHaveBeenCalled();
  });

  it("follows a MangaDex rename instead of losing the account", async () => {
    const d = deps({
      byMangadexId: vi.fn(async () => user({ mangadexId: MD_ID, mangadexUsername: "old-name" })),
    });
    const match = await matchMangadexIdentity(identity({ username: "new-name" }), d);
    expect(match.outcome).toBe("login");
    expect(d.bindMangadex).toHaveBeenCalledWith("u1", MD_ID, "new-name");
  });

  it("holds a bound-but-unapproved account at pending", async () => {
    const d = deps({
      byMangadexId: vi.fn(async () =>
        user({ mangadexId: MD_ID, mangadexUsername: "ardax", approved: false }),
      ),
    });
    await expect(matchMangadexIdentity(identity(), d)).resolves.toMatchObject({ outcome: "pending" });
  });

  it("claims an unclaimed invite for that username", async () => {
    const d = deps({
      byMangadexUsername: vi.fn(async () => user({ mangadexUsername: "ardax" })),
    });
    const match = await matchMangadexIdentity(identity(), d);
    expect(match).toMatchObject({ outcome: "login", bound: true });
    expect(d.bindMangadex).toHaveBeenCalledWith("u1", MD_ID, "ardax");
  });

  /**
   * The reason binding is guarded: usernames are transferable on MangaDex, so
   * a released name must not carry the account it used to be bound to.
   */
  it("refuses a username whose row is bound to a different MangaDex account", async () => {
    const d = deps({
      byMangadexUsername: vi.fn(async () =>
        user({ mangadexId: "ffffffff-0000-0000-0000-000000000000", mangadexUsername: "ardax" }),
      ),
    });
    await expect(matchMangadexIdentity(identity(), d)).resolves.toEqual({ outcome: "unknown" });
    expect(d.bindMangadex).not.toHaveBeenCalled();
  });

  it("refuses an unknown account when no group allowlist is configured", async () => {
    const d = deps();
    await expect(matchMangadexIdentity(identity(), d)).resolves.toEqual({ outcome: "unknown" });
    expect(d.createFromMangadex).not.toHaveBeenCalled();
    expect(d.signupsEnabled).not.toHaveBeenCalled();
  });

  it("refuses an unknown account that is in no allowed group", async () => {
    const d = deps({ allowedGroupIds: new Set([GROUP]) });
    const match = await matchMangadexIdentity(identity({ groupIds: [OTHER_GROUP] }), d);
    expect(match).toEqual({ outcome: "not-in-group" });
    expect(d.createFromMangadex).not.toHaveBeenCalled();
  });

  it("signs up a group member as unapproved when signups are on", async () => {
    const d = deps({ allowedGroupIds: new Set([GROUP]) });
    const match = await matchMangadexIdentity(identity({ groupIds: [OTHER_GROUP, GROUP] }), d);
    expect(match).toMatchObject({ outcome: "pending" });
    expect(d.createFromMangadex).toHaveBeenCalledWith({ mangadexId: MD_ID, username: "ardax" });
  });

  it("refuses a group member when signups are off", async () => {
    const d = deps({ allowedGroupIds: new Set([GROUP]), signupsEnabled: vi.fn(async () => false) });
    const match = await matchMangadexIdentity(identity({ groupIds: [GROUP] }), d);
    expect(match).toEqual({ outcome: "signups-disabled" });
    expect(d.createFromMangadex).not.toHaveBeenCalled();
  });

  /** The group gate applies to established accounts too, not just signups. */
  it("locks out a bound account that has left every allowed group", async () => {
    const d = deps({
      allowedGroupIds: new Set([GROUP]),
      byMangadexId: vi.fn(async () => user({ mangadexId: MD_ID, mangadexUsername: "ardax" })),
    });
    const match = await matchMangadexIdentity(identity({ groupIds: [] }), d);
    expect(match).toEqual({ outcome: "not-in-group" });
  });
});

describe("parseGroupIds", () => {
  it("takes UUIDs separated by commas or spaces and ignores junk", () => {
    expect(parseGroupIds(`${GROUP}, not-a-uuid ${OTHER_GROUP},,`)).toEqual(
      new Set([GROUP, OTHER_GROUP]),
    );
  });

  it("is empty for undefined, which callers treat as the strict setting", () => {
    expect(parseGroupIds(undefined).size).toBe(0);
  });
});

describe("mangadexPasswordGrant", () => {
  it("posts a password grant and returns only the access token", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "at", refresh_token: "rt" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const token = await mangadexPasswordGrant(
      { username: "ardax", password: "pw", clientId: "cid", clientSecret: "cs" },
      { authUrl: "https://auth.example/realms/mangadex/protocol/openid-connect/" },
      fetchImpl,
    );

    expect(token).toBe("at");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // The trailing slash on the configured URL must not become a double slash.
    expect(url).toBe("https://auth.example/realms/mangadex/protocol/openid-connect/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("username")).toBe("ardax");
    expect(body.get("client_id")).toBe("cid");
  });

  it("throws a message that cannot carry the credentials back", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant", password: "pw" }), { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      mangadexPasswordGrant(
        { username: "ardax", password: "pw", clientId: "cid", clientSecret: "cs" },
        { authUrl: "https://auth.example" },
        fetchImpl,
      ),
    ).rejects.toThrow("token endpoint returned 401");
  });
});

describe("fetchMangadexIdentity", () => {
  const userMe = {
    result: "ok",
    response: "entity",
    data: {
      id: MD_ID,
      type: "user",
      attributes: { username: "ardax", roles: ["ROLE_GROUP_MEMBER"], version: 1 },
      relationships: [
        { id: GROUP, type: "scanlation_group" },
        { id: "cccccccc-0000-0000-0000-000000000000", type: "manga" },
      ],
    },
  };

  it("keeps the UUID, username and only scanlation_group relationships", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(userMe), { status: 200 }),
    ) as unknown as typeof fetch;

    const identity = await fetchMangadexIdentity("at", { apiUrl: "https://api.example" }, fetchImpl);

    expect(identity).toEqual({
      id: MD_ID,
      username: "ardax",
      roles: ["ROLE_GROUP_MEMBER"],
      groupIds: [GROUP],
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.example/user/me");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer at");
  });

  it("rejects a body that is not a user entity", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: "not-a-uuid" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchMangadexIdentity("at", { apiUrl: "https://api.example" }, fetchImpl),
    ).rejects.toThrow("unexpected body");
  });
});
