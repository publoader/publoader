#!/usr/bin/env node
/**
 * `publoader-admin`: operator CLI for the platform control plane.
 *
 * Every subcommand is a thin wrapper over an admin API endpoint (see
 * docs/ipc-to-api-mapping.md for the legacy IPC equivalences). The CLI holds no
 * database credentials and never talks to Postgres directly: the core API is
 * the only writer, so the CLI is safe to run from a laptop.
 *
 * Configuration (env):
 *   PUBLOADER_API_URL     default https://publoader.ardax.dev
 *   PUBLOADER_ADMIN_TOKEN required for every command
 *   USER                  sent as X-Actor so the audit trail names a human
 */
import { Command } from "commander";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { BundleBuildError, buildExtensionBundle } from "../core/webhooks/bundleBuilder.js";

const DEFAULT_API_URL = "https://publoader.ardax.dev";

function apiBase(): string {
  return (process.env["PUBLOADER_API_URL"] ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

function adminToken(): string {
  const token = process.env["PUBLOADER_ADMIN_TOKEN"];
  if (!token) {
    fail("PUBLOADER_ADMIN_TOKEN is not set");
  }
  return token;
}

function actor(): string {
  return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** `namespace/externalId` when the extension has catalogues, else the bare id. */
function qualify(namespace: string | undefined, mangaId: string): string {
  return namespace ? `${namespace}/${mangaId}` : mangaId;
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  json?: unknown;
  raw?: { body: Buffer; contentType: string; headers?: Record<string, string> };
  query?: Record<string, string | number | undefined>;
};

/**
 * One request against the admin API. Non-2xx responses abort the process with
 * the server's error message; an operator running a script wants a non-zero
 * exit, not a partially-applied change reported as success.
 */
async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(apiBase() + path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${adminToken()}`,
    "x-actor": actor(),
    accept: "application/json",
  };
  let body: string | Uint8Array | undefined;
  if (opts.raw) {
    headers["content-type"] = opts.raw.contentType;
    Object.assign(headers, opts.raw.headers ?? {});
    body = new Uint8Array(opts.raw.body);
  } else if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }

  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? "GET", headers, body });
  } catch (err) {
    return fail(`cannot reach ${url.origin}: ${(err as Error).message}`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const detail =
      (parsed as { error?: string; message?: string }).error ??
      (parsed as { message?: string }).message ??
      text.slice(0, 500);
    return fail(`${res.status} ${res.statusText} from ${url.pathname}: ${detail}`);
  }
  return parsed as T;
}

// ---------------------------------------------------------------- formatting

type Column<T> = { header: string; get: (row: T) => unknown };

function cell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Left-aligned fixed-width table. CLI output is the one place console.log is correct. */
function table<T>(rows: T[], columns: Column<T>[], emptyNote = "(none)"): void {
  if (rows.length === 0) {
    console.log(emptyNote);
    return;
  }
  const cells = rows.map((row) => columns.map((col) => cell(col.get(row))));
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...cells.map((r) => (r[i] ?? "").length)),
  );
  const line = (values: string[]) =>
    values.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ").trimEnd();

  console.log(line(columns.map((c) => c.header)));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of cells) console.log(line(row));
}

function kv(obj: Record<string, unknown>): void {
  const width = Math.max(0, ...Object.keys(obj).map((k) => k.length));
  for (const [key, value] of Object.entries(obj)) {
    console.log(`${key.padEnd(width)}  ${cell(value)}`);
  }
}

function ok(message: string): void {
  console.log(message);
}

function ago(iso: unknown): string {
  if (typeof iso !== "string") return "-";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "-";
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

// ------------------------------------------------------------------ commands

const program = new Command();
program
  .name("publoader-admin")
  .description("Operator CLI for the Publoader distributed platform")
  .version("1.0.0")
  .showHelpAfterError();

// ---- enroll tokens ----
const enroll = program.command("enroll-token").description("worker enrollment tokens");

enroll
  .command("create")
  .description("mint a single-use enrollment token for a new worker host")
  .option("--trust", "issue a TRUSTED-tier token (default COMMUNITY)", false)
  .option("--note <text>", "free-text note recorded with the token")
  .option("--ttl-hours <n>", "validity window in hours", "24")
  .action(async (opts: { trust: boolean; note?: string; ttlHours: string }) => {
    const ttlHours = Number(opts.ttlHours);
    if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 720) {
      fail("--ttl-hours must be an integer between 1 and 720");
    }
    const res = await api<{ token: string; expiresAt: string }>(
      "/api/v1/admin/enroll-tokens",
      {
        method: "POST",
        json: {
          trust: opts.trust ? "TRUSTED" : "COMMUNITY",
          ...(opts.note ? { note: opts.note } : {}),
          ttlHours,
        },
      },
    );
    kv({
      token: res.token,
      trust: opts.trust ? "TRUSTED" : "COMMUNITY",
      expiresAt: res.expiresAt,
    });
    console.log("");
    console.log("This token is shown once. Hand it to the worker host as ENROLL_TOKEN.");
  });

// ---- workers ----
const workers = program.command("workers").description("worker fleet");

workers
  .command("list")
  .description("list enrolled workers")
  .action(async () => {
    const res = await api<{ workers: Record<string, unknown>[] }>("/api/v1/admin/workers");
    table(res.workers, [
      { header: "ID", get: (w) => w["id"] },
      { header: "NAME", get: (w) => w["name"] },
      { header: "STATUS", get: (w) => w["status"] },
      { header: "TRUST", get: (w) => w["trust"] },
      { header: "AGENT", get: (w) => w["agentVersion"] },
      { header: "HEARTBEAT", get: (w) => ago(w["lastHeartbeatAt"]) },
    ], "no workers enrolled");
  });

for (const action of ["drain", "activate", "revoke"] as const) {
  const help = {
    drain: "stop leasing new jobs to a worker (in-flight job finishes)",
    activate: "return a drained worker to service",
    revoke: "permanently invalidate a worker's credential",
  }[action];
  workers
    .command(`${action} <id>`)
    .description(help)
    .action(async (id: string) => {
      const res = await api<{ status: string }>(`/api/v1/admin/workers/${id}/${action}`, {
        method: "POST",
      });
      ok(`worker ${id} -> ${res.status}`);
    });
}

// ---- runs ----
const runs = program.command("runs").description("scrape runs");

runs
  .command("list")
  .description("recent runs, newest first")
  .option("--limit <n>", "how many runs", "25")
  .option("--extension <name>", "filter to one extension")
  .action(async (opts: { limit: string; extension?: string }) => {
    const res = await api<{ runs: Record<string, unknown>[] }>("/api/v1/admin/runs", {
      query: { limit: opts.limit, extension: opts.extension },
    });
    table(res.runs, [
      { header: "ID", get: (r) => r["id"] },
      { header: "EXTENSION", get: (r) => r["extension"] },
      { header: "KIND", get: (r) => r["kind"] },
      { header: "STATE", get: (r) => r["state"] },
      { header: "SEGMENTS", get: (r) => r["segmentsTotal"] },
      { header: "TRIGGERED BY", get: (r) => r["triggeredBy"] },
      { header: "CREATED", get: (r) => ago(r["createdAt"]) },
    ], "no runs");
  });

runs
  .command("show <id>")
  .description("one run and all of its jobs")
  .action(async (id: string) => {
    const res = await api<{ run: Record<string, unknown> & { jobs: Record<string, unknown>[] } }>(
      `/api/v1/admin/runs/${id}`,
    );
    const { jobs, ...run } = res.run;
    kv(run);
    console.log("");
    console.log(`jobs (${jobs.length}):`);
    table(jobs, [
      { header: "ID", get: (j) => j["id"] },
      { header: "SEG", get: (j) => `${Number(j["segmentIndex"]) + 1}/${j["segmentTotal"]}` },
      { header: "STATE", get: (j) => j["state"] },
      { header: "ATTEMPT", get: (j) => `${j["attempt"]}/${j["maxAttempts"]}` },
      { header: "WORKER", get: (j) => j["leaseWorkerId"] },
      { header: "LEASE EXPIRES", get: (j) => j["leaseExpiresAt"] },
      { header: "ERROR", get: (j) => String(j["lastError"] ?? "").slice(0, 60) || "-" },
    ]);
  });

runs
  .command("trigger <extension>")
  .description("create a run now (bypasses the schedule)")
  .option("--kind <kind>", "UPDATE | CLEAN | FORCE", "FORCE")
  .option("--idempotency-key <key>", "reuse a key to make the trigger retry-safe")
  .action(async (extension: string, opts: { kind: string; idempotencyKey?: string }) => {
    const kind = opts.kind.toUpperCase();
    if (!["UPDATE", "CLEAN", "FORCE"].includes(kind)) {
      fail("--kind must be one of UPDATE, CLEAN, FORCE");
    }
    const res = await api<{ runId: string; created: boolean; jobs?: number }>(
      "/api/v1/admin/runs",
      {
        method: "POST",
        json: {
          extension,
          kind,
          ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        },
      },
    );
    kv({
      runId: res.runId,
      created: res.created,
      jobs: res.jobs ?? "-",
      note: res.created ? "queued" : "idempotency key already existed; no new run",
    });
  });

// ---- jobs ----
const jobs = program.command("jobs").description("individual scrape jobs");

jobs
  .command("cancel <id>")
  .description("request cancellation of a pending or running job")
  .action(async (id: string) => {
    const res = await api<{ result: string }>(`/api/v1/admin/jobs/${id}/cancel`, {
      method: "POST",
    });
    ok(`job ${id} cancel: ${res.result}`);
  });

jobs
  .command("retry <id>")
  .description("replay a dead-lettered job")
  .action(async (id: string) => {
    await api(`/api/v1/admin/jobs/${id}/retry`, { method: "POST" });
    ok(`job ${id} requeued`);
  });

// ---- dead letter / quarantine ----
program
  .command("dead-letter")
  .description("jobs that exhausted retries or hit a permanent error")
  .action(async () => {
    const res = await api<{ jobs: Record<string, unknown>[] }>("/api/v1/admin/dead-letter");
    table(res.jobs, [
      { header: "ID", get: (j) => j["id"] },
      { header: "EXTENSION", get: (j) => j["extension"] },
      { header: "KIND", get: (j) => j["kind"] },
      { header: "ATTEMPTS", get: (j) => `${j["attempt"]}/${j["maxAttempts"]}` },
      { header: "CLASS", get: (j) => j["errorClass"] },
      { header: "WHEN", get: (j) => ago(j["updatedAt"]) },
      { header: "ERROR", get: (j) => String(j["lastError"] ?? "").slice(0, 80) || "-" },
    ], "dead-letter queue is empty");
  });

program
  .command("quarantine")
  .description("result envelopes rejected by schema or policy validation")
  .action(async () => {
    const res = await api<{ quarantined: Record<string, unknown>[] }>(
      "/api/v1/admin/quarantine",
    );
    table(res.quarantined, [
      { header: "ID", get: (q) => q["id"] },
      { header: "JOB", get: (q) => q["jobId"] },
      { header: "WORKER", get: (q) => q["workerId"] },
      { header: "WHEN", get: (q) => ago(q["createdAt"]) },
      { header: "REASON", get: (q) => String(q["rejectReason"] ?? "").slice(0, 90) || "-" },
    ], "nothing quarantined");
  });

// ---- pause / resume ----
program
  .command("pause")
  .description("suspend scheduling and upload task processing")
  .option("--minutes <n>", "auto-resume after N minutes (omit for indefinite)")
  .action(async (opts: { minutes?: string }) => {
    const json: Record<string, unknown> = {};
    if (opts.minutes !== undefined) {
      const minutes = Number(opts.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        fail("--minutes must be an integer between 1 and 1440");
      }
      json["minutes"] = minutes;
    }
    const res = await api<{ indefinite: boolean }>("/api/v1/admin/pause", {
      method: "POST",
      json,
    });
    ok(res.indefinite ? "paused indefinitely" : `paused for ${opts.minutes} minutes`);
  });

program
  .command("resume")
  .description("lift a pause")
  .action(async () => {
    await api("/api/v1/admin/resume", { method: "POST" });
    ok("resumed");
  });

// ---- extensions ----
const extensions = program.command("extensions").description("published extensions");

extensions
  .command("list")
  .description("latest published bundle per extension")
  .action(async () => {
    const res = await api<{ extensions: Record<string, unknown>[] }>(
      "/api/v1/admin/extensions",
    );
    table(res.extensions, [
      { header: "NAME", get: (e) => e["name"] },
      { header: "VERSION", get: (e) => e["version"] },
      { header: "SHA256", get: (e) => String(e["sha256"] ?? "").slice(0, 12) },
      { header: "DISABLED", get: (e) => (e["disabled"] ? "yes" : "no") },
      { header: "PUBLISHED", get: (e) => ago(e["publishedAt"]) },
    ], "no bundles published");
  });

for (const action of ["enable", "disable"] as const) {
  extensions
    .command(`${action} <name>`)
    .description(`${action} scheduling for an extension`)
    .action(async (name: string) => {
      await api(`/api/v1/admin/extensions/${name}/${action}`, { method: "POST" });
      ok(`extension ${name} ${action}d`);
    });
}

// ---- tracked manga (the database replacement for manga_id_map.json) ----
const tracked = program
  .command("tracked")
  .description("external manga id -> MangaDex id mapping");

/**
 * `--namespace` names one of an extension's catalogues (viz has `shonenjump`
 * and `vizmanga`, where the same numeric id under each is a different series).
 * Omitting it means the single flat id space, which is what every extension
 * except viz has; so no existing invocation changes.
 */
tracked
  .command("list <extension>")
  .description("every tracked manga for an extension")
  .option("--namespace <namespace>", "only this catalogue (default: all of them)")
  .action(async (extension: string, opts: { namespace?: string }) => {
    const res = await api<{ tracked: Record<string, unknown>[]; namespaces: string[] }>(
      `/api/v1/admin/extensions/${extension}/tracked`,
      { query: { namespace: opts.namespace } },
    );
    const namespaced = res.tracked.some((t) => t["namespace"]);
    table(res.tracked, [
      // The column is omitted entirely for a flat extension rather than shown
      // full of empty strings.
      ...(namespaced ? [{ header: "NAMESPACE", get: (t: Record<string, unknown>) => t["namespace"] || "-" }] : []),
      { header: "MANGA ID", get: (t) => t["mangaId"] },
      { header: "MANGADEX ID", get: (t) => t["mdMangaId"] },
      { header: "SOURCE", get: (t) => t["source"] },
      { header: "ADDED", get: (t) => ago(t["createdAt"]) },
    ], `nothing tracked for ${extension}`);
    if (res.tracked.length > 0) console.log(`\n${res.tracked.length} tracked`);
    const others = res.namespaces.filter((n) => n !== "");
    if (others.length > 0) console.log(`namespaces: ${others.join(", ")}`);
  });

tracked
  .command("set <extension> <mangaId> <mdMangaId>")
  .description("add or repoint a mapping")
  .option("--namespace <namespace>", "the extension catalogue this id belongs to")
  .action(async (extension: string, mangaId: string, mdMangaId: string, opts: { namespace?: string }) => {
    await api(`/api/v1/admin/extensions/${extension}/tracked`, {
      method: "PUT",
      json: { mangaId, mdMangaId, ...(opts.namespace ? { namespace: opts.namespace } : {}) },
    });
    ok(`${extension}: ${qualify(opts.namespace, mangaId)} -> ${mdMangaId}`);
  });

tracked
  .command("remove <extension> <mangaId>")
  .description("stop tracking a manga (does not touch MangaDex)")
  .option("--namespace <namespace>", "the extension catalogue this id belongs to")
  .action(async (extension: string, mangaId: string, opts: { namespace?: string }) => {
    const res = await api<{ removed: boolean }>(
      `/api/v1/admin/extensions/${extension}/tracked/${encodeURIComponent(mangaId)}`,
      { method: "DELETE", query: { namespace: opts.namespace } },
    );
    const subject = `${extension}:${qualify(opts.namespace, mangaId)}`;
    ok(res.removed ? `removed ${subject}` : `no mapping for ${subject}`);
  });

tracked
  .command("import <extension> [file]")
  .description("bulk-add mappings from pasted `[namespace,]externalId,titleId` lines, or stdin")
  .option("--namespace <namespace>", "default catalogue for lines that do not name one")
  .option("--remove", "treat each line's external id as a removal instead")
  .option("--dry-run", "report what would happen and write nothing")
  .action(async (
    extension: string,
    file: string | undefined,
    opts: { namespace?: string; remove?: boolean; dryRun?: boolean },
  ) => {
    const text = file && file !== "-" ? readFileSync(resolve(file), "utf8") : readFileSync(0, "utf8");
    const body = opts.remove
      ? {
          remove: text
            .split(/\r?\n/)
            .map((line) => line.split("#")[0]!.trim())
            .filter(Boolean)
            .map((mangaId) => ({ mangaId, ...(opts.namespace ? { namespace: opts.namespace } : {}) })),
        }
      : { text };
    const res = await api<{
      added: number;
      updated: number;
      unchanged: number;
      removed: number;
      failed: number;
      parseErrors: { line: number; reason: string }[];
      results: { mangaId: string; namespace?: string; outcome: string; detail?: string }[];
    }>(`/api/v1/admin/extensions/${extension}/tracked/batch`, {
      method: "POST",
      json: {
        ...body,
        ...(opts.namespace ? { namespace: opts.namespace } : {}),
        dryRun: opts.dryRun === true,
      },
    });
    for (const err of res.parseErrors) console.error(`  line ${err.line}: ${err.reason}`);
    // Only the rows that did not simply work: a 2000-line paste's useful output
    // is the handful that needs a decision.
    for (const row of res.results) {
      if (row.outcome === "added" || row.outcome === "unchanged" || row.outcome === "removed") continue;
      console.error(`  ${qualify(row.namespace, row.mangaId)}: ${row.outcome}${row.detail ? ` (${row.detail})` : ""}`);
    }
    ok(
      `${opts.dryRun ? "would apply" : "applied"}: ${res.added} added, ${res.updated} updated, ` +
        `${res.unchanged} unchanged, ${res.removed} removed, ${res.failed} failed`,
    );
  });

// ---- series-map write-back (the return trip: database -> manga_id_map.json) ----
const maps = program
  .command("maps")
  .description("write the tracked series map back to the extensions repos");

maps
  .command("sync")
  .description("update manga_id_map.json in GitHub from the database (runs weekly on its own)")
  .option("--dry-run", "report what would be committed and write nothing")
  .option("--extension <name...>", "only these extensions (default: all tracked)")
  .option(
    "--force",
    "commit even when the write would delete more than half of a file's mappings",
  )
  .action(async (opts: { dryRun?: boolean; extension?: string[]; force?: boolean }) => {
    const res = await api<{
      dryRun: boolean;
      written: number;
      failed: number;
      skippedReason?: string;
      outcomes: {
        extension: string;
        status: string;
        repo?: string;
        path?: string;
        commit?: string;
        detail?: string;
        added: number;
        removed: number;
        mappings: number;
      }[];
    }>("/api/v1/admin/maps/sync", {
      method: "POST",
      json: {
        dryRun: opts.dryRun === true,
        force: opts.force === true,
        extensions: opts.extension ?? [],
      },
    });
    if (res.skippedReason) console.error(`  nothing to do: ${res.skippedReason}`);
    table(res.outcomes, [
      { header: "EXTENSION", get: (o) => o["extension"] },
      { header: "STATUS", get: (o) => o["status"] },
      { header: "REPO", get: (o) => o["repo"] ?? "-" },
      { header: "MAPPINGS", get: (o) => o["mappings"] },
      { header: "DELTA", get: (o) => `+${o["added"]} -${o["removed"]}` },
      { header: "COMMIT", get: (o) => String(o["commit"] ?? "").slice(0, 7) || "-" },
      { header: "DETAIL", get: (o) => o["detail"] ?? "" },
    ], "no extensions have tracked mappings");
    ok(
      `${res.dryRun ? "would write" : "wrote"} ${res.written} file(s)` +
        (res.failed > 0 ? `, ${res.failed} failed` : ""),
    );
  });

// ---- chapter archives vs. what MangaDex actually holds ----

interface ReconcileReportShape {
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
    idRule: { segments: number; samples: number; agreement: number } | null;
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

/** Mirrors ReconcileStep in core/md/reconcilePlan.ts. */
interface ReconcileStepShape {
  id: string;
  label: string;
  state: "pending" | "running" | "done" | "skipped" | "failed";
  done: number;
  total: number | null;
  note: string | null;
}

/** Mirrors ReconcileRunState in core/md/reconcileRunner.ts. */
interface ReconcileStatus {
  state: "idle" | "running" | "done" | "failed";
  progress?: { steps: ReconcileStepShape[] };
  report?: ReconcileReportShape;
  error?: string;
}

/** How often to ask how a pass is getting on. */
const RECONCILE_POLL_MS = 2000;

/**
 * Watch a reconcile pass to its end, printing progress, and return its report.
 *
 * The pass belongs to the server, not to this process: it was started by a
 * request that has already been answered, so quitting here leaves it running
 * and re-running the command picks it back up. That is the point of polling
 * rather than holding one long request open -- a group walk is minutes of
 * MangaDex calls, and a request that long dies to the proxy in front of the API
 * having done all the work and delivered none of it.
 */
async function follow(): Promise<ReconcileReportShape> {
  const tty = process.stderr.isTTY === true;
  let lastLine = "";
  /** Steps already reported as finished, so each is announced exactly once. */
  const announced = new Set<string>();

  const clear = (): void => {
    if (tty && lastLine) process.stderr.write("\r" + " ".repeat(lastLine.length) + "\r");
    lastLine = "";
  };

  /**
   * Print the steps that have finished since the last poll, then leave the
   * running one on the line below.
   *
   * A finished step scrolls; the running one is rewritten in place on a
   * terminal. That way the transcript ends up being the plan -- what ran, in
   * order, with its result -- rather than a megabyte of carriage returns, which
   * is also what makes it readable when piped into a file.
   */
  const draw = (steps: ReconcileStepShape[]): void => {
    for (const step of steps) {
      if (step.state === "pending" || step.state === "running") continue;
      if (announced.has(step.id)) continue;
      announced.add(step.id);
      clear();
      const mark = step.state === "done" ? "✓" : step.state === "skipped" ? "-" : "✗";
      console.error(`  ${mark} ${step.label}${step.note ? `: ${step.note}` : ""}`);
    }

    const running = steps.find((step) => step.state === "running");
    if (!running) return;
    const line =
      `  · ${running.label}` +
      (running.total !== null
        ? ` (${running.done}/${running.total})`
        : running.done > 0
          ? ` (${running.done})`
          : "") +
      (running.note ? ` — ${running.note}` : "");
    if (tty) {
      process.stderr.write("\r" + " ".repeat(lastLine.length) + "\r" + line);
      lastLine = line;
    } else if (line !== lastLine) {
      console.error(line);
      lastLine = line;
    }
  };

  for (;;) {
    const status = await api<ReconcileStatus>("/api/v1/admin/chapters/reconcile");
    if (status.progress) draw(status.progress.steps);

    if (status.state === "done" && status.report) {
      clear();
      return status.report;
    }
    if (status.state === "failed") {
      clear();
      throw new Error(status.error ?? "the reconcile pass failed");
    }
    if (status.state === "idle") {
      clear();
      throw new Error("the reconcile pass is not running and left no report");
    }
    await new Promise((resolve) => setTimeout(resolve, RECONCILE_POLL_MS));
  }
}

const chapters = program
  .command("chapters")
  .description("the record of what is on MangaDex, and what has happened to it");

chapters
  .command("reconcile")
  .description("bring our record of the chapters back in line with what MangaDex holds")
  .option("--apply", "write the rows (default is a dry run that writes nothing)")
  .option("--extension <name...>", "only these extensions (default: every group we have uploaded to)")
  .option("--skip-deleted", "skip the uploaded_chapters sweep, which is the only pass that finds deletions")
  .option("--skip-adopt", "report the untracked live chapters without recording any of them")
  .option("--skip-unavailable", "report the carded chapters without archiving any of them")
  .action(async (opts: {
    apply?: boolean;
    extension?: string[];
    skipDeleted?: boolean;
    skipAdopt?: boolean;
    skipUnavailable?: boolean;
  }) => {
    const start = await api<ReconcileStatus & { started: boolean }>(
      "/api/v1/admin/chapters/reconcile",
      {
        method: "POST",
        json: {
          dryRun: opts.apply !== true,
          extensions: opts.extension ?? [],
          skipDeleted: opts.skipDeleted === true,
          skipAdopt: opts.skipAdopt === true,
          skipUnavailable: opts.skipUnavailable === true,
        },
      },
    );
    if (!start.started) {
      console.error("  a reconcile pass was already running; following that one instead");
    }

    // The pass runs on the server and this polls it. A group walk is ~124
    // MangaDex requests at the client's rate limit -- minutes -- and a request
    // held open that long dies to the proxy in front of the API with nothing to
    // show for it. Polling also means Ctrl-C here abandons the *watching*, not
    // the work.
    const res = await follow();

    table(res.groups, [
      { header: "EXTENSION", get: (g) => g["extension"] },
      { header: "GROUP", get: (g) => String(g["groupId"]).slice(0, 8) },
      { header: "ON MD", get: (g) => g["total"] },
      { header: "CARDED", get: (g) => g["carded"] },
      { header: "NEW", get: (g) => g["recorded"] },
      { header: "MD-HIDDEN", get: (g) => g["hiddenOnMangadex"] },
      { header: "LIVE", get: (g) => g["live"] },
      { header: "UNTRACKED", get: (g) => g["untracked"] },
      { header: "ADOPTED", get: (g) => g["adopted"] },
      { header: "WITH ID", get: (g) => g["adoptedWithId"] },
    ], "no extension has uploaded anything, so there are no groups to ask about");

    // The rule is a measurement, not a setting, so it is shown wherever it
    // decided something: an extension whose own rows do not agree on where its
    // chapter ids sit gets adopted rows with no chapter_id, and that silently
    // costs the extension the `postedChapterIds` skip on every future run.
    for (const group of res.groups) {
      if (group.untracked === 0) continue;
      if (group.idRule === null) {
        console.error(
          `  ${group.extension}: no chapter id could be recovered from its URLs; ` +
            "adopted rows carry no chapter_id, so those chapters stay outside postedChapterIds",
        );
        continue;
      }
      console.error(
        `  ${group.extension}: chapter id read as the last ${group.idRule.segments} ` +
          `path segment(s) of the chapter URL (${Math.round(group.idRule.agreement * 100)}% of ` +
          `${group.idRule.samples} existing row(s) agree)`,
      );
    }

    console.error(
      `  scanned ${res.scanned} uploaded row(s)` +
        (res.skippedByGroupWalk > 0
          ? `, ${res.skippedByGroupWalk} of them answered by the group walk`
          : ""),
    );
    if (res.hiddenOnMangadex.length > 0) {
      // Never archived: MangaDex is refusing to serve these, but they carry no
      // card of ours, so they are candidates for an UNAVAILABLE task rather
      // than chapters we have already marked.
      console.error(
        `  ${res.hiddenOnMangadex.length} live chapter(s) MangaDex will not serve: ` +
          "not archived; queue them unavailable if that is what you want:",
      );
      for (const id of res.hiddenOnMangadex.slice(0, 20)) console.error(`    ${id}`);
      if (res.hiddenOnMangadex.length > 20) {
        console.error(`    … and ${res.hiddenOnMangadex.length - 20} more`);
      }
    }
    ok(
      `${res.dryRun ? "would record" : "recorded"} ` +
        `${res.unavailableRecorded} unavailable and ${res.deletedRecorded} deleted ` +
        `(found ${res.unavailableFound} / ${res.deletedFound}; the rest were already archived), ` +
        `and ${res.dryRun ? "would adopt" : "adopted"} ${res.adoptedRecorded} live chapter(s) ` +
        `(${res.idsRecorded} with a recovered chapter id; ${res.untrackedFound} untracked in total)` +
        (res.dryRun ? "; re-run with --apply to write" : ""),
    );
  });

chapters
  .command("series")
  .description("the titles present in an archive, most-affected first")
  .option("--archive <name>", "uploaded | unavailable | deleted | edited", "unavailable")
  .option("--extension <name>", "only chapters this extension uploaded")
  .option("--language <code>", "only chapters in this language")
  .option("--search <text>", "substring of the title name, or any id")
  .option("--limit <n>", "how many titles to list", "50")
  .action(
    async (opts: {
      archive: string;
      extension?: string;
      language?: string;
      search?: string;
      limit: string;
    }) => {
      const res = await api<{
        archive: string;
        series: {
          mdMangaId: string;
          mangaName: string | null;
          extensions: string[];
          count: number;
          at: string;
        }[];
        capped: boolean;
      }>("/api/v1/admin/chapters/series", {
        query: {
          archive: opts.archive,
          extension: opts.extension,
          language: opts.language,
          search: opts.search,
          limit: opts.limit,
        },
      });

      table(
        res.series,
        [
          { header: "TITLE", get: (row) => (row.mangaName ?? "-").slice(0, 44) },
          { header: "MD MANGA ID", get: (row) => row.mdMangaId },
          { header: "CHAPTERS", get: (row) => row.count },
          { header: "EXTENSION", get: (row) => row.extensions.map((e) => e || "(none)").join(",") },
          { header: "MOST RECENT", get: (row) => ago(row.at) },
        ],
        `no title has a chapter in the ${res.archive} archive matching that filter`,
      );
      if (res.capped) {
        console.error("  the list is capped; narrow it with --search or raise --limit");
      }
    },
  );

/**
 * Re-render and re-post the card images of chapters already marked unavailable.
 *
 * The one target that is worth having a command for rather than a dashboard
 * panel is `--series`: a stale card is nearly always reported one title at a
 * time, and a title is the unit somebody complains in. The sweep pages on the
 * primary key and follows its own continuation, so a title with four hundred
 * chapters is one command rather than three requests an operator has to chain.
 */
chapters
  .command("recard")
  .description("re-render and re-post the card image of chapters already marked unavailable")
  .option("--series <mdMangaId>", "every unavailable chapter of one MangaDex title")
  .option("--chapter <mdChapterId...>", "these MangaDex chapter ids and no others")
  .option("--all", "every unavailable chapter, narrowed by the filters below")
  .option("--extension <name>", "narrow to one extension")
  .option("--language <code>", "narrow to one language")
  .option("--search <text>", "narrow by substring of the title name, or any id")
  .option("--note <text>", "replace the card's standard explanatory paragraph")
  .option("--batch <n>", "chapters per request while sweeping", "200")
  .option("--apply", "queue the re-cards (default is a dry run that queues nothing)")
  .action(
    async (opts: {
      series?: string;
      chapter?: string[];
      all?: boolean;
      extension?: string;
      language?: string;
      search?: string;
      note?: string;
      batch: string;
      apply?: boolean;
    }) => {
      const targets = [opts.series, opts.chapter?.length ? opts.chapter : undefined, opts.all].filter(
        (value) => value !== undefined && value !== false,
      );
      if (targets.length !== 1) {
        fail("give exactly one of --series, --chapter or --all");
      }
      const narrowing = opts.extension || opts.language || opts.search;
      if (opts.chapter?.length && narrowing) {
        fail("--extension, --language and --search narrow a sweep; an explicit --chapter list is already exact");
      }

      const filter = {
        ...(opts.series ? { mdMangaId: opts.series } : {}),
        ...(opts.extension ? { extension: opts.extension } : {}),
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.search ? { search: opts.search } : {}),
      };
      const target = opts.chapter?.length ? { ids: opts.chapter } : { filter };
      const request = {
        ...target,
        ...(opts.note ? { footerNote: opts.note } : {}),
        batch: Number(opts.batch),
      };

      interface RecardItem {
        mdChapterId: string;
        ok: boolean;
        outcome: string;
        reason?: string;
        mangaName?: string | null;
        chapterNumber?: string | null;
        unavailableAt?: string;
      }
      interface RecardPage {
        matched: number;
        resolved?: number;
        requested?: number;
        wouldQueue?: number;
        queued?: number;
        blocked?: number;
        refused?: number;
        nextAfterId: string | null;
        results: RecardItem[];
      }

      const call = (afterId: string | null) =>
        api<RecardPage>("/api/v1/admin/chapters/unavailable/recard", {
          method: "POST",
          json: {
            ...request,
            dryRun: opts.apply !== true,
            confirm: opts.apply === true,
            ...(afterId ? { afterId } : {}),
          },
        });

      // A dry run reports the first page only: it is a description of what the
      // sweep would do, and paging the whole archive to describe it costs the
      // same as doing it. The live run follows the continuation to the end,
      // because a half-swept title is the outcome nobody asked for.
      let afterId: string | null = null;
      let acted = 0;
      let skipped = 0;
      let matched = 0;
      let pages = 0;
      const shown: RecardItem[] = [];
      for (;;) {
        const page: RecardPage = await call(afterId);
        pages += 1;
        matched = page.matched;
        acted += page.wouldQueue ?? page.queued ?? 0;
        skipped += page.blocked ?? page.refused ?? 0;
        for (const item of page.results) if (shown.length < 50) shown.push(item);
        afterId = page.nextAfterId;
        if (!afterId || opts.apply !== true) break;
        console.error(`  … ${acted} queued so far of ${matched} matching`);
      }

      table(
        shown,
        [
          { header: "TITLE", get: (row) => (row.mangaName ?? "-").slice(0, 30) },
          { header: "CHAPTER", get: (row) => (row.chapterNumber ? `Ch. ${row.chapterNumber}` : "-") },
          { header: "MD CHAPTER ID", get: (row) => row.mdChapterId },
          { header: "UNAVAILABLE", get: (row) => ago(row.unavailableAt) },
          { header: "OUTCOME", get: (row) => row.outcome },
          { header: "WHY", get: (row) => (row.reason ?? "").slice(0, 44) || "-" },
        ],
        "nothing matched",
      );

      kv({
        matched,
        pages,
        [opts.apply === true ? "queued" : "wouldQueue"]: acted,
        skipped,
        ...(afterId ? { nextAfterId: afterId } : {}),
      });
      ok(
        opts.apply === true
          ? `queued ${acted} re-card(s)${skipped > 0 ? `, skipped ${skipped}` : ""}; ` +
              "core-uploader drains the UNAVAILABLE queue at MangaDex's pace"
          : `would queue ${acted} re-card(s) of ${matched} matching` +
              (afterId ? " in the first page alone" : "") +
              `${skipped > 0 ? `, skipping ${skipped}` : ""}; re-run with --apply to queue`,
      );
    },
  );

// ---- extension config (the database replacement for override_options.json) ----
const extConfig = program
  .command("ext-config")
  .description("per-extension override options");

extConfig
  .command("get <extension>")
  .description("print the current override options as JSON")
  .option("--split", "show which keys are modelled tables and which are passed through")
  .action(async (extension: string, opts: { split?: boolean }) => {
    const res = await api<{
      overrideOptions: unknown;
      passthrough: Record<string, unknown>;
      same: Record<string, string[]>;
      multi_chapters: Record<string, string[]>;
      custom_language: Record<string, string>;
    }>(`/api/v1/admin/extensions/${extension}/config`);
    if (!opts.split) {
      // The reassembled legacy document, so `get > f && set f` round-trips.
      console.log(JSON.stringify(res.overrideOptions, null, 2));
      return;
    }
    console.log(
      JSON.stringify(
        {
          tables: {
            same: res.same,
            multi_chapters: res.multi_chapters,
            custom_language: res.custom_language,
          },
          passthrough: res.passthrough,
        },
        null,
        2,
      ),
    );
  });

extConfig
  .command("set <extension> [file]")
  .description("replace the override options from a JSON file, or from stdin when omitted")
  .action(async (extension: string, file?: string) => {
    // Reading a whole document from argv would be unusable; a file or a pipe is
    // how an operator actually has this content to hand.
    const raw =
      file && file !== "-"
        ? readFileSync(resolve(file), "utf8")
        : readFileSync(0, "utf8");
    let overrideOptions: unknown;
    try {
      overrideOptions = JSON.parse(raw);
    } catch (err) {
      return fail(`input is not valid JSON: ${(err as Error).message}`);
    }
    if (typeof overrideOptions !== "object" || overrideOptions === null || Array.isArray(overrideOptions)) {
      fail("override options must be a JSON object");
    }
    const res = await api<{
      aliases: number;
      multiChapters: number;
      languages: number;
      passthroughKeys: string[];
      rejected: { option: string; key: string; value?: string; reason: string }[];
    }>(`/api/v1/admin/extensions/${extension}/config`, {
      method: "PUT",
      json: { overrideOptions },
    });
    // A rejected row is not a failed command, the rest of the document landed,
 // but it must be visible, because a dropped `custom_language` row silently
    // stops protecting a language from the chapter-removal pass.
    for (const row of res.rejected) {
      console.error(
        `  rejected ${row.option}.${row.key}${row.value ? ` = ${row.value}` : ""}: ${row.reason}`,
      );
    }
    ok(
      `override options replaced for ${extension}: ${res.aliases} chapter aliases, ` +
        `${res.multiChapters} multi-chapter numbers, ${res.languages} language overrides, ` +
        `${res.passthroughKeys.length} extension-private keys (${res.passthroughKeys.join(", ") || "none"})` +
        (res.rejected.length > 0 ? `, ${res.rejected.length} rejected` : ""),
    );
  });

// ---- untracked series pipeline ----
const untracked = program
  .command("untracked")
  .description("series an extension reported that have no MangaDex title yet");

untracked
  .command("list")
  .description("untracked candidates, newest first")
  .option("--state <state>", "NEW | CREATING | CREATED | TRACKED | FAILED | SKIPPED")
  .option("--limit <n>", "how many rows", "100")
  .action(async (opts: { state?: string; limit: string }) => {
    const state = opts.state?.toUpperCase();
    const valid = ["NEW", "CREATING", "CREATED", "TRACKED", "FAILED", "SKIPPED"];
    if (state && !valid.includes(state)) fail(`--state must be one of ${valid.join(", ")}`);
    const res = await api<{ untracked: Record<string, unknown>[] }>("/api/v1/admin/untracked", {
      query: { state, limit: opts.limit },
    });
    table(res.untracked, [
      { header: "ID", get: (u) => u["id"] },
      { header: "EXTENSION", get: (u) => u["extension"] },
      { header: "MANGA", get: (u) => String(u["mangaName"] ?? "").slice(0, 40) },
      { header: "LANG", get: (u) => u["mangaLanguage"] },
      { header: "STATE", get: (u) => u["state"] },
      { header: "MANGADEX ID", get: (u) => u["mdMangaId"] },
      { header: "TRIES", get: (u) => u["attempts"] },
      { header: "ERROR", get: (u) => String(u["lastError"] ?? "").slice(0, 50) || "-" },
    ], "no untracked series");
  });

untracked
  .command("approve <id>")
  .description("create the MangaDex title now and start tracking it")
  .action(async (id: string) => {
    const res = await api<{ mdMangaId: string }>(`/api/v1/admin/untracked/${id}/approve`, {
      method: "POST",
    });
    kv({ mdMangaId: res.mdMangaId, url: `https://mangadex.org/title/${res.mdMangaId}` });
  });

untracked
  .command("skip <id>")
  .description("never create a title for this series")
  .action(async (id: string) => {
    await api(`/api/v1/admin/untracked/${id}/skip`, { method: "POST" });
    ok(`untracked ${id} skipped`);
  });

// ---- schedules ----
const schedules = program.command("schedules").description("run schedules");

/**
 * `--days mon,wed` / `--days 0,2` / `--days weekends`.
 *
 * Names are accepted because 0=Monday is a footgun the moment anyone reads it
 * as JavaScript's 0=Sunday: an operator typing `--days 0` for "Sunday" would
 * silently get Monday, and the run would just look like it had drifted. Names
 * cannot be misread; the numbers stay for scripts that already speak the
 * contract.
 */
const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function parseDays(raw: string | undefined): number[] {
  if (raw === undefined) return [];
  const out = new Set<number>();
  for (const token of raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    if (token === "daily" || token === "everyday" || token === "every") return [];
    if (token === "weekdays") {
      [0, 1, 2, 3, 4].forEach((d) => out.add(d));
      continue;
    }
    if (token === "weekends") {
      [5, 6].forEach((d) => out.add(d));
      continue;
    }
    const byName = DAY_NAMES.findIndex((name) => token.length >= 3 && name.startsWith(token));
    if (byName >= 0) {
      out.add(byName);
      continue;
    }
    const asNumber = Number(token);
    if (!Number.isInteger(asNumber) || asNumber < 0 || asNumber > 6) {
      fail(`--days: "${token}" is not a weekday (mon..sun, weekdays, weekends, or 0-6 with 0=Monday)`);
    }
    out.add(asNumber);
  }
  return [...out].sort((a, b) => a - b);
}

function parseKind(raw: string | undefined): "UPDATE" | "CLEAN" | "FORCE" {
  const kind = (raw ?? "UPDATE").toUpperCase();
  if (kind !== "UPDATE" && kind !== "CLEAN" && kind !== "FORCE") {
    fail("--kind must be one of UPDATE, CLEAN, FORCE");
  }
  return kind;
}

function parseTime(hourRaw: string, minuteRaw: string): { hour: number; minute: number } {
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) fail("hour must be 0-23");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) fail("minute must be 0-59");
  return { hour, minute };
}

