import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AdminRole, AdminSession, AdminUser, PrismaClient } from "@prisma/client";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * Dashboard operator accounts and their sessions.
 *
 * Every piece of auth state is a Postgres row, which is what makes an
 * individual session revocable and an account approvable. Nothing here returns
 * a stored secret: passwords are scrypt-hashed and session secrets are
 * sha256-hashed, both compared in constant time.
 */

/** Deliberately expensive; ~100ms per verification on a modern core. */
const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;

export const MIN_PASSWORD_LENGTH = 12;

/** Encoded as `salt:hash`, both hex, matching the schema's documented shape. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN, SCRYPT);
  return timingSafeEqual(derived, expected);
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** What the auth layer needs to make a decision, resolved in one query. */
export interface ResolvedSession {
  sessionId: string;
  userId: string;
  actor: string;
  role: AdminRole;
  email: string;
  expiresAt: Date;
}

export type AdminUserPublic = Omit<AdminUser, "passwordHash" | "mdClientSecret"> & {
  hasPassword: boolean;
  /** Whether this operator has a usable MangaDex personal client stored. */
  hasMangadexClient: boolean;
};

/**
 * Never leak a secret to a client, but do say whether one is set — the Users
 * view has to show who can actually get in, and "no credentials" is the state
 * an owner needs to act on.
 */
export function toPublicUser(user: AdminUser): AdminUserPublic {
  const { passwordHash, mdClientSecret, ...rest } = user;
  return {
    ...rest,
    hasPassword: passwordHash !== null,
    hasMangadexClient: mdClientSecret !== null,
  };
}

export class AdminUserStore {
  constructor(private readonly prisma: PrismaClient) {}

  // ---- accounts ----

  /**
   * Idempotently ensure the configured owner exists. Runs on every core-api
   * start so a fresh database is never locked out, and so an owner that was
   * demoted or unapproved by accident is restored to a usable state.
   */
  async ensureOwner(email: string): Promise<AdminUser> {
    const normalised = email.trim().toLowerCase();
    const existing = await this.prisma.adminUser.findUnique({ where: { email: normalised } });
    if (existing) {
      if (existing.role === "OWNER" && existing.approved) return existing;
      return this.prisma.adminUser.update({
        where: { id: existing.id },
        data: { role: "OWNER", approved: true },
      });
    }
    return this.prisma.adminUser.create({
      data: { email: normalised, role: "OWNER", approved: true },
    });
  }

  list(): Promise<AdminUser[]> {
    return this.prisma.adminUser.findMany({ orderBy: { createdAt: "asc" } });
  }

  byId(id: string): Promise<AdminUser | null> {
    return this.prisma.adminUser.findUnique({ where: { id } });
  }

  byEmail(email: string): Promise<AdminUser | null> {
    return this.prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  }

  /**
   * Invite: an approved account with no credentials yet. The invitee gets in
   * by signing in with the named MangaDex account, or by an owner setting a
   * password for them.
   *
   * Naming the MangaDex username here is what makes "only people we know" real:
   * an account that was never invited cannot be claimed by a MangaDex login
   * unless it also passes the scanlation-group gate.
   */
  invite(email: string, role: AdminRole, mangadexUsername?: string): Promise<AdminUser> {
    return this.prisma.adminUser.create({
      data: {
        email: email.trim().toLowerCase(),
        role,
        approved: true,
        mangadexUsername: mangadexUsername?.trim() || null,
      },
    });
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.prisma.adminUser.update({
      where: { id },
      data: { passwordHash: await hashPassword(password) },
    });
  }

  async approve(id: string): Promise<AdminUser | null> {
    const updated = await this.prisma.adminUser.updateMany({
      where: { id, approved: false },
      data: { approved: true },
    });
    return updated.count === 1 ? this.byId(id) : null;
  }

  private async ownerCount(excludingId?: string): Promise<number> {
    return this.prisma.adminUser.count({
      where: { role: "OWNER", ...(excludingId ? { id: { not: excludingId } } : {}) },
    });
  }

  /**
   * Demotion and deletion both have to leave at least one OWNER standing —
   * otherwise the only way back in is the break-glass admin token.
   */
  async setRole(id: string, role: AdminRole): Promise<"ok" | "unknown" | "last-owner"> {
    const user = await this.byId(id);
    if (!user) return "unknown";
    if (user.role === "OWNER" && role !== "OWNER" && (await this.ownerCount(id)) === 0) {
      return "last-owner";
    }
    await this.prisma.adminUser.update({ where: { id }, data: { role } });
    return "ok";
  }

