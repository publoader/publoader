import { setTimeout as sleep } from "node:timers/promises";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../../config.js";
import type { Logger } from "../../logging.js";
import type { MdApi, MdChapter, MdManga, MdMangaDetail } from "./types.js";

/**
 * MangaDex API client. Three things it owns:
 *
 *   1. OAuth password/refresh grants, with the token pair persisted in the
 *      `settings` table, so a restarted or replaced core container resumes the
 *      same MangaDex session.
 *   2. A single request gate: every call, authed or not, is spaced by at least
 *      `config.mdRatelimitMs`, and a 429 pushes the gate forward for everyone
 *      rather than only the caller that hit it.
 *   3. Bounded retries. `config.uploadRetry` attempts is a hard ceiling on every
 *      request, and exhausting it throws MdRequestError.
 */

const USER_AGENT = "publoader/2.0.0";
const ACCESS_TOKEN_KEY = "mdauth_access";
const REFRESH_TOKEN_KEY = "mdauth_refresh";
const PAGE_LIMIT = 100;
/** MangaDex accepts at most 10 files per upload POST. */
const IMAGE_BATCH_SIZE = 10;
/** Refresh this far ahead of `exp` so a token can't expire mid-flight. */
const TOKEN_SKEW_SECONDS = 60;
/** MangaDex rejects offsets past this; misc.py walks around it with a cursor. */
/**
 * Sent on every chapter *collection* read.
 *
 * Without it MangaDex silently omits the chapters it will not serve, so a
 * lookup of "what does MangaDex have for this series" quietly under-reports and
 * the caller concludes a chapter is missing when it is merely unreadable; for
 * the processor, that is the difference between leaving a chapter alone and
 * uploading a second copy of it.
 *
 * Its similarly-named siblings are NOT toggles and are deliberately never sent:
 * `includeExternalUrl`, `includeEmptyPages` and `includeFuturePublishAt` are
 * exclusive filters on this endpoint, and `includeExternalUrl=1` returns *only*
 * external chapters. Adding them to "include more" removes nearly everything.
 */
const INCLUDE_UNAVAILABLE = { includeUnavailable: "1" } as const;
const MAX_OFFSET = 10000;
/** Safety valve: a createdAt cursor that stops advancing must not loop forever. */
const MAX_PAGES = 500;
const CREATED_AT_EPOCH = "2000-01-01T00:00:00";
const REQUEST_TIMEOUT_MS = 30_000;
/** Fallback pause when a 429 arrives with no Retry-After (model.py used 60s). */
const RATELIMIT_FALLBACK_MS = 60_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

export class MdRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Parsed error body, when MangaDex sent one; `optimisticLockVersion` reads it. */
    readonly body?: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "MdRequestError";
  }
}

/**
 * The version MangaDex says the entity *actually* holds, read off a 409.
 *
 * Every versioned write (PUT /chapter, PUT /manga, POST /upload/begin/{id})
 * carries the version we believe MangaDex holds, and MangaDex rejects the write
 * when that number is not the current one:
 *
 *   409 optimistic_lock_exception
 *   "The optimistic lock failed, version 2 was expected, but is actually 3"
 *
 * The number we send comes from a GET, and a GET is not a reliable reading of
 * the version *during* a write sequence: MangaDex serves chapter reads from a
 * cache that lags its own writes, and the commit of an edit session bumps the
 * version behind that cache. So a task that failed after committing and is now
 * being retried re-reads the pre-commit version and is rejected on its next
 * write, every time, for as long as the cache is warm. Re-reading harder does
 * not fix it; the rejection itself names the current version, and that is the
 * one authoritative reading available, so the write is replayed with it.
 *
 * Null for a 409 that is not a version conflict (an already-open upload
 * session, say) — those must not be replayed.
 */
export function optimisticLockVersion(err: unknown): number | null {
  if (!(err instanceof MdRequestError) || err.status !== 409) return null;
  const errors = err.body?.errors;
  const details: string[] = [];
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (entry === null || typeof entry !== "object") continue;
      const { title, detail } = entry as { title?: unknown; detail?: unknown };
      if (title !== "optimistic_lock_exception") continue;
      if (typeof detail === "string") details.push(detail);
    }
  }
  // The message carries the raw body, so a response that failed to parse (or
  // arrived in some shape other than the documented one) is still readable.
  if (details.length === 0 && err.message.includes("optimistic_lock_exception")) {
    details.push(err.message);
  }
  for (const detail of details) {
    const match = /is actually (\d+)/.exec(detail);
    if (!match?.[1]) continue;
    const version = Number(match[1]);
    if (Number.isInteger(version) && version > 0) return version;
  }
  return null;
}

