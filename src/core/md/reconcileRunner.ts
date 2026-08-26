import type { PrismaClient } from "@prisma/client";
import type { Logger } from "../../logging.js";
import type { AuditLog, SettingsStore } from "../store/settings.js";
import type { MdExtendedApi } from "./client.js";
import {
  ChapterReconciler,
  type ReconcileOptions,
  type ReconcileProgress,
  type ReconcileReport,
} from "./chapterReconcile.js";

/**
 * Run a reconcile pass in the background and let callers poll it.
 *
 * WHY THIS EXISTS. A pass is minutes long and almost all of it is one thing:
 * `chapterAvailabilityForGroup` paginates the group twice at the MangaDex
 * client's rate limit, which on the live group is ~124 requests and about four
 * minutes. Served as a synchronous HTTP request that is a request nobody
 * receives the end of -- the tunnel in front of this API gives up long before,
 * and the browser reports it as a plain failure with no way to tell "still
 * working" from "broken". The re-card sweep already learned this and solved it
 * by paging from the client (see the note above `runApply` in dashboard/app.js);
 * a group walk cannot be paged that way, because the pagination is MangaDex's
 * and the caller has nothing to resume from.
 *
 * So the request starts the work and returns, and the state lives in the
 * `settings` table where anything can read it: the dashboard polls it, the CLI
 * polls it, and a run survives the client that asked for it going away. That
 * last part is the real prize -- an operator closing the tab used to abandon
 * four minutes of MangaDex calls, and the next click started them again.
 *
 * ONE AT A TIME, and not for tidiness. Two passes racing would both walk the
 * same group -- doubling the slowest thing here -- and would then both decide
 * what to adopt from separately-taken snapshots. The writes themselves are safe
 * (insert-only, unique on `md_chapter_id`), so the damage is wasted minutes and
 * a report that describes neither run.
 *
 * A run that dies with the process would otherwise hold the lock forever, so
 * the lock expires: a `running` state whose progress has not moved in
 * `STALE_AFTER_MS` is treated as abandoned. That is a heartbeat rather than a
 * timeout -- progress is written on every page, so a live run refreshes it far
 * more often than the window, and only a dead one falls behind.
 */

const STATE_KEY = "chapters_reconcile_state";


/**
 * How long a `running` state may go without moving before a new run may
 * replace it.
 *
 * Comfortably longer than the gap between two progress writes (one MangaDex
 * page, i.e. `mdRatelimitMs`, plus whatever a retried request costs) and far
 * shorter than a pass, so a crashed run does not lock the button out for the
 * rest of the day.
 */
const STALE_AFTER_MS = 5 * 60 * 1000;

/** What was asked for, echoed back so a poller can describe the run it found. */
export interface ReconcileRunOptions {
  dryRun: boolean;
  extensions: string[];
  skipDeleted: boolean;
  skipAdopt: boolean;
  skipUnavailable: boolean;
}

export type ReconcileRunState =
  | { state: "idle" }
  | {
      state: "running";
      startedAt: string;
      /** Last time progress moved; how staleness is judged. */
      beatAt: string;
      actor: string;
      options: ReconcileRunOptions;
      progress: ReconcileProgress;
    }
  | {
      state: "done";
      startedAt: string;
      finishedAt: string;
      actor: string;
      options: ReconcileRunOptions;
      report: ReconcileReport;
    }
  | {
      state: "failed";
      startedAt: string;
      finishedAt: string;
      actor: string;
      options: ReconcileRunOptions;
      error: string;
      /** The steps as they stood when it died; absent for an abandoned run. */
      progress?: ReconcileProgress;
    };

export interface ReconcileRunnerDeps {
  prisma: PrismaClient;
  md: MdExtendedApi;
  log: Logger;
  audit: AuditLog;
  settings: SettingsStore;
}

export class ReconcileRunner {
  constructor(private readonly deps: ReconcileRunnerDeps) {}

  /** The last known state, or idle when nothing has ever run. */
  async status(): Promise<ReconcileRunState> {
    const raw = await this.deps.settings.getSetting(STATE_KEY);
    if (raw === null) return { state: "idle" };
    let parsed: ReconcileRunState;
    try {
      parsed = JSON.parse(raw) as ReconcileRunState;
    } catch {
      // A row we cannot read is not a run in progress, and refusing to start
      // because of it would be the worst of both.
      this.deps.log.warn("reconcile state is not readable json; treating as idle");
      return { state: "idle" };
    }
    if (parsed.state === "running" && this.isStale(parsed)) {
      return {
        state: "failed",
        startedAt: parsed.startedAt,
        finishedAt: parsed.beatAt,
        actor: parsed.actor,
        options: parsed.options,
        error: "the run stopped reporting progress; it was most likely interrupted by a restart",
        // Its last known steps, which say how far it got before it died.
        progress: parsed.progress,
      };
    }
    return parsed;
  }

