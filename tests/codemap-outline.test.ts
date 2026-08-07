import { describe, expect, it } from "vitest";
import { runOutline } from "../src/codemap/outline.js";

describe("runOutline", () => {
  it("parses ast-grep outline JSON into typed entries with 1-indexed lines", () => {
    const files = runOutline(["src/agents/turn-budget.ts"]);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.path).toBe("src/agents/turn-budget.ts");
    const finding = file.items.find((i) => i.name === "AgentTurnBudget");
    expect(finding).toBeDefined();
    expect(finding!.symbolType).toBe("interface");
    expect(finding!.members).toHaveLength(2);
    expect(finding!.members.map((m) => m.name).sort()).toEqual(["graceTurns", "maxTurns"]);
    // Line conversion: the first symbol is at line 1 (0-indexed line 0 in JSON -> 1-indexed)
    expect(finding!.range.line).toBe(1);
  });

  it("returns an empty array when the binary is absent", () => {
    const files = runOutline(["src/agents/turn-budget.ts"], { binary: "/nonexistent/binary" });
    expect(files).toEqual([]);
  });
});
