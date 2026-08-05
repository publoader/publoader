import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminUser } from "@prisma/client";
import { z } from "zod";
import type { AppContext } from "./context.js";
import { cleanActor, issueSession } from "./session.js";
import { deriveSecretBoxKey, openSecret, sealSecret } from "./secretBox.js";

/**
 * "Login with MangaDex" for the operator dashboard.
 *
 * ## Why this is a form and not a redirect
 *
 * MangaDex documents two OAuth client types and has only shipped one. Public
 * clients — the `authorization_code` flow, the redirect to auth.mangadex.org
 * and back, the thing that would let this be a "Sign in with MangaDex" button —
 * are "not yet available". What exists is the personal client: a `password`
 * grant, and "only the account that owns a personal client can be used with
 * it."
 *
 * Two consequences shape everything below:
 *
 *  1. The operator's MangaDex password is posted to core-api, because a
 *     password grant is the only grant on offer. It is used once, forwarded to
 *     MangaDex, and never stored, logged, or held after the request.
 *  2. There is no single deployment-wide client that can authenticate the whole
 *     team, so every operator brings their own personal client (registered at
 *     mangadex.org/settings). The one exception is the account that owns the
 *     deployment's own client — usually the uploader account — which can reuse
 *     it.
 *
 * If MangaDex ever ships public clients this module is the only thing that has
 * to change: the identity it produces, and every decision made from it, stay
 * the same.
 *
 * ## Who gets in
 *
 * Fails closed. An identity is admitted only when it is already *known* — an
 * account bound to that MangaDex UUID, or an unclaimed invite created by an
 * OWNER for that username. An unknown identity may self-signup only when
 * MANGADEX_ALLOWED_GROUP_IDS is configured, the account is a member of one of
 * those scanlation groups, and signups are enabled — and it still lands
 * unapproved. With no allowed groups configured, self-signup is refused
 * outright rather than left open.
 */

const MD_TOKEN_TIMEOUT_MS = 15_000;

/** The subset of a MangaDex account this module is willing to act on. */
export interface MangadexIdentity {
  /** Account UUID — the stable identity. */
  id: string;
  username: string;
  roles: string[];
  /** Scanlation groups the account belongs to, from `/user/me` relationships. */
  groupIds: string[];
}

const UserMeResponse = z.object({
  data: z.object({
    id: z.string().uuid(),
    attributes: z.object({
      username: z.string().min(1).max(190),
      roles: z.array(z.string().max(190)).nullish(),
    }),
    relationships: z
      .array(z.object({ id: z.string().max(190), type: z.string().max(64) }))
      .nullish(),
  }),
});

export type MangadexMatch =
  | { outcome: "login"; user: AdminUser; bound: boolean }
  | { outcome: "pending"; user: AdminUser }
  | { outcome: "not-in-group" }
  | { outcome: "signups-disabled" }
  | { outcome: "unknown" };

export interface MangadexMatchDeps {
  byMangadexId: (mangadexId: string) => Promise<AdminUser | null>;
  byMangadexUsername: (username: string) => Promise<AdminUser | null>;
  bindMangadex: (userId: string, mangadexId: string, username: string) => Promise<AdminUser>;
  createFromMangadex: (opts: { mangadexId: string; username: string }) => Promise<AdminUser>;
  signupsEnabled: () => Promise<boolean>;
  /** Empty means "not configured", which is treated as *stricter*, not looser. */
  allowedGroupIds: ReadonlySet<string>;
}

/**
 * Decide what a verified MangaDex identity means. Every side effect is behind
 * an injected port so the decision table is unit-testable without a database
 * or a network (test/unit/mangadexLogin.test.ts).
 *
 * Order matters and is deliberate:
 *  1. A bound mangadexId *is* the account. Usernames are mutable on MangaDex,
 *     so a rename must never repoint an existing login.
 *  2. Otherwise an unclaimed invite for that username binds — but only if it
 *     carries no UUID yet. Without that guard, releasing a username on
 *     MangaDex and letting someone else register it would hand them the
 *     account.
 *  3. Otherwise it is a signup, gated on group membership and always
 *     unapproved.
 */