interface Slot {
  id?: string;
  enabled?: boolean;
  hour: number;
  minute: number;
  days: number[];
  kind: string;
  label?: string;
}

function formatSlot(slot: Slot): string {
  const at = `${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")} UTC`;
  const when =
    slot.days.length === 0
      ? "daily"
      : slot.days.map((d) => (DAY_NAMES[d] ?? `day ${d}`).slice(0, 3)).join(",");
  return `${at} ${when} ${slot.kind.toLowerCase()}`;
}

type SlotOpts = { days?: string; kind?: string; label?: string };

function slotBody(hourRaw: string, minuteRaw: string, opts: SlotOpts): Slot {
  const { hour, minute } = parseTime(hourRaw, minuteRaw);
  return {
    hour,
    minute,
    days: parseDays(opts.days),
    kind: parseKind(opts.kind),
    ...(opts.label ? { label: opts.label } : {}),
  };
}

/** The three options `add` and `set` share; declared once so they cannot drift. */
function withSlotOptions(cmd: Command): Command {
  return cmd
    .option("--days <list>", "mon,wed / weekdays / weekends / 0-6 with 0=Monday. Omit for every day")
    .option("--kind <kind>", "UPDATE (default) | CLEAN | FORCE")
    .option("--label <text>", 'a note for the listing, e.g. "weekly deep clean"');
}

