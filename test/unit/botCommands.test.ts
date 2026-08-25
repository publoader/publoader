import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { AdminApiError, type AdminApiClient } from "../../src/bot/apiClient.js";
import {
  ALL_COMMANDS,
  COMMANDS_BY_NAME,
  RETIRED_COMMANDS,
  resolveSensitivity,
  runCommand,
  type BotCommand,
  type OptionReader,
} from "../../src/bot/commands.js";
import { actorFor, FatalBotConfigError, translateLoginError } from "../../src/bot/bot.js";

const log = pino({ level: "silent" });

/** Options as supplied by a user, keyed by option name. */
function options(values: Record<string, string | number | boolean | null>, subcommand?: string): OptionReader {
  const read = <T>(name: string, kind: "string" | "number" | "boolean"): T | null => {
    const value = values[name];
    if (value === undefined || value === null) return null;
    if (kind === "string") return (typeof value === "string" ? value : String(value)) as T;
    if (kind === "number") return (typeof value === "number" ? value : null) as T | null;
    return (typeof value === "boolean" ? value : null) as T | null;
  };
  return {
    subcommand: () => subcommand ?? null,
    string: (name) => read<string>(name, "string"),
    integer: (name) => read<number>(name, "number"),
    boolean: (name) => read<boolean>(name, "boolean"),
  };
}

/**
 * A stand-in for the API client. Only the methods a given test exercises need
 * to exist; anything else being called is itself a failure worth surfacing.
 */
function fakeApi(over: Partial<Record<keyof AdminApiClient, unknown>> = {}): AdminApiClient {
  return {
    baseUrl: "https://core.example",
    tokenFingerprint: "pa_a…z999 (24 chars)",
    looksScoped: true,
    ...over,
  } as unknown as AdminApiClient;
}

function invoke(
  name: string,
  api: AdminApiClient,
  values: Record<string, string | number | boolean | null> = {},
  subcommand?: string,
) {
  const command = COMMANDS_BY_NAME.get(name);
  if (!command) throw new Error(`no such command: ${name}`);
  return runCommand(command, {
    api,
    actor: "discord:ardax",
    options: options(values, subcommand),
    log,
    interactionId: "interaction-1",
  });
}

describe("command table", () => {
  it("registers every command exactly once", () => {
    const names = ALL_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps builder names in step with command names; a mismatch would route to nothing", () => {
    for (const command of ALL_COMMANDS) {
      expect(command.builder.toJSON().name).toBe(command.name);
    }
  });

  it("covers every legacy command that has no platform equivalent", () => {
    // The list the migration doc calls retired; if one is dropped here, someone
    // typing it gets "unknown command" instead of a pointer.
    for (const legacy of ["logs", "kill", "restart-workers", "config", "login", "logout", "pull", "reload", "restart"]) {
      expect(COMMANDS_BY_NAME.has(legacy)).toBe(true);
    }
  });

  it("every retired command explains what to do instead", async () => {
    for (const retired of RETIRED_COMMANDS) {
      const reply = await invoke(retired.name, fakeApi());
      expect(reply.text).toContain("is retired");
      expect(reply.text).toContain(retired.replacement);
    }
  });
});

describe("resolveSensitivity", () => {
  const withSubs: BotCommand = {
    ...(COMMANDS_BY_NAME.get("extensions") as BotCommand),
  };

  it("reads a per-subcommand mapping", () => {
    expect(resolveSensitivity(withSubs, "list")).toBe("read");
    expect(resolveSensitivity(withSubs, "disable")).toBe("mutate");
  });

  it("falls back to destructive for an unmapped subcommand, not to read", () => {
    // A subcommand added to the builder but forgotten in the sensitivity map
    // must fail closed.
    expect(resolveSensitivity(withSubs, "nuke")).toBe("destructive");
    expect(resolveSensitivity(withSubs, null)).toBe("destructive");
  });

  it("reads a flat sensitivity", () => {
    expect(resolveSensitivity(COMMANDS_BY_NAME.get("run") as BotCommand, null)).toBe("mutate");
    expect(resolveSensitivity(COMMANDS_BY_NAME.get("status") as BotCommand, null)).toBe("read");
  });

  it("classifies the irreversible operations as destructive", () => {
    expect(resolveSensitivity(COMMANDS_BY_NAME.get("enroll") as BotCommand, null)).toBe("destructive");
    expect(resolveSensitivity(COMMANDS_BY_NAME.get("workers") as BotCommand, "revoke")).toBe("destructive");
    expect(resolveSensitivity(COMMANDS_BY_NAME.get("untracked") as BotCommand, "approve")).toBe("destructive");
  });
});

