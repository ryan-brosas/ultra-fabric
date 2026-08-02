import { describe, expect, it } from "vitest";
import {
  appendAgentTurnBudgetPrompt,
  agentTurnBudgetDecision,
  resolveAgentTurnBudget,
} from "../src/agents/turn-budget.js";

describe("Agent turn budgets", () => {
  it("validates a soft limit with bounded grace", () => {
    expect(resolveAgentTurnBudget({ maxTurns: 6 })).toEqual({ maxTurns: 6, graceTurns: 1 });
    expect(() => resolveAgentTurnBudget({ maxTurns: 0 })).toThrow("maxTurns");
    expect(() => resolveAgentTurnBudget({ maxTurns: 3, graceTurns: -1 })).toThrow("graceTurns");
    expect(() => resolveAgentTurnBudget({ maxTurns: 3, extra: true })).toThrow("extra");
  });

  it("requests wrap-up before enforcing the hard boundary", () => {
    const budget = { maxTurns: 3, graceTurns: 1 };
    expect(agentTurnBudgetDecision(budget, 2)).toBe("continue");
    expect(agentTurnBudgetDecision(budget, 3)).toBe("wrap-up");
    expect(agentTurnBudgetDecision(budget, 4)).toBe("stop");
  });

  it("places the bounded stop contract in the system prompt", () => {
    const prompt = appendAgentTurnBudgetPrompt("Role instructions", { maxTurns: 4, graceTurns: 1 });
    expect(prompt).toContain("soft limit of 4 assistant turns");
    expect(prompt).toContain("one final wrap-up turn");
    expect(prompt).toContain("must stop");
  });
});