type ScheduleList = {
  defaults: Record<string, Slot[]>;
  overrides: Record<string, Slot[]>;
  effective: Record<string, Slot[]>;
};

schedules
  .command("list")
  .description("every extension's slots: manifest defaults, operator rows, and what actually runs")
  .action(async () => {
    const res = await api<ScheduleList>("/api/v1/admin/schedules");
    const names = [...new Set([...Object.keys(res.defaults), ...Object.keys(res.overrides)])].sort();
    // One row per SLOT, not per extension. An extension with four of them is
    // the case this command exists for, and collapsing them into one cell would
    // hide exactly what the operator came to check.
    const rows = names.flatMap((name) => {
      const slots = res.overrides[name] ?? res.defaults[name] ?? [];
      const source = res.overrides[name] ? "operator" : "manifest";
      if (slots.length === 0) return [{ name, source, slot: null as Slot | null }];
      return slots.map((slot) => ({ name, source, slot }));
    });
    table(
      rows,
      [
        { header: "EXTENSION", get: (r) => r.name },
        { header: "SOURCE", get: (r) => r.source },
        { header: "WHEN", get: (r) => (r.slot ? formatSlot(r.slot) : "nothing scheduled") },
        { header: "LABEL", get: (r) => r.slot?.label ?? "-" },
        { header: "ON", get: (r) => (r.slot?.enabled === false ? "off" : "yes") },
        { header: "ID", get: (r) => r.slot?.id ?? "-" },
      ],
      "no schedules configured",
    );
  });

