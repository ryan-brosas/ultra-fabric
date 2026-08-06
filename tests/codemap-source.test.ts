import { describe, expect, it } from "vitest";
import { codemapOperation } from "../src/codemap/tool.js";

const root = process.cwd();

describe("codemap source operation", () => {
  it("returns the exact source range of a symbol key", () => {
    const r = codemapOperation("source", { entities: ["resolveDefiners:src/codemap/scope.ts"] }, root);
    expect(r.operation).toBe("source");
    expect(r.text).toContain("resolveDefiners");
    expect(r.text).toContain("imported.has(d.file)");
    expect(r.entities).toEqual(["resolveDefiners:src/codemap/scope.ts"]);
  });

  it("bounds the range to maxTokens", () => {
    const r = codemapOperation("source", { entities: ["resolveDefiners:src/codemap/scope.ts"], maxTokens: 40 }, root);
    expect(r.truncated).toBe(true);
  });

  it("reports an unknown key cleanly", () => {
    const r = codemapOperation("source", { entities: ["nope:src/x.ts"] }, root);
    expect(r.text).toContain("not found");
  });
});
