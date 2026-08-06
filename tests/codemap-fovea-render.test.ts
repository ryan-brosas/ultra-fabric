// Renderer unit tests: budget hardness under a huge glow periphery, tier
// boundaries, and the delta disclosure bookkeeping.

import { describe, expect, it } from "vitest";
import { revealFoveated, buildCsr, heatAt, tokenEstimate, type Graph, type NodeRec } from "./codemap-fovea-bridge.js";

// One hub symbol fanning out to many files: after diffusion the hub is hot,
// a handful of neighbours warm, and the long tail collapses to glow lines.
const fanGraph = (files: number): Graph => {
  const nodes: NodeRec[] = [{ id: "hub@src/hub.ts", name: "hub", kind: "function", file: "src/hub.ts", line: 1, sig: "export function hub()", lang: "TypeScript" }];
  const edges: Graph["edges"] = [];
  for (let f = 0; f < files; f++) {
    const file = `src/mod${f}.ts`;
    nodes.push({ id: `file:${file}`, name: `mod${f}.ts`, kind: "file", file, line: 0, sig: file, lang: "TypeScript" });
    for (let s = 0; s < 3; s++) {
      const idx = nodes.length;
      nodes.push({ id: `helper${s}@${file}`, name: `helper${s}Mod${f}`, kind: "function", file, line: 3 + s, sig: `function helper${s}Mod${f}() { ... }`, lang: "TypeScript" });
      edges.push({ a: 0, b: idx, kind: "invokes", w: f < 3 ? 0.8 : 0.25 });
    }
  }
  return { nodes, edges, byName: new Map(), byFile: new Map(), anchors: [], files: [] };
};

describe("revealFoveated", () => {
  for (const files of [8, 40, 90]) {
    for (const B of [300, 800, 2000]) {
      it(`never exceeds budget (${files} files, B=${B})`, () => {
        const g = fanGraph(files);
        const csr = buildCsr(g);
        const s = new Float64Array(g.nodes.length);
        s[0] = 1;
        const field = heatAt(csr, s, 3);
        const fit = revealFoveated(g, field, { header: "t", budget: B });
        expect(fit.tokens).toBeLessThanOrEqual(B);
        expect(tokenEstimate(fit.text)).toBeLessThanOrEqual(B);
      });
    }
  }

  it("renders the hot hub with its signature and marks warmer tiers", () => {
    const g = fanGraph(10);
    const csr = buildCsr(g);
    const s = new Float64Array(g.nodes.length);
    s[0] = 1;
    const fit = revealFoveated(g, heatAt(csr, s, 2), { header: "t", budget: 4000 });
    expect(fit.text).toContain("▲ src/hub.ts:1  export function hub()");
    expect(fit.revealedIds).toContain("hub@src/hub.ts");
  });

  it("disclosed nodes are suppressed from later reveals (delta bookkeeping)", () => {
    const g = fanGraph(10);
    const csr = buildCsr(g);
    const s = new Float64Array(g.nodes.length);
    s[0] = 1;
    const field = heatAt(csr, s, 2);
    const first = revealFoveated(g, field, { header: "t", budget: 4000 });
    const second = revealFoveated(g, field, { header: "t", budget: 4000, disclosed: new Set(first.revealedIds) });
    expect(second.suppressed).toBe(first.revealedIds.length);
    for (const id of first.revealedIds) expect(second.revealedIds).not.toContain(id);
  });

  it("extreme budgets degrade to header-only instead of overspending", () => {
    const g = fanGraph(120);
    const csr = buildCsr(g);
    const s = new Float64Array(g.nodes.length);
    s[0] = 1;
    const fit = revealFoveated(g, heatAt(csr, s, 3), { header: "fovea focus x", budget: 256 });
    expect(fit.tokens).toBeLessThanOrEqual(256);
    expect(fit.text).toContain("below threshold"); // periphery was truncated, budget intact
    expect(fit.truncated).toBe(true);
  });
});