schedules
  .command("show <extension>")
  .description("one extension's slots, with the ids the other subcommands take")
  .action(async (extension: string) => {
    const res = await api<{ manifest: Slot[]; entries: Slot[]; effective: Slot[]; source: string }>(
      `/api/v1/admin/schedules/${extension}`,
    );
    console.log(
      `source: ${res.source}` +
        (res.source === "manifest" ? " (no operator rows; `schedules add` takes over)" : ""),
    );
    console.log(`manifest: ${res.manifest.map(formatSlot).join(" | ") || "none"}`);
    table(
      res.entries,
      [
        { header: "ID", get: (s) => s.id },
        { header: "WHEN", get: (s) => formatSlot(s) },
        { header: "LABEL", get: (s) => s.label ?? "-" },
        { header: "ON", get: (s) => (s.enabled === false ? "off" : "yes") },
      ],
      "no operator rows; the manifest schedule above is what runs",
    );
  });

withSlotOptions(
  schedules
    .command("add <extension> <hour> <minute>")
    .description("add one slot (UTC), keeping the ones already there"),
).action(async (extension: string, hourRaw: string, minuteRaw: string, opts: SlotOpts) => {
  const json = slotBody(hourRaw, minuteRaw, opts);
  const res = await api<{ id: string; created: boolean; seeded: number }>(
    `/api/v1/admin/schedules/${extension}`,
    { method: "POST", json },
  );
  if (res.seeded > 0) {
    ok(`copied ${res.seeded} manifest slot(s) into the database first, so they keep running`);
  }
  ok(
    res.created
      ? `added for ${extension}: ${formatSlot(json)} (id ${res.id})`
      : `${extension} already had that exact slot (id ${res.id}); nothing changed`,
  );
});

