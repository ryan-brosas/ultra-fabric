// Bridge: pi-fovea API surface → codemap implementation.
// This lets pi-fovea's original test files import our code unchanged.
import {
  buildHeatCsr, heatAt, taylorReference, besselI,
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

export { heatAt, taylorReference, besselI };

export const tokenEstimate = (text: string): number => Math.ceil(text.length / 4);
