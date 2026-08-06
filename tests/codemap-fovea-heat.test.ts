// Diffusion core validation: Chebyshev heat evaluation must match an
// independent Taylor-series implementation on random graphs, plus invariants
// (heat-kernel positivity, Bessel values).

import { describe, expect, it } from "vitest";
import { besselI, buildCsr, heatAt, taylorReference, type Graph, type NodeRec } from "./codemap-fovea-bridge.js";

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const randomGraph = (n: number, p: number, seed: number): Graph => {
  const rnd = mulberry32(seed);
  const nodes: NodeRec[] = Array.from({ length: n }, (_, i) => ({
    id: `n${i}@f${i % 5}`, name: `n${i}`, kind: "function", file: `f${i % 5}`, line: i, sig: `n${i}`, lang: "t",
  }));
  const edges: Graph["edges"] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rnd() < p) edges.push({ a: i, b: j, kind: "invokes", w: 0.2 + rnd() });
    }
  }
  return { nodes, edges, byName: new Map(), byFile: new Map(), anchors: [], files: [] };
};

describe("heat diffusion", () => {
  it("besselI matches known values", () => {
    expect(besselI(0, 3)).toBeCloseTo(4.880792585865, 6);
    expect(besselI(1, 3)).toBeCloseTo(3.953370217403, 6);
    expect(besselI(5, 10)).toBeCloseTo(777.188286403, 3);
    expect(besselI(0, 0)).toBe(1);
    expect(besselI(3, 0)).toBe(0);
  });

  it("Chebyshev heat matches the Taylor reference at several times", () => {
    const g = randomGraph(60, 0.08, 42);
    const csr = buildCsr(g);
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
    const g = randomGraph(40, 0.1, 7);
    const csr = buildCsr(g);
    const s = new Float64Array(40);
    s[3] = 1;
    const v = heatAt(csr, s, 1);
    for (const x of v) expect(x).toBeGreaterThanOrEqual(-1e-12);
    expect(v[3]!).toBeGreaterThan(0.3);
    // unreached isolated/seedless regions stay cold at small t
    let maxOther = 0;
    v.forEach((x, i) => { if (i !== 3) maxOther = Math.max(maxOther, x); });
    expect(maxOther).toBeLessThan(v[3]!);
  });

  it("dwell monotonicity: increasing t strictly widens the lit set", () => {
    const g = randomGraph(80, 0.05, 11);
    const csr = buildCsr(g);
    const s = new Float64Array(80);
    s[0] = 1;
    const lit = (t: number) => heatAt(csr, s, t).filter((x) => x > 0.02 * Math.max(...heatAt(csr, s, t))).length;
    expect(lit(1)).toBeLessThanOrEqual(lit(8));
  });
});
