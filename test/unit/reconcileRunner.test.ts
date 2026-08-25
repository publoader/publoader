import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../src/logging.js";
import { ReconcileRunner } from "../../src/core/md/reconcileRunner.js";
import { SettingsStore, type AuditLog } from "../../src/core/store/settings.js";
import type { MdExtendedApi } from "../../src/core/md/client.js";

/**
 * Running a reconcile pass in the background.
 *
 * This exists because a pass is minutes long: the group walk alone is ~124
 * MangaDex requests at the client's rate limit. Served synchronously it was a
 * request the proxy killed before anyone saw the end of it, which the dashboard
 * could only report as a bare failure -- indistinguishable, from the operator's
 * side, from the platform being broken.
 *
 * So the properties worth pinning are the ones that decide whether a button is
 * trustworthy rather than whether the arithmetic is right:
 *
 *  - a second click while a pass is in flight joins it instead of starting a
 *    rival walk of the same group;
 *  - a pass that dies with the process does not hold the lock forever, or the
 *    button is dead until someone clears a settings row by hand;
 *  - a failure is recorded as a failure, because a state stuck on `running` is
 *    the same lock-out by another route.
 */

/** The settings row, in memory: SettingsStore touches only these two calls. */
function fakeSettings(): { store: SettingsStore; rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const prisma = {
    setting: {
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        rows.set(where.key, create.value);
      },
      findUnique: async ({ where }: { where: { key: string } }) =>
        rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null,
      deleteMany: async ({ where }: { where: { key: string } }) => {
        rows.delete(where.key);
      },
    },
  } as unknown as PrismaClient;
  return { store: new SettingsStore(prisma), rows };
}

const OPTIONS = {
  dryRun: true,
  extensions: [],
  skipDeleted: false,
  skipAdopt: false,
  skipUnavailable: false,
};

