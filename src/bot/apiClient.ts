/**
 * Typed client for the admin half of the core API, as consumed by the Discord
 * bot (see src/core/api/routes/admin.ts for the server side).
 *
 * The bot is an API client and nothing else: it holds no database URL, no
 * MangaDex credential, and no Docker socket. Everything it can do to the
 * platform, it does through one bearer token over HTTPS; which means the blast
 * radius of a compromised bot host is exactly the set of scopes on that token.
 */
import type { Logger } from "../logging.js";
// The scope taxonomy is shared with the server rather than restated here: a
// scope name the bot invents is a 403 nobody can act on, and scopes.ts is a
// dependency-free constant module, so importing it costs the bot nothing.
import type { Scope } from "../core/api/scopes.js";

/**
 * Where the bot looks for the control plane when CORE_URL is unset. Matches
 * worker/coreApi.ts: the public deployment, not a LAN address, because the bot
 * is expected to run wherever is convenient.
 */
export const DEFAULT_CORE_URL = "https://publoader.ardax.dev";

export type { Scope };

/** Any non-2xx answer from the admin API. */
export class AdminApiError extends Error {
  readonly status: number;
  /** The API's own `{error: "..."}` text when it sent one, else the raw body. */
  readonly detail: string;
  readonly scope: Scope;
  readonly retryAfterSeconds: number | undefined;
  /**
   * Scopes the token actually holds. A 403 from `requireScope` reports them,
   * which is the difference between "forbidden" and "you have A and B, you
   * need C".
   */
  readonly held: readonly string[] | undefined;

  constructor(opts: {
    status: number;
    detail: string;
    scope: Scope;
    method: string;
    path: string;
    retryAfterSeconds?: number | undefined;
    held?: readonly string[] | undefined;
  }) {
    super(`${opts.status} from ${opts.method} ${opts.path}: ${opts.detail}`);
    this.name = "AdminApiError";
    this.status = opts.status;
    this.detail = opts.detail;
    this.scope = opts.scope;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.held = opts.held;
  }

  /** True when the credential itself was rejected, as opposed to the request. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Transport-level failure: DNS, connection reset, TLS, timeout. */
export class AdminNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AdminNetworkError";
  }
}

/**
 * Turn a thrown error into something an operator reading Discord can act on.
 * Every branch names the next step, because "403 Forbidden" in a chat window
 * with no logs in front of you is not actionable.
 */
export function describeApiError(err: unknown): string {
  if (err instanceof AdminApiError) {
    switch (err.status) {
      case 401:
        return (
          `**401: the bot's API token was rejected.** The API said: \`${err.detail}\`\n` +
          "Check `BOT_API_TOKEN`: it must be a token the core currently accepts, " +
          "and it must be sent to the right `CORE_URL`. If the token was rotated, " +
          "redeploy the bot with the new value."
        );
      case 403: {
        const holds =
          err.held && err.held.length > 0
            ? `\nThe token currently holds: ${err.held.map((s) => `\`${s}\``).join(", ")}.`
            : "";
        return (
          `**403: the bot's API token lacks the \`${err.scope}\` scope.** The API said: \`${err.detail}\`${holds}\n` +
          `Mint a replacement token that includes \`${err.scope}\` (\`publoader-admin tokens create\`), or accept that this command is not available to the bot.`
        );
      }
      case 404:
        return `**404: not found.** The API said: \`${err.detail}\``;
      case 409:
        // 409 is the API's "your request is valid but the world says no":
        // paused platform, uncancellable job, un-skippable row.
        return `**409: conflict.** The API said: \`${err.detail}\``;
      case 429: {
        const wait = err.retryAfterSeconds
          ? `Wait ${err.retryAfterSeconds}s and try again.`
          : "Wait a few seconds and try again.";
        return `**429: rate limited by the admin API.** ${wait} The API said: \`${err.detail}\``;
      }
      case 503:
        return `**503: that part of the API is not available on this deployment.** The API said: \`${err.detail}\``;
      default:
        return `**${err.status} from the admin API.** It said: \`${err.detail}\``;
    }
  }
  if (err instanceof AdminNetworkError) {
    return `**Could not reach the core API.** ${err.message}\nCheck \`CORE_URL\` and that core-api is up.`;
  }
  return `**Unexpected failure:** \`${err instanceof Error ? err.message : String(err)}\``;
}