  private isStale(run: { beatAt: string }): boolean {
    const beat = Date.parse(run.beatAt);
    return !Number.isFinite(beat) || Date.now() - beat > STALE_AFTER_MS;
  }

  /**
   * Start a pass, unless one is already going.
   *
   * Returns the state a poller should now watch: the new run, or the one
   * already in flight. Never throws for "busy" -- a second click on a slow
   * button is the most ordinary thing an operator does, and an error there
   * reads as a fault when the honest answer is "it is already doing that".
   */
  async start(
    options: ReconcileRunOptions,
    actor: string,
  ): Promise<{ started: boolean; status: ReconcileRunState }> {
    const current = await this.status();
    if (current.state === "running") return { started: false, status: current };

    const startedAt = new Date().toISOString();
    const progress: ReconcileProgress = { steps: [] };
    const running: ReconcileRunState = {
      state: "running",
      startedAt,
      beatAt: startedAt,
      actor,
      options,
      progress,
    };
    await this.write(running);

    // Deliberately not awaited: the caller is an HTTP request that must answer
    // now. Errors are caught inside `execute`, so nothing here can reject.
    void this.execute(options, actor, startedAt);
    return { started: true, status: running };
  }

  private async execute(
    options: ReconcileRunOptions,
    actor: string,
    startedAt: string,
  ): Promise<void> {
    // Progress writes are throttled, and the phases are why: the walk reports
    // once per MangaDex page (seconds apart, worth writing every time), while
    // adoption reports per batch and could otherwise write hundreds of rows in
    // a second for a number nobody can read that fast.
    let lastWrite = 0;
    /**
     * The step states as of the last write, so a step starting or finishing can
     * skip the throttle. Counts move constantly and can wait; a row ticking
     * over is the event an operator is watching for, and delaying those is what
     * makes a queue look stuck one row from the end. Per execution, never
     * module-level: two runs sharing it would each suppress the other's events.
     */
    let lastStates = "";
    const changedState = (progress: ReconcileProgress): boolean => {
      const signature = progress.steps.map((step) => `${step.id}:${step.state}`).join(",");
      const changed = signature !== lastStates;
      lastStates = signature;
      return changed;
    };
    const beat = (progress: ReconcileProgress, force = false): void => {
      const now = Date.now();
      if (!force && now - lastWrite < 500) return;
      lastWrite = now;
      void this.write({
        state: "running",
        startedAt,
        beatAt: new Date(now).toISOString(),
        actor,
        options,
        progress,
      }).catch((error: unknown) => {
        // A lost progress write is cosmetic; losing the run over it is not.
        this.deps.log.warn({ error }, "could not write reconcile progress");
      });
    };

    const reconcilerOptions: ReconcileOptions = { ...options, actor };
    const reconciler = new ChapterReconciler({
      prisma: this.deps.prisma,
      md: this.deps.md,
      log: this.deps.log,
      audit: this.deps.audit,
      // Forced whenever a step changes state rather than merely advances: a
      // step ticking over is the one update nobody should have to wait out the
      // throttle to see, and there are only ever a handful of them.
      onProgress: (progress) => beat(progress, changedState(progress)),
    });

    try {
      const report = await reconciler.run(reconcilerOptions);

      await this.write({
        state: "done",
        startedAt,
        finishedAt: new Date().toISOString(),
        actor,
        options,
        report,
      });
      this.deps.log.info(
        { adopted: report.adoptedRecorded, unavailable: report.unavailableRecorded },
        "reconcile finished",
      );
    } catch (error) {
      // The run is over either way; what must not happen is the state staying
      // `running` forever, because that locks out every later attempt until the
      // stale window passes.
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.error({ error }, "reconcile failed");
      await this.write({
        state: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        actor,
        options,
        error: message,
        // The steps as they stood, so the card can show WHICH one died rather
        // than replacing the whole queue with one error line.
        progress: { steps: reconciler.steps() },
      }).catch((writeError: unknown) => {
        this.deps.log.error({ error: writeError }, "could not record the reconcile failure");
      });
    }
  }

  private async write(state: ReconcileRunState): Promise<void> {
    await this.deps.settings.setSetting(STATE_KEY, JSON.stringify(state));
  }
}