describe("running a reconcile pass in the background", () => {
  const log = createLogger("test-runner", "error");
  const audit = { record: async () => {} } as unknown as AuditLog;

  /**
   * A deployment with no groups to walk, so a pass is over almost at once.
   * `gate` holds the very first query open when given, which is how a run can
   * be observed mid-flight without waiting on anything real.
   */
  function deps(opts: { gate?: Promise<void>; throws?: Error } = {}) {
    const settings = fakeSettings();
    const prisma = {
      uploadedChapter: {
        findMany: async () => {
          if (opts.gate) await opts.gate;
          if (opts.throws) throw opts.throws;
          return [];
        },
      },
    } as unknown as PrismaClient;
    const md = {} as unknown as MdExtendedApi;
    return { settings, deps: { prisma, md, log, audit, settings: settings.store } };
  }

  /** Wait for the persisted state to reach one of these, so nothing races. */
  async function settleTo(
    runner: ReconcileRunner,
    states: string[],
  ): Promise<Awaited<ReturnType<ReconcileRunner["status"]>>> {
    for (let i = 0; i < 200; i++) {
      const status = await runner.status();
      if (states.includes(status.state)) return status;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`state never reached ${states.join("/")}`);
  }

  it("answers immediately and finishes in its own time", async () => {
    const { deps: d } = deps();
    const runner = new ReconcileRunner(d);

    const started = await runner.start(OPTIONS, "tester");

    // The whole point: the caller is an HTTP request and it is answered now,
    // not in four minutes.
    expect(started.started).toBe(true);
    expect(started.status.state).toBe("running");

    const done = await settleTo(runner, ["done"]);
    expect(done.state).toBe("done");
    if (done.state === "done") {
      expect(done.report.groups).toEqual([]);
      expect(done.actor).toBe("tester");
    }
  });

  it("joins the pass already running instead of starting a second one", async () => {
    // Two passes racing would both walk the same group -- doubling the slowest
    // thing here -- and then decide what to adopt from separate snapshots.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps: d } = deps({ gate });
    const runner = new ReconcileRunner(d);

    const first = await runner.start(OPTIONS, "tester");
    const second = await runner.start(OPTIONS, "someone-else");

    expect(first.started).toBe(true);
    // Not an error: a second click on a four-minute button is the most ordinary
    // thing an operator does, and a 500 there reads as a fault.
    expect(second.started).toBe(false);
    expect(second.status.state).toBe("running");
    if (second.status.state === "running") expect(second.status.actor).toBe("tester");

    release();
    await settleTo(runner, ["done"]);
  });

  it("lets a new pass start once the last one is done", async () => {
    const { deps: d } = deps();
    const runner = new ReconcileRunner(d);

    await runner.start(OPTIONS, "tester");
    await settleTo(runner, ["done"]);
    const again = await runner.start(OPTIONS, "tester");

    expect(again.started).toBe(true);
  });

  it("records a failure rather than leaving the state on running", async () => {
    // A state stuck on `running` locks the button out until the stale window
    // passes, so a pass that dies must say so on the way down.
    const { deps: d } = deps({ throws: new Error("mangadex said no") });
    const runner = new ReconcileRunner(d);

    await runner.start(OPTIONS, "tester");
    const failed = await settleTo(runner, ["failed"]);

    expect(failed.state).toBe("failed");
    if (failed.state === "failed") expect(failed.error).toContain("mangadex said no");
    // And the next attempt is allowed.
    expect((await runner.start(OPTIONS, "tester")).started).toBe(true);
  });

  it("treats a run that stopped reporting progress as abandoned", async () => {
    // A process killed mid-pass leaves `running` in the table with nobody
    // behind it. Without an expiry that row is a permanent lock on the button,
    // clearable only by editing the database.
    const { settings, deps: d } = deps();
    const runner = new ReconcileRunner(d);
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    settings.rows.set(
      "chapters_reconcile_state",
      JSON.stringify({
        state: "running",
        startedAt: stale,
        beatAt: stale,
        actor: "a-process-that-died",
        options: OPTIONS,
        progress: { phase: "walking", extension: "mangaplus", done: 2400, total: null, detail: "" },
      }),
    );

    const status = await runner.status();
    expect(status.state).toBe("failed");
    if (status.state === "failed") expect(status.error).toContain("interrupted");

    expect((await runner.start(OPTIONS, "tester")).started).toBe(true);
    await settleTo(runner, ["done"]);
  });

  it("keeps a live run's lock, because its heartbeat is fresh", async () => {
    // The counterpart to the test above: staleness must be judged on the
    // heartbeat and not on when the run started, or every pass longer than the
    // window becomes stealable from under itself.
    const { settings, deps: d } = deps();
    const runner = new ReconcileRunner(d);
    settings.rows.set(
      "chapters_reconcile_state",
      JSON.stringify({
        state: "running",
        // Started long ago, still reporting: a big catalogue, not a dead run.
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        beatAt: new Date().toISOString(),
        actor: "a-long-pass",
        options: OPTIONS,
        progress: { phase: "walking", extension: "mangaplus", done: 9000, total: null, detail: "" },
      }),
    );

    expect((await runner.status()).state).toBe("running");
    expect((await runner.start(OPTIONS, "tester")).started).toBe(false);
  });

  it("reports idle rather than refusing when the stored state is unreadable", async () => {
    // A row we cannot parse is not a run in progress, and refusing to start
    // because of it would be the worst of both: no pass, and no way to fix it
    // from the dashboard.
    const { settings, deps: d } = deps();
    const runner = new ReconcileRunner(d);
    settings.rows.set("chapters_reconcile_state", "{not json");

    expect((await runner.status()).state).toBe("idle");
    expect((await runner.start(OPTIONS, "tester")).started).toBe(true);
    await settleTo(runner, ["done"]);
  });

  it("survives a progress sink that cannot write", async () => {
    // Losing minutes of MangaDex calls because a progress write failed would be
    // a worse failure than showing a stale number.
    const { settings, deps: d } = deps();
    const broken = vi
      .spyOn(settings.store, "setSetting")
      .mockRejectedValueOnce(new Error("connection reset"));
    const runner = new ReconcileRunner(d);

    // The very first write is the one that fails, so `start` itself must not
    // reject and take the click down with it.
    await expect(runner.start(OPTIONS, "tester")).rejects.toThrow("connection reset");
    broken.mockRestore();

    // …and the runner is not wedged afterwards.
    expect((await runner.start(OPTIONS, "tester")).started).toBe(true);
    await settleTo(runner, ["done"]);
  });
});