describe("/status", () => {
  const stats = {
    jobs: { QUEUED: 3, RUNNING: 1, PROCESSED: 40 },
    uploadTasks: [{ kind: "UPLOAD", state: "PENDING", count: 7 }],
    workers: { ACTIVE: 2, DRAINED: 1 },
    quarantined: 0,
    paused: false,
  };

  it("reports pause state, job counts, queue depths and the fleet", async () => {
    const api = fakeApi({
      stats: vi.fn().mockResolvedValue(stats),
      workers: vi.fn().mockResolvedValue({
        workers: [
          {
            id: "w1",
            name: "alpha",
            status: "ACTIVE",
            trust: "TRUSTED",
            lastHeartbeatAt: new Date().toISOString(),
            agentVersion: "1.0.0",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    });
    const reply = await invoke("status", api);
    expect(reply.text).toContain("Platform: running");
    expect(reply.text).toContain("QUEUED=3");
    expect(reply.text).toContain("UPLOAD/PENDING=7");
    expect(reply.text).toContain("alpha");
  });

  it("says the platform is paused, loudly", async () => {
    const api = fakeApi({
      stats: vi.fn().mockResolvedValue({ ...stats, paused: true }),
      workers: vi.fn().mockResolvedValue({ workers: [] }),
    });
    expect((await invoke("status", api)).text).toContain("PAUSED");
  });

  it("still reports status when the token cannot read the fleet", async () => {
    // A partial credential must degrade one section, not the whole command.
    const api = fakeApi({
      stats: vi.fn().mockResolvedValue(stats),
      workers: vi.fn().mockRejectedValue(
        new AdminApiError({ status: 403, detail: "no scope", scope: "workers:read", method: "GET", path: "/x" }),
      ),
    });
    const reply = await invoke("status", api);
    expect(reply.text).toContain("QUEUED=3");
    expect(reply.text).toContain("lacks `workers:read`");
  });

  it("flags quarantined submissions", async () => {
    const api = fakeApi({
      stats: vi.fn().mockResolvedValue({ ...stats, quarantined: 4 }),
      workers: vi.fn().mockResolvedValue({ workers: [] }),
    });
    expect((await invoke("status", api)).text).toContain("4 :warning:");
  });
});

describe("/run", () => {
  it("defaults to an UPDATE run and passes an interaction-derived idempotency key", async () => {
    const triggerRun = vi.fn().mockResolvedValue({ runId: "run-1", created: true });
    const reply = await invoke("run", fakeApi({ triggerRun }), { extension: "mangaplus" });
    expect(triggerRun).toHaveBeenCalledWith("discord:ardax", {
      extension: "mangaplus",
      kind: "UPDATE",
      idempotencyKey: "discord:interaction-1",
    });
    expect(reply.text).toContain("run-1");
  });

  it("refuses a CLEAN run without confirmation and makes no API call", async () => {
    const triggerRun = vi.fn();
    const reply = await invoke("run", fakeApi({ triggerRun }), { extension: "mangaplus", mode: "CLEAN" });
    expect(triggerRun).not.toHaveBeenCalled();
    expect(reply.text).toContain("not started");
    expect(reply.text).toContain("confirm: true");
  });

  it("runs a confirmed CLEAN", async () => {
    const triggerRun = vi.fn().mockResolvedValue({ runId: "run-2", created: true });
    await invoke("run", fakeApi({ triggerRun }), { extension: "mangaplus", mode: "CLEAN", confirm: true });
    expect(triggerRun).toHaveBeenCalledWith(
      "discord:ardax",
      expect.objectContaining({ kind: "CLEAN" }),
    );
  });

  it("does not require confirmation for FORCE, which is not destructive", async () => {
    const triggerRun = vi.fn().mockResolvedValue({ runId: "run-3", created: true });
    await invoke("run", fakeApi({ triggerRun }), { extension: "mangaplus", mode: "FORCE" });
    expect(triggerRun).toHaveBeenCalledWith("discord:ardax", expect.objectContaining({ kind: "FORCE" }));
  });

  it("rejects a malformed extension name locally, with a usable message", async () => {
    const triggerRun = vi.fn();
    const reply = await invoke("run", fakeApi({ triggerRun }), { extension: "Manga Plus!" });
    expect(triggerRun).not.toHaveBeenCalled();
    expect(reply.text).toContain("not a valid extension name");
  });

  it("says nothing was created when the idempotency key already existed", async () => {
    const api = fakeApi({ triggerRun: vi.fn().mockResolvedValue({ runId: "run-1", created: false }) });
    expect((await invoke("run", api, { extension: "mangaplus" })).text).toContain("already existed");
  });

  it("surfaces the paused 409 as the API worded it", async () => {
    const api = fakeApi({
      triggerRun: vi.fn().mockRejectedValue(
        new AdminApiError({
          status: 409,
          detail: "platform is paused",
          scope: "runs:write",
          method: "POST",
          path: "/runs",
        }),
      ),
    });
    const reply = await invoke("run", api, { extension: "mangaplus" });
    expect(reply.text).toContain("platform is paused");
  });
});

describe("/pause and /resume", () => {
  it("pauses indefinitely when no duration is given", async () => {
    const pause = vi.fn().mockResolvedValue({ paused: true, indefinite: true });
    const reply = await invoke("pause", fakeApi({ pause }));
    expect(pause).toHaveBeenCalledWith("discord:ardax", null);
    expect(reply.text).toContain("indefinitely");
  });

  it("pauses for a bounded window", async () => {
    const pause = vi.fn().mockResolvedValue({ paused: true, indefinite: false });
    const reply = await invoke("pause", fakeApi({ pause }), { minutes: 30 });
    expect(pause).toHaveBeenCalledWith("discord:ardax", 30);
    expect(reply.text).toContain("30 minute(s)");
  });

  it("resumes", async () => {
    const resume = vi.fn().mockResolvedValue({ paused: false });
    expect((await invoke("resume", fakeApi({ resume }))).text).toContain("resumed");
  });
});

describe("/extensions", () => {
  it("lists published bundles with their disabled state", async () => {
    const api = fakeApi({
      extensions: vi.fn().mockResolvedValue({
        extensions: [
          { name: "mangaplus", version: "1.2", sha256: "abc123def456789", disabled: false, publishedAt: "2026-07-01T10:00:00Z" },
          { name: "k_manga", version: "0.9", sha256: "fff", disabled: true, publishedAt: "2026-06-01T10:00:00Z" },
        ],
      }),
    });
    const reply = await invoke("extensions", api, {}, "list");
    expect(reply.text).toContain("mangaplus");
    expect(reply.text).toContain(":no_entry: `k_manga`");
  });

  it("explains the empty case in terms of publishing, not missing files", async () => {
    const api = fakeApi({ extensions: vi.fn().mockResolvedValue({ extensions: [] }) });
    expect((await invoke("extensions", api, {}, "list")).text).toContain("bundle publish");
  });

  it("enables and disables", async () => {
    const setExtensionEnabled = vi.fn().mockResolvedValue({ ok: true });
    await invoke("extensions", fakeApi({ setExtensionEnabled }), { extension: "mangaplus" }, "enable");
    expect(setExtensionEnabled).toHaveBeenCalledWith("discord:ardax", "mangaplus", true);

    const off = vi.fn().mockResolvedValue({ ok: true });
    await invoke("extensions", fakeApi({ setExtensionEnabled: off }), { extension: "mangaplus" }, "disable");
    expect(off).toHaveBeenCalledWith("discord:ardax", "mangaplus", false);
  });
});

describe("/schedule", () => {
  const daily = (hour: number, over: object = {}) => ({
    hour,
    minute: 0,
    days: [],
    kind: "UPDATE",
    ...over,
  });

  it("shows every slot an extension has, not just the first", async () => {
    const api = fakeApi({
      schedules: vi.fn().mockResolvedValue({
        defaults: { mangaplus: [daily(15)], k_manga: [daily(1)] },
        overrides: {
          mangaplus: [
            daily(15),
            daily(1),
            daily(1, { days: [2], kind: "CLEAN", label: "weekly deep clean" }),
          ],
        },
        effective: {},
      }),
    });
    const reply = await invoke("schedule", api, {}, "list");
    expect(reply.text).toContain("15:00 UTC daily");
    expect(reply.text).toContain("01:00 UTC wed `clean`, weekly deep clean");
    expect(reply.text).toContain("*(override)*");
    expect(reply.text).toContain("01:00 UTC daily `update`");
  });

  it("adds a slot without disturbing the ones already there", async () => {
    const addSchedule = vi.fn().mockResolvedValue({ ok: true, id: "abc", created: true, seeded: 0 });
    await invoke(
      "schedule",
      fakeApi({ addSchedule }),
      { extension: "mangaplus", hour: 1, minute: 0, days: "wed", kind: "CLEAN", label: "weekly" },
      "add",
    );
    expect(addSchedule).toHaveBeenCalledWith("discord:ardax", "mangaplus", {
      hour: 1,
      minute: 0,
      days: [2],
      kind: "CLEAN",
      label: "weekly",
    });
  });

  it("reports the manifest slots it copied in, so nothing looks silently dropped", async () => {
    const addSchedule = vi.fn().mockResolvedValue({ ok: true, id: "abc", created: true, seeded: 2 });
    const reply = await invoke(
      "schedule",
      fakeApi({ addSchedule }),
      { extension: "mangaplus", hour: 1, minute: 0 },
      "add",
    );
    expect(reply.text).toContain("2 manifest slot(s) were copied in first");
  });

  it("accepts weekday names and rejects a word that is not one", async () => {
    const addSchedule = vi.fn().mockResolvedValue({ ok: true, id: "a", created: true, seeded: 0 });
    await invoke(
      "schedule",
      fakeApi({ addSchedule }),
      { extension: "mangaplus", hour: 1, minute: 0, days: "sat,sun" },
      "add",
    );
    expect(addSchedule.mock.calls[0]?.[2]).toMatchObject({ days: [5, 6] });

    const bad = await invoke(
      "schedule",
      fakeApi({ addSchedule }),
      { extension: "mangaplus", hour: 1, minute: 0, days: "funday" },
      "add",
    );
    expect(bad.text).toContain("not a weekday");
  });

  it("`set` says out loud that it replaced everything else", async () => {
    const setSchedule = vi.fn().mockResolvedValue({ ok: true, entries: 1 });
    const reply = await invoke(
      "schedule",
      fakeApi({ setSchedule }),
      { extension: "mangaplus", hour: 4, minute: 15 },
      "set",
    );
    expect(setSchedule).toHaveBeenCalledWith("discord:ardax", "mangaplus", {
      hour: 4,
      minute: 15,
      days: [],
      kind: "UPDATE",
    });
    expect(reply.text).toContain("every other slot was removed");
  });

  it("addresses a slot by its listed number, not by a uuid nobody can type", async () => {
    const extensionSchedule = vi.fn().mockResolvedValue({
      extension: "mangaplus",
      manifest: [],
      entries: [
        { id: "id-one", enabled: true, ...daily(15) },
        { id: "id-two", enabled: true, ...daily(1, { days: [2], kind: "CLEAN" }) },
      ],
      effective: [],
      source: "operator",
    });
    const removeScheduleEntry = vi.fn().mockResolvedValue({ ok: true, removed: true });
    const reply = await invoke(
      "schedule",
      fakeApi({ extensionSchedule, removeScheduleEntry }),
      { extension: "mangaplus", slot: 2 },
      "remove",
    );
    expect(removeScheduleEntry).toHaveBeenCalledWith("discord:ardax", "mangaplus", "id-two");
    // The confirmation names the slot back, so a stale number is visible.
    expect(reply.text).toContain("01:00 UTC wed");
  });

  it("refuses a slot number the extension does not have", async () => {
    const extensionSchedule = vi.fn().mockResolvedValue({
      extension: "mangaplus",
      manifest: [],
      entries: [{ id: "id-one", enabled: true, ...daily(15) }],
      effective: [],
      source: "operator",
    });
    const reply = await invoke(
      "schedule",
      fakeApi({ extensionSchedule }),
      { extension: "mangaplus", slot: 4 },
      "remove",
    );
    expect(reply.text).toContain("has 1 slot(s)");
  });

  it("switching a slot off keeps the row", async () => {
    const extensionSchedule = vi.fn().mockResolvedValue({
      extension: "mangaplus",
      manifest: [],
      entries: [{ id: "id-one", enabled: true, ...daily(1, { days: [2], kind: "CLEAN" }) }],
      effective: [],
      source: "operator",
    });
    const setScheduleEnabled = vi.fn().mockResolvedValue({ ok: true, enabled: false });
    const reply = await invoke(
      "schedule",
      fakeApi({ extensionSchedule, setScheduleEnabled }),
      { extension: "mangaplus", slot: 1 },
      "disable",
    );
    expect(setScheduleEnabled).toHaveBeenCalledWith("discord:ardax", "mangaplus", "id-one", false);
    expect(reply.text).toContain("the row is kept");
  });

  it("distinguishes resetting an override from there never having been one", async () => {
    const had = fakeApi({ removeSchedule: vi.fn().mockResolvedValue({ ok: true, removed: true }) });
    expect((await invoke("schedule", had, { extension: "mangaplus" }, "reset")).text).toContain(
      "All operator slots removed",
    );

    const none = fakeApi({ removeSchedule: vi.fn().mockResolvedValue({ ok: true, removed: false }) });
    expect((await invoke("schedule", none, { extension: "mangaplus" }, "reset")).text).toContain(
      "no operator slots",
    );
  });
});

describe("/removal-mode", () => {
  it("reports the current mode and the valid set", async () => {
    const api = fakeApi({
      getRemovalMode: vi.fn().mockResolvedValue({ mode: "unavailable", validModes: ["unavailable", "delete"] }),
    });
    expect((await invoke("removal-mode", api, {}, "get")).text).toContain("**unavailable**");
  });

  it("sets it and notes that manifests can still override", async () => {
    const setRemovalMode = vi.fn().mockResolvedValue({ ok: true, mode: "delete" });
    const reply = await invoke("removal-mode", fakeApi({ setRemovalMode }), { mode: "delete" }, "set");
    expect(setRemovalMode).toHaveBeenCalledWith("discord:ardax", "delete");
    expect(reply.text).toContain("manifest still win");
  });
});

describe("/runs", () => {
  it("lists recent runs with the trigger source", async () => {
    const api = fakeApi({
      listRuns: vi.fn().mockResolvedValue({
        runs: [
          {
            id: "run-aaaaaaaa-1",
            extension: "mangaplus",
            kind: "FORCE",
            state: "PROCESSED",
            createdAt: "2026-07-29T15:05:00Z",
            triggeredBy: "admin:discord:ardax",
          },
        ],
      }),
    });
    const reply = await invoke("runs", api, { limit: 5 }, "recent");
    expect(reply.text).toContain("mangaplus");
    expect(reply.text).toContain("admin:discord:ardax");
  });

  it("defaults the limit rather than sending undefined", async () => {
    const listRuns = vi.fn().mockResolvedValue({ runs: [] });
    await invoke("runs", fakeApi({ listRuns }), {}, "recent");
    expect(listRuns).toHaveBeenCalledWith("discord:ardax", { limit: 15 });
  });

  it("shows a run with its jobs and each job's last error", async () => {
    const api = fakeApi({
      getRun: vi.fn().mockResolvedValue({
        run: {
          id: "run-1",
          extension: "mangaplus",
          kind: "UPDATE",
          state: "FAILED",
          createdAt: "2026-07-29T15:05:00Z",
          jobs: [
            { id: "job-abcdefgh", state: "DEAD_LETTER", attempt: 4, segmentIndex: 0, segmentTotal: 2, lastError: "upstream 500" },
            { id: "job-ijklmnop", state: "PROCESSED", attempt: 1, segmentIndex: 1, segmentTotal: 2, lastError: null },
          ],
        },
      }),
    });
    const reply = await invoke("runs", api, { id: "run-1" }, "show");
    expect(reply.text).toContain("2 job(s)");
    expect(reply.text).toContain("seg 1/2");
    expect(reply.text).toContain("upstream 500");
  });

  it("requires an id for show", async () => {
    expect((await invoke("runs", fakeApi({}), {}, "show")).text).toContain("`id` is required");
  });
});

describe("/jobs, /dead-letter, /quarantine", () => {
  it("reports what cancel actually did", async () => {
    const api = fakeApi({ cancelJob: vi.fn().mockResolvedValue({ ok: true, result: "cancelled" }) });
    expect((await invoke("jobs", api, { id: "job-1" }, "cancel")).text).toContain("cancelled");
  });

  it("explains a 409 from cancel instead of claiming success", async () => {
    const api = fakeApi({
      cancelJob: vi.fn().mockRejectedValue(
        new AdminApiError({ status: 409, detail: "job not cancellable", scope: "runs:write", method: "POST", path: "/x" }),
      ),
    });
    const reply = await invoke("jobs", api, { id: "job-1" }, "cancel");
    expect(reply.text).toContain("job not cancellable");
  });

  it("retries a dead-lettered job", async () => {
    const retryJob = vi.fn().mockResolvedValue({ ok: true });
    expect((await invoke("jobs", fakeApi({ retryJob }), { id: "job-1" }, "retry")).text).toContain("requeued");
  });

  it("says the dead-letter queue is empty when it is", async () => {
    const api = fakeApi({ deadLetter: vi.fn().mockResolvedValue({ jobs: [] }) });
    expect((await invoke("dead-letter", api)).text).toContain("empty");
  });

  it("points at the replay command when listing dead letters", async () => {
    const api = fakeApi({
      deadLetter: vi.fn().mockResolvedValue({
        jobs: [{ id: "job-abcdefgh", extension: "mangaplus", state: "DEAD_LETTER", attempt: 5, lastError: "boom" }],
      }),
    });
    const reply = await invoke("dead-letter", api);
    expect(reply.text).toContain("/jobs retry");
    expect(reply.text).toContain("boom");
  });

  it("shows quarantined submissions with their reject reason", async () => {
    const api = fakeApi({
      quarantine: vi.fn().mockResolvedValue({
        quarantined: [
          { id: "q1", jobId: "job-abcdefgh", workerId: "worker-1", rejectReason: "schema: pages[0]", createdAt: "2026-07-29T15:00:00Z" },
        ],
      }),
    });
    expect((await invoke("quarantine", api)).text).toContain("schema: pages[0]");
  });
});

describe("/workers", () => {
  it("lists the fleet with full ids, since the ids are what other commands take", async () => {
    const api = fakeApi({
      workers: vi.fn().mockResolvedValue({
        workers: [
          {
            id: "worker-uuid-1234",
            name: "alpha",
            status: "DRAINED",
            trust: "COMMUNITY",
            lastHeartbeatAt: null,
            agentVersion: null,
            createdAt: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    });
    const reply = await invoke("workers", api, {}, "list");
    expect(reply.text).toContain("worker-uuid-1234");
    expect(reply.text).toContain("heartbeat never");
  });

  it("drains and activates without confirmation; both are reversible", async () => {
    const drain = vi.fn().mockResolvedValue({ ok: true, status: "DRAINED" });
    await invoke("workers", fakeApi({ workerAction: drain }), { id: "w1" }, "drain");
    expect(drain).toHaveBeenCalledWith("discord:ardax", "w1", "drain");

    const activate = vi.fn().mockResolvedValue({ ok: true, status: "ACTIVE" });
    await invoke("workers", fakeApi({ workerAction: activate }), { id: "w1" }, "activate");
    expect(activate).toHaveBeenCalledWith("discord:ardax", "w1", "activate");
  });

  it("refuses to revoke without confirmation and suggests drain instead", async () => {
    const workerAction = vi.fn();
    const reply = await invoke("workers", fakeApi({ workerAction }), { id: "w1" }, "revoke");
    expect(workerAction).not.toHaveBeenCalled();
    expect(reply.text).toContain("not revoked");
    expect(reply.text).toContain("drain");
  });

  it("revokes when confirmed", async () => {
    const workerAction = vi.fn().mockResolvedValue({ ok: true, status: "REVOKED" });
    await invoke("workers", fakeApi({ workerAction }), { id: "w1", confirm: true }, "revoke");
    expect(workerAction).toHaveBeenCalledWith("discord:ardax", "w1", "revoke");
  });
});

describe("/enroll", () => {
  it("puts the token in a DM and never in the channel reply", async () => {
    const api = fakeApi({
      createEnrollToken: vi.fn().mockResolvedValue({ token: "pe_supersecret", expiresAt: "2026-07-30T00:00:00Z" }),
    });
    const reply = await invoke("enroll", api, { trust: "TRUSTED", note: "arda laptop" });
    expect(reply.dm).toContain("pe_supersecret");
    expect(reply.text).not.toContain("pe_supersecret");
    expect(reply.text).toContain("DM");
  });

  it("defaults to COMMUNITY trust and a 24h window", async () => {
    const createEnrollToken = vi.fn().mockResolvedValue({ token: "pe_x", expiresAt: "2026-07-30T00:00:00Z" });
    await invoke("enroll", fakeApi({ createEnrollToken }));
    expect(createEnrollToken).toHaveBeenCalledWith("discord:ardax", { trust: "COMMUNITY", ttlHours: 24 });
  });
});

describe("/untracked and /tracked", () => {
  it("refuses to approve without confirmation, because it creates a real title", async () => {
    const approveUntracked = vi.fn();
    const reply = await invoke("untracked", fakeApi({ approveUntracked }), { id: "u1" }, "approve");
    expect(approveUntracked).not.toHaveBeenCalled();
    expect(reply.text).toContain("cannot be undone");
  });

  it("approves when confirmed and reports the new MangaDex id", async () => {
    const api = fakeApi({ approveUntracked: vi.fn().mockResolvedValue({ ok: true, mdMangaId: "md-uuid" }) });
    expect((await invoke("untracked", api, { id: "u1", confirm: true }, "approve")).text).toContain("md-uuid");
  });

  it("skips without confirmation; skipping is reversible by re-reporting", async () => {
    const skipUntracked = vi.fn().mockResolvedValue({ ok: true });
    await invoke("untracked", fakeApi({ skipUntracked }), { id: "u1" }, "skip");
    expect(skipUntracked).toHaveBeenCalledWith("discord:ardax", "u1");
  });

  it("filters the untracked list by state", async () => {
    const untracked = vi.fn().mockResolvedValue({ untracked: [] });
    await invoke("untracked", fakeApi({ untracked }), { state: "NEW", limit: 5 }, "list");
    expect(untracked).toHaveBeenCalledWith("discord:ardax", { limit: 5, state: "NEW" });
  });

  it("maps a tracked entry and says MangaDex was untouched on removal", async () => {
    const setTracked = vi.fn().mockResolvedValue({ ok: true });
    await invoke(
      "tracked",
      fakeApi({ setTracked }),
      { extension: "mangaplus", "manga-id": "100001", "md-manga-id": "md-uuid" },
      "set",
    );
    expect(setTracked).toHaveBeenCalledWith("discord:ardax", "mangaplus", {
      mangaId: "100001",
      mdMangaId: "md-uuid",
    });

    const removeTracked = vi.fn().mockResolvedValue({ ok: true, removed: true });
    const reply = await invoke(
      "tracked",
      fakeApi({ removeTracked }),
      { extension: "mangaplus", "manga-id": "100001" },
      "remove",
    );
    expect(reply.text).toContain("Nothing on MangaDex was changed");
  });
});

describe("/whoami", () => {
  it("shows where it points, a masked token, and the audit identity", async () => {
    const api = fakeApi({ tokenSelf: vi.fn().mockResolvedValue(null) });
    const reply = await invoke("whoami", api);
    expect(reply.text).toContain("https://core.example");
    expect(reply.text).toContain("pa_a…z999");
    expect(reply.text).toContain("discord:ardax");
    expect(reply.text).toContain("no token-introspection endpoint");
  });

  it("lists real scopes when the deployment exposes them", async () => {
    const api = fakeApi({ tokenSelf: vi.fn().mockResolvedValue({ scopes: ["runs:write", "stats:read"] }) });
    expect((await invoke("whoami", api)).text).toContain("`runs:write`");
  });

  it("calls out a wildcard scope as defeating the purpose", async () => {
    const api = fakeApi({ tokenSelf: vi.fn().mockResolvedValue({ scopes: ["*"] }) });
    expect((await invoke("whoami", api)).text).toContain("defeats the point");
  });

  it("warns when the bot is running on something that is not a scoped token", async () => {
    const api = fakeApi({ looksScoped: false, tokenSelf: vi.fn().mockResolvedValue(null) });
    expect((await invoke("whoami", api)).text).toContain("root `ADMIN_TOKEN`");
  });
});

describe("runCommand error handling", () => {
  it("turns an unexpected throw into an actionable reply rather than an unhandled rejection", async () => {
    const api = fakeApi({ stats: vi.fn().mockRejectedValue(new TypeError("undefined is not a function")) });
    const reply = await invoke("status", api);
    expect(reply.text).toContain("`/status` failed");
    expect(reply.text).toContain("undefined is not a function");
  });
});

describe("actorFor", () => {
  it("prefixes the username so the audit log names the human", () => {
    expect(actorFor("ardax")).toBe("discord:ardax");
  });

  it("strips anything that could forge a header; the username is untrusted input", () => {
    // CRLF plus a second header name is the whole attack; neither the newlines
    // nor the colon survive.
    expect(actorFor("ard\r\nx-actor: admin")).toBe("discord:ardx-actoradmin");
  });

  it("keeps the value inside the server's 64-character bound", () => {
    expect(actorFor("a".repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it("never produces a bare prefix for a username of only stripped characters", () => {
    expect(actorFor("！！！")).toBe("discord:unknown");
  });
});

describe("translateLoginError", () => {
  it("turns an invalid Discord token into a fatal config error naming the fix", () => {
    const translated = translateLoginError(Object.assign(new Error("An invalid token was provided."), { code: "TokenInvalid" }));
    expect(translated).toBeInstanceOf(FatalBotConfigError);
    expect((translated as Error).message).toContain("Reset Token");
  });

  it("explains a disallowed-intents rejection", () => {
    const translated = translateLoginError(Object.assign(new Error("x"), { code: "DisallowedIntents" }));
    expect(translated).toBeInstanceOf(FatalBotConfigError);
    expect((translated as Error).message).toContain("Privileged Gateway Intents");
  });

  it("passes anything else through, so a network blip stays retryable", () => {
    // Declaring a transient failure unfixable would stop the supervisor
    // retrying a login that would have succeeded a second later.
    const original = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    expect(translateLoginError(original)).toBe(original);
    const bare = new Error("no code at all");
    expect(translateLoginError(bare)).toBe(bare);
  });
});

describe("/queue (upload tasks)", () => {
  const listing = {
    tasks: [
      {
        id: "task-uuid-1",
        kind: "UPLOAD",
        state: "DEAD_LETTER",
        dedupeKey: "mangaplus:1001:5",
        attempt: 3,
        maxAttempts: 3,
        lastError: "MangaDex 429",
        updatedAt: "2026-07-29T15:00:00Z",
      },
    ],
    counts: [
      { kind: "UPLOAD", state: "PENDING", count: 12 },
      { kind: "UPLOAD", state: "DONE", count: 0 },
    ],
  };

  it("lists rows and depth totals, dropping empty buckets", async () => {
    const api = fakeApi({ uploadTasks: vi.fn().mockResolvedValue(listing) });
    const reply = await invoke("queue", api, {}, "list");
    expect(reply.text).toContain("UPLOAD/PENDING=12");
    expect(reply.text).not.toContain("DONE=0");
    expect(reply.text).toContain("MangaDex 429");
  });

  it("passes kind and state filters through", async () => {
    const uploadTasks = vi.fn().mockResolvedValue(listing);
    await invoke("queue", fakeApi({ uploadTasks }), { kind: "EDIT", state: "FAILED", limit: 5 }, "list");
    expect(uploadTasks).toHaveBeenCalledWith("discord:ardax", { limit: 5, kind: "EDIT", state: "FAILED" });
  });

  it("still shows depths when no row matches the filter", async () => {
    const api = fakeApi({ uploadTasks: vi.fn().mockResolvedValue({ tasks: [], counts: listing.counts }) });
    const reply = await invoke("queue", api, {}, "list");
    expect(reply.text).toContain("No matching upload tasks");
    expect(reply.text).toContain("UPLOAD/PENDING=12");
  });

  it("retries a dead-lettered task", async () => {
    const retryUploadTask = vi.fn().mockResolvedValue({ ok: true, state: "PENDING" });
    await invoke("queue", fakeApi({ retryUploadTask }), { id: "task-1" }, "retry");
    expect(retryUploadTask).toHaveBeenCalledWith("discord:ardax", "task-1");
  });

  it("refuses to cancel without confirmation; the chapter would never upload", async () => {
    const cancelUploadTask = vi.fn();
    const reply = await invoke("queue", fakeApi({ cancelUploadTask }), { id: "task-1" }, "cancel");
    expect(cancelUploadTask).not.toHaveBeenCalled();
    expect(reply.text).toContain("never sent to");
  });

  it("cancels when confirmed", async () => {
    const cancelUploadTask = vi.fn().mockResolvedValue({ ok: true, state: "DONE" });
    await invoke("queue", fakeApi({ cancelUploadTask }), { id: "task-1", confirm: true }, "cancel");
    expect(cancelUploadTask).toHaveBeenCalledWith("discord:ardax", "task-1");
  });

  it("explains the LEASED 409 rather than claiming the cancel worked", async () => {
    const api = fakeApi({
      cancelUploadTask: vi.fn().mockRejectedValue(
        new AdminApiError({
          status: 409,
          detail: "upload task is LEASED by a worker; wait for the lease to expire or requeue stale leases first",
          scope: "runs:write",
          method: "POST",
          path: "/x",
        }),
      ),
    });
    const reply = await invoke("queue", api, { id: "task-1", confirm: true }, "cancel");
    expect(reply.text).toContain("LEASED by a worker");
  });

  it("reports how many stale leases were swept, including none", async () => {
    const some = fakeApi({ requeueStaleUploadTasks: vi.fn().mockResolvedValue({ ok: true, requeued: 4 }) });
    expect((await invoke("queue", some, {}, "requeue-stale")).text).toContain("**4**");

    const none = fakeApi({ requeueStaleUploadTasks: vi.fn().mockResolvedValue({ ok: true, requeued: 0 }) });
    expect((await invoke("queue", none, {}, "requeue-stale")).text).toContain("Nothing to requeue");
  });

  it("gates cancel as destructive and the rest as read/mutate", () => {
    const queue = COMMANDS_BY_NAME.get("queue") as BotCommand;
    expect(resolveSensitivity(queue, "list")).toBe("read");
    expect(resolveSensitivity(queue, "retry")).toBe("mutate");
    expect(resolveSensitivity(queue, "requeue-stale")).toBe("mutate");
    expect(resolveSensitivity(queue, "cancel")).toBe("destructive");
  });
});

describe("/mdauth", () => {
  it("reports a healthy session with its remaining lifetime", async () => {
    const api = fakeApi({
      mdAuth: vi.fn().mockResolvedValue({
        hasAccess: true,
        hasRefresh: true,
        expiresAt: "2026-07-29T16:00:00Z",
        expired: false,
        expiresInSeconds: 1800,
      }),
    });
    const reply = await invoke("mdauth", api, {}, "status");
    expect(reply.text).toContain("access token stored");
    expect(reply.text).toContain("~30 min");
  });

  it("says an expired access token is normal, so nobody clears a working session", async () => {
    const api = fakeApi({
      mdAuth: vi.fn().mockResolvedValue({
        hasAccess: true,
        hasRefresh: true,
        expiresAt: "2026-07-29T10:00:00Z",
        expired: true,
        expiresInSeconds: -600,
      }),
    });
    const reply = await invoke("mdauth", api, {}, "status");
    expect(reply.text).toContain("**expired**");
    expect(reply.text).toContain("normal");
  });

  it("does not report an unparseable token as dead", async () => {
    const api = fakeApi({
      mdAuth: vi.fn().mockResolvedValue({
        hasAccess: true,
        hasRefresh: false,
        expiresAt: null,
        expired: false,
        expiresInSeconds: null,
      }),
    });
    expect((await invoke("mdauth", api, {}, "status")).text).toContain("does not mean it is bad");
  });

  it("flags a completely absent session", async () => {
    const api = fakeApi({
      mdAuth: vi.fn().mockResolvedValue({
        hasAccess: false,
        hasRefresh: false,
        expiresAt: null,
        expired: false,
        expiresInSeconds: null,
      }),
    });
    expect((await invoke("mdauth", api, {}, "status")).text).toContain("No MangaDex session is stored");
  });

  it("refuses to clear without confirmation, and says it is not a revocation", async () => {
    const clearMdAuth = vi.fn();
    const reply = await invoke("mdauth", fakeApi({ clearMdAuth }), {}, "clear");
    expect(clearMdAuth).not.toHaveBeenCalled();
    expect(reply.text).toContain("revoke anything on MangaDex's side");
  });

  it("clears when confirmed", async () => {
    const clearMdAuth = vi.fn().mockResolvedValue({ ok: true, cleared: true });
    const reply = await invoke("mdauth", fakeApi({ clearMdAuth }), { confirm: true }, "clear");
    expect(clearMdAuth).toHaveBeenCalledWith("discord:ardax");
    expect(reply.text).toContain("cleared");
  });
});

describe("/errors", () => {
  const twoFailures = {
    clearedHidden: 0,
    errors: [
      { at: "2026-07-29T15:00:00Z", kind: "job:DEAD_LETTER", source: "job", subject: "mangaplus · segment 1/2", message: "upstream 500", id: "3f9a1c2b-job" },
      { at: "2026-07-29T14:00:00Z", kind: "upload-task:FAILED", source: "upload-task", subject: "UPLOAD · key", message: "MD 429", id: "7b1c2d3e-task" },
    ],
  };

  it("merges the failure sources into one list, with the id `clear` takes", async () => {
    const api = fakeApi({ errors: vi.fn().mockResolvedValue(twoFailures) });
    const reply = await invoke("errors", api, { limit: 5 }, "list");
    expect(reply.text).toContain("job:DEAD_LETTER");
    expect(reply.text).toContain("upload-task:FAILED");
    expect(reply.text).toContain("2 failure(s)");
    // The short id is what makes the next command typeable from this message.
    expect(reply.text).toContain("3f9a1c2b");
    expect(reply.text).toContain("/errors clear");
  });

  it("distinguishes nothing outstanding from nothing ever failing", async () => {
    const quiet = fakeApi({ errors: vi.fn().mockResolvedValue({ errors: [], clearedHidden: 0 }) });
    expect((await invoke("errors", quiet, {}, "list")).text).toContain("Nothing has failed recently");

    // Same empty list, but four failures were dealt with; an operator deciding
    // whether to dig further needs that difference.
    const handled = fakeApi({ errors: vi.fn().mockResolvedValue({ errors: [], clearedHidden: 4 }) });
    const reply = await invoke("errors", handled, {}, "list");
    expect(reply.text).toContain("Nothing outstanding");
    expect(reply.text).toContain("4 cleared");
  });

  it("lists cleared entries with who cleared them", async () => {
    const errors = vi.fn().mockResolvedValue({
      clearedHidden: 0,
      errors: [{ ...twoFailures.errors[0]!, cleared: { at: "2026-07-30T00:00:00Z", by: "discord:ardax", note: "upstream fixed" } }],
    });
    const reply = await invoke("errors", fakeApi({ errors }), { show: "only" }, "list");
    expect(errors).toHaveBeenCalledWith("discord:ardax", 10, "only");
    expect(reply.text).toContain("cleared by discord:ardax");
    expect(reply.text).toContain("upstream fixed");
  });

  it("clears one failure by id prefix, with a note", async () => {
    const clearErrors = vi.fn().mockResolvedValue({ ok: true, cleared: 1, skipped: [] });
    const reply = await invoke("errors", fakeApi({ clearErrors }), { id: "3f9a1c2b", note: "fixed in 1.4.2" }, "clear");
    expect(clearErrors).toHaveBeenCalledWith("discord:ardax", { ids: ["3f9a1c2b"], note: "fixed in 1.4.2" });
    expect(reply.text).toContain("1 failure(s) cleared");
    // The reply has to say what clearing did NOT do, or it reads as a delete.
    expect(reply.text).toContain("unchanged");
  });

  it("reports entries it could not clear instead of claiming success", async () => {
    const clearErrors = vi.fn().mockResolvedValue({
      ok: false,
      cleared: 0,
      skipped: [{ source: null, id: "deadbeef", reason: "nothing currently failing matches this id" }],
    });
    const reply = await invoke("errors", fakeApi({ clearErrors }), { id: "deadbeef" }, "clear");
    expect(reply.text).toContain("Nothing was cleared");
    expect(reply.text).toContain("nothing currently failing matches this id");
  });

  it("refuses an id together with all, and refuses neither", async () => {
    const clearErrors = vi.fn();
    const api = fakeApi({ clearErrors });
    // `id` with `all` reads as "clear this one" but would clear everything, so it
    // is a user error rather than a resolved ambiguity.
    expect((await invoke("errors", api, { id: "3f9a1c2b", all: true }, "clear")).text).toContain("not both");
    expect((await invoke("errors", api, {}, "clear")).text).toContain("all");
    expect(clearErrors).not.toHaveBeenCalled();
  });

  it("restores cleared entries, and says when nothing matched", async () => {
    const restored = vi.fn().mockResolvedValue({ ok: true, restored: 2 });
    expect((await invoke("errors", fakeApi({ restoreErrors: restored }), { all: true }, "restore")).text).toContain("2 entries");
    expect(restored).toHaveBeenCalledWith("discord:ardax", { all: true });

    const none = vi.fn().mockResolvedValue({ ok: true, restored: 0 });
    expect((await invoke("errors", fakeApi({ restoreErrors: none }), { id: "deadbeef" }, "restore")).text).toContain(
      "Nothing matched",
    );
  });

  it("keeps clearing behind a mutate sensitivity while listing stays read", () => {
    const errors = COMMANDS_BY_NAME.get("errors")!;
    expect(resolveSensitivity(errors, "list")).toBe("read");
    expect(resolveSensitivity(errors, "clear")).toBe("mutate");
    expect(resolveSensitivity(errors, "restore")).toBe("mutate");
  });
});

describe("retired pointers stay accurate as endpoints land", () => {
  it("sends /logs to /errors now that a failure feed exists", async () => {
    expect((await invoke("logs", fakeApi())).text).toContain("/errors");
  });

  it("sends /logout and /login to /mdauth clear", async () => {
    expect((await invoke("logout", fakeApi())).text).toContain("/mdauth clear");
    expect((await invoke("login", fakeApi())).text).toContain("/mdauth clear");
  });

  it("no longer registers queue or mdauth as retired; they are real commands", () => {
    const retiredNames = RETIRED_COMMANDS.map((r) => r.name);
    expect(retiredNames).not.toContain("queue");
    expect(retiredNames).not.toContain("mdauth");
  });

  it("sends /kill to both cancel paths", async () => {
    const reply = await invoke("kill", fakeApi());
    expect(reply.text).toContain("/jobs cancel");
    expect(reply.text).toContain("/queue cancel");
  });
});


/**
 * `/recard`: the half of a re-card the bot can actually do.
 *
 * Queuing card images is closed to api tokens at the endpoint, so the command
 * reports and hands over a command line rather than pretending it can act. The
 * property worth holding is that it never hands over a command line aimed at a
 * title nobody chose.
 */
describe("recard", () => {
  const series = (over: Record<string, unknown> = {}) => ({
    mdMangaId: "9a1b1c1d-0000-4000-8000-000000000000",
    mangaName: "Sakamoto Days",
    extensions: ["mangaplus"],
    count: 12,
    at: "2026-03-04T05:06:07.000Z",
    ...over,
  });

  it("names the title, the size of the job, and how to run it", async () => {
    const archiveSeries = vi.fn().mockResolvedValue({
      archive: "unavailable",
      series: [series()],
      limit: 5,
      capped: false,
    });
    const reply = await invoke("recard", fakeApi({ archiveSeries }), { series: "sakamoto" });

    expect(archiveSeries).toHaveBeenCalledWith("discord:ardax", {
      archive: "unavailable",
      search: "sakamoto",
      extension: undefined,
      limit: 5,
    });
    expect(reply.text).toContain("Sakamoto Days");
    expect(reply.text).toContain("12");
    expect(reply.text).toContain(
      "padmin chapters recard --series 9a1b1c1d-0000-4000-8000-000000000000 --apply",
    );
    // Said plainly rather than discovered as a 403 after the fact.
    expect(reply.text).toContain("cannot post card images");
  });

  it("shortlists rather than guessing when a name matches several titles", async () => {
    const archiveSeries = vi.fn().mockResolvedValue({
      archive: "unavailable",
      series: [series(), series({ mdMangaId: "other-id", mangaName: "Sakamoto Days Gaiden", count: 3 })],
      limit: 5,
      capped: false,
    });
    const reply = await invoke("recard", fakeApi({ archiveSeries }), { series: "sakamoto" });

    expect(reply.text).toContain("Sakamoto Days Gaiden");
    // No command line: running one against the wrong title is the failure this
    // shortlist exists to prevent.
    expect(reply.text).not.toContain("--apply");
    expect(reply.text).toContain("Name one of them");
  });

  it("carries the extension into the command line it hands over", async () => {
    const archiveSeries = vi.fn().mockResolvedValue({
      archive: "unavailable",
      series: [series()],
      limit: 5,
      capped: false,
    });
    const reply = await invoke("recard", fakeApi({ archiveSeries }), {
      series: "sakamoto",
      extension: "mangaplus",
    });
    expect(reply.text).toContain("--extension mangaplus --apply");
  });

  it("says so when nothing is carded at all", async () => {
    const archiveSeries = vi.fn().mockResolvedValue({
      archive: "unavailable",
      series: [],
      limit: 10,
      capped: false,
    });
    const reply = await invoke("recard", fakeApi({ archiveSeries }), {});
    expect(reply.text).toContain("no card to re-post");
  });

  it("stays a read command; it has no write to gate", () => {
    expect(resolveSensitivity(COMMANDS_BY_NAME.get("recard")!, null)).toBe("read");
  });
});


/**
 * `/recheck`: the question before a card exists.
 *
 * Unlike `/recard`, this one the bot can actually do — it creates a run, and
 * run creation is not closed to api tokens. So the guard that matters is the
 * confirmation: the reply must report without starting anything until asked.
 */
describe("recheck", () => {
  const MD_MANGA = "9a1b1c1d-0000-4000-8000-000000000000";
  const report = (over: Record<string, unknown> = {}) => ({
    dryRun: true,
    extension: "mangaplus",
    mangaId: "100191",
    removalMode: "unavailable",
    onMangadex: 41,
    carded: 3,
    candidates: 38,
    publishesCatalogue: true,
    note: "note",
    ...over,
  });

  it("reports what it would cover and starts nothing", async () => {
    const recheckSeries = vi.fn().mockResolvedValue(report());
    const reply = await invoke("recheck", fakeApi({ recheckSeries }), { series: MD_MANGA });

    expect(recheckSeries).toHaveBeenCalledWith("discord:ardax", {
      mdMangaId: MD_MANGA,
      extension: undefined,
      apply: false,
      idempotencyKey: "discord:interaction-1",
    });
    expect(reply.text).toContain("mangaplus");
    expect(reply.text).toContain("38");
    expect(reply.text).toContain("UNAVAILABLE");
    expect(reply.text).toContain("Nothing has been started");
  });

  it("starts the run when confirmed, and names it", async () => {
    const recheckSeries = vi
      .fn()
      .mockResolvedValue(report({ dryRun: false, runId: "run-1", created: true }));
    const reply = await invoke("recheck", fakeApi({ recheckSeries }), {
      series: MD_MANGA,
      extension: "mangaplus",
      confirm: true,
    });

    expect(recheckSeries).toHaveBeenCalledWith("discord:ardax", {
      mdMangaId: MD_MANGA,
      extension: "mangaplus",
      apply: true,
      idempotencyKey: "discord:interaction-1",
    });
    expect(reply.text).toContain("run-1");
    expect(reply.text).toContain("/runs show id:run-1");
  });

  it("warns when the extension publishes no catalogue listing to compare against", async () => {
    const recheckSeries = vi.fn().mockResolvedValue(report({ publishesCatalogue: false }));
    const reply = await invoke("recheck", fakeApi({ recheckSeries }), { series: MD_MANGA });
    expect(reply.text).toContain("full catalogue listing");
    expect(reply.text).toContain("probably find nothing");
  });

  it("says how to name a series rather than 404ing on typed text", async () => {
    const recheckSeries = vi.fn();
    const reply = await invoke("recheck", fakeApi({ recheckSeries }), { series: "sakamoto days" });
    expect(recheckSeries).not.toHaveBeenCalled();
    expect(reply.text).toContain("not a MangaDex title id");
  });

  it("is gated as a mutation; it queues real changes to public pages", () => {
    expect(resolveSensitivity(COMMANDS_BY_NAME.get("recheck")!, null)).toBe("mutate");
  });
});