withSlotOptions(
  schedules
    .command("set <extension> <hour> <minute>")
    .description("REPLACE the whole schedule with this single slot (use `add` to keep the others)"),
).action(async (extension: string, hourRaw: string, minuteRaw: string, opts: SlotOpts) => {
  const json = slotBody(hourRaw, minuteRaw, opts);
  await api(`/api/v1/admin/schedules/${extension}`, { method: "PUT", json });
  ok(`schedule for ${extension} is now exactly: ${formatSlot(json)}`);
});

schedules
  .command("disable <extension> <id>")
  .description("stop one slot firing, keeping it in the list")
  .action(async (extension: string, id: string) => {
    await api(`/api/v1/admin/schedules/${extension}/${id}`, {
      method: "PATCH",
      json: { enabled: false },
    });
    ok(`slot ${id} switched off for ${extension}`);
  });

schedules
  .command("enable <extension> <id>")
  .description("switch a slot back on")
  .action(async (extension: string, id: string) => {
    await api(`/api/v1/admin/schedules/${extension}/${id}`, {
      method: "PATCH",
      json: { enabled: true },
    });
    ok(`slot ${id} switched on for ${extension}`);
  });

schedules
  .command("remove <extension> <id>")
  .description("delete one slot (`schedules show` lists the ids)")
  .action(async (extension: string, id: string) => {
    await api(`/api/v1/admin/schedules/${extension}/${id}`, { method: "DELETE" });
    ok(`slot ${id} removed from ${extension}`);
  });

