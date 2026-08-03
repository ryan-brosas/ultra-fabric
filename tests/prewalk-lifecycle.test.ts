import { describe, expect, it } from "vitest";
import {
  reducePrewalkLifecycle,
  type FabricPrewalkArm,
  type FabricPrewalkArmedStatus,
  type FabricPrewalkHandoffStatus,
  type FabricPrewalkStatus,
} from "../src/prewalk/lifecycle.js";

const arm = (overrides: Partial<FabricPrewalkArm> = {}): FabricPrewalkArm => ({
  mode: "in-place",
  model: "anthropic/executor",
  sessionId: "session-1",
  armedAt: 10,
  alwaysRearm: false,
  returnPolicy: "executor",
  task: "Implement the guard",
  ...overrides,
});

const armed = (
  overrides: Partial<FabricPrewalkArmedStatus> = {},
): FabricPrewalkArmedStatus => ({
  state: "armed",
  ...arm(),
  attempt: 0,
  ...overrides,
});

const handingOff = (
  overrides: Partial<FabricPrewalkHandoffStatus> = {},
): FabricPrewalkHandoffStatus => ({
  ...armed(),
  state: "handing_off",
  attempt: 1,
  handoffId: "handoff-1",
  ...overrides,
});

describe("reducePrewalkLifecycle", () => {
  it("arms a task with a fresh attempt counter", () => {
    expect(
      reducePrewalkLifecycle(
        { state: "idle" },
        { kind: "armed", arm: arm() },
      ),
    ).toEqual(armed());
  });

  it("claims only an armed task from the matching session", () => {
    const state = armed();
    expect(
      reducePrewalkLifecycle(state, {
        kind: "handoff_claimed",
        sessionId: "session-1",
        handoffId: "handoff-1",
      }),
    ).toEqual(handingOff());
    expect(
      reducePrewalkLifecycle(state, {
        kind: "handoff_claimed",
        sessionId: "session-2",
        handoffId: "handoff-1",
      }),
    ).toBe(state);
  });

  it("blocks a failed handoff with its task and attempt intact", () => {
    expect(
      reducePrewalkLifecycle(handingOff(), {
        kind: "handoff_failed",
        at: 20,
        error: "provider unavailable",
      }),
    ).toEqual({
      ...handingOff(),
      state: "blocked",
      blockedAt: 20,
      error: "provider unavailable",
    });
  });

  it("retries a blocked task only in its owning session", () => {
    const state: FabricPrewalkStatus = {
      ...handingOff(),
      state: "blocked",
      blockedAt: 20,
      error: "provider unavailable",
    };
    expect(
      reducePrewalkLifecycle(state, {
        kind: "retry_requested",
        sessionId: "session-2",
        at: 30,
      }),
    ).toBe(state);
    expect(
      reducePrewalkLifecycle(state, {
        kind: "retry_requested",
        sessionId: "session-1",
        at: 30,
      }),
    ).toEqual({
      ...armed(),
      armedAt: 30,
      attempt: 1,
    });
  });

  it("settles a one-shot task only after its matching continuation runs", () => {
    const pending = reducePrewalkLifecycle(handingOff(), {
      kind: "handoff_succeeded",
      at: 20,
      handoffId: "handoff-1",
    });
    expect(pending).toMatchObject({
      state: "continuation_pending",
      handoffId: "handoff-1",
      task: "Implement the guard",
    });

    const stale = reducePrewalkLifecycle(pending, {
      kind: "continuation_accepted",
      sessionId: "session-1",
      handoffId: "stale-handoff",
    });
    expect(stale).toBe(pending);

    const continuing = reducePrewalkLifecycle(pending, {
      kind: "continuation_accepted",
      sessionId: "session-1",
      handoffId: "handoff-1",
    });
    expect(continuing).toMatchObject({ state: "continuing", handoffId: "handoff-1" });
    expect(
      reducePrewalkLifecycle(continuing, {
        kind: "continuation_settled",
        sessionId: "session-1",
        at: 30,
      }),
    ).toEqual({ state: "idle" });

    const state = armed();
    expect(
      reducePrewalkLifecycle(state, {
        kind: "handoff_succeeded",
        at: 20,
        handoffId: "handoff-1",
      }),
    ).toBe(state);
  });

  it("re-arms a continuous controller only after continuation settlement", () => {
    const pending = reducePrewalkLifecycle(handingOff({ alwaysRearm: true }), {
      kind: "handoff_succeeded",
      at: 20,
      handoffId: "handoff-1",
    });
    const continuing = reducePrewalkLifecycle(pending, {
      kind: "continuation_accepted",
      sessionId: "session-1",
      handoffId: "handoff-1",
    });
    expect(
      reducePrewalkLifecycle(continuing, {
        kind: "continuation_settled",
        sessionId: "session-1",
        at: 30,
      }),
    ).toEqual({
      state: "armed",
      mode: "in-place",
      model: "anthropic/executor",
      sessionId: "session-1",
      armedAt: 30,
      alwaysRearm: true,
      returnPolicy: "executor",
      attempt: 0,
    });
  });

  it("routes gated verification through one bounded revision", () => {
    const gated = arm({
      verificationMode: "gated",
      maxPhaseRevisions: 1,
    } as Partial<FabricPrewalkArm>);
    const executing = reducePrewalkLifecycle(
      { state: "idle" },
      { kind: "armed", arm: gated },
    );
    const claimed = reducePrewalkLifecycle(executing, {
      kind: "handoff_claimed",
      sessionId: "session-1",
      handoffId: "execute-1",
    });
    const pending = reducePrewalkLifecycle(claimed, {
      kind: "handoff_succeeded",
      at: 20,
      handoffId: "execute-1",
    });
    expect(pending).toMatchObject({
      state: "verification_pending",
      revision: 0,
      handoffId: "execute-1",
    });
    const verifying = reducePrewalkLifecycle(pending, {
      kind: "continuation_accepted",
      sessionId: "session-1",
      handoffId: "execute-1",
    });
    const revision = reducePrewalkLifecycle(verifying, {
      kind: "verification_revision",
      sessionId: "session-1",
      at: 30,
      gate: "acceptance",
      feedback: "test failed",
    } as never);
    expect(revision).toMatchObject({
      state: "armed",
      revision: 1,
      revisionGate: "acceptance",
      revisionFeedback: "test failed",
      task: "Implement the guard",
    });
  });

  it("settles gated verification only after a passing evidence gate", () => {
    const gated = arm({
      verificationMode: "gated",
      maxPhaseRevisions: 2,
    } as Partial<FabricPrewalkArm>);
    const claimed = reducePrewalkLifecycle(
      reducePrewalkLifecycle({ state: "idle" }, { kind: "armed", arm: gated }),
      { kind: "handoff_claimed", sessionId: "session-1", handoffId: "execute-1" },
    );
    const pending = reducePrewalkLifecycle(claimed, {
      kind: "handoff_succeeded",
      at: 20,
      handoffId: "execute-1",
    });
    const verifying = reducePrewalkLifecycle(pending, {
      kind: "continuation_accepted",
      sessionId: "session-1",
      handoffId: "execute-1",
    });
    expect(reducePrewalkLifecycle(verifying, {
      kind: "continuation_settled",
      sessionId: "session-1",
      at: 30,
    })).toMatchObject({
      state: "blocked",
      error: "Prewalk verification settled without acceptance evidence",
    });

    const passed = reducePrewalkLifecycle(verifying, {
      kind: "verification_passed",
      sessionId: "session-1",
      gate: "acceptance",
    } as never);
    expect(passed).toMatchObject({
      state: "continuing",
      verificationGate: "acceptance",
    });
    expect(reducePrewalkLifecycle(passed, {
      kind: "continuation_settled",
      sessionId: "session-1",
      at: 31,
    })).toEqual({ state: "idle" });
  });

  it("blocks gated verification after its revision cap", () => {
    const state = {
      ...handingOff({
        verificationMode: "gated",
        maxPhaseRevisions: 1,
      } as Partial<FabricPrewalkHandoffStatus>),
      state: "verifying",
      revision: 1,
    } as FabricPrewalkStatus;
    expect(reducePrewalkLifecycle(state, {
      kind: "verification_revision",
      sessionId: "session-1",
      at: 40,
      gate: "acceptance",
      feedback: "still failing",
    } as never)).toMatchObject({
      state: "blocked",
      error: "Prewalk verification revision limit exhausted (1)",
      task: "Implement the guard",
    });
  });

  it("keeps an unfired one-shot arm armed when its task settles", () => {
    const taskless = armed();
    delete taskless.task;
    expect(
      reducePrewalkLifecycle(taskless, {
        kind: "task_settled",
        sessionId: "session-1",
        at: 20,
      }),
    ).toBe(taskless);
    const pending = armed();
    expect(
      reducePrewalkLifecycle(pending, {
        kind: "task_settled",
        sessionId: "session-1",
        at: 20,
      }),
    ).toBe(pending);
  });

  it("clears the settled task so a re-arming prewalk rebinds the next one", () => {
    const next = reducePrewalkLifecycle(armed({ alwaysRearm: true }), {
      kind: "task_settled",
      sessionId: "session-1",
      at: 20,
    });
    expect(next).toMatchObject({
      state: "armed",
      alwaysRearm: true,
      armedAt: 20,
      attempt: 0,
    });
    expect(next).not.toHaveProperty("task");
  });

  it("records checklist readiness for any armed mode, not only research", () => {
    const state = armed({ mode: "research" });
    const checklist = {
      items: Array.from({ length: 5 }, (_, index) => ({
        task: `Change target ${index + 1}`,
        validation: `Run check ${index + 1}`,
      })),
      readyAt: 15,
    };
    expect(reducePrewalkLifecycle(state, {
      kind: "checklist_ready",
      sessionId: "session-2",
      checklist,
    })).toBe(state);
    expect(reducePrewalkLifecycle(state, {
      kind: "checklist_ready",
      sessionId: "session-1",
      checklist,
    })).toEqual({ ...state, checklist });
    // An in-place (default-mode) arm records the checklist the same way.
    const inPlace = armed();
    expect(reducePrewalkLifecycle(inPlace, {
      kind: "checklist_ready",
      sessionId: "session-1",
      checklist,
    })).toEqual({ ...inPlace, checklist });
  });
});