// ---- response shapes -------------------------------------------------------
// Structural subsets of what admin.ts returns: only the fields the bot renders.
// Prisma rows come back verbatim, so these intentionally do not try to mirror
// the whole model; a field added server-side must not break the bot.

export interface Stats {
  jobs: Record<string, number>;
  uploadTasks: { kind: string; state: string; count: number }[];
  workers: Record<string, number>;
  quarantined: number;
  paused: boolean;
}

export interface WorkerSummary {
  id: string;
  name: string;
  status: string;
  trust: string;
  capabilities?: unknown;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  createdAt: string;
}

export interface RunSummary {
  id: string;
  extension: string;
  kind: string;
  state: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  triggeredBy?: string | null;
}

export interface JobSummary {
  id: string;
  runId?: string;
  extension?: string;
  state: string;
  attempt: number;
  segmentIndex?: number | null;
  segmentTotal?: number | null;
  lastError?: string | null;
  updatedAt?: string;
  workerId?: string | null;
}

export interface RunDetail extends RunSummary {
  jobs: JobSummary[];
}

export interface ExtensionSummary {
  name: string;
  version: string;
  sha256: string;
  disabled: boolean;
  publishedAt: string;
}

export interface ScheduleEntry {
  id?: string;
  enabled?: boolean;
  hour: number;
  minute: number;
  /** Monday=0 … Sunday=6. Empty = every day. */
  days: number[];
  kind: "UPDATE" | "CLEAN" | "FORCE";
  label?: string;
}

export interface Schedules {
  defaults: Record<string, ScheduleEntry[]>;
  overrides: Record<string, ScheduleEntry[]>;
  effective: Record<string, ScheduleEntry[]>;
}

export interface ExtensionSchedule {
  extension: string;
  manifest: ScheduleEntry[];
  entries: ScheduleEntry[];
  effective: ScheduleEntry[];
  source: "operator" | "manifest";
}

export interface QuarantineEntry {
  id: string;
  jobId: string;
  workerId: string | null;
  rejectReason: string | null;
  createdAt: string;
}

export interface UntrackedEntry {
  id: string;
  extension: string;
  mangaId: string;
  title?: string | null;
  state: string;
  createdAt: string;
}

export interface TrackedEntry {
  extension: string;
  mangaId: string;
  mdMangaId: string;
  source?: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id?: string;
  actor: string;
  action: string;
  target?: string | null;
  createdAt: string;
  metadata?: unknown;
}

/** What POST /enroll-tokens returns: the secret, once, plus its expiry. */
export interface EnrollToken {
  token: string;
  expiresAt: string;
}

export interface TriggerRunResult {
  runId: string;
  created: boolean;
}

/** A row from the uploader's queue; the view legacy `queue_peek` gave. */
export interface UploadTask {
  id: string;
  kind: string;
  state: string;
  dedupeKey: string;
  attempt: number;
  maxAttempts: number;
  notBefore?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: string | null;
  updatedAt: string;
}

/**
 * MangaDex session state. Deliberately says whether a token exists and when it
 * goes stale, never what it is.
 */
export interface MdAuthState {
  hasAccess: boolean;
  hasRefresh: boolean;
  expiresAt: string | null;
  expired: boolean;
  expiresInSeconds: number | null;
}

/** One entry in the merged error feed that stands in for legacy `logs`. */
export interface ErrorEntry {
  at: string;
  kind: string;
  /** Which table it came from, and what `clear`/`restore` take as `source`. */
  source: "job" | "upload-task" | "submission";
  subject: string;
  message: string;
  id: string;
  /** Set only on entries an operator has already dealt with. */
  cleared?: { at: string; by: string; note: string | null };
}

/** Which acknowledged entries a feed read should include. */
export type ErrorClearedFilter = "without" | "with" | "only";

export type UploadTaskKind = "UPLOAD" | "EDIT" | "DELETE" | "UNAVAILABLE";
export type UploadTaskState = "PENDING" | "LEASED" | "DONE" | "FAILED" | "DEAD_LETTER";

/**
 * What a reconcile pass found. Mirrors ReconcileReport in
 * core/md/chapterReconcile.ts, narrowed to the fields the bot renders.
 */