export async function matchMangadexIdentity(
  identity: MangadexIdentity,
  deps: MangadexMatchDeps,
): Promise<MangadexMatch> {
  // null when no allowlist is configured — "unchecked", which is distinct from
  // "checked and failed" and is why this is a tri-state rather than a boolean.
  const inAllowedGroup =
    deps.allowedGroupIds.size === 0
      ? null
      : identity.groupIds.some((id) => deps.allowedGroupIds.has(id));

  const bound = await deps.byMangadexId(identity.id);
  if (bound) {
    if (inAllowedGroup === false) return { outcome: "not-in-group" };
    // Keep the stored username in step with MangaDex so the Users view does
    // not show a name that no longer exists.
    const user =
      bound.mangadexUsername === identity.username
        ? bound
        : await deps.bindMangadex(bound.id, identity.id, identity.username);
    return user.approved
      ? { outcome: "login", user, bound: false }
      : { outcome: "pending", user };
  }

  const invited = await deps.byMangadexUsername(identity.username);
  if (invited) {
    // The row already belongs to a different MangaDex account: this is a
    // username that changed hands, not the invitee. Refuse, and say no more
    // than "unknown" about it.
    if (invited.mangadexId && invited.mangadexId !== identity.id) return { outcome: "unknown" };
    if (inAllowedGroup === false) return { outcome: "not-in-group" };
    const user = await deps.bindMangadex(invited.id, identity.id, identity.username);
    return user.approved
      ? { outcome: "login", user, bound: true }
      : { outcome: "pending", user };
  }

  // Nobody invited this account. Self-signup needs something to verify against.
  if (inAllowedGroup === null) return { outcome: "unknown" };
  if (!inAllowedGroup) return { outcome: "not-in-group" };
  if (!(await deps.signupsEnabled())) return { outcome: "signups-disabled" };
  const created = await deps.createFromMangadex({
    mangadexId: identity.id,
    username: identity.username,
  });
  return { outcome: "pending", user: created };
}

/**
 * Password grant against MangaDex's Keycloak realm. Separated from the route so
 * the route body stays about policy. Throws with a message safe to log —
 * never one derived from the response body, which can echo the credentials.
 */
export async function mangadexPasswordGrant(
  credentials: { username: string; password: string; clientId: string; clientSecret: string },
  opts: { authUrl: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(`${opts.authUrl.replace(/\/+$/, "")}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      username: credentials.username,
      password: credentials.password,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
    signal: AbortSignal.timeout(MD_TOKEN_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`token endpoint returned ${response.status}`);
  const token = z
    .object({ access_token: z.string().min(1) })
    .safeParse(await response.json());
  if (!token.success) throw new Error("token endpoint returned an unexpected body");
  return token.data.access_token;
}

/**
 * Resolve the access token to an account. The token is deliberately not kept:
 * this is an identity check, not a delegation — the platform already has its
 * own MangaDex session for doing work, and clobbering it with an operator's
 * would be a mess.
 */
export async function fetchMangadexIdentity(
  accessToken: string,
  opts: { apiUrl: string },
  fetchImpl: typeof fetch = fetch,
): Promise<MangadexIdentity> {
  const response = await fetchImpl(`${opts.apiUrl.replace(/\/+$/, "")}/user/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(MD_TOKEN_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`user endpoint returned ${response.status}`);
  const parsed = UserMeResponse.safeParse(await response.json());
  if (!parsed.success) throw new Error("user endpoint returned an unexpected body");
  const { id, attributes, relationships } = parsed.data.data;
  return {
    id,
    username: attributes.username,
    roles: attributes.roles ?? [],
    groupIds: (relationships ?? [])
      .filter((rel) => rel.type === "scanlation_group")
      .map((rel) => rel.id),
  };
}

/** Comma/space separated UUID list, junk ignored rather than fatal. */
export function parseGroupIds(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const token of (raw ?? "").split(/[\s,]+/)) {
    const trimmed = token.trim().toLowerCase();
    if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(trimmed)) out.add(trimmed);
  }
  return out;
}

const MangadexLogin = z.object({
  username: z.string().min(1).max(190),
  password: z.string().min(1).max(1024),
  /** Only needed until the account has a client stored against it. */
  clientId: z.string().min(1).max(190).optional(),
  clientSecret: z.string().min(1).max(512).optional(),
});

interface ResolvedClient {
  clientId: string;
  clientSecret: string;
  /** The operator typed it this time, so it is worth offering to remember. */
  fromRequest: boolean;
}