/** Generic MangaDex entity as it comes off the wire. */
export interface MdEntity {
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: MdRelationship[];
}

/**
 * A group's chapters, split by whether MangaDex will serve them.
 *
 * `all` carries the raw entity rather than a mapped `MdChapter` because the
 * caller archives the MangaDex record as it stood: the attributes it needs
 * (`pages`, `readableAt`, `isUnavailable`) are exactly the ones the mapping
 * drops, and once MangaDex stops serving a chapter this snapshot is the only
 * remaining answer to what it looked like.
 */
/**
 * Called after each page of a group walk.
 *
 * A group walk is the slowest thing this platform asks MangaDex for: two full
 * paginations at `mdRatelimitMs` apart, which on the live group is ~124 requests
 * and about four minutes. Anything driving it needs to say what it is doing
 * while it happens, or it is indistinguishable from a hang.
 *
 * `total` is MangaDex's own count for the query, taken from the `total` field
 * every list response carries. It is what turns the walk from a rising number
 * into a real proportion. Null when MangaDex omitted it, and null again once
 * the walk has to restart its window past the offset ceiling, because from then
 * on the count describes a different query than the one being collected.
 */
export type WalkProgress = (
  collected: number,
  total: number | null,
  pass: "all" | "served",
) => void;

export interface MdGroupAvailability {
  /** Every chapter id the group has, including the unserved ones. */
  all: Map<string, MdEntity>;
  /** The subset MangaDex returns without being asked for the rest. */
  served: Set<string>;
}

export interface MdRelationship {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

/** A single chapter fetched with `includes[]`, so relationships carry attributes. */
export interface MdChapterDetail extends MdChapter {
  relationships: MdRelationship[];
}

export interface MdCommitResult {
  id: string;
  /** Present when MangaDex echoed the committed chapter; carries the bumped version. */
  attributes?: { version?: number };
}

export interface MdUploadedImage {
  id: string;
  originalFileName: string;
  fileSize: number;
}

/**
 * The full surface MdClient offers. MdApi is the contract the processor codes
 * against; the unavailable-chapter flow additionally needs single-chapter reads
 * (with relationship attributes) and edit-mode upload sessions, which have no
 * place in the narrower interface. Any test double used by taskWorkers must
 * implement this, not just MdApi.
 */
export interface MdExtendedApi extends MdApi {
  chapterById(chapterId: string, includes?: string[]): Promise<MdChapterDetail | null>;
  chapterAvailabilityForGroup(
    groupId: string,
    onPage?: WalkProgress,
  ): Promise<MdGroupAvailability>;
  beginEditSession(chapterId: string, version: number | null): Promise<{ id: string }>;
  uploadImages(
    sessionId: string,
    files: { name: string; data: Buffer }[],
  ): Promise<MdUploadedImage[]>;
  commitUploadSession(
    sessionId: string,
    draft: {
      volume: string | null;
      chapter: string | null;
      title: string | null;
      translatedLanguage: string;
      externalUrl: string | null;
    },
    pageOrder: string[],
  ): Promise<MdCommitResult | null>;
}

interface MdResponse {
  status: number;
  /** Parsed JSON body, or null when the body was empty/unparseable. */
  data: Record<string, unknown> | null;
}

interface RequestOptions {
  params?: Record<string, string | string[] | number>;
  json?: unknown;
  form?: Record<string, string>;
  formData?: FormData;
  /** Status codes to return to the caller instead of retrying (e.g. 404). */
  successfulCodes?: number[];
  /** Attempt ceiling; defaults to config.uploadRetry. */
  tries?: number;
  /** Auth endpoints must not recurse into the auth flow. */
  authenticated?: boolean;
}

export class MdClient implements MdExtendedApi {
  private readonly log: Logger;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokensLoaded = false;
  private authFlight: Promise<void> | null = null;
  /** Serialises *slot acquisition* only; requests may still overlap in flight. */
  private gate: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(
    private readonly config: Config,
    private readonly prisma: PrismaClient,
    log: Logger,
  ) {
    this.log = log.child({ component: "md-client" });
  }

  // ---------------------------------------------------------------- transport

  /**
   * Wait for our turn on the shared gate. Only the wait is serialised: once a
   * caller has claimed its slot the next one may start `mdRatelimitMs` later,
   * regardless of whether the first request has come back.
   */
  private async acquireSlot(): Promise<void> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const wait = this.nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    this.nextRequestAt = Date.now() + this.config.mdRatelimitMs;
    release();
  }