/** One title's footprint in an archive, as `/chapters/series` reports it. */
export interface ArchiveSeries {
  mdMangaId: string;
  mangaName: string | null;
  extensions: string[];
  count: number;
  at: string;
}

export interface ArchiveSeriesReport {
  archive: string;
  series: ArchiveSeries[];
  limit: number;
  capped: boolean;
}

/** Mirrors ReconcileRunState in core/md/reconcileRunner.ts. */
export interface ChapterReconcileStatus {
  state: "idle" | "running" | "done" | "failed";
  progress?: { detail: string; done: number; total: number | null };
  report?: ChapterReconcileReport;
  error?: string;
}

export interface ChapterReconcileReport {
  dryRun: boolean;
  groups: {
    extension: string;
    groupId: string;
    total: number;
    carded: number;
    recorded: number;
    hiddenOnMangadex: number;
    live: number;
    untracked: number;
    adopted: number;
    adoptedWithId: number;
  }[];
  unavailableFound: number;
  unavailableRecorded: number;
  untrackedFound: number;
  adoptedRecorded: number;
  idsRecorded: number;
  scanned: number;
  skippedByGroupWalk: number;
  deletedFound: number;
  deletedRecorded: number;
  hiddenOnMangadex: string[];
}

/**
 * What the bot can say about its own credential. `scopes` is populated only if
 * the deployment exposes token introspection; see `tokenSelf()`.
 */
export interface TokenIdentity {
  actor?: string;
  scopes?: string[];
  expiresAt?: string | null;
  note?: string | null;
}

export interface RoleBaseline {
  role: string;
  scopes: string[];
  defaults: string[];
  custom: boolean;
  tunable: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface PermissionCatalogue {
  scopes: { name: string; description: string }[];
  presets: Record<string, string[]>;
  tunableRoles: string[];
  roles: RoleBaseline[];
}

export interface UserPermissions {
  userId: string;
  email: string;
  role: string;
  baseline: string[];
  extraScopes: string[];
  deniedScopes: string[];
  effective: string[];
  tunable: boolean;
}

export type UntrackedState = "NEW" | "CREATING" | "CREATED" | "TRACKED" | "FAILED" | "SKIPPED";
export type RunKind = "UPDATE" | "CLEAN" | "FORCE";
export type RemovalMode = "unavailable" | "delete";
export type WorkerAction = "drain" | "activate" | "revoke";

interface RequestSpec {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  scope: Scope;
  /** Attributed to this human in the audit log via `x-actor`. */
  actor: string;
  json?: unknown;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}

export interface AdminApiClientOptions {
  baseUrl?: string | undefined;
  token: string;
  log?: Logger | undefined;
  /** Overridable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
}

export class AdminApiClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly log: Logger | undefined;
  private readonly fetchImpl: typeof fetch;
  /** Learned from a 403's `held` array; see `request()`. */
  private lastKnownScopes: readonly string[] | undefined;

  constructor(opts: AdminApiClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_CORE_URL).replace(/\/+$/, "");
    this.token = opts.token;
    this.log = opts.log;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * A masked form of the token, safe to print. Enough to tell two tokens apart
   * and to see at a glance whether the bot was handed a scoped `pa_…` token or
   * the root admin token.
   */
  get tokenFingerprint(): string {
    const t = this.token;
    if (t.length <= 8) return "*".repeat(t.length);
    return `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`;
  }

  /**
   * True when the token looks like a scoped per-client credential rather than
   * the platform's root ADMIN_TOKEN. Prefix-based and therefore a hint, not a
   * guarantee; but a bot running on the root token is worth warning about on
   * every startup, and this is the only signal available client-side.
   */
  get looksScoped(): boolean {
    return this.token.startsWith("pa_");
  }

  /**
   * Scopes observed on this token, if any command has been refused for lacking
   * one. Not authoritative, it is empty until the first 403, but it is the
   * only scope information available without an introspection endpoint.
   */
  get observedScopes(): readonly string[] | undefined {
    return this.lastKnownScopes;
  }