schedules
  .command("reset <extension>")
  .description("drop every operator slot and fall back to the manifest schedule")
  .action(async (extension: string) => {
    const res = await api<{ removed: boolean }>(`/api/v1/admin/schedules/${extension}`, {
      method: "DELETE",
    });
    ok(
      res.removed
        ? `${extension} is back on its manifest schedule`
        : `${extension} had no operator rows`,
    );
  });

// ---- removal mode ----
const removalMode = program
  .command("removal-mode")
  .description("what happens when a publisher drops a chapter");

removalMode
  .command("get")
  .description("show the current mode")
  .action(async () => {
    const res = await api<{ mode: string; validModes: string[] }>(
      "/api/v1/admin/removal-mode",
    );
    kv({ mode: res.mode, validModes: res.validModes.join(", ") });
  });

removalMode
  .command("set <mode>")
  .description("set the mode (unavailable | delete)")
  .action(async (mode: string) => {
    const res = await api<{ mode: string }>("/api/v1/admin/removal-mode", {
      method: "POST",
      json: { mode: mode.toLowerCase() },
    });
    ok(`removal mode is now ${res.mode}`);
  });

// ---- bundles ----
const bundle = program.command("bundle").description("extension bundle publishing");

bundle
  .command("publish <dir>")
  .description("build (if needed), zip, and publish an extension as a content-addressed bundle")
  .option("--source-commit <sha>", "record the source repo commit this was built from")
  .option(
    "--allow-legacy-runtime",
    "republish a pre-v2 python bundle (audit-logged; new extensions must use API v2)",
    false,
  )
  .action(async (dir: string, opts: { sourceCommit?: string; allowLegacyRuntime: boolean }) => {
    const root = resolve(dir);
    try {
      if (!statSync(root).isDirectory()) fail(`${root} is not a directory`);
    } catch {
      fail(`${root} does not exist`);
    }
    // The same build+zip the GitHub push webhook runs (core/webhooks/
    // bundleBuilder.ts), so both publish paths produce identical bytes; and so
    // an operator gets an immediate, obvious error rather than a 422 after
    // uploading tens of megabytes.
    let built;
    try {
      built = await buildExtensionBundle(root);
    } catch (err) {
      if (err instanceof BundleBuildError) return fail(err.message);
      throw err;
    }
    const { zipData, manifest } = built;
    if (built.builtFrom) console.log(`built ${built.builtFrom} -> index.mjs (esbuild)`);

    console.log(
      `publishing ${manifest.name}@${manifest.version} (${(zipData.length / 1024).toFixed(1)} KiB)`,
    );
    const headers: Record<string, string> = {};
    if (opts.sourceCommit) headers["x-source-commit"] = opts.sourceCommit;
    if (opts.allowLegacyRuntime) headers["x-allow-legacy-runtime"] = "true";
    const res = await api<{
      extension: string;
      version: string;
      sha256: string;
      created: boolean;
      warnings?: string[];
    }>("/api/v1/admin/bundles", {
      method: "POST",
      raw: { body: zipData, contentType: "application/zip", headers },
    });
    kv({
      extension: res.extension,
      version: res.version,
      sha256: res.sha256,
      status: res.created ? "published" : "already published (identical content)",
    });
    // Not grounds for refusing the bundle, but the operator is here now.
    for (const warning of res.warnings ?? []) console.error(`  warning: ${warning}`);
  });

// ---- client tokens ----
const tokens = program
  .command("tokens")
  .description("scoped per-client API credentials (pa_…)");

tokens
  .command("scopes")
  .description("the scope taxonomy and the recommended set per client")
  .action(async () => {
    const res = await api<{ scopes: string[]; presets: Record<string, string[]> }>(
      "/api/v1/admin/tokens/scopes",
    );
    console.log("scopes:");
    for (const scope of res.scopes) console.log(`  ${scope}`);
    console.log("");
    console.log("presets:");
    kv(Object.fromEntries(Object.entries(res.presets).map(([k, v]) => [k, v.join(",")])));
  });

tokens
  .command("list")
  .description("issued tokens (metadata only; secrets are unrecoverable)")
  .action(async () => {
    const res = await api<{ tokens: Record<string, unknown>[] }>("/api/v1/admin/tokens");
    table(res.tokens, [
      { header: "ID", get: (t) => t["id"] },
      { header: "NAME", get: (t) => t["name"] },
      { header: "SCOPES", get: (t) => (t["scopes"] as string[]).join(",") },
      { header: "CREATED BY", get: (t) => t["createdBy"] },
      { header: "LAST USED", get: (t) => (t["lastUsedAt"] ? ago(t["lastUsedAt"]) : "never") },
      { header: "EXPIRES", get: (t) => t["expiresAt"] ?? "never" },
      { header: "REVOKED", get: (t) => (t["revoked"] ? "yes" : "no") },
    ], "no client tokens issued");
  });

