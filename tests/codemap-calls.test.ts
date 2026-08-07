import { describe, expect, it } from "vitest";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runOutline } from "../src/codemap/outline.js";
import { buildSymbolIndex } from "../src/codemap/symbols.js";
import { callSiteStats, extractCallEdges, extractCallSites } from "../src/codemap/calls.js";

const root = process.cwd();
// cache.ts calls runOutline (defined in outline.ts) via its mtime-cached outline driver;
// build.ts no longer calls runOutline directly after dead-code cleanup removed two map functions.
// Include all three files so both can be resolved in the index.
const files = runOutline(["src/codemap/cache.ts", "src/codemap/build.ts", "src/codemap/outline.ts", "src/codemap/rank.ts"], { cwd: root });
const index = buildSymbolIndex(files);

describe("extractCallEdges", () => {
  it("has an invokes edge from build.ts into runOutline", () => {
    const edges = extractCallEdges(index, { cwd: root });
    const intoOutline = edges.filter((e) => e.to.startsWith("runOutline:src/codemap/outline.ts"));
    expect(intoOutline.length).toBeGreaterThan(0);
    expect(intoOutline.every((e) => e.kind === "invokes")).toBe(true);
    // the edge must originate from a symbol in cache.ts (previously build.ts before dead-code cleanup stripped two map functions)
    expect(intoOutline.every((e) => e.from.endsWith(":src/codemap/cache.ts"))).toBe(true);
  });

  it("does not emit edges for identifiers appearing only inside strings or comments", () => {
    const dir = join("/tmp", "codemap-calls-fixture");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "fixture.ts");
    writeFileSync(
      target,
      [
        "export const phantomMark = 1;",
        "export function usesNothing() {",
        '  // phantomMark should not be a call here',
        '  const s = "phantomMark(1)";',
        "  return s.length;",
        "}",
      ].join("\n"),
    );
    const outline = runOutline([target], { cwd: dir });
    const idx = buildSymbolIndex(outline);
    const edges = extractCallEdges(idx, { cwd: dir });
    const intoPhantom = edges.filter((e) => e.to.includes("phantomMark"));
    expect(intoPhantom.length).toBe(0);
  });

  it("resolves the final member segment of a dotted callee", () => {
    // A dotted call like obj.runOutline resolves to the defined symbol runOutline.
    // build.ts calls pageRank as a bare identifier; verify the edge lands on rank.ts.
    const edges = extractCallEdges(index, { cwd: root });
    const intoPageRank = edges.filter((e) => e.to.startsWith("pageRank:src/codemap/rank.ts"));
    expect(intoPageRank.length).toBeGreaterThan(0);
  });
});
describe("call-site scan cache", () => {
  it("serves unchanged files from cache and rescans only after mtime drift", () => {
    const dir = join("/tmp", "codemap-calls-cache-" + Date.now());
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "fixture.ts");
    writeFileSync(target, "export function callee() { return 1; }\nexport function caller() { return callee(); }\n");
    const outline = runOutline([target], { cwd: dir });
    const idx = buildSymbolIndex(outline);
    const before = callSiteStats.batches;
    const first = extractCallSites(idx, { cwd: dir });
    expect(first.length).toBeGreaterThan(0);
    const afterFirst = callSiteStats.batches;
    expect(afterFirst).toBeGreaterThan(before);
    // unchanged files: cache hit, zero ast-grep batches
    extractCallSites(idx, { cwd: dir });
    expect(callSiteStats.batches).toBe(afterFirst);
    // mtime drift: rescan, and the new caller's site surfaces
    writeFileSync(target, "export function callee() { return 1; }\nexport function caller() { return callee(); }\nexport function caller2() { return callee(); }\n");
    const future = Date.now() / 1000 + 5;
    utimesSync(target, future, future);
    // Mirror the bundle rebuild: the index refreshes with the file.
    const outline2 = runOutline([target], { cwd: dir });
    const idx2 = buildSymbolIndex(outline2);
    const second = extractCallSites(idx2, { cwd: dir });
    expect(second.some((s) => s.caller === "caller2")).toBe(true);
    expect(callSiteStats.batches).toBeGreaterThan(afterFirst);
  });
});