  private async request<T>(spec: RequestSpec): Promise<T> {
    const url = new URL(this.baseUrl + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
      // The audit log records the principal, not the process: without this
      // every action taken through the bot would read as one anonymous robot.
      "x-actor": spec.actor,
    };
    let body: string | undefined;
    if (spec.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(spec.json);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(spec.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new AdminNetworkError(`${spec.method} ${url.pathname} failed: ${(err as Error).message}`, {
        cause: err,
      });
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const held = extractHeldScopes(text);
      // A 403 is the only place the API volunteers what the token can do. Keep
      // it so `/whoami` can answer honestly without an introspection endpoint.
      if (held) this.lastKnownScopes = held;
      throw new AdminApiError({
        status: res.status,
        detail: extractError(text) ?? `${res.status} ${res.statusText}`,
        scope: spec.scope,
        method: spec.method,
        path: url.pathname,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        held,
      });
    }
    this.log?.debug({ method: spec.method, path: url.pathname, status: res.status }, "admin api call");
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AdminNetworkError(`${spec.method} ${url.pathname} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  // ---- observability ----

  stats(actor: string): Promise<Stats> {
    return this.request<Stats>({ method: "GET", path: "/api/v1/admin/stats", scope: "stats:read", actor });
  }

  audit(actor: string, limit: number): Promise<{ events: AuditEntry[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/audit",
      scope: "audit:read",
      actor,
      query: { limit },
    });
  }

  /**
   * Best-effort token introspection.
   *
   * There is no self-describe endpoint today: `/api/v1/admin/tokens/*` manages
   * *other* tokens and is gated on `users:admin` + OWNER, which a bot token can
   * never hold. So a 404 here is the expected answer and means "this deployment
   * cannot describe the token" rather than a failure. The probe stays because
   * the day such an endpoint exists, `/whoami` starts listing real scopes with
   * no change to the bot. A 403 is also treated as "cannot tell"; it still
   * yields the held-scope list via `observedScopes`.
   */
  async tokenSelf(actor: string): Promise<TokenIdentity | null> {
    try {
      return await this.request<TokenIdentity>({
        method: "GET",
        path: "/api/v1/admin/tokens/self",
        scope: "stats:read",
        actor,
      });
    } catch (err) {
      if (err instanceof AdminApiError && [403, 404, 405].includes(err.status)) return null;
      throw err;
    }
  }

  /**
   * Start a reporting pass over what MangaDex holds.
   *
   * Dry run only, and not because the bot is untrusted in general: applying is
   * closed to api tokens at the endpoint (routes/chapters.ts), so a bot token
   * could not write these rows even if this asked it to. Reporting is the
   * useful half here anyway: the answer is a number somebody needs to see
   * before deciding to act on it.
   *
   * The pass runs on the server and this only starts it. It takes minutes --
   * a group walk is ~124 MangaDex requests at the client's rate limit -- which
   * is longer than a Discord interaction may be left unanswered, so the command
   * polls `reconcileStatus` and reports whatever is known when its own clock
   * runs out.
   */
  startChapterReconcile(
    actor: string,
    extensions: string[],
  ): Promise<ChapterReconcileStatus & { started: boolean }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/chapters/reconcile",
      scope: "chapters:read",
      actor,
      json: { dryRun: true, extensions },
    });
  }