export function registerMangadexLoginRoutes(app: FastifyInstance, ctx: AppContext): void {
  const allowedGroupIds = parseGroupIds(ctx.config.mdAllowedGroupIds);
  const boxKey = ctx.signingKey ? deriveSecretBoxKey(ctx.signingKey) : null;

  /**
   * Which client credentials to authenticate with, in order of specificity.
   * Looking the account up by the *submitted* username is safe: it decides
   * only which client to try, never who you are — that comes from `/user/me`.
   */
  const resolveClient = async (
    username: string,
    body: z.infer<typeof MangadexLogin>,
  ): Promise<ResolvedClient | null> => {
    if (body.clientId && body.clientSecret) {
      return { clientId: body.clientId, clientSecret: body.clientSecret, fromRequest: true };
    }
    const existing = await ctx.adminUsers.byMangadexUsername(username);
    if (existing?.mdClientId && existing.mdClientSecret && boxKey) {
      const secret = openSecret(existing.mdClientSecret, boxKey);
      // null means the signing material rotated; fall through so the operator
      // is asked for the secret again instead of failing with a bad grant.
      if (secret) return { clientId: existing.mdClientId, clientSecret: secret, fromRequest: false };
    }
    const { mdUsername, mdClientId, mdClientSecret } = ctx.config;
    if (
      mdClientId &&
      mdClientSecret &&
      mdUsername &&
      mdUsername.trim().toLowerCase() === username.toLowerCase()
    ) {
      // The deployment's own client, usable only by the account that owns it.
      return { clientId: mdClientId, clientSecret: mdClientSecret, fromRequest: false };
    }
    return null;
  };

  app.post("/api/v1/admin/session/mangadex", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.sessionLimiter.allow(req.ip)) {
      return reply.code(429).send({ error: "too many login attempts" });
    }
    const parsed = MangadexLogin.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "username and password are required" });
    }
    const username = parsed.data.username.trim();

    const client = await resolveClient(username, parsed.data);
    if (!client) {
      return reply.code(400).send({
        error:
          "this account has no MangaDex API client yet — create a personal client at " +
          "mangadex.org/settings and enter its id and secret",
        needsClient: true,
      });
    }

    let identity: MangadexIdentity;
    try {
      const accessToken = await mangadexPasswordGrant(
        {
          username,
          password: parsed.data.password,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
        },
        { authUrl: ctx.config.mdAuthUrl },
      );
      identity = await fetchMangadexIdentity(accessToken, { apiUrl: ctx.config.mdApiUrl });
    } catch (err) {
      // Only the shaped message — a raw error can carry the grant body.
      ctx.log.warn(
        { stage: "mangadex-login", reason: (err as Error).message },
        "mangadex login failed",
      );
      await ctx.audit.record(`ip:${req.ip}`, "session.login.rejected", undefined, {
        method: "mangadex",
        username: username.slice(0, 190),
      });
      return reply.code(401).send({ error: "invalid MangaDex credentials, or the client is not yours" });
    }

    const match = await matchMangadexIdentity(identity, {
      byMangadexId: (id) => ctx.adminUsers.byMangadexId(id),
      byMangadexUsername: (name) => ctx.adminUsers.byMangadexUsername(name),
      bindMangadex: (userId, id, name) => ctx.adminUsers.bindMangadex(userId, id, name),
      createFromMangadex: (opts) => ctx.adminUsers.createFromMangadex(opts),
      signupsEnabled: () => ctx.settings.getSignupsEnabled(),
      allowedGroupIds,
    });

    if (match.outcome === "unknown") {
      await ctx.audit.record(`mangadex:${identity.id}`, "session.login.rejected", undefined, {
        method: "mangadex",
        reason: "not a known operator",
      });
      // Same shape as a bad password: do not confirm which usernames exist.
      return reply.code(401).send({ error: "invalid MangaDex credentials, or the client is not yours" });
    }
    if (match.outcome === "not-in-group") {
      await ctx.audit.record(`mangadex:${identity.id}`, "session.login.rejected", undefined, {
        method: "mangadex",
        reason: "not a member of an allowed scanlation group",
      });
      return reply.code(403).send({ error: "your MangaDex account is not in an allowed scanlation group" });
    }
    if (match.outcome === "signups-disabled") {
      await ctx.audit.record(`mangadex:${identity.id}`, "session.signup.rejected", undefined, {
        reason: "signups disabled",
      });
      return reply.code(403).send({ error: "this dashboard is not accepting new accounts" });
    }
    if (match.outcome === "pending") {
      await ctx.audit.record(`mangadex:${identity.id}`, "session.signup.pending", match.user.id, {
        username: identity.username,
      });
      return reply.code(403).send({ error: "your account is awaiting approval by an owner" });
    }

    // Remember the client only now — after MangaDex has confirmed it works and
    // after the identity has been matched to this account.
    if (client.fromRequest && boxKey) {
      await ctx.adminUsers.setMangadexClient(
        match.user.id,
        client.clientId,
        sealSecret(client.clientSecret, boxKey),
      );
    }

    const actor = cleanActor(match.user.displayName ?? identity.username) ?? match.user.email;
    return issueSession(ctx, req, reply, match.user, actor, {
      method: "mangadex",
      mangadexId: identity.id,
      bound: match.bound,
    });
  });
}
