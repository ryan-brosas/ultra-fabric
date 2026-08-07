// Bridge: pi-fovea API surface → codemap implementation.
// This lets pi-fovea's original test files import our code unchanged.
import {
  buildHeatCsr, besselI, chebyshevVectors, heatField,
  type Csr,
} from "../src/codemap/heat.js";
import {
  renderHeatField, type RenderNode,
} from "../src/codemap/render-heat.js";

// ── types matching pi-fovea's Graph/NodeRec ──────────────────────────────────

export interface NodeRec {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  sig: string;
  lang: string;
}

export interface Graph {
  nodes: NodeRec[];
  edges: Array<{ a: number; b: number; kind: string; w: number }>;
  byName: Map<string, number[]>;
  byFile: Map<string, number[]>;
  anchors: unknown[];
  files: string[];
}

// ── buildCsr(g: Graph) → our Csr ────────────────────────────────────────────

export const buildCsr = (g: Graph) => {
  const keys = g.nodes.map((n, i) => `${n.id}@${i}`);
  const rankEdges = g.edges.map((e) => ({
    from: keys[e.a]!,
    to: keys[e.b]!,
    weight: e.w,
    kind: "invokes" as const,
  }));
  return buildHeatCsr(keys, rankEdges);
};

// ── revealFoveated(g, field, opts) → our renderHeatField ─────────────────────

export const revealFoveated = (
  g: Graph,
  field: Float64Array,
  opts: { header?: string; disclosed?: ReadonlySet<string>; exclude?: ReadonlySet<string>; budget: number; maxCandidates?: number },
) => {
  const nodes: RenderNode[] = g.nodes.map((n, i) => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    file: n.file,
    line: n.line,
    sig: n.sig,
  }));
  return renderHeatField(nodes, field, opts);
};

// Local test oracles (moved from src/codemap/heat.ts when de-exported):
// heatAt = one-shot Chebyshev convenience; taylorReference = independent
// scaling-and-squaring Taylor implementation used to validate the Chebyshev path.
const chooseOrder = (t: number): number => Math.min(90, Math.ceil(2.2 * t) + 16);
const applyNegP = (csr: Csr, x: Float64Array): Float64Array => {
  const { n, rowPtr, col, w, deg } = csr;
  const invSqrt = new Float64Array(n);
  for (let i = 0; i < n; i++) invSqrt[i] = deg[i]! > 0 ? 1 / Math.sqrt(deg[i]!) : 0;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const s = rowPtr[i]!;
    const e = rowPtr[i + 1]!;
    for (let p = s; p < e; p++) acc += w[p]! * invSqrt[col[p]!]! * x[col[p]!]!;
    y[i] = -invSqrt[i]! * acc;
  }
  return y;
};
export const heatAt = (csr: Csr, s: Float64Array, t: number): Float64Array => {
  const K = chooseOrder(t);
  return heatField(chebyshevVectors(csr, s, K), t, csr.n);
};
export const taylorReference = (csr: Csr, s: Float64Array, t: number): Float64Array => {
  const m = Math.max(0, Math.ceil(Math.log2(t / 0.5)));
  const tau = t / 2 ** m;
  const lpApply = (x: Float64Array): Float64Array => {
    const neg = applyNegP(csr, x);
    const out = new Float64Array(csr.n);
    for (let i = 0; i < csr.n; i++) out[i] = x[i]! + neg[i]!;
    return out;
  };
  const expTauApply = (x: Float64Array): Float64Array => {
    const y = Float64Array.from(x);
    let term: Float64Array = Float64Array.from(x);
    let factor = 1;
    for (let k = 0; k < 80; k++) {
      const next = lpApply(term);
      for (let i = 0; i < csr.n; i++) next[i]! *= -tau;
      term = next;
      factor /= k + 1;
      if (k > 2 && Math.abs(factor) * 8 < 1e-18) break;
      for (let i = 0; i < csr.n; i++) y[i]! += factor * term[i]!;
    }
    return y;
  };
  let v: Float64Array = Float64Array.from(s);
  for (let i = 0; i < 2 ** m; i++) v = expTauApply(v);
  return v;
};
export { besselI };

export const tokenEstimate = (text: string): number => Math.ceil(text.length / 4);
