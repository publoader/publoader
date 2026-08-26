/**
 * A reconcile pass as a list of steps, so it can be watched rather than waited
 * out.
 *
 * WHY. A pass is one long call that ends, minutes later, in a report. Behind a
 * single progress line that is barely better than a spinner: the line changes,
 * but nothing says how much work there is, how much of it is done, or what is
 * still coming. On the live deployment that is eight minutes of a button
 * looking broken, and the honest question -- "is this doing anything?" -- has
 * no answer on the screen.
 *
 * So the pass declares its work up front and ticks through it. Each step is a
 * real unit an operator recognises ("read mangaplus's chapters on MangaDex",
 * "record 5593 untracked chapters"), carries its own count, and moves through
 * pending -> running -> done where anyone can see it. What was one opaque wait
 * becomes a queue draining.
 *
 * The plan is built as it becomes knowable, not guessed. Which groups exist is
 * a database query, and how many chapters each has is MangaDex's answer to the
 * first page of the walk, so steps appear with `total: null` and gain their
 * total the moment there is a real one. Nothing here ever invents a
 * denominator: a bar that lies about how far along it is would be worse than
 * the spinner it replaced.
 */

export type StepState = "pending" | "running" | "done" | "skipped" | "failed";

export interface ReconcileStep {
  /** Stable within a pass; how an update finds the step it belongs to. */
  id: string;
  label: string;
  state: StepState;
  /** Units finished. Meaningless until `state` is running or later. */
  done: number;
  /** Units in total, or null while genuinely unknown. Never a guess. */
  total: number | null;
  /** Extra context for the row: the id rule found, why a step was skipped. */
  note: string | null;
}

/**
 * The steps of one pass, and the only thing that mutates them.
 *
 * Every change calls `emit` with a fresh copy of the whole list, because the
 * consumers are a JSON blob in a settings row and a table in a browser: both
 * want the state of the world, not a diff to apply.
 */
export class ReconcilePlan {
  private readonly steps: ReconcileStep[] = [];

  constructor(private readonly emit: (steps: ReconcileStep[]) => void) {}

  /** Declare a step. Returns its id so the caller need not repeat itself. */
  add(id: string, label: string): string {
    this.steps.push({ id, label, state: "pending", done: 0, total: null, note: null });
    this.publish();
    return id;
  }

  start(id: string, total: number | null = null): void {
    this.update(id, (step) => {
      step.state = "running";
      step.done = 0;
      if (total !== null) step.total = total;
    });
  }

  /**
   * Report progress within a step.
   *
   * `total` is accepted on every call rather than only at the start because the
   * walk learns it from MangaDex's first page, which arrives after the step is
   * already running.
   */
  advance(id: string, done: number, total?: number | null): void {
    this.update(id, (step) => {
      step.done = done;
      if (total !== undefined && total !== null) step.total = total;
    });
  }

  /**
   * Finish a step.
   *
   * The count settles to what actually happened, which is the number worth
   * keeping: a walk that ended at 6220 against a reported total of 6220 is a
   * different thing from one that stopped at 6100, and the row should say so
   * after the fact rather than snapping to full.
   */
  finish(id: string, done?: number, note?: string): void {
    this.update(id, (step) => {
      step.state = "done";
      if (done !== undefined) {
        step.done = done;
        // A step whose total was never known is complete at whatever it did.
        if (step.total === null) step.total = done;
      } else if (step.total !== null) {
        step.done = step.total;
      }
      if (note !== undefined) step.note = note;
    });
  }

  /** A step that was asked not to run, or had nothing to do. */
  skip(id: string, note: string): void {
    this.update(id, (step) => {
      step.state = "skipped";
      step.note = note;
    });
  }

  /**
   * Mark the running step failed, and everything after it abandoned.
   *
   * Without this a crashed pass leaves its steps on `running` and `pending`
   * forever, which reads as still working.
   */
  fail(note: string): void {
    for (const step of this.steps) {
      if (step.state === "running") {
        step.state = "failed";
        step.note = note;
      } else if (step.state === "pending") {
        step.state = "skipped";
        step.note = "not reached";
      }
    }
    this.publish();
  }

  /** Note something about a step without changing its state. */
  note(id: string, note: string): void {
    this.update(id, (step) => {
      step.note = note;
    });
  }

  snapshot(): ReconcileStep[] {
    return this.steps.map((step) => ({ ...step }));
  }

  private update(id: string, change: (step: ReconcileStep) => void): void {
    const step = this.steps.find((candidate) => candidate.id === id);
    // Silently ignored rather than thrown: a mistyped step id must not be able
    // to destroy a pass that is otherwise doing its job correctly.
    if (!step) return;
    change(step);
    this.publish();
  }

  private publish(): void {
    this.emit(this.snapshot());
  }
}
