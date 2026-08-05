import { z } from "zod";

/**
 * All configuration is environment-driven (12-factor). Secrets support the
 * Docker-secrets convention: any VAR may instead be provided as VAR_FILE
 * pointing at a file whose contents are the value.
 */
import { readFileSync } from "node:fs";

function env(name: string): string | undefined {
  const fileVar = process.env[`${name}_FILE`];
  if (fileVar) {
    return readFileSync(fileVar, "utf8").trim();
  }
  return process.env[name];
}

const ConfigSchema = z.object({
  // Empty on worker agents by design — workers never see the database.
  // Core services fail fast in getPrisma() if it is missing.
  databaseUrl: z.string().default(""),
  port: z.coerce.number().int().default(8100),
  host: z.string().default("0.0.0.0"),
  /** Admin bearer token for operator endpoints (bot/dash/CLI). */
  adminToken: z.string().min(16).optional(),
  /**
   * HMAC key for short-lived signed cookies (currently the OAuth state
   * cookie). Session cookies are DB-backed and do not depend on it. Optional:
   * when unset a key is derived from adminToken via HKDF, with a boot warning.
   */
  sessionSecret: z.string().min(32).optional(),
  sessionTtlMinutes: z.coerce.number().int().min(5).max(10080).default(720),
  /**
   * Force the `Secure` cookie attribute. Normally inferred per-request from
   * `x-forwarded-proto`; set this when the proxy does not send that header.
   */
  sessionCookieSecure: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  // Lease/queue tuning
  leaseTtlSeconds: z.coerce.number().int().min(30).default(300),
  sweepIntervalSeconds: z.coerce.number().int().min(5).default(30),
  schedulerIntervalSeconds: z.coerce.number().int().min(5).default(30),
  retryBaseSeconds: z.coerce.number().int().min(1).default(60),
  retryMaxSeconds: z.coerce.number().int().min(60).default(3600),
  leasePollWaitSeconds: z.coerce.number().int().min(1).max(60).default(25),

  // MangaDex (core only; NEVER passed to workers)
  mdApiUrl: z.string().default("https://api.mangadex.org"),
  mdAuthUrl: z
    .string()
    .default("https://auth.mangadex.org/realms/mangadex/protocol/openid-connect"),
  mdUsername: z.string().optional(),
  mdPassword: z.string().optional(),
  mdClientId: z.string().optional(),
  mdClientSecret: z.string().optional(),
  /**
   * Scanlation group UUIDs whose members may reach the dashboard, comma- or
   * space-separated. Empty means no group is trusted, which is the *strict*
   * setting: MangaDex self-signup is refused outright and only accounts an
   * OWNER invited by username can sign in.
   */
  mdAllowedGroupIds: z.string().default(""),
  mdRatelimitMs: z.coerce.number().int().default(2000),
  uploadRetry: z.coerce.number().int().min(1).default(3),

  // Discord notifications (core only)
  discordWebhookUrls: z.string().default(""),

  // Dashboard accounts (core-api only)
  /** Seeded OWNER account, created idempotently at core-api startup. */
  dashOwnerEmail: z.string().email().default("iam@ardax.dev"),
  /** Public origin the browser reaches. */
  dashPublicUrl: z.string().url().default("https://publoader.ardax.dev"),

  // GitHub push webhook (core-api only). See docs/webhooks.md — CI-side
  // publishing is the preferred alternative to all of this.
  /**
   * Shared HMAC secret for X-Hub-Signature-256. The endpoint is
   * unauthenticated by design, so this IS the credential: with it unset the
   * webhook refuses every delivery rather than accepting unsigned ones.
   */
  githubWebhookSecret: z.string().min(16).optional(),
  /** Required to match the owner in `repository.full_name`, case-insensitively. */
  githubRepoOwner: z.string().default("publoader"),
  /** Comma-separated repo names whose pushes publish extension bundles. */
  githubExtensionsRepos: z.string().default(""),
  /** Repo name for the core service; pushes to it are acknowledged, not acted on. */
  githubCoreRepo: z.string().default(""),
  /** Read access to the extensions repos. Required for the private one. */
  githubToken: z.string().optional(),
  githubApiUrl: z.string().default("https://api.github.com"),

  // Operator self-service (core-api only). See docs/operations.md §"Self-service".
  /**
   * Where the shipped documentation lives, for the dashboard's docs viewer.
   * Empty means "look for a `docs/` directory next to the build", which is
   * correct both in the container (/app/docs) and from a source checkout.
   */
  docsPath: z.string().default(""),
  /**
   * Whether the restart endpoint may exit the process.
   *
   * Restart is implemented as a graceful self-exit and depends entirely on the
   * container runtime starting the service again (`restart: unless-stopped`).
   * Set this false wherever that policy is absent — a bare `docker run` or a
   * `docker compose up` with no restart policy — so the button refuses instead
   * of taking the service down for good.
   */
  sysopsRestartEnabled: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Worker agent settings (worker process only)
  coreUrl: z.string().optional(),
  workerToken: z.string().optional(),
  enrollToken: z.string().optional(),
  workerName: z.string().optional(),
  workerStatePath: z.string().default("/var/lib/publoader-worker"),
  /**
   * DEPRECATED. Only used for bundles published before extension API v2; the
   * worker image no longer ships an interpreter, so this needs an explicitly
   * provisioned python3 to work at all.
   */
  runnerPython: z.string().default("python3"),
  runnerExtraArgs: z.string().default(""),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(overrides: Partial<Record<string, string>> = {}): Config {
  // A blank value means "not set". Compose interpolates unset variables to the
  // empty string and .env templates ship keys with no value, so without this a
  // commented-out optional knob would fail schema validation at boot.
  const get = (n: string) => {
    const raw = overrides[n] ?? env(n);
    return raw === "" ? undefined : raw;
  };
  return ConfigSchema.parse({
    databaseUrl: get("DATABASE_URL") ?? "",
    port: get("PORT"),
    host: get("HOST"),
    adminToken: get("ADMIN_TOKEN"),
    sessionSecret: get("SESSION_SECRET"),
    sessionTtlMinutes: get("SESSION_TTL_MINUTES"),
    sessionCookieSecure: get("SESSION_COOKIE_SECURE"),
    logLevel: get("LOG_LEVEL"),
    leaseTtlSeconds: get("LEASE_TTL_SECONDS"),
    sweepIntervalSeconds: get("SWEEP_INTERVAL_SECONDS"),
    schedulerIntervalSeconds: get("SCHEDULER_INTERVAL_SECONDS"),
    retryBaseSeconds: get("RETRY_BASE_SECONDS"),
    retryMaxSeconds: get("RETRY_MAX_SECONDS"),
    leasePollWaitSeconds: get("LEASE_POLL_WAIT_SECONDS"),
    mdApiUrl: get("MANGADEX_API_URL"),
    mdAuthUrl: get("MANGADEX_AUTH_URL"),
    mdUsername: get("MANGADEX_USERNAME"),
    mdPassword: get("MANGADEX_PASSWORD"),
    mdClientId: get("MANGADEX_CLIENT_ID"),
    mdClientSecret: get("MANGADEX_CLIENT_SECRET"),
    mdAllowedGroupIds: get("MANGADEX_ALLOWED_GROUP_IDS"),
    mdRatelimitMs: get("MANGADEX_RATELIMIT_MS"),
    uploadRetry: get("UPLOAD_RETRY"),
    discordWebhookUrls: get("DISCORD_WEBHOOK_URLS"),
    dashOwnerEmail: get("DASH_OWNER_EMAIL"),
    dashPublicUrl: get("DASH_PUBLIC_URL"),
    githubWebhookSecret: get("GITHUB_WEBHOOK_SECRET"),
    githubRepoOwner: get("GITHUB_REPO_OWNER"),
    githubExtensionsRepos: get("GITHUB_EXTENSIONS_REPOS"),
    githubCoreRepo: get("GITHUB_CORE_REPO"),
    githubToken: get("GITHUB_TOKEN"),
    githubApiUrl: get("GITHUB_API_URL"),
    docsPath: get("DOCS_PATH"),
    sysopsRestartEnabled: get("SYSOPS_RESTART_ENABLED"),
    coreUrl: get("CORE_URL"),
    workerToken: get("WORKER_TOKEN"),
    enrollToken: get("ENROLL_TOKEN"),
    workerName: get("WORKER_NAME"),
    workerStatePath: get("WORKER_STATE_PATH"),
    runnerPython: get("RUNNER_PYTHON"),
    runnerExtraArgs: get("RUNNER_EXTRA_ARGS"),
  });
}