tokens
  .command("create")
  .description("mint a client token with exactly the scopes it needs")
  .requiredOption("--name <name>", "which client this is for, e.g. discord-bot")
  .requiredOption("--scopes <list>", "comma-separated scopes, or a preset name from `tokens scopes`")
  .option("--ttl-days <n>", "expire after N days (omit for no expiry)")
  .action(async (opts: { name: string; scopes: string; ttlDays?: string }) => {
    // A preset NAME is accepted as well as a scope list, because that is what
    // the help promises and because the presets are the least-privilege path we
    // want people on. Resolve it here rather than posting the name, which the
    // server would reject as an unknown scope.
    const requested = opts.scopes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (requested.length === 0) fail("--scopes must list at least one scope");

    const { presets } = (await api("/api/v1/admin/tokens/scopes")) as {
      presets: Record<string, string[]>;
    };
    const scopes = [
      ...new Set(requested.flatMap((entry) => presets[entry] ?? [entry])),
    ];
    const expanded = requested.filter((entry) => presets[entry]);
    if (expanded.length > 0) {
      console.log(`expanded preset(s) ${expanded.join(", ")} -> ${scopes.join(", ")}`);
    }
    const json: Record<string, unknown> = { name: opts.name, scopes };
    if (opts.ttlDays !== undefined) {
      const days = Number(opts.ttlDays);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        fail("--ttl-days must be an integer between 1 and 3650");
      }
      json["ttlDays"] = days;
    }
    const res = await api<{ id: string; name: string; scopes: string[]; expiresAt: string | null; token: string }>(
      "/api/v1/admin/tokens",
      { method: "POST", json },
    );
    kv({
      id: res.id,
      name: res.name,
      scopes: res.scopes.join(","),
      expiresAt: res.expiresAt ?? "never",
      token: res.token,
    });
    console.log("");
    console.log("This token is shown once and cannot be recovered. To rotate: create the");
    console.log("replacement, update the client, then `tokens revoke` the old id.");
  });

tokens
  .command("revoke <id>")
  .description("invalidate a client token immediately")
  .action(async (id: string) => {
    await api(`/api/v1/admin/tokens/${id}/revoke`, { method: "POST" });
    ok(`token ${id} revoked`);
  });

// ---- upload-task queues ----
const queues = program
  .command("queues")
  .description("MangaDex upload task queues");

queues
  .command("list")
  .description("queued upload tasks and the depth summary")
  .option("--kind <kind>", "UPLOAD | EDIT | DELETE | UNAVAILABLE")
  .option("--state <state>", "PENDING | LEASED | DONE | FAILED | DEAD_LETTER")
  .option("--limit <n>", "how many rows", "100")
  .action(async (opts: { kind?: string; state?: string; limit: string }) => {
    const kind = opts.kind?.toUpperCase();
    const taskState = opts.state?.toUpperCase();
    const kinds = ["UPLOAD", "EDIT", "DELETE", "UNAVAILABLE"];
    const states = ["PENDING", "LEASED", "DONE", "FAILED", "DEAD_LETTER"];
    if (kind && !kinds.includes(kind)) fail(`--kind must be one of ${kinds.join(", ")}`);
    if (taskState && !states.includes(taskState)) fail(`--state must be one of ${states.join(", ")}`);
    const res = await api<{
      tasks: Record<string, unknown>[];
      counts: { kind: string; state: string; count: number }[];
    }>("/api/v1/admin/upload-tasks", { query: { kind, state: taskState, limit: opts.limit } });

    console.log("depth by kind and state:");
    table(res.counts, [
      { header: "KIND", get: (c) => c.kind },
      { header: "STATE", get: (c) => c.state },
      { header: "COUNT", get: (c) => c.count },
    ], "no upload tasks have ever been queued");
    console.log("");
    table(res.tasks, [
      { header: "ID", get: (t) => t["id"] },
      { header: "KIND", get: (t) => t["kind"] },
      { header: "STATE", get: (t) => t["state"] },
      { header: "DEDUPE KEY", get: (t) => t["dedupeKey"] },
      { header: "ATTEMPTS", get: (t) => `${t["attempt"]}/${t["maxAttempts"]}` },
      { header: "NOT BEFORE", get: (t) => t["notBefore"] },
      { header: "ERROR", get: (t) => String(t["lastError"] ?? "").slice(0, 60) || "-" },
    ], "no upload tasks match that filter");
  });

queues
  .command("retry <id>")
  .description("requeue a failed or dead-lettered upload task with a fresh attempt budget")
  .action(async (id: string) => {
    await api(`/api/v1/admin/upload-tasks/${id}/retry`, { method: "POST" });
    ok(`upload task ${id} requeued`);
  });

queues
  .command("cancel <id>")
  .description("drop an upload task without sending it to MangaDex")
  .action(async (id: string) => {
    await api(`/api/v1/admin/upload-tasks/${id}/cancel`, { method: "POST" });
    ok(`upload task ${id} cancelled`);
  });

queues
  .command("requeue-stale")
  .description("reclaim upload tasks whose lease expired (crashed uploader)")
  .action(async () => {
    const res = await api<{ requeued: number }>("/api/v1/admin/upload-tasks/requeue-stale", {
      method: "POST",
    });
    ok(`${res.requeued} stale lease(s) requeued`);
  });

// ---- merged error feed ----

/** What `--cleared` accepts, mapped straight onto the API's query parameter. */
const CLEARED_FILTERS = ["without", "with", "only"] as const;

type ErrorEntry = {
  at: string;
  kind: string;
  source: string;
  subject: string;
  message: string;
  id: string;
  cleared?: { at: string; by: string; note: string | null };
};

/**
 * The feed, plus clearing the entries that have been dealt with.
 *
 * `padmin errors` still lists, so the muscle memory and every existing runbook
 * keep working; `errors clear` and `errors restore` hang off it as subcommands.
 * The list is a to-do list by default: cleared entries are hidden and counted, so
 * an empty list means "nothing needs you", not "nothing ever broke".
 */
const errorFeed = program
  .command("errors")
  .description("dead-lettered jobs, failed upload tasks, and quarantined submissions, newest first")
  .option("--limit <n>", "how many rows", "50")
  .option(`--cleared <${CLEARED_FILTERS.join("|")}>`, "hide cleared entries (default), include them, or show only them", "without")
  .action(async (opts: { limit: string; cleared: string }) => {
    if (!CLEARED_FILTERS.includes(opts.cleared as (typeof CLEARED_FILTERS)[number])) {
      fail(`--cleared must be one of ${CLEARED_FILTERS.join(", ")}`);
    }
    const res = await api<{ errors: ErrorEntry[]; clearedHidden: number }>("/api/v1/admin/errors", {
      query: { limit: opts.limit, cleared: opts.cleared },
    });
    table(res.errors, [
      { header: "WHEN", get: (e) => e.at },
      { header: "KIND", get: (e) => e.kind },
      { header: "ID", get: (e) => e.id },
      { header: "SUBJECT", get: (e) => e.subject.slice(0, 50) },
      { header: "MESSAGE", get: (e) => e.message.slice(0, 80) || "-" },
      {
        header: "CLEARED",
        get: (e) => (e.cleared ? `${e.cleared.by}${e.cleared.note ? ` (${e.cleared.note})` : ""}` : "-"),
      },
    ], opts.cleared === "only" ? "nothing has been cleared" : "nothing is outstanding");
    console.log("");
    if (opts.cleared === "without" && res.clearedHidden > 0) {
      console.log(
        `${res.clearedHidden} cleared entr${res.clearedHidden === 1 ? "y" : "ies"} hidden; ` +
          "`padmin errors --cleared only` to review, `errors restore` to un-clear.",
      );
    }
    console.log("Container logs are not aggregated here; use `docker compose logs` on the host.");
  });

errorFeed
  .command("clear")
  .description("mark failures as read and dealt with, so they drop out of the feed")
  .argument("[id...]", "entry ids, or the leading characters of one (as printed by `padmin errors`)")
  .option("--all", "clear every outstanding failure")
  .option("--note <text>", "why it is fine; shown to whoever reviews cleared entries")
  .action(async (ids: string[], opts: { all?: boolean; note?: string }) => {
    // Both at once is a contradiction worth rejecting rather than resolving: it
    // reads as "clear these" and would clear everything.
    if (opts.all && ids.length > 0) fail("pass ids or --all, not both");
    if (!opts.all && ids.length === 0) fail("pass one or more ids, or --all");

    const res = await api<{
      cleared: number;
      entries?: { source: string; id: string }[];
      skipped?: { source: string | null; id: string; reason: string }[];
    }>("/api/v1/admin/errors/clear", {
      method: "POST",
      json: {
        ...(opts.all ? { all: true } : { ids }),
        ...(opts.note ? { note: opts.note } : {}),
      },
    });

    for (const skip of res.skipped ?? []) console.log(`skipped ${skip.id}: ${skip.reason}`);
    ok(
      `${res.cleared} failure(s) cleared; hidden from the feed. Nothing else changed: ` +
        "the jobs, tasks and submissions keep their state, anything that fails again reappears, " +
        "and `errors restore` undoes this.",
    );
  });