  /** Push the gate out so every pending caller respects a server-side pause. */
  private delayGate(ms: number): void {
    this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + ms);
  }

  private static buildUrl(base: string, params?: RequestOptions["params"]): string {
    if (!params) return base;
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.append(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * How long MangaDex wants us to wait. It sends `x-ratelimit-retry-after` as a
   * unix timestamp (model.py reads it that way) and, on some routes, a standard
   * `retry-after` delta in seconds.
   */
  private static retryAfterMs(headers: Headers): number | null {
    const stamp = headers.get("x-ratelimit-retry-after");
    if (stamp) {
      const seconds = Number(stamp);
      if (Number.isFinite(seconds)) {
        const delta = seconds * 1000 - Date.now();
        if (delta > 0) return delta + 1000;
        return 1000;
      }
    }
    const standard = headers.get("retry-after");
    if (standard) {
      const seconds = Number(standard);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    }
    return null;
  }

  private static backoffMs(attempt: number): number {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }

  private async request(
    method: string,
    route: string,
    opts: RequestOptions = {},
  ): Promise<MdResponse> {
    const authenticated = opts.authenticated ?? true;
    const tries = Math.max(1, opts.tries ?? this.config.uploadRetry);
    const successfulCodes = opts.successfulCodes ?? [];
    const url = MdClient.buildUrl(route, opts.params);
    let lastError = "no attempts made";

    for (let attempt = 1; attempt <= tries; attempt++) {
      if (authenticated) await this.ensureAuth();

      const headers: Record<string, string> = { "User-Agent": USER_AGENT };
      if (authenticated && this.accessToken) {
        headers.Authorization = `Bearer ${this.accessToken}`;
      }

      let body: string | URLSearchParams | FormData | undefined;
      if (opts.formData) {
        // Undici sets the multipart boundary itself; setting Content-Type here
        // would produce a boundary-less header and MangaDex would reject it.
        body = opts.formData;
      } else if (opts.form) {
        body = new URLSearchParams(opts.form);
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      } else if (opts.json !== undefined) {
        body = JSON.stringify(opts.json);
        headers["Content-Type"] = "application/json";
      }

      await this.acquireSlot();

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.log.warn({ method, url, attempt, err: lastError }, "md request failed to send");
        if (attempt < tries) await sleep(MdClient.backoffMs(attempt));
        continue;
      }

      const text = await response.text();
      let data: Record<string, unknown> | null = null;
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed !== null && typeof parsed === "object") {
            data = parsed as Record<string, unknown>;
          }
        } catch {
          data = null;
        }
      }
      const status = response.status;

      if (successfulCodes.includes(status) || (status >= 200 && status < 300)) {
        return { status, data };
      }

      lastError = `${status}: ${text.slice(0, 500)}`;

      if (status === 401 && authenticated) {
        this.log.warn({ method, url, attempt }, "md returned 401, re-authenticating");
        await this.ensureAuth(true);
        continue;
      }

      if (status === 429) {
        const waitMs = MdClient.retryAfterMs(response.headers) ?? RATELIMIT_FALLBACK_MS;
        this.log.warn({ method, url, waitMs }, "md ratelimited");
        this.delayGate(waitMs);
        continue;
      }

      if (status >= 500) {
        this.log.warn({ method, url, status, attempt }, "md server error");
        if (attempt < tries) await sleep(MdClient.backoffMs(attempt));
        continue;
      }

      // 4xx other than 401/429 will not change on retry.
      throw new MdRequestError(`${method} ${url} failed; ${lastError}`, status, data);
    }

    throw new MdRequestError(`${method} ${url} exhausted ${tries} attempts; ${lastError}`);
  }

  /**
   * Run a versioned write; if MangaDex rejects the version, run it once more
   * with the version the rejection names. See `optimisticLockVersion` for why
   * the error is a better reading of the current version than another GET.
   *
   * Once, deliberately. A second conflict means the entity is moving under us
   * for reasons this flow does not control, and replaying a body built from a
   * stale read on top of someone else's edit is the failure mode a lock exists
   * to prevent. One replay recovers our own lagging read of our own write,
   * which is the case that actually happens here.
   */
  private async withVersionRetry<T>(
    what: string,
    version: number | null,
    run: (version: number | null) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(version);
    } catch (err) {
      const actual = optimisticLockVersion(err);
      if (actual === null || actual === version) throw err;
      this.log.warn(
        { what, sent: version, actual },
        "md rejected the version; replaying the write with the version it reports",
      );
      return await run(actual);
    }
  }

  // --------------------------------------------------------------------- auth

  /** JWT `exp` in seconds, or null when the token isn't a decodable JWT. */
  private static tokenExpiry(token: string | null): number | null {
    if (!token) return null;
    const segment = token.split(".")[1];
    if (!segment) return null;
    try {
      const payload: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
      if (payload === null || typeof payload !== "object") return null;
      const exp = (payload as { exp?: unknown }).exp;
      return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
    } catch {
      return null;
    }
  }

  /** Set when the current access token has no decodable `exp` claim. */
  private opaqueTokenIssuedAt: number | null = null;
  /** Grace lifetime for tokens without a readable expiry (non-JWT). */
  private static readonly OPAQUE_TOKEN_TTL_SECONDS = 60;

  private tokenUsable(token: string | null): boolean {
    if (!token) return false;
    const exp = MdClient.tokenExpiry(token);
    if (exp !== null) return exp - TOKEN_SKEW_SECONDS > Date.now() / 1000;
    // Not a decodable JWT (test doubles, or an upstream format change): trust
    // it briefly instead of re-authenticating on every request; a 401 still
    // forces an immediate refresh through the normal retry path.
    return (
      this.opaqueTokenIssuedAt !== null &&
      Date.now() / 1000 - this.opaqueTokenIssuedAt < MdClient.OPAQUE_TOKEN_TTL_SECONDS
    );
  }

  private async loadTokens(): Promise<void> {
    if (this.tokensLoaded) return;
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: [ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY] } },
    });
    for (const row of rows) {
      if (row.key === ACCESS_TOKEN_KEY) this.accessToken = row.value;
      if (row.key === REFRESH_TOKEN_KEY) this.refreshToken = row.value;
    }
    this.tokensLoaded = true;
  }

  private async persistTokens(): Promise<void> {
    const write = async (key: string, value: string | null) => {
      if (!value) {
        await this.prisma.setting.deleteMany({ where: { key } });
        return;
      }
      await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    };
    await write(ACCESS_TOKEN_KEY, this.accessToken);
    await write(REFRESH_TOKEN_KEY, this.refreshToken);
  }

  /**
   * Make sure `this.accessToken` is usable. Concurrent callers share one flight
   * so a burst of requests can't fire N password grants at MangaDex.
   */
  private async ensureAuth(force = false): Promise<void> {
    await this.loadTokens();
    if (!force && this.tokenUsable(this.accessToken)) return;
    if (this.authFlight) {
      await this.authFlight;
      if (!force || this.tokenUsable(this.accessToken)) return;
    }
    this.authFlight = this.authenticate(force).finally(() => {
      this.authFlight = null;
    });
    await this.authFlight;
  }

  private async authenticate(force: boolean): Promise<void> {
    if (!force && this.tokenUsable(this.accessToken)) return;

    // An opaque (non-JWT) refresh token has no readable expiry; try it anyway
    // rather than burning a password grant on every startup.
    const refreshExp = MdClient.tokenExpiry(this.refreshToken);
    const refreshUsable =
      this.refreshToken !== null &&
      (refreshExp === null || refreshExp - TOKEN_SKEW_SECONDS > Date.now() / 1000);
    if (refreshUsable) {
      if (await this.grant("refresh_token")) return;
      this.log.warn("refresh grant rejected, falling back to password grant");
    }
    if (await this.grant("password")) return;

    throw new MdRequestError("could not authenticate with MangaDex");
  }

  private async grant(kind: "password" | "refresh_token"): Promise<boolean> {
    const { mdUsername, mdPassword, mdClientId, mdClientSecret } = this.config;
    if (!mdClientId || !mdClientSecret) {
      throw new MdRequestError("MangaDex client credentials are not configured");
    }

    let form: Record<string, string>;
    if (kind === "password") {
      if (!mdUsername || !mdPassword) {
        throw new MdRequestError("MangaDex account credentials are not configured");
      }
      form = {
        grant_type: "password",
        username: mdUsername,
        password: mdPassword,
        client_id: mdClientId,
        client_secret: mdClientSecret,
      };
    } else {
      if (!this.refreshToken) return false;
      form = {
        grant_type: "refresh_token",
        client_id: mdClientId,
        client_secret: mdClientSecret,
        refresh_token: this.refreshToken,
      };
    }

    let response: MdResponse;
    try {
      response = await this.request("POST", `${this.config.mdAuthUrl}/token`, {
        form,
        authenticated: false,
        successfulCodes: [400, 401, 403, 404],
        tries: 1,
      });
    } catch (err) {
      this.log.error({ err, grant: kind }, "token request failed");
      return false;
    }

    if (response.status !== 200 || !response.data) {
      this.log.error({ grant: kind, status: response.status }, "token request rejected");
      return false;
    }

    const access = response.data.access_token;
    const refresh = response.data.refresh_token;
    if (typeof access !== "string" || typeof refresh !== "string") {
      this.log.error({ grant: kind }, "token response missing tokens");
      return false;
    }
    this.accessToken = access;
    this.refreshToken = refresh;
    await this.persistTokens();
    this.log.info({ grant: kind }, "authenticated with MangaDex");
    return true;
  }

  // -------------------------------------------------------------- pagination

  /** MangaDex's own count for a list query, when it sent a usable one. */
  private static reportedTotal(data: Record<string, unknown> | null): number | null {
    const total = data?.["total"];
    return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
  }

  private static entities(data: Record<string, unknown> | null): MdEntity[] {
    const list = data?.data;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (item): item is MdEntity =>
        item !== null && typeof item === "object" && typeof (item as MdEntity).id === "string",
    );
  }

  private static createdAt(entity: MdEntity): string {
    const value = entity.attributes?.createdAt;
    return typeof value === "string" ? value : "";
  }

  /**
   * Port of get_md_api: offset pagination at limit 100, ordered by createdAt,
   * hopping the 10k offset ceiling with a createdAtSince cursor, returning the
   * combined array sorted oldest-first.
   */
  private async paginate(
    route: string,
    params: Record<string, string | string[] | number>,
    onPage?: (collected: number, total: number | null) => void,
  ): Promise<MdEntity[]> {
    const collected: MdEntity[] = [];
    let offset = 0;
    let createdAtSince = CREATED_AT_EPOCH;
    /** True once the offset ceiling has forced the query to be narrowed. */
    let windowed = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.request("GET", `${this.config.mdApiUrl}/${route}`, {
        params: { ...params, limit: PAGE_LIMIT, offset, createdAtSince },
      });
      const entities = MdClient.entities(response.data);
      collected.push(...entities);
      // MangaDex reports the size of the whole result set on every page. Once
      // the window has been restarted past the offset ceiling that number
      // describes a narrowed query rather than this walk, so it is dropped
      // rather than quietly shown as a total it is no longer the total of.
      onPage?.(collected.length, windowed ? null : MdClient.reportedTotal(response.data));
      if (entities.length === 0) break;

      offset += PAGE_LIMIT;
      if (offset >= MAX_OFFSET) {
        const last = collected[collected.length - 1];
        const stamp = last ? MdClient.createdAt(last) : "";
        if (!stamp) break;
        // MangaDex rejects the offset ceiling; restart the window from the
        // newest item we have (dropping the timezone suffix as misc.py does).
        createdAtSince = stamp.split("+")[0] ?? CREATED_AT_EPOCH;
        offset = 0;
        windowed = true;
      }
    }

    return collected.sort((a, b) => MdClient.createdAt(a).localeCompare(MdClient.createdAt(b)));
  }

  private static toChapter(entity: MdEntity): MdChapter {
    const attrs = entity.attributes ?? {};
    const str = (key: string): string | null => {
      const value = attrs[key];
      return typeof value === "string" && value !== "" ? value : null;
    };
    const version = attrs.version;
    const pages = attrs.pages;
    const isUnavailable = attrs.isUnavailable;
    return {
      id: entity.id,
      attributes: {
        volume: str("volume"),
        chapter: str("chapter"),
        title: str("title"),
        translatedLanguage: str("translatedLanguage") ?? "",
        externalUrl: str("externalUrl"),
        version: typeof version === "number" ? version : 1,
        createdAt: MdClient.createdAt(entity),
        // Carried, not dropped: `pages` is the ONLY thing that separates a
        // chapter carrying our unavailable card from a live external one, and
        // dropping it here made every consumer blind to that (see isCarded).
        // A carded chapter's externalUrl is repointed rather than cleared, so
        // without this the removal passes read our own cards as duplicates of
        // one another and hard-delete them.
        ...(typeof pages === "number" ? { pages } : {}),
        ...(isUnavailable === true ? { isUnavailable: true } : {}),
      },
      relationships: (entity.relationships ?? []).map((rel) => ({ id: rel.id, type: rel.type })),
    };
  }

  private static toManga(entity: MdEntity): MdManga {
    const attrs = entity.attributes ?? {};
    const title = attrs.title;
    const altTitles = attrs.altTitles;
    const originalLanguage = attrs.originalLanguage;
    return {
      id: entity.id,
      attributes: {
        title:
          title !== null && typeof title === "object" ? (title as Record<string, string>) : {},
        altTitles: Array.isArray(altTitles) ? (altTitles as Record<string, string>[]) : [],
        originalLanguage: typeof originalLanguage === "string" ? originalLanguage : null,
      },
    };
  }

  /** As `toManga`, plus the edit-relevant attributes and the version. */
  private static toMangaDetail(entity: MdEntity): MdMangaDetail {
    const base = MdClient.toManga(entity);
    const attrs = entity.attributes ?? {};
    const str = (key: string): string | null => {
      const value = attrs[key];
      return typeof value === "string" && value !== "" ? value : null;
    };
    const links = attrs.links;
    const version = attrs.version;
    return {
      id: base.id,
      attributes: {
        ...base.attributes,
        status: str("status"),
        contentRating: str("contentRating"),
        links:
          links !== null && typeof links === "object" && !Array.isArray(links)
            ? (links as Record<string, string>)
            : null,
        // A title with no readable version cannot be edited safely; 1 is the
        // value MangaDex assigns a fresh entity, and a wrong guess is refused
        // rather than silently overwriting someone else's edit.
        version: typeof version === "number" ? version : 1,
      },
    };
  }

  private static chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  // ----------------------------------------------------------------- MdApi

  async chaptersForManga(mangaId: string, groupId: string): Promise<MdChapter[]> {
    const entities = await this.paginate("chapter", {
      manga: mangaId,
      "groups[]": [groupId],
      "order[createdAt]": "desc",
      ...INCLUDE_UNAVAILABLE,
    });
    return entities.map(MdClient.toChapter);
  }

  async chaptersByIds(ids: string[]): Promise<MdChapter[]> {
    const out: MdChapter[] = [];
    for (const batch of MdClient.chunk([...new Set(ids)], PAGE_LIMIT)) {
      const entities = await this.paginate("chapter", {
        "ids[]": batch,
        "order[createdAt]": "desc",
        ...INCLUDE_UNAVAILABLE,
      });
      out.push(...entities.map(MdClient.toChapter));
    }
    return out;
  }

  /**
   * Which of a group's chapters MangaDex holds, and which it is willing to
   * serve. The set difference is the group's unavailable chapters.
   *
   * It has to be measured as a difference. `isUnavailable` looks like the
   * direct answer and is not: the attribute is absent entirely from chapters
   * whose records predate the field, and on a real group every unavailable
   * chapter came back with no attribute at all, so a test on the flag finds
   * none of them. What MangaDex *does* do reliably is drop them from
   * collection responses unless `includeUnavailable` is set, and that is what
   * this compares. Both passes are otherwise identical so the difference
   * between them can only mean the one thing.
   */
  async chapterAvailabilityForGroup(
    groupId: string,
    onPage?: WalkProgress,
  ): Promise<MdGroupAvailability> {
    const page = async (includeUnavailable: boolean): Promise<MdEntity[]> =>
      this.paginate(
        "chapter",
        {
          "groups[]": [groupId],
          "order[createdAt]": "asc",
          ...(includeUnavailable ? INCLUDE_UNAVAILABLE : {}),
        },
        onPage
          ? (collected, total) => onPage(collected, total, includeUnavailable ? "all" : "served")
          : undefined,
      );

    const all = new Map<string, MdEntity>();
    for (const entity of await page(true)) all.set(entity.id, entity);
    const served = new Set((await page(false)).map((entity) => entity.id));
    return { all, served };
  }

  async mangaByIds(ids: string[]): Promise<MdManga[]> {
    const out: MdManga[] = [];
    for (const batch of MdClient.chunk([...new Set(ids)], PAGE_LIMIT)) {
      const entities = await this.paginate("manga", { "ids[]": batch });
      out.push(...entities.map(MdClient.toManga));
    }
    return out;
  }

  /**
   * GET /manga?title=…; used by the title pipeline to check whether a series
   * already exists on MangaDex before creating a new entry for it. Creating a
   * duplicate title is the one mistake here that other people have to clean up,
   * so this call is worth making every time.
   */
  async searchManga(title: string, limit = 5): Promise<MdManga[]> {
    const trimmed = title.trim();
    if (trimmed.length === 0) return [];
    const response = await this.request("GET", `${this.config.mdApiUrl}/manga`, {
      params: { title: trimmed, limit, "order[relevance]": "desc" },
      successfulCodes: [404],
    });
    if (response.status !== 200 || !response.data) return [];
    const data = response.data["data"];
    if (!Array.isArray(data)) return [];
    return data.map((entity) => MdClient.toManga(entity as MdEntity));
  }

  async mangaById(mangaId: string): Promise<MdMangaDetail | null> {
    const response = await this.request("GET", `${this.config.mdApiUrl}/manga/${mangaId}`, {
      successfulCodes: [404],
    });
    if (response.status === 404) return null;
    const entity = response.data?.data;
    if (entity === null || typeof entity !== "object") return null;
    const typed = entity as MdEntity;
    if (typeof typed.id !== "string") return null;
    return MdClient.toMangaDetail(typed);
  }

  /**
   * Correct an existing title. Mirrors `editChapter`: a PUT carrying the
   * version MangaDex currently holds, which it bumps itself.
   *
   * `tries: 1`, unlike every other write here: a rejection is a validation
   * error, and replaying it against a public catalogue risks applying an edit
   * the operator was told had failed. A 4xx becomes an MdRequestError carrying
   * the status, so the caller can tell "the title moved under you" from
   * "MangaDex refused this".
   *
   * The one rejection that IS replayed is a version conflict, and only with the
   * version MangaDex names in it: the same stale number can never succeed, but
   * the corrected one is the write the caller asked for.
   */
  async editManga(
    mangaId: string,
    payload: Record<string, unknown>,
    version: number,
  ): Promise<boolean> {
    return this.withVersionRetry(`PUT /manga/${mangaId}`, version, async (attempt) => {
      const response = await this.request("PUT", `${this.config.mdApiUrl}/manga/${mangaId}`, {
        json: { ...payload, version: attempt },
        tries: 1,
      });
      return response.status === 200;
    });
  }

  /** Port of fetch_aggregate; returns the `volumes` object, or null on error. */
  async mangaAggregate(mangaId: string, groupId: string): Promise<unknown> {
    const params: Record<string, string | string[]> = {};
    if (groupId) params["groups[]"] = [groupId];
    try {
      const response = await this.request(
        "GET",
        `${this.config.mdApiUrl}/manga/${mangaId}/aggregate`,
        { params },
      );
      return response.data?.volumes ?? null;
    } catch (err) {
      this.log.error({ err, mangaId }, "aggregate fetch failed");
      return null;
    }
  }

  async chapterById(chapterId: string, includes: string[] = []): Promise<MdChapterDetail | null> {
    const params: Record<string, string | string[]> = {};
    if (includes.length > 0) params["includes[]"] = includes;
    const response = await this.request("GET", `${this.config.mdApiUrl}/chapter/${chapterId}`, {
      params,
      successfulCodes: [404],
    });
    if (response.status === 404) return null;
    const entity = response.data?.data;
    if (entity === null || typeof entity !== "object") return null;
    const typed = entity as MdEntity;
    if (typeof typed.id !== "string") return null;
    const chapter = MdClient.toChapter(typed);
    return { ...chapter, relationships: typed.relationships ?? [] };
  }

  async currentUploadSession(): Promise<{ id: string } | null> {
    const response = await this.request("GET", `${this.config.mdApiUrl}/upload`, {
      successfulCodes: [404],
    });
    if (response.status === 404) return null;
    const id = MdClient.dataId(response.data);
    return id ? { id } : null;
  }

  async deleteUploadSession(sessionId: string): Promise<void> {
    await this.request("DELETE", `${this.config.mdApiUrl}/upload/${sessionId}`, {
      successfulCodes: [404],
    });
  }

  async createUploadSession(mangaId: string, groupIds: string[]): Promise<{ id: string }> {
    const response = await this.request("POST", `${this.config.mdApiUrl}/upload/begin`, {
      json: { manga: mangaId, groups: groupIds },
      tries: 1,
    });
    const id = MdClient.dataId(response.data);
    if (!id) throw new MdRequestError("upload session response carried no id");
    return { id };
  }

  /**
   * Edit-mode upload session for an existing chapter (unavailable.py step 3).
   * Unlike /upload/begin this attaches pages to a chapter that already exists.
   */
  async beginEditSession(chapterId: string, version: number | null): Promise<{ id: string }> {
    return this.withVersionRetry(`POST /upload/begin/${chapterId}`, version, async (attempt) => {
      const response = await this.request(
        "POST",
        `${this.config.mdApiUrl}/upload/begin/${chapterId}`,
        { json: { version: attempt }, tries: 1 },
      );
      const id = MdClient.dataId(response.data);
      if (!id) throw new MdRequestError("edit session response carried no id");
      return { id };
    });
  }

  /**
   * POST files to an open session. MangaDex caps a request at 10 files, so
   * larger inputs are split; each file's form field name and filename are both
   * `name`, because MangaDex echoes the filename back as `originalFileName` and
   * the uploader keys page order off it.
   *
   * Throws when MangaDex reports errors for a request, which makes the caller
   * retry the batch.
   */
  async uploadImages(
    sessionId: string,
    files: { name: string; data: Buffer }[],
  ): Promise<MdUploadedImage[]> {
    const uploaded: MdUploadedImage[] = [];

    for (const batch of MdClient.chunk(files, IMAGE_BATCH_SIZE)) {
      const form = new FormData();
      for (const file of batch) {
        const bytes = new Uint8Array(file.data);
        form.append(file.name, new Blob([bytes], { type: sniffImageType(file.data) }), file.name);
      }

      const response = await this.request(
        "POST",
        `${this.config.mdApiUrl}/upload/${sessionId}`,
        { formData: form },
      );

      const errors = response.data?.errors;
      if (response.data?.result === "error" || (Array.isArray(errors) && errors.length > 0)) {
        throw new MdRequestError(
          `image upload reported errors: ${JSON.stringify(errors ?? null).slice(0, 500)}`,
          response.status,
        );
      }

      for (const entity of MdClient.entities(response.data)) {
        const attrs = entity.attributes ?? {};
        const originalFileName = attrs.originalFileName;
        if (typeof originalFileName !== "string") continue;
        const fileSize = attrs.fileSize;
        uploaded.push({
          id: entity.id,
          originalFileName,
          fileSize: typeof fileSize === "number" ? fileSize : 0,
        });
      }
    }

    return uploaded;
  }

  async commitUploadSession(
    sessionId: string,
    draft: {
      volume: string | null;
      chapter: string | null;
      title: string | null;
      translatedLanguage: string;
      externalUrl: string | null;
    },
    pageOrder: string[],
  ): Promise<MdCommitResult | null> {
    // ChapterDraft is `additionalProperties: false` and rejects a null
    // externalUrl, so the key is omitted rather than sent empty.
    const chapterDraft: Record<string, unknown> = {
      volume: draft.volume,
      chapter: draft.chapter,
      title: draft.title,
      translatedLanguage: draft.translatedLanguage,
    };
    if (draft.externalUrl) chapterDraft.externalUrl = draft.externalUrl;

    const response = await this.request(
      "POST",
      `${this.config.mdApiUrl}/upload/${sessionId}/commit`,
      { json: { chapterDraft, pageOrder, termsAccepted: true } },
    );

    const entity = response.data?.data;
    if (entity === null || typeof entity !== "object") {
      // Committed, but MangaDex gave us nothing to record. uploader.py treats
      // this as a success without an id; so do we.
      this.log.warn({ sessionId }, "commit succeeded but response carried no chapter");
      return null;
    }
    const typed = entity as MdEntity;
    if (typeof typed.id !== "string") return null;
    const version = typed.attributes?.version;
    return {
      id: typed.id,
      ...(typeof version === "number" ? { attributes: { version } } : {}),
    };
  }

  async editChapter(chapterId: string, payload: Record<string, unknown>): Promise<boolean> {
    const sent = typeof payload.version === "number" ? payload.version : null;
    return this.withVersionRetry(`PUT /chapter/${chapterId}`, sent, async (version) => {
      const response = await this.request("PUT", `${this.config.mdApiUrl}/chapter/${chapterId}`, {
        json: version === null ? payload : { ...payload, version },
      });
      return response.status === 200;
    });
  }

  /**
   * POST /manga leaves the title in the `draft` state; it only becomes visible
   * once commitMangaDraft publishes it, so the two are always used as a pair.
   */
  async createMangaDraft(payload: {
    title: Record<string, string>;
    originalLanguage: string;
    status: string;
    contentRating: string;
    links?: Record<string, string>;
  }): Promise<{ id: string; version: number }> {
    const response = await this.request("POST", `${this.config.mdApiUrl}/manga`, {
      json: payload,
      tries: 1,
    });
    const entity = response.data?.data;
    if (entity === null || typeof entity !== "object") {
      throw new MdRequestError("manga draft response carried no data");
    }
    const typed = entity as MdEntity;
    if (typeof typed.id !== "string") {
      throw new MdRequestError("manga draft response carried no id");
    }
    const version = typed.attributes?.version;
    return { id: typed.id, version: typeof version === "number" ? version : 1 };
  }

  async commitMangaDraft(mangaId: string, version: number): Promise<boolean> {
    const response = await this.request(
      "POST",
      `${this.config.mdApiUrl}/manga/draft/${mangaId}/commit`,
      { json: { version } },
    );
    return response.status === 200;
  }

  /** 404 counts as deleted; the chapter is gone either way. */
  async deleteChapter(chapterId: string): Promise<boolean> {
    const response = await this.request("DELETE", `${this.config.mdApiUrl}/chapter/${chapterId}`, {
      successfulCodes: [404],
    });
    return response.status === 200 || response.status === 404;
  }

  private static dataId(data: Record<string, unknown> | null): string | null {
    const entity = data?.data;
    if (entity === null || typeof entity !== "object") return null;
    const id = (entity as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
}

/** Magic-byte sniff so the multipart part carries an honest content type. */
function sniffImageType(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6 && data.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (data.length >= 6 && data.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}
