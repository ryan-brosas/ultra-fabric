import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildCodeGraph, buildRenderNodes, type CodeGraph } from "./build.js";
import { buildLiteralIndex } from "./literals.js";
import { route } from "./route.js";
import { expand, buildDisclosureGraph, minimalSkeleton, type Direction } from "./disclose.js";
import { predictFileCascade, predictSymbolCascade } from "./cascade.js";
import { readSymbolSource } from "./source.js";
import { searchSymbols } from "./search.js";
import {
  buildHeatCsr, chebyshevVectors, heatField, type Csr,
} from "./heat.js";
import { renderHeatField, type RenderNode } from "./render-heat.js";

// The codemap as an agent tool: "incremental mapping through agent discovery on
// the tools." Operations, each bounded by an explicit token budget:
//   skeleton  - the minimal compressed map to start from
//   search    - route a query to the symbol/literal index
//   focus     - heat-diffuse query seeds through the graph (t=4)
//   dwell     - expand an active field (t grows) and return the delta
//   expand    - greedy neighborhood disclosure (kept for backward compatibility)
//   cascade   - predict co-change cascade from a seed file or symbol
//   source    - return the AST range text of a name:file symbol key
// The graph is built once (mtime-cached) and reused across operations.

export type CodemapOperation = "skeleton" | "search" | "focus" | "dwell" | "expand" | "cascade" | "source";

export interface CodemapOpArgs {
  query?: string;
  entities?: readonly string[];
  direction?: Direction;
  depth?: number;
  maxTokens?: number;
  seed?: string;
  t?: number;
  disclosed?: readonly string[];
}

export interface CodemapOpResult {
  operation: CodemapOperation;
  text: string;
  tokens: number;
  entities: string[];
  truncated: boolean;
}

const tokenEstimate = (text: string): number => Math.ceil(text.length / 4);

// Truncate text to at most maxTokens (4 chars/token), cutting on a line boundary
// when possible so the skeleton stays readable.
const truncateToTokens = (text: string, maxTokens: number): { text: string; tokens: number; truncated: boolean } => {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return { text, tokens: tokenEstimate(text), truncated: false };
  const cut = text.slice(0, maxChars);
  const lastNl = cut.lastIndexOf("\n");
  const body = lastNl > 0 ? cut.slice(0, lastNl) : cut;
  return { text: body, tokens: tokenEstimate(body), truncated: true };
};

// A prepared bundle per root: the built symbol graph plus its derived literal
// index and disclosure graph. buildAllEdges runs an ast-grep call scan, so we
// memoize the bundle for the module lifetime to keep repeated skeleton/search/
// expand calls in one turn cheap. The underlying outline is mtime-cached
// (cache.ts), so the memo only avoids recomputing the index and edges.
export interface CodeGraphBundle {
  graph: CodeGraph;
  disclosure: ReturnType<typeof buildDisclosureGraph>;
  literals: ReturnType<typeof buildLiteralIndex>;
}

const graphCache = new Map<string, CodeGraphBundle>();

export const getCodeGraph = (root: string): CodeGraphBundle => {
  const cached = graphCache.get(root);
  if (cached) return cached;
  const graph = buildCodeGraph({ root });
  const literals = buildLiteralIndex(graph.files, graph.index, { cwd: root });
  const disclosure = buildDisclosureGraph(graph.index, graph.edges, graph.outlineFiles);
  const bundle: CodeGraphBundle = { graph, disclosure, literals };
  graphCache.set(root, bundle);
  return bundle;
};

// Heat session: per-root diffused field. The Chebyshev vectors are cached
// at a high fixed order so every later dwell recombines coefficients instead of
// re-walking the graph. A cheap bundle fingerprint guards against the graph
// being rebuilt (files edited mid-turn) so the CSR/node ordering stays aligned.
interface HeatSession {
  root: string;
  bundleId: string;
  csr: Csr;
  nodes: RenderNode[];
  seeds: ReadonlySet<string>;
  t: number;
  tk: Float64Array[];
  disclosed: Set<string>;
}

const FOCUS_T = 4;
const TK_ORDER = 90; // covers dwell up to t ~ 64

const fieldCache = new Map<string, HeatSession>();

const bundleIdOf = (graph: CodeGraph): string => {
  const k = graph.nodeKeys;
  return k.length + ":" + (k[0] ?? "");
};