errorFeed
  .command("restore")
  .description("put cleared entries back in the feed")
  .argument("[id...]", "entry ids, or the leading characters of one")
  .option("--all", "restore everything that was cleared")
  .action(async (ids: string[], opts: { all?: boolean }) => {
    if (opts.all && ids.length > 0) fail("pass ids or --all, not both");
    if (!opts.all && ids.length === 0) fail("pass one or more ids, or --all");
    const res = await api<{ restored: number }>("/api/v1/admin/errors/restore", {
      method: "POST",
      json: opts.all ? { all: true } : { ids },
    });
    ok(`${res.restored} entr${res.restored === 1 ? "y" : "ies"} restored to the feed`);
  });

// ---- MangaDex session ----
const mangadex = program
  .command("mangadex")
  .description("the platform's saved MangaDex session");

mangadex
  .command("auth")
  .description("whether the saved session is still usable (never prints tokens)")
  .action(async () => {
    const res = await api<{
      hasAccess: boolean;
      hasRefresh: boolean;
      expiresAt: string | null;
      expired: boolean;
      expiresInSeconds: number | null;
    }>("/api/v1/admin/mangadex/auth");
    kv({
      accessToken: res.hasAccess ? "saved" : "absent",
      refreshToken: res.hasRefresh ? "saved" : "absent",
      expiresAt: res.expiresAt ?? "unknown",
      expired: res.expired,
      expiresIn:
        res.expiresInSeconds === null ? "unknown" : `${Math.round(res.expiresInSeconds / 60)}m`,
    });
  });

mangadex
  .command("clear-auth")
  .description("forget the saved session so the next upload re-authenticates")
  .action(async () => {
    await api("/api/v1/admin/mangadex/auth/clear", { method: "POST" });
    ok("saved MangaDex session cleared; the next upload authenticates from configured credentials");
  });

// ---- observability ----
program
  .command("stats")
  .description("queue depths, worker counts, pause state")
  .action(async () => {
    const res = await api<{
      jobs: Record<string, number>;
      uploadTasks: { kind: string; state: string; count: number }[];
      workers: Record<string, number>;
      quarantined: number;
      paused: boolean;
    }>("/api/v1/admin/stats");
    console.log("jobs by state:");
    kv(res.jobs);
    console.log("");
    console.log("upload tasks:");
    table(res.uploadTasks, [
      { header: "KIND", get: (t) => t.kind },
      { header: "STATE", get: (t) => t.state },
      { header: "COUNT", get: (t) => t.count },
    ], "no upload tasks queued");
    console.log("");
    console.log("workers by status:");
    kv(res.workers);
    console.log("");
    kv({ quarantined: res.quarantined, paused: res.paused });
  });

// ---- permission tuning ----
const permissions = program
  .command("permissions")
  .description("what each role means here, and per-account grants and denials");

/** Shared by every subcommand below: `--scopes a,b,c`, or empty for none. */
function scopeList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

interface RoleBaselineRow {
  role: string;
  scopes: string[];
  defaults: string[];
  custom: boolean;
  tunable: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

permissions
  .command("show")
  .description("the scope taxonomy and every role's current baseline")
  .action(async () => {
    const res = await api<{
      scopes: { name: string; description: string }[];
      roles: RoleBaselineRow[];
      tunableRoles: string[];
    }>("/api/v1/admin/permissions");
    console.log("scopes:");
    const width = Math.max(...res.scopes.map((s) => s.name.length));
    for (const s of res.scopes) console.log(`  ${s.name.padEnd(width)}  ${s.description}`);
    console.log("");
    console.log("roles:");
    table(res.roles, [
      { header: "ROLE", get: (r) => r.role },
      { header: "SOURCE", get: (r) => (r.custom ? "custom" : r.tunable ? "default" : "fixed") },
      { header: "SCOPES", get: (r) => r.scopes.join(",") },
      { header: "CHANGED BY", get: (r) => r.updatedBy ?? "-" },
    ]);
    console.log("");
    console.log(`Tunable roles: ${res.tunableRoles.join(", ")}. OWNER is the wildcard by construction.`);
  });

permissions
  .command("set-role <role>")
  .description("redefine a role's baseline (ADMIN | CONTRIBUTOR); replaces the whole list")
  .requiredOption("--scopes <list>", "comma-separated scopes, or a preset name from `tokens scopes`")
  .action(async (role: string, opts: { scopes: string }) => {
    const requested = scopeList(opts.scopes);
    if (requested.length === 0) fail("--scopes must list at least one scope");
    // Presets are the least-privilege path, so accept one by name here too.
    const { presets } = (await api("/api/v1/admin/tokens/scopes")) as {
      presets: Record<string, string[]>;
    };
    const scopes = [...new Set(requested.flatMap((entry) => presets[entry] ?? [entry]))];
    const res = await api<{ role: string; scopes: string[] }>(
      `/api/v1/admin/permissions/roles/${encodeURIComponent(role.toUpperCase())}`,
      { method: "PUT", json: { scopes } },
    );
    ok(`${res.role} baseline is now: ${res.scopes.join(", ")}`);
    console.log("Open sessions pick this up within a few seconds — no re-login needed.");
  });

permissions
  .command("reset-role <role>")
  .description("drop a custom baseline and track the shipped default again")
  .action(async (role: string) => {
    const res = await api<{ role: string; scopes: string[] }>(
      `/api/v1/admin/permissions/roles/${encodeURIComponent(role.toUpperCase())}`,
      { method: "DELETE" },
    );
    ok(`${res.role} is back on the shipped default: ${res.scopes.join(", ")}`);
  });

permissions
  .command("user <id>")
  .description("one account's permissions, and the parts that produced them")
  .action(async (id: string) => {
    const res = await api<{
      email: string;
      role: string;
      baseline: string[];
      extraScopes: string[];
      deniedScopes: string[];
      effective: string[];
      tunable: boolean;
    }>(`/api/v1/admin/users/${id}/permissions`);
    kv({
      email: res.email,
      role: res.role,
      baseline: res.baseline.join(",") || "none",
      granted: res.extraScopes.join(",") || "none",
      denied: res.deniedScopes.join(",") || "none",
      effective: res.effective.join(",") || "none",
    });
    if (!res.tunable) {
      console.log("");
      console.log("This account is an OWNER: it holds every scope and ignores grants and denials.");
    }
  });

permissions
  .command("set-user <id>")
  .description("grant and deny scopes for one account; both lists are replaced wholesale")
  .option("--grant <list>", "comma-separated scopes to add on top of the role")
  .option("--deny <list>", "comma-separated scopes to refuse despite the role")
  .option("--clear", "remove all tuning and leave the account exactly its role")
  .action(async (id: string, opts: { grant?: string; deny?: string; clear?: boolean }) => {
    if (opts.clear && (opts.grant || opts.deny)) {
      fail("--clear cannot be combined with --grant or --deny");
    }
    if (!opts.clear && opts.grant === undefined && opts.deny === undefined) {
      fail("pass --grant, --deny, or --clear");
    }
    // Omitting one list means "leave it as it is", not "empty it" — a command
    // that only mentions --deny must not silently drop existing grants.
    const current = await api<{ extraScopes: string[]; deniedScopes: string[] }>(
      `/api/v1/admin/users/${id}/permissions`,
    );
    const json = opts.clear
      ? { extraScopes: [], deniedScopes: [] }
      : {
          extraScopes: opts.grant === undefined ? current.extraScopes : scopeList(opts.grant),
          deniedScopes: opts.deny === undefined ? current.deniedScopes : scopeList(opts.deny),
        };
    const res = await api<{ extraScopes: string[]; deniedScopes: string[]; effective: string[] }>(
      `/api/v1/admin/users/${id}/permissions`,
      { method: "PUT", json },
    );
    kv({
      granted: res.extraScopes.join(",") || "none",
      denied: res.deniedScopes.join(",") || "none",
      effective: res.effective.join(",") || "none",
    });
  });

program
  .command("audit")
  .description("recent audit trail entries")
  .option("--limit <n>", "how many events", "50")
  .action(async (opts: { limit: string }) => {
    const res = await api<{ events: Record<string, unknown>[] }>("/api/v1/admin/audit", {
      query: { limit: opts.limit },
    });
    table(res.events, [
      { header: "WHEN", get: (e) => e["createdAt"] },
      { header: "ACTOR", get: (e) => e["actor"] },
      { header: "ACTION", get: (e) => e["action"] },
      { header: "SUBJECT", get: (e) => e["subject"] },
      { header: "DETAIL", get: (e) => String(cell(e["detail"])).slice(0, 70) },
    ], "no audit events");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  fail((err as Error).message ?? String(err));
});