  /** Where the current or last pass is up to. Cheap: one settings row, no MangaDex. */
  reconcileStatus(actor: string): Promise<ChapterReconcileStatus> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/chapters/reconcile",
      scope: "chapters:read",
      actor,
    });
  }

  /**
   * The titles present in an archive, most-affected first.
   *
   * Read-only and therefore reachable on a `pa_…` token, unlike the re-card it
   * exists to aim: queuing card images is closed to api tokens at the endpoint,
   * so what the bot can usefully do is answer "which title, and how many pages
   * would move?" — the question somebody asks in a channel before going to the
   * dashboard or the CLI to do it.
   */
  archiveSeries(
    actor: string,
    opts: { archive: string; search?: string | undefined; extension?: string | undefined; limit?: number },
  ): Promise<ArchiveSeriesReport> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/chapters/series",
      scope: "chapters:read",
      actor,
      query: {
        archive: opts.archive,
        search: opts.search,
        extension: opts.extension,
        limit: opts.limit ?? 25,
      },
      // Autocomplete calls this on the keystroke and Discord closes the window
      // at three seconds; a slow answer is worth abandoning, not waiting for.
      timeoutMs: 2500,
    });
  }

  // ---- permission tuning ----

  /**
   * What the roles mean on this deployment.
   *
   * Reachable with `users:admin` alone, unlike everything below it — which is
   * the whole reason the bot has a permissions command at all. The writes are
   * OWNER-gated server-side and a `pa_…` token is never OWNER, so they answer
   * 403 unless the bot was (unwisely) given the root ADMIN_TOKEN. That refusal
   * is the honest outcome and the handler renders it rather than hiding the
   * subcommand: "you cannot do this from here" beats a missing feature.
   */
  permissions(actor: string): Promise<PermissionCatalogue> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/permissions",
      scope: "users:admin",
      actor,
    });
  }

  setRolePermissions(actor: string, role: string, scopes: string[]): Promise<{ role: string; scopes: string[] }> {
    return this.request({
      method: "PUT",
      path: `/api/v1/admin/permissions/roles/${encodeURIComponent(role)}`,
      scope: "users:admin",
      actor,
      json: { scopes },
    });
  }

  resetRolePermissions(actor: string, role: string): Promise<{ role: string; scopes: string[] }> {
    return this.request({
      method: "DELETE",
      path: `/api/v1/admin/permissions/roles/${encodeURIComponent(role)}`,
      scope: "users:admin",
      actor,
    });
  }

  userPermissions(actor: string, userId: string): Promise<UserPermissions> {
    return this.request({
      method: "GET",
      path: `/api/v1/admin/users/${encodeURIComponent(userId)}/permissions`,
      scope: "users:admin",
      actor,
    });
  }

  setUserPermissions(
    actor: string,
    userId: string,
    tuning: { extraScopes: string[]; deniedScopes: string[] },
  ): Promise<{ extraScopes: string[]; deniedScopes: string[]; effective: string[] }> {
    return this.request({
      method: "PUT",
      path: `/api/v1/admin/users/${encodeURIComponent(userId)}/permissions`,
      scope: "users:admin",
      actor,
      json: tuning,
    });
  }

  // ---- pause / resume ----

  pause(actor: string, minutes: number | null): Promise<{ paused: boolean; indefinite: boolean }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/pause",
      scope: "settings:write",
      actor,
      json: { minutes },
    });
  }

  resume(actor: string): Promise<{ paused: boolean }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/resume",
      scope: "settings:write",
      actor,
      json: {},
    });
  }

  // ---- runs & jobs ----

  triggerRun(
    actor: string,
    opts: { extension: string; kind: RunKind; idempotencyKey?: string },
  ): Promise<TriggerRunResult> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/runs",
      scope: "runs:write",
      actor,
      json: opts,
      // createRunForExtension does real work (bundle lookup, segmentation).
      timeoutMs: 45_000,
    });
  }

  listRuns(actor: string, opts: { limit: number; extension?: string }): Promise<{ runs: RunSummary[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/runs",
      scope: "runs:read",
      actor,
      query: { limit: opts.limit, extension: opts.extension },
    });
  }

  getRun(actor: string, id: string): Promise<{ run: RunDetail }> {
    return this.request({
      method: "GET",
      path: `/api/v1/admin/runs/${encodeURIComponent(id)}`,
      scope: "runs:read",
      actor,
    });
  }

  cancelJob(actor: string, id: string): Promise<{ ok: boolean; result: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/jobs/${encodeURIComponent(id)}/cancel`,
      scope: "runs:write",
      actor,
      json: {},
    });
  }

  retryJob(actor: string, id: string): Promise<{ ok: boolean }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/jobs/${encodeURIComponent(id)}/retry`,
      scope: "runs:write",
      actor,
      json: {},
    });
  }

  deadLetter(actor: string): Promise<{ jobs: JobSummary[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/dead-letter",
      scope: "runs:read",
      actor,
    });
  }

  quarantine(actor: string): Promise<{ quarantined: QuarantineEntry[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/quarantine",
      scope: "runs:read",
      actor,
    });
  }

  // ---- upload-task queues (routes/ops.ts) ----

  uploadTasks(
    actor: string,
    opts: { kind?: UploadTaskKind; state?: UploadTaskState; limit: number },
  ): Promise<{ tasks: UploadTask[]; counts: { kind: string; state: string; count: number }[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/upload-tasks",
      scope: "runs:read",
      actor,
      query: { kind: opts.kind, state: opts.state, limit: opts.limit },
    });
  }

  retryUploadTask(actor: string, id: string): Promise<{ ok: boolean; state: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/upload-tasks/${encodeURIComponent(id)}/retry`,
      scope: "runs:write",
      actor,
      json: {},
    });
  }

  cancelUploadTask(actor: string, id: string): Promise<{ ok: boolean; state: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/upload-tasks/${encodeURIComponent(id)}/cancel`,
      scope: "runs:write",
      actor,
      json: {},
    });
  }

  requeueStaleUploadTasks(actor: string): Promise<{ ok: boolean; requeued: number }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/upload-tasks/requeue-stale",
      scope: "runs:write",
      actor,
      json: {},
    });
  }

  // ---- MangaDex session visibility (routes/ops.ts) ----

  mdAuth(actor: string): Promise<MdAuthState> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/mangadex/auth",
      scope: "settings:write",
      actor,
    });
  }

  clearMdAuth(actor: string): Promise<{ ok: boolean; cleared: boolean }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/mangadex/auth/clear",
      scope: "settings:write",
      actor,
      json: {},
    });
  }

  /**
   * The merged failure feed: dead-lettered jobs, failed tasks, quarantines.
   *
   * Acknowledged entries are omitted by default and counted in `clearedHidden`,
   * so a quiet feed can be reported as "nothing outstanding" without implying
   * nothing ever failed.
   */
  errors(
    actor: string,
    limit: number,
    cleared: ErrorClearedFilter = "without",
  ): Promise<{ errors: ErrorEntry[]; clearedHidden: number }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/errors",
      scope: "runs:read",
      actor,
      query: { limit, cleared },
    });
  }

  /**
   * Mark failures as read and dealt with, by id (a full id or a leading prefix)
   * or all at once. Hides them from the feed; changes nothing about the rows.
   */
  clearErrors(
    actor: string,
    body: { ids?: string[]; all?: boolean; note?: string },
  ): Promise<{
    ok: boolean;
    cleared: number;
    entries?: { source: string; id: string }[];
    skipped?: { source: string | null; id: string; reason: string }[];
  }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/errors/clear",
      scope: "runs:write",
      actor,
      json: body,
    });
  }

  /** Undo clearing: put acknowledged entries back in the feed. */
  restoreErrors(actor: string, body: { ids?: string[]; all?: boolean }): Promise<{ ok: boolean; restored: number }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/errors/restore",
      scope: "runs:write",
      actor,
      json: body,
    });
  }

  // ---- extensions ----

  extensions(actor: string): Promise<{ extensions: ExtensionSummary[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/extensions",
      scope: "extensions:read",
      actor,
    });
  }

  setExtensionEnabled(actor: string, name: string, enabled: boolean): Promise<{ ok: boolean }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/extensions/${encodeURIComponent(name)}/${enabled ? "enable" : "disable"}`,
      scope: "extensions:write",
      actor,
      json: {},
    });
  }

  // ---- schedules ----

  schedules(actor: string): Promise<Schedules> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/schedules",
      scope: "extensions:read",
      actor,
    });
  }

  extensionSchedule(actor: string, name: string): Promise<ExtensionSchedule> {
    return this.request({
      method: "GET",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}`,
      scope: "extensions:read",
      actor,
    });
  }

  /** Append a slot. The API seeds the manifest's slots first when there are none. */
  addSchedule(
    actor: string,
    name: string,
    entry: Omit<ScheduleEntry, "id" | "enabled">,
  ): Promise<{ ok: boolean; id: string; created: boolean; seeded: number }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}`,
      scope: "extensions:write",
      actor,
      json: entry,
    });
  }

  /** Replace the whole schedule with this one slot. */
  setSchedule(
    actor: string,
    name: string,
    entry: Omit<ScheduleEntry, "id" | "enabled">,
  ): Promise<{ ok: boolean; entries: number }> {
    return this.request({
      method: "PUT",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}`,
      scope: "extensions:write",
      actor,
      json: entry,
    });
  }

  setScheduleEnabled(
    actor: string,
    name: string,
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; enabled: boolean }> {
    return this.request({
      method: "PATCH",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
      scope: "extensions:write",
      actor,
      json: { enabled },
    });
  }

  removeScheduleEntry(
    actor: string,
    name: string,
    id: string,
  ): Promise<{ ok: boolean; removed: boolean }> {
    return this.request({
      method: "DELETE",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
      scope: "extensions:write",
      actor,
    });
  }

  /** Drop every slot; the extension falls back to its manifest schedule. */
  removeSchedule(actor: string, name: string): Promise<{ ok: boolean; removed: boolean }> {
    return this.request({
      method: "DELETE",
      path: `/api/v1/admin/schedules/${encodeURIComponent(name)}`,
      scope: "extensions:write",
      actor,
    });
  }

  // ---- removal mode ----

  getRemovalMode(actor: string): Promise<{ mode: RemovalMode; validModes: readonly string[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/removal-mode",
      scope: "settings:write",
      actor,
    });
  }

  setRemovalMode(actor: string, mode: RemovalMode): Promise<{ ok: boolean; mode: string }> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/removal-mode",
      scope: "settings:write",
      actor,
      json: { mode },
    });
  }

  // ---- worker fleet ----

  workers(actor: string): Promise<{ workers: WorkerSummary[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/workers",
      scope: "workers:read",
      actor,
    });
  }

  workerAction(actor: string, id: string, action: WorkerAction): Promise<{ ok: boolean; status: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/workers/${encodeURIComponent(id)}/${action}`,
      scope: "workers:write",
      actor,
      json: {},
    });
  }

  createEnrollToken(
    actor: string,
    opts: { trust: "TRUSTED" | "COMMUNITY"; note?: string; ttlHours: number },
  ): Promise<EnrollToken> {
    return this.request({
      method: "POST",
      path: "/api/v1/admin/enroll-tokens",
      scope: "enroll:write",
      actor,
      json: opts,
    });
  }

  // ---- untracked / tracked series ----

  untracked(
    actor: string,
    opts: { state?: UntrackedState; limit: number },
  ): Promise<{ untracked: UntrackedEntry[] }> {
    return this.request({
      method: "GET",
      path: "/api/v1/admin/untracked",
      scope: "untracked:read",
      actor,
      query: { state: opts.state, limit: opts.limit },
    });
  }

  approveUntracked(actor: string, id: string): Promise<{ ok: boolean; mdMangaId?: string }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/untracked/${encodeURIComponent(id)}/approve`,
      scope: "untracked:write",
      actor,
      json: {},
      // Creates a real MangaDex title synchronously.
      timeoutMs: 60_000,
    });
  }

  skipUntracked(actor: string, id: string): Promise<{ ok: boolean }> {
    return this.request({
      method: "POST",
      path: `/api/v1/admin/untracked/${encodeURIComponent(id)}/skip`,
      scope: "untracked:write",
      actor,
      json: {},
    });
  }

  tracked(actor: string, extension: string): Promise<{ tracked: TrackedEntry[] }> {
    return this.request({
      method: "GET",
      path: `/api/v1/admin/extensions/${encodeURIComponent(extension)}/tracked`,
      scope: "extensions:read",
      actor,
    });
  }

  setTracked(
    actor: string,
    extension: string,
    entry: { mangaId: string; mdMangaId: string },
  ): Promise<{ ok: boolean }> {
    return this.request({
      method: "PUT",
      path: `/api/v1/admin/extensions/${encodeURIComponent(extension)}/tracked`,
      scope: "extensions:write",
      actor,
      json: entry,
    });
  }

  removeTracked(actor: string, extension: string, mangaId: string): Promise<{ ok: boolean; removed: boolean }> {
    return this.request({
      method: "DELETE",
      path:
        `/api/v1/admin/extensions/${encodeURIComponent(extension)}` +
        `/tracked/${encodeURIComponent(mangaId)}`,
      scope: "extensions:write",
      actor,
    });
  }
}

/**
 * Pull the `held` array out of a `requireScope` 403 body
 * (`{error: "missing scope: x", held: [...]}`). Absent on any other error.
 */
function extractHeldScopes(body: string): readonly string[] | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "held" in parsed) {
      const held = (parsed as { held: unknown }).held;
      if (Array.isArray(held) && held.every((s) => typeof s === "string")) return held;
    }
  } catch {
    // Not JSON; nothing to learn.
  }
  return undefined;
}

/** Pull `{error: "..."}` out of an API response body, if that is its shape. */
function extractError(body: string): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const value = (parsed as { error: unknown }).error;
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    }
  } catch {
    // Not JSON; a proxy error page, most likely.
  }
  return body.slice(0, 300);
}