const rebuildField = (session: HeatSession, graph: CodeGraph): HeatSession => {
  const csr = buildHeatCsr(graph.nodeKeys, graph.edges);
  const nodes = buildRenderNodes(graph.nodeKeys, graph.index);
  const s = new Float64Array(csr.n);
  const keyToIdx = new Map<string, number>();
  for (let i = 0; i < graph.nodeKeys.length; i++) keyToIdx.set(graph.nodeKeys[i]!, i);
  for (const key of session.seeds) {
    const idx = keyToIdx.get(key);
    if (idx !== undefined) s[idx] = 1;
  }
  const tk = chebyshevVectors(csr, s, TK_ORDER);
  return { ...session, bundleId: bundleIdOf(graph), csr, nodes, tk, seeds: session.seeds };
};

export const codemapOperation = (
  operation: CodemapOperation,
  args: CodemapOpArgs,
  root: string,
): CodemapOpResult => {
  const maxTokens = args.maxTokens ?? 4000;
  const { graph, disclosure, literals } = getCodeGraph(root);

  if (operation === "skeleton") {
    const full = minimalSkeleton(disclosure);
    const t = truncateToTokens(full, maxTokens);
    return { operation, text: t.text, tokens: t.tokens, entities: [], truncated: t.truncated };
  }

  if (operation === "search") {
    const query = args.query ?? "";
    const r = route(query, { index: graph.index, literals });
    const lines: string[] = ["[" + r.category + " via " + r.source + "]"];
    for (const s of r.symbols) lines.push(s.name + " (" + s.symbolType + ") " + s.file + ":" + s.line);
    for (const l of r.literals) lines.push("  " + l.kind + " " + l.file + ":" + l.line + " " + l.text.slice(0, 80));
    const t = truncateToTokens(lines.join("\n"), maxTokens);
    return { operation: "search", text: t.text, tokens: t.tokens, entities: r.symbols.map((s) => s.name + ":" + s.file), truncated: t.truncated };
  }

  if (operation === "focus") {
    const query = args.query ?? "";
    if (!query) throw new Error("focus requires a query");
    const matched = searchSymbols(graph.index, query, { limit: 50 });
    if (matched.length === 0) {
      return { operation: "focus", text: "focus: no symbols matched query \"" + query + "\"", tokens: 0, entities: [], truncated: false };
    }
    const keyToIdx = new Map<string, number>();
    for (let i = 0; i < graph.nodeKeys.length; i++) keyToIdx.set(graph.nodeKeys[i]!, i);
    const seeds = new Set<string>();
    const s = new Float64Array(graph.nodeKeys.length);
    for (const m of matched) {
      const key = m.name + ":" + m.file;
      const idx = keyToIdx.get(key);
      if (idx !== undefined && !seeds.has(key)) {
        seeds.add(key);
        s[idx] = 1;
      }
    }
    const csr = buildHeatCsr(graph.nodeKeys, graph.edges);
    const nodes = buildRenderNodes(graph.nodeKeys, graph.index);
    const tk = chebyshevVectors(csr, s, TK_ORDER);
    const t = args.t ?? FOCUS_T;
    const field = heatField(tk, t, csr.n);
    const session: HeatSession = {
      root,
      bundleId: bundleIdOf(graph),
      csr,
      nodes,
      seeds,
      t,
      tk,
      disclosed: new Set<string>(),
    };
    fieldCache.set(root, session);
    const res = renderHeatField(nodes, field, { header: "focus: " + query + " (t=" + t + ")", budget: maxTokens });
    for (const id of res.revealedIds) session.disclosed.add(id);
    return { operation: "focus", text: res.text, tokens: res.tokens, entities: res.revealedIds, truncated: res.truncated };
  }

  if (operation === "dwell") {
    let session = fieldCache.get(root);
    if (!session) {
      return { operation: "dwell", text: "dwell: no active focus — call focus first", tokens: 0, entities: [], truncated: false };
    }
    if (session.bundleId !== bundleIdOf(graph)) session = rebuildField(session, graph);
    const t = args.t ?? session.t * 2;
    const field = heatField(session.tk, t, session.csr.n);
    for (const id of args.disclosed ?? []) session.disclosed.add(id);
    const res = renderHeatField(session.nodes, field, {
      header: "dwell (t=" + t + ")",
      budget: maxTokens,
      disclosed: session.disclosed,
    });
    for (const id of res.revealedIds) session.disclosed.add(id);
    session.t = t;
    fieldCache.set(root, session);
    return { operation: "dwell", text: res.text, tokens: res.tokens, entities: res.revealedIds, truncated: res.truncated };
  }

  // cascade
  if (operation === "cascade") {
    const seed = args.seed ?? "";
    if (!seed) throw new Error("cascade requires a seed (file path or name:file symbol key)");
    const isSymbolKey = seed.includes(":");
    const preds = isSymbolKey
      ? predictSymbolCascade(seed, { index: graph.index, edges: graph.edges }, { cwd: root })
      : predictFileCascade(seed, { cwd: root, maxCommits: 200 });
    const lines = ["cascade from " + seed];
    for (const p of preds.slice(0, 100)) lines.push(p.file + "  " + p.score.toFixed(3) + "  hist=" + p.historyRate.toFixed(3) + "  dep=" + p.dependencyScore.toFixed(3));
    const t = truncateToTokens(lines.join("\n"), maxTokens);
    return { operation: "cascade", text: t.text, tokens: t.tokens, entities: preds.slice(0, 100).map((p) => p.file), truncated: t.truncated };
  }

  // source
  if (operation === "source") {
    const key = (args.entities ?? [])[0] ?? "";
    if (!key) throw new Error("source requires a name:file symbol key");
    const s = readSymbolSource(graph.index, root, key);
    if (!s.found) {
      return { operation: "source", text: "symbol not found: " + key, tokens: 0, entities: [], truncated: false };
    }
    const header = key + " (" + s.line + "-" + s.endLine + ")\n";
    const t = truncateToTokens(header + s.text, maxTokens);
    return { operation: "source", text: t.text, tokens: t.tokens, entities: [key], truncated: t.truncated };
  }

  // expand
  const entities = args.entities ?? [];
  const ex = expand(disclosure, entities, {
    maxTokens,
    ...(args.direction !== undefined ? { direction: args.direction } : {}),
    ...(args.depth !== undefined ? { depth: args.depth } : {}),
  });
  const lines: string[] = ["revealed " + ex.entities.length + " entities in " + ex.files.length + " files (" + ex.tokens + " tokens" + (ex.truncated ? ", truncated" : "") + ")"];
  for (const e of ex.entities) lines.push("  " + e);
  return { operation: "expand", text: lines.join("\n"), tokens: ex.tokens, entities: ex.entities, truncated: ex.truncated };
};

