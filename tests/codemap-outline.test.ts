import { describe, expect, it } from "vitest";
import { runOutline, findInterface, type OutlineFile, type OutlineRange } from "../src/codemap/outline.js";

describe("runOutline", () => {
  it("parses ast-grep outline JSON into typed entries with 1-indexed lines", () => {
    const files = runOutline(["src/lifecycle/review.ts"]);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.path).toBe("src/lifecycle/review.ts");
    const finding = file.items.find((i) => i.name === "ReviewFinding");
    expect(finding).toBeDefined();
    expect(finding!.symbolType).toBe("interface");
    expect(finding!.members).toHaveLength(4);
    expect(finding!.members.map((m) => m.name).sort()).toEqual(["claim", "line", "path", "severity"]);
    // Line conversion: the first symbol is at line 1 (0-indexed line 0 in JSON -> 1-indexed)
    expect(finding!.range.line).toBe(1);
  });

  it("returns an empty array when the binary is absent", () => {
    const files = runOutline(["src/lifecycle/review.ts"], { binary: "/nonexistent/binary" });
    expect(files).toEqual([]);
  });
});

describe("findInterface", () => {
  it("locates an interface by name across files", () => {
    const files: OutlineFile[] = [{
      path: "test.ts",
      language: "TypeScript",
      items: [{
        symbolType: "interface",
        name: "TestIFace",
        range: { line: 1, column: 0, endLine: 3, endColumn: 1 },
        signature: "interface TestIFace {",
        astKind: "interface_declaration",
        isImport: false,
        isExported: true,
        members: [{ symbolType: "field", name: "x", range: { line: 2, column: 2, endLine: 2, endColumn: 10 } as OutlineRange, isPublic: true }],
      }],
    }];
    expect(findInterface(files, "TestIFace")?.name).toBe("TestIFace");
    expect(findInterface(files, "Missing")).toBeUndefined();
  });
});