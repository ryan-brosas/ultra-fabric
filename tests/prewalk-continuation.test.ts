import { describe, expect, it, vi } from "vitest";
import {
  PREWALK_ARMED_MESSAGE_TYPE,
  PREWALK_CONTINUE_MESSAGE_TYPE,
  PREWALK_PLAN_MESSAGE_TYPE,
  filterPrewalkContinuationMessages,
  filterPrewalkPlanningMessages,
} from "../src/prewalk/continuation.js";

interface TestMessage {
  role: string;
  customType?: string;
  details?: unknown;
  content: string;
}

const continuation = (
  continuationId: string | undefined,
  content: string,
): TestMessage => ({
  role: "custom",
  customType: PREWALK_CONTINUE_MESSAGE_TYPE,
  ...(continuationId === undefined ? {} : { details: { continuationId } }),
  content,
});

describe("filterPrewalkContinuationMessages", () => {
  it("returns the original context when it contains no Prewalk continuation", () => {
    const messages: TestMessage[] = [{ role: "user", content: "hello" }];
    const accept = vi.fn(() => true);

    const result = filterPrewalkContinuationMessages(messages, accept);

    expect(result).toEqual({ messages, changed: false });
    expect(result.messages).toBe(messages);
    expect(accept).not.toHaveBeenCalled();
  });

  it("keeps only the continuation accepted by the current lifecycle", () => {
    const ordinary: TestMessage = { role: "user", content: "new task" };
    const active = continuation("handoff-current", "continue current task");
    const messages = [
      continuation(undefined, "legacy continuation"),
      continuation("handoff-stale", "continue stale task"),
      ordinary,
      active,
    ];
    const accept = vi.fn((handoffId: string) => handoffId === "handoff-current");

    const result = filterPrewalkContinuationMessages(messages, accept);

    expect(result).toEqual({ messages: [ordinary, active], changed: true });
    expect(accept.mock.calls).toEqual([["handoff-stale"], ["handoff-current"]]);
  });
});

describe("filterPrewalkPlanningMessages", () => {
  const planning: TestMessage = {
    role: "custom",
    customType: PREWALK_PLAN_MESSAGE_TYPE,
    content: "research planning instruction",
  };
  const armed: TestMessage = {
    role: "custom",
    customType: PREWALK_ARMED_MESSAGE_TYPE,
    content: "prewalk armed instruction",
  };
  const ordinary: TestMessage = { role: "user", content: "continue" };

  it("keeps the instructions only while the planner owns the phase", () => {
    const visible = filterPrewalkPlanningMessages(
      [planning, armed, ordinary],
      true,
    );
    expect(visible).toEqual({
      messages: [planning, armed, ordinary],
      changed: false,
    });
    expect(visible.messages[0]).toBe(planning);

    expect(
      filterPrewalkPlanningMessages([planning, armed, ordinary], false),
    ).toEqual({
      messages: [ordinary],
      changed: true,
    });
  });
});
