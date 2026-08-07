import { describe, it, expect } from "vitest";
import { buildHeatCsr } from "../src/codemap/heat.js";
import { heatAt, taylorReference, besselI } from "./codemap-fovea-bridge.js";
import { renderHeatField, type RenderNode } from "../src/codemap/render-heat.js";
import type { RankEdge } from "../src/codemap/rank.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const randomRanks = (n: number, p: number, seed: number): { keys: string[]; edges: RankEdge[] } => {
  const rnd = mulberry32(seed);
  const keys = Array.from({ length: n }, (_, i) => `n${i}@f${i % 5}`);
  const edges: RankEdge[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rnd() < p) edges.push({ from: keys[i]!, to: keys[j]!, weight: 0.2 + rnd(), kind: "invokes" });
    }
  }
  return { keys, edges };
};

// ── Bessel / Chebyshev mathematical correctness (from pi-fovea heat.test.ts) ──

describe("heat diffusion (pi-fovea reference tests)", () => {
  it("besselI matches known values", () => {
    expect(besselI(0, 3)).toBeCloseTo(4.880792585865, 6);
    expect(besselI(1, 3)).toBeCloseTo(3.953370217403, 6);
    expect(besselI(5, 10)).toBeCloseTo(777.188286403, 3);
    expect(besselI(0, 0)).toBe(1);
    expect(besselI(3, 0)).toBe(0);
  });

  it("Chebyshev heat matches the Taylor reference at several times", () => {
    const { keys, edges } = randomRanks(60, 0.08, 42);
    const csr = buildHeatCsr(keys, edges);
    const s = new Float64Array(60);
    s[7] = 1;
    s[23] = 0.5;
    for (const t of [0.5, 2, 8, 16]) {
      const got = heatAt(csr, s, t);
      const ref = taylorReference(csr, s, t);
      let maxDiff = 0;
      let maxRef = 0;
      for (let i = 0; i < 60; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(got[i]! - ref[i]!));
        maxRef = Math.max(maxRef, ref[i]!);
      }
      expect(maxRef).toBeGreaterThan(1e-6);
      expect(maxDiff).toBeLessThan(1e-8);
    }
  });

  it("heat fields are non-negative and the seed stays hottest at small t", () => {
    const { keys, edges } = randomRanks(40, 0.1, 7);
    const csr = buildHeatCsr(keys, edges);
    const s = new Float64Array(40);
    s[3] = 1;
    const v = heatAt(csr, s, 1);
    for (const x of v) expect(x).toBeGreaterThanOrEqual(-1e-12);
    expect(v[3]!).toBeGreaterThan(0.3);
    let maxOther = 0;
    v.forEach((x, i) => { if (i !== 3) maxOther = Math.max(maxOther, x); });
    expect(maxOther).toBeLessThan(v[3]!);
  });

  it("dwell monotonicity: increasing t widens the lit set", () => {
    const { keys, edges } = randomRanks(80, 0.05, 11);
    const csr = buildHeatCsr(keys, edges);
    const s = new Float64Array(80);
    s[0] = 1;
    const litAt = (t: number) => {
      const field = heatAt(csr, s, t);
      const max = Math.max(...field);
      return field.filter((x) => x > 0.02 * max).length;
    };
    expect(litAt(1)).toBeLessThanOrEqual(litAt(8));
  });
});

// ── Renderer budget hardness (from pi-fovea render.test.ts) ──────────────────

describe("heat renderer (pi-fovea reference tests)", () => {
  // Build a fan graph: one hub symbol connecting to N files, each with 3 helpers.
  const fanNodes = (files: number): { nodes: RenderNode[]; edges: RankEdge[] } => {
    const nodes: RenderNode[] = [
      { id: "hub@src/hub.ts", name: "hub", kind: "function", file: "src/hub.ts", line: 1, sig: "export function hub()" },
    ];
    const edges: RankEdge[] = [];
    for (let f = 0; f < files; f++) {
      for (let s = 0; s < 3; s++) {
        const id = `helper${s}@src/mod${f}.ts`;
        const name = `helper${s}Mod${f}`;
        nodes.push({ id, name, kind: "function", file: `src/mod${f}.ts`, line: 3 + s, sig: `function helper${s}Mod${f}()` });
        edges.push({ from: "hub@src/hub.ts", to: id, weight: f < 3 ? 0.8 : 0.25, kind: "invokes" });
      }
    }
    return { nodes, edges };
  };

  const fanTest = (files: number) => {
    const { nodes, edges } = fanNodes(files);
    const keys = nodes.map((n) => n.id);
    const csr = buildHeatCsr(keys, edges);
    const s = new Float64Array(keys.length);
    s[0] = 1;
    const field = heatAt(csr, s, 3);
    return { nodes, field, keys };
  };

  for (const files of [8, 40, 90]) {
    for (const B of [300, 800, 2000]) {
      it(`never exceeds budget (${files} files, B=${B})`, () => {
        const { nodes, field } = fanTest(files);
        const fit = renderHeatField(nodes, field, { header: "t", budget: B });
        expect(fit.tokens).toBeLessThanOrEqual(B);
      });
    }
  }

  it("renders the hot hub with its signature", () => {
    const { nodes, field } = fanTest(10);
    const fit = renderHeatField(nodes, field, { header: "t", budget: 4000 });
    expect(fit.text).toContain("▲ src/hub.ts:1  export function hub()");
    expect(fit.revealedIds).toContain("hub@src/hub.ts");
  });

  it("disclosed nodes are suppressed from later reveals (delta bookkeeping)", () => {
    const { nodes, field } = fanTest(10);
    const first = renderHeatField(nodes, field, { header: "t", budget: 4000 });
    const second = renderHeatField(nodes, field, { header: "t", budget: 4000, disclosed: new Set(first.revealedIds) });
    expect(second.suppressed).toBe(first.revealedIds.length);
    for (const id of first.revealedIds) expect(second.revealedIds).not.toContain(id);
  });

  it("extreme budgets degrade to header-only instead of overspending", () => {
    const { nodes, field } = fanTest(120);
    const fit = renderHeatField(nodes, field, { header: "codemap focus", budget: 256 });
    expect(fit.tokens).toBeLessThanOrEqual(256);
    expect(fit.text).toContain("below threshold");
    expect(fit.truncated).toBe(true);
  });
});