  async remove(id: string): Promise<"ok" | "unknown" | "last-owner"> {
    const user = await this.byId(id);
    if (!user) return "unknown";
    if (user.role === "OWNER" && (await this.ownerCount(id)) === 0) return "last-owner";
    // Sessions cascade with the user row, so deletion is also a logout.
    await this.prisma.adminUser.delete({ where: { id } });
    return "ok";
  }

  // ---- MangaDex identity ----

  /** Bind (or re-bind after a rename) a MangaDex account to an operator row. */
  async bindMangadex(id: string, mangadexId: string, mangadexUsername: string): Promise<AdminUser> {
    return this.prisma.adminUser.update({
      where: { id },
      data: { mangadexId, mangadexUsername: mangadexUsername.trim() },
    });
  }

  byMangadexId(mangadexId: string): Promise<AdminUser | null> {
    return this.prisma.adminUser.findUnique({ where: { mangadexId } });
  }

  byMangadexUsername(mangadexUsername: string): Promise<AdminUser | null> {
    return this.prisma.adminUser.findUnique({
      where: { mangadexUsername: mangadexUsername.trim() },
    });
  }

  /**
   * Remember an operator's own personal API client. The secret arrives already
   * sealed — this store never handles it in the clear, so a stray log of a
   * write is not a credential leak.
   */
  async setMangadexClient(id: string, mdClientId: string, sealedSecret: string): Promise<void> {
    await this.prisma.adminUser.update({
      where: { id },
      data: { mdClientId, mdClientSecret: sealedSecret },
    });
  }

  createFromMangadex(opts: { mangadexId: string; username: string }): Promise<AdminUser> {
    // Self-signup lands unapproved and non-privileged by construction.
    //
    // MangaDex never gives us an email — the password grant returns an account,
    // not a contact — but `email` is the table's natural key. A `.invalid`
    // address (RFC 2606, permanently unresolvable) keeps that key total without
    // ever pretending to be somewhere mail could be delivered.
    return this.prisma.adminUser.create({
      data: {
        email: `md-${opts.mangadexId}@mangadex.invalid`,
        mangadexId: opts.mangadexId,
        mangadexUsername: opts.username.trim(),
        displayName: opts.username.trim(),
        role: "ADMIN",
        approved: false,
      },
    });
  }

  // ---- sessions ----

  /**
   * Mint a session. The cookie is `${id}.${secret}`: the id is a lookup key
   * and the secret is what is actually verified, so a leaked session *id*
   * (in a log, in an admin list view) is not a credential.
   */
  async createSession(user: AdminUser, actor: string, ttlSeconds: number): Promise<string> {
    const secret = randomBytes(32).toString("base64url");
    const session = await this.prisma.adminSession.create({
      data: {
        userId: user.id,
        tokenHash: sha256(secret),
        actor,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });
    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return `${session.id}.${secret}`;
  }

  /** Returns the session only if it is live, unrevoked, and the user approved. */
  async resolveSession(cookieValue: string): Promise<ResolvedSession | null> {
    const dot = cookieValue.indexOf(".");
    if (dot <= 0 || dot === cookieValue.length - 1) return null;
    const id = cookieValue.slice(0, dot);
    const secret = cookieValue.slice(dot + 1);
    // A malformed id would make Prisma throw on a uuid column; keep it cheap.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;

    const session = await this.prisma.adminSession.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!session || session.revoked) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;
    if (!session.user.approved) return null;

    const given = Buffer.from(sha256(secret), "utf8");
    const expected = Buffer.from(session.tokenHash, "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    return {
      sessionId: session.id,
      userId: session.userId,
      actor: session.actor,
      role: session.user.role,
      email: session.user.email,
      expiresAt: session.expiresAt,
    };
  }

  async revokeSession(id: string): Promise<boolean> {
    const res = await this.prisma.adminSession.updateMany({
      where: { id, revoked: false },
      data: { revoked: true },
    });
    return res.count === 1;
  }

  /** Live sessions only — revoked and expired rows are noise in the UI. */
  listSessions(): Promise<(AdminSession & { user: AdminUser })[]> {
    return this.prisma.adminSession.findMany({
      where: { revoked: false, expiresAt: { gt: new Date() } },
      include: { user: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }
}
