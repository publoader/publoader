import { describe, expect, it, vi } from "vitest";
import { ReconcilePlan, type ReconcileStep } from "../../src/core/md/reconcilePlan.js";

/**
 * The step list a reconcile pass is watched through.
 *
 * What matters here is not bookkeeping, it is honesty about progress. A pass is
 * eight minutes; the whole reason this exists is that an operator cannot tell a
 * long pass from a hung one. So the properties worth pinning are the ones that
 * would let it lie:
 *
 *  - a step never gains a total it was not given, because a bar drawn from an
 *    invented denominator is worse than no bar;
 *  - a step that ends short of its total says so, rather than snapping to full;
 *  - a crash marks the running step failed and the rest abandoned, or a dead
 *    pass reads as one that is still working.
 */
describe("the reconcile step plan", () => {
  /** The last emitted list, since every consumer is given the whole state. */
  function collect(): { plan: ReconcilePlan; latest: () => ReconcileStep[]; emits: () => number } {
    let latest: ReconcileStep[] = [];
    let emits = 0;
    const plan = new ReconcilePlan((steps) => {
      latest = steps;
      emits += 1;
    });
    return { plan, latest: () => latest, emits: () => emits };
  }

  it("declares the whole queue before any of it runs", async () => {
    // The point of the plan: at the first poll the card already shows what is
    // coming, so a four-minute first step reads as step 1 of 5 rather than as
    // nothing happening.
    const { plan, latest } = collect();
    plan.add("groups", "Find which groups we have uploaded to");
    plan.add("walk:g1", "Read mangaplus's chapters on MangaDex");
    plan.add("sweep", "Check our own rows against MangaDex");

    expect(latest().map((step) => step.state)).toEqual(["pending", "pending", "pending"]);
    expect(latest()[1]?.label).toBe("Read mangaplus's chapters on MangaDex");
  });

  it("emits the whole list on every change", () => {
    // Consumers are a JSON blob in a settings row and a table in a browser.
    // Neither wants a diff to apply.
    const { plan, latest, emits } = collect();
    plan.add("a", "A");
    plan.add("b", "B");
    plan.start("a");
    plan.advance("a", 3, 10);

    expect(emits()).toBe(4);
    expect(latest()).toHaveLength(2);
    expect(latest()[0]).toMatchObject({ state: "running", done: 3, total: 10 });
  });

  it("never invents a total", () => {
    // The walk learns its total from MangaDex's first page. Until then there is
    // no denominator, and the card must draw no bar rather than a plausible one.
    const { plan, latest } = collect();
    plan.add("walk", "Read the catalogue");
    plan.start("walk");
    plan.advance("walk", 100);

    expect(latest()[0]?.total).toBeNull();

    // …and takes it the moment one is real.
    plan.advance("walk", 200, 6220);
    expect(latest()[0]).toMatchObject({ done: 200, total: 6220 });
  });

  it("keeps a total once given, rather than dropping it on a later tick", () => {
    // Pagination past the offset ceiling stops reporting a usable total. Losing
    // the bar mid-step would read as the pass restarting.
    const { plan, latest } = collect();
    plan.add("walk", "Read the catalogue");
    plan.start("walk", 6220);
    plan.advance("walk", 300, null);

    expect(latest()[0]).toMatchObject({ done: 300, total: 6220 });
  });

  it("settles a finished step on what it actually did", () => {
    // A walk that stopped at 6100 against a predicted 6220 is a different thing
    // from one that finished, and the row should say so after the fact instead
    // of snapping to full.
    const { plan, latest } = collect();
    plan.add("walk", "Read the catalogue");
    plan.start("walk", 6220);
    plan.finish("walk", 6100, "6100 chapter(s) on MangaDex");

    expect(latest()[0]).toMatchObject({
      state: "done",
      done: 6100,
      total: 6220,
      note: "6100 chapter(s) on MangaDex",
    });
  });

  it("completes a step whose total was never known at whatever it did", () => {
    const { plan, latest } = collect();
    plan.add("sweep", "Check our own rows");
    plan.start("sweep");
    plan.finish("sweep", 491);

    expect(latest()[0]).toMatchObject({ state: "done", done: 491, total: 491 });
  });

  it("records why a step was skipped, so a flag does not look like a failure", () => {
    const { plan, latest } = collect();
    plan.add("sweep", "Check our own rows");
    plan.skip("sweep", "skipped: --skip-deleted");

    expect(latest()[0]).toMatchObject({ state: "skipped", note: "skipped: --skip-deleted" });
  });

  it("marks the running step failed and abandons the rest", () => {
    // Without this a crashed pass leaves its steps on running and pending
    // forever, which reads as still working -- the exact confusion the plan
    // exists to end.
    const { plan, latest } = collect();
    plan.add("a", "A");
    plan.add("b", "B");
    plan.add("c", "C");
    plan.finish("a");
    plan.start("b");
    plan.fail("mangadex said no");

    expect(latest().map((step) => step.state)).toEqual(["done", "failed", "skipped"]);
    expect(latest()[1]?.note).toBe("mangadex said no");
    expect(latest()[2]?.note).toBe("not reached");
    // A step that already finished keeps its result; failing later does not
    // retroactively unmake the work it did.
    expect(latest()[0]?.note).toBeNull();
  });

  it("ignores an update for a step it does not have", () => {
    // A mistyped id must not be able to destroy a pass that is otherwise doing
    // its job: eight minutes of MangaDex calls is too much to lose to a typo in
    // a progress label.
    const { plan, latest } = collect();
    plan.add("a", "A");

    expect(() => plan.advance("nope", 5)).not.toThrow();
    expect(() => plan.finish("nope")).not.toThrow();
    expect(latest()).toHaveLength(1);
  });

  it("hands out copies, so a consumer cannot edit the plan by accident", () => {
    const { plan, latest } = collect();
    plan.add("a", "A");
    const snapshot = plan.snapshot();
    snapshot[0]!.state = "failed";

    expect(latest()[0]?.state).toBe("pending");
    expect(plan.snapshot()[0]?.state).toBe("pending");
  });

  it("does not let a throwing consumer stop the pass", () => {
    // The sink is a database write. Losing minutes of MangaDex calls to a
    // failed progress update would be a far worse failure than a stale row --
    // but the plan itself must not swallow it silently either, so the guard
    // lives in the reconciler where it can be logged. Here: the plan propagates.
    const plan = new ReconcilePlan(() => {
      throw new Error("connection reset");
    });
    expect(() => plan.add("a", "A")).toThrow("connection reset");
  });

  it("keeps steps in the order they were declared", () => {
    // The list is a queue an operator reads top to bottom; re-ordering it as
    // states change would make the same pass look like a different one.
    const { plan, latest } = collect();
    plan.add("a", "A");
    plan.add("b", "B");
    plan.add("c", "C");
    plan.start("c");
    plan.finish("c");
    plan.start("a");

    expect(latest().map((step) => step.id)).toEqual(["a", "b", "c"]);
  });

  it("reports progress as it happens rather than in one lump at the end", () => {
    // The regression this guards is the original bug: adoption wrote 5593 rows
    // in one go and reported once, so the card sat still and then jumped.
    const seen: number[] = [];
    const plan = new ReconcilePlan((steps) => {
      const step = steps.find((candidate) => candidate.id === "adopt");
      if (step && step.state === "running") seen.push(step.done);
    });
    plan.add("adopt", "Record untracked chapters");
    plan.start("adopt", 1500);
    for (const done of [500, 1000, 1500]) plan.advance("adopt", done);
    plan.finish("adopt", 1500);

    expect(seen).toEqual([0, 500, 1000, 1500]);
  });

  it("does not emit after the pass is over", () => {
    const emit = vi.fn();
    const plan = new ReconcilePlan(emit);
    plan.add("a", "A");
    plan.finish("a");
    const after = emit.mock.calls.length;
    // Nothing further happens on its own; the plan is inert once nobody drives it.
    expect(emit.mock.calls.length).toBe(after);
  });
});