export interface CodemapToolDeps {
  root?: string;
}

export const createCodemapTool = (deps: CodemapToolDeps = {}): ToolDefinition<any, any, any> =>
  defineTool({
    name: "codemap",
    label: "Code Map",
    description:
      "AST-compressed code map for incremental navigation. Operations: skeleton (minimal map), search (route a query to symbols/literals), focus (heat-diffuse query seeds through the graph), dwell (expand an active field and return the delta), expand (greedy neighborhood disclosure), cascade (predict co-change cascade from a seed file or symbol), source (return the AST range text of a name:file symbol key). Each response is bounded by maxTokens.",
    promptSnippet: "AST code map: skeleton, search, focus, dwell, expand, cascade, source",
    promptGuidelines: [
      "Use codemap for: symbol definitions, type signatures, function/class structure, call and import relationships, and dependency neighborhoods.",
      "Call focus with a query to center the map on a task, then dwell to expand it without re-extracting.",
      "Reserve grep for: literal text inside string literals, comments, configuration files, and patterns that are not valid identifiers or code symbols.",
    ],
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("skeleton"), Type.Literal("search"), Type.Literal("focus"), Type.Literal("dwell"),
        Type.Literal("expand"), Type.Literal("cascade"), Type.Literal("source"),
      ]),
      seed: Type.Optional(Type.String({ description: "file path or name:file symbol key to seed the cascade (operation: cascade)" })),
      query: Type.Optional(Type.String({ description: "search query (operation: search); focus query (operation: focus)" })),
      entities: Type.Optional(Type.Array(Type.String(), { description: "symbol keys name:file to expand from (operation: expand) or read source for (operation: source)" })),
      direction: Type.Optional(Type.Union([Type.Literal("upstream"), Type.Literal("downstream"), Type.Literal("both")])),
      depth: Type.Optional(Type.Number({ minimum: 1, maximum: 2 })),
      t: Type.Optional(Type.Number({ minimum: 1, maximum: 64, description: "diffusion time for focus/dwell" })),
      disclosed: Type.Optional(Type.Array(Type.String(), { description: "node keys already disclosed, for dwell delta rendering" })),
      maxTokens: Type.Optional(Type.Number({ minimum: 100, maximum: 20000 })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      void toolCallId; void signal; void onUpdate;
      const root = deps.root ?? ctx.cwd;
      const result = codemapOperation(params.operation, params, root);
      return {
        content: [{ type: "text", text: result.text }],
        details: { tokens: result.tokens, entities: result.entities, truncated: result.truncated },
      };
    },
  });
