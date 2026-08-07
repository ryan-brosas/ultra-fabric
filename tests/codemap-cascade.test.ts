import { describe, expect, it } from "vitest";
import { runOutline } from "../src/codemap/outline.js";
import { buildSymbolIndex } from "../src/codemap/symbols.js";
import { buildAllEdges } from "../src/codemap/build.js";
import { predictFileCascade, predictSymbolCascade } from "../src/codemap/cascade.js";

const root = process.cwd();

describe("predictFileCascade", () => {
  it("predicts the measured co-change partners of src/config.ts", { timeout: 30000 }, () => {
    const preds = predictFileCascade("src/config.ts", { cwd: root, historyWeight: 0.5, maxCommits: 200 });
    const byFile = new Map(preds.map((p) => [p.file, p]));
    // The doc measured config.test.ts at 75% and ui/settings.ts at 50% co-change.
    const testCfg = byFile.get("tests/config.test.ts");
    const settings = byFile.get("src/ui/settings.ts");
    expect(testCfg).toBeDefined();
    expect(settings).toBeDefined();
    expect(testCfg!.historyRate).toBeGreaterThanOrEqual(0.7);
    expect(settings!.historyRate).toBeGreaterThanOrEqual(0.45);
    // Both should rank near the top of the cascade.
    const top = preds.slice(0, 6).map((p) => p.file);
    expect(top).toContain("tests/config.test.ts");
    expect(top).toContain("src/ui/settings.ts");
  });

  it("pure-dependency weight (historyWeight 0) still returns the import neighbours", { timeout: 30000 }, () => {
    const preds = predictFileCascade("src/config.ts", { cwd: root, historyWeight: 0, maxCommits: 200 });
    expect(preds.length).toBeGreaterThan(0);
    // with history excluded, every prediction's score equals its dependency score
    for (const p of preds) expect(Math.abs(p.score - p.dependencyScore)).toBeLessThan(1e-9);
  });
});

describe("predictSymbolCascade", () => {
  it("yields dependency-derived candidates alongside any history signal", { timeout: 30000 }, () => {
    // The dependency channel must contribute on its own merits. This previously
    // relied on disclose.ts being untracked so historyRate was always 0, which
    // silently broke the moment src/codemap was committed. Assert the durable
    // property instead: the AST dependency graph yields candidates regardless of
    // whether the seed file has commit history.
    const files = runOutline(["src/codemap/disclose.ts", "src/codemap/search.ts", "src/codemap/skeleton.ts", "src/codemap/symbols.ts", "src/codemap/outline.ts", "src/codemap/rank.ts"], { cwd: root });
    const index = buildSymbolIndex(files);
    const edges = buildAllEdges(index, root);
    const preds = predictSymbolCascade("expand:src/codemap/disclose.ts", { index, edges }, { cwd: root, historyWeight: 0.5, maxCommits: 200 });
    // History is empty (no commits), so candidates come from the dependency channel.
    expect(preds.length).toBeGreaterThan(0);
    expect(preds.some((p) => p.dependencyScore > 0)).toBe(true);
    // disclose.ts imports search.ts, skeleton.ts, symbols.ts, outline.ts, rank.ts
    expect(preds.some((p) => p.file === "src/codemap/search.ts")).toBe(true);
  });
});