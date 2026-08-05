import { describe, expect, it } from "vitest";
import { createCodemapTool, codemapOperation, getCodeGraph } from "../src/codemap/tool.js";

const ROOT = process.cwd();

describe("codemap tool surface", () => {
  it("returns a tool definition with a callable execute", () => {
    const tool = createCodemapTool();
    expect(typeof tool.execute).toBe("function");
    expect(tool.name).toBe("codemap");
  });

  it("skeleton operation respects maxTokens", () => {
    const r = codemapOperation("skeleton", { maxTokens: 500 }, ROOT);
    expect(r.operation).toBe("skeleton");
    expect(r.tokens).toBeLessThanOrEqual(500);
    if (r.truncated) expect(r.text.length).toBeGreaterThan(0);
  });

  it("search operation respects maxTokens", () => {
    const r = codemapOperation("search", { query: "config", maxTokens: 500 }, ROOT);
    expect(r.operation).toBe("search");
    expect(r.tokens).toBeLessThanOrEqual(500);
  });

  it("expand operation respects maxTokens", () => {
    const r = codemapOperation("expand", { entities: [], maxTokens: 500 }, ROOT);
    expect(r.operation).toBe("expand");
    expect(r.tokens).toBeLessThanOrEqual(500);
  });

  it("cascade operation returns ranked predictions within budget", { timeout: 30000 }, () => {
    const r = codemapOperation("cascade", { seed: "src/config.ts", maxTokens: 2000 }, ROOT);
    expect(r.operation).toBe("cascade");
    expect(r.tokens).toBeLessThanOrEqual(2000);
    expect(r.text).toContain("tests/config.test.ts");
    expect(r.entities.length).toBeGreaterThan(0);
  });

  it("memoizes the built graph per root (identity, not timing)", () => {
    expect(getCodeGraph(ROOT)).toBe(getCodeGraph(ROOT));
  });
});