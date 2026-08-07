import { describe, expect, it } from "vitest";
import { runOutline, chunkPaths } from "../src/codemap/outline.js";

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

describe("chunkPaths", () => {
  it("packs chunks under the character budget", () => {
    const files = Array.from({ length: 40 }, (_, i) => "src/mod" + i + "/deep/file-" + i + ".ts");
    const chunks = chunkPaths(files, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const chars = chunk.join(" ").length;
      expect(chars).toBeLessThanOrEqual(200);
    }
  });

  it("preserves global order across chunks", () => {
    const files = Array.from({ length: 50 }, (_, i) => "src/a".repeat(30) + "/f" + i + ".ts");
    const flat = chunkPaths(files, 1000).flat();
    expect(flat).toEqual(files);
  });

  it("keeps an oversized single path in its own chunk", () => {
    const long = "src/" + "x".repeat(5000) + ".ts";
    const chunks = chunkPaths([long, "src/a.ts"], 1000);
    expect(chunks).toEqual([[long], ["src/a.ts"]]);
  });

  it("returns one chunk when everything fits", () => {
    expect(chunkPaths(["src/a.ts", "src/b.ts"], 1000)).toEqual([["src/a.ts", "src/b.ts"]]);
  });

  it("handles an empty file list", () => {
    expect(chunkPaths([], 1000)).toEqual([]);
  });
});
