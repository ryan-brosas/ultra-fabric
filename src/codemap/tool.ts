import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildCodeGraph, buildRenderNodes, type CodeGraph } from "./build.js";
import { pageRank } from "./rank.js";
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
import {
  cgcQuery,
  cypher,
  extractCgcJson,
  type CgcOptions,
} from "./cgc.js";

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

export type CodemapOperation =
  | "skeleton"
  | "search"
  | "focus"
  | "dwell"
  | "expand"
  | "cascade"
  | "source"
  | "explore";

export interface CodemapOpArgs {
  query?: string;
  entities?: readonly string[];
  direction?: Direction;
  depth?: number;
  maxTokens?: number;
  seed?: string;
  t?: number;
  disclosed?: readonly string[];
  // "ast" (default) uses the project's own ast-grep graph; "cgc" queries the
  // installed CodeGraphContext database (separate namespace, read-only).
  mode?: "ast" | "cgc";
  // CGC path prefix or named context (mode: "cgc"). Overrides the configured
  // codemap.cgc.context for this call.
  context?: string;
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
  // The marker rides inside the budget so a cut view is visibly partial; a
  // silent cut reads as a complete result and misleads scope decisions.
  const marker = "… truncated at " + maxTokens + " tokens; refine scope or raise maxTokens";
  const cut = text.slice(0, Math.max(0, maxChars - marker.length - 1));
  const lastNl = cut.lastIndexOf("\n");
  const body = (lastNl > 0 ? cut.slice(0, lastNl) : cut) + "\n" + marker;
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

export interface CgcToolOptions extends CgcOptions {
  enabled?: boolean;
}

export interface CodemapToolOptions {
  cgc?: CgcToolOptions;
}

const cgcToolEnabled = (opts: CodemapToolOptions | undefined, args: CodemapOpArgs): CgcOptions | null => {
  const cfg = opts?.cgc;
  if (!cfg || cfg.enabled !== true) return null;
  const out: CgcOptions = {};
  const context = args.context ?? cfg.context;
  if (context) out.context = context;
  if (cfg.timeoutMs !== undefined) out.timeoutMs = cfg.timeoutMs;
  if (cfg.runner) out.runner = cfg.runner;
  return out;
};

const cgcQueryLines = (
  cgc: CgcOptions,
  cypherText: string,
  render: (rec: Record<string, unknown>) => string | null,
): string[] => {
  const r = cgcQuery(cypherText, cgc);
  if (!r.ok) return ["cgc " + r.kind + ": " + r.message];
  const parsed = extractCgcJson(r.text);
  if (!Array.isArray(parsed)) return ["cgc query returned no records"];
  const lines: string[] = [];
  for (const rec of parsed as Array<Record<string, unknown>>) {
    const l = render(rec);
    if (l) lines.push(l);
  }
  return lines;
};

const cgcSearch = (query: string, cgc: CgcOptions, maxTokens: number): CodemapOpResult => {
  const lines: string[] = ["[cgc search: " + query + "]"];
  lines.push(
    ...cgcQueryLines(cgc, cypher.symbolSearch(query, cgc.context), (rec) => {
      const name = rec["f.name"];
      if (typeof name !== "string") return null;
      return name + " (" + (rec["f.lang"] ?? "?") + ") " + (rec["f.path"] ?? "?") + ":" + (rec["f.line_number"] ?? "?");
    }),
  );
  lines.push(
    ...cgcQueryLines(cgc, cypher.classSearch(query, cgc.context), (rec) => {
      const name = rec["c.name"];
      if (typeof name !== "string") return null;
      return name + " (class, " + (rec["c.lang"] ?? "?") + ") " + (rec["c.path"] ?? "?") + ":" + (rec["c.line_number"] ?? "?");
    }),
  );
  lines.push(
    ...cgcQueryLines(cgc, cypher.fileSearch(query, cgc.context), (rec) => {
      const p = rec["f.path"];
      return typeof p === "string" ? p : null;
    }),
  );
  const t = truncateToTokens(lines.join("\n"), maxTokens);
  return { operation: "search", text: t.text, tokens: t.tokens, entities: [], truncated: t.truncated };
};

const cgcSkeleton = (cgc: CgcOptions, maxTokens: number): CodemapOpResult => {
  const lines: string[] = ["[cgc skeleton" + (cgc.context ? " scoped to " + cgc.context : " (global work graph)") + "]"];
  lines.push(
    ...cgcQueryLines(cgc, cypher.functionCount(cgc.context), (rec) =>
      rec["c"] !== undefined ? "functions: " + rec["c"] : null,
    ),
  );
  lines.push(
    ...cgcQueryLines(cgc, cypher.fileCount(cgc.context), (rec) =>
      rec["c"] !== undefined ? "files: " + rec["c"] : null,
    ),
  );
  lines.push("## top complexity hotspots");
  lines.push(
    ...cgcQueryLines(cgc, cypher.hotspots(20, cgc.context), (rec) => {
      const name = rec["f.name"];
      if (typeof name !== "string") return null;
      return name + " (complexity " + rec["f.cyclomatic_complexity"] + ") " + (rec["f.path"] ?? "?") + ":" + (rec["f.line_number"] ?? "?");
    }),
  );
  const t = truncateToTokens(lines.join("\n"), maxTokens);
  return { operation: "skeleton", text: t.text, tokens: t.tokens, entities: [], truncated: t.truncated };
};

const cgcExpand = (entities: readonly string[], cgc: CgcOptions, maxTokens: number): CodemapOpResult => {
  const lines: string[] = ["[cgc expand]"];
  for (const e of entities.slice(0, 6)) {
    if (e.includes("/") && !e.includes(":")) {
      lines.push("## imports of " + e);
      lines.push(
        ...cgcQueryLines(cgc, cypher.importsOf(e), (rec) => {
          const n = rec["m.name"];
          return typeof n === "string" ? n : null;
        }),
      );
    } else {
      const name = e.split(":")[0] ?? e;
      lines.push("## inheritance of " + name);
      lines.push(
        ...cgcQueryLines(cgc, cypher.inheritsOf(name, cgc.context), (rec) => {
          const n = rec["x.name"];
          const p = rec["x.path"];
          return typeof n === "string" ? n + (typeof p === "string" ? " " + p : "") : null;
        }),
      );
    }
  }
  const t = truncateToTokens(lines.join("\n"), maxTokens);
  return { operation: "expand", text: t.text, tokens: t.tokens, entities: [...entities], truncated: t.truncated };
};

const cgcSource = (entity: string, cgc: CgcOptions, maxTokens: number): CodemapOpResult => {
  const colon = entity.indexOf(":");
  const name = colon >= 0 ? entity.slice(0, colon) : entity;
  const fileQualifier = colon >= 0 ? entity.slice(colon + 1) : "";
  if (!name) {
    return { operation: "source", text: "source requires a name:file entity", tokens: 0, entities: [], truncated: false };
  }
  const lines: string[] = ["[cgc source: " + name + (fileQualifier ? " @ " + fileQualifier : "") + "]"];
  lines.push(
    ...cgcQueryLines(cgc, cypher.sourceOf(name, cgc.context, fileQualifier || undefined), (rec) => {
      const s = rec["f.source"];
      return typeof s === "string" ? s : null;
    }),
  );
  const t = truncateToTokens(lines.join("\n"), maxTokens);
  return { operation: "source", text: t.text, tokens: t.tokens, entities: [name], truncated: t.truncated };
};

const cgcExplore = (query: string, cgc: CgcOptions, maxTokens: number): CodemapOpResult => {
  const lines: string[] = ["[cgc explore: " + query + "]", "## symbols"];
  lines.push(
    ...cgcQueryLines(cgc, cypher.symbolSearch(query, cgc.context), (rec) => {
      const name = rec["f.name"];
      if (typeof name !== "string") return null;
      return name + " (" + (rec["f.lang"] ?? "?") + ") " + (rec["f.path"] ?? "?") + ":" + (rec["f.line_number"] ?? "?");
    }),
  );
  lines.push("## files");
  lines.push(
    ...cgcQueryLines(cgc, cypher.fileSearch(query, cgc.context), (rec) => {
      const p = rec["f.path"];
      return typeof p === "string" ? p : null;
    }),
  );
  lines.push("## hotspots");
  lines.push(
    ...cgcQueryLines(cgc, cypher.hotspots(20, cgc.context), (rec) => {
      const name = rec["f.name"];
      if (typeof name !== "string") return null;
      return name + " (complexity " + rec["f.cyclomatic_complexity"] + ") " + (rec["f.path"] ?? "?") + ":" + (rec["f.line_number"] ?? "?");
    }),
  );
  lines.push("## tests that pin the seam");
  const token = query.trim().toLowerCase();
  lines.push(
    ...cgcQueryLines(cgc, cypher.testsIn(cgc.context), (rec) => {
      const p = rec["f.path"];
      if (typeof p !== "string") return null;
      return token && p.toLowerCase().includes(token) ? p + "  (matches query)" : p;
    }),
  );
  const t = truncateToTokens(lines.join("\n"), maxTokens);
  return { operation: "explore", text: t.text, tokens: t.tokens, entities: [], truncated: t.truncated };
};

// Aggregate symbol PageRank per file (node keys are name:file), so the
// skeleton renders load-bearing modules first and budget truncation drops the
// unreferenced tail. Graph-structural only: no file-content scoring.
const fileRankFromGraph = (graph: CodeGraph): Map<string, number> => {
  const scores = pageRank(graph.nodeKeys, graph.edges);
  const byFile = new Map<string, number>();
  for (const key of graph.nodeKeys) {
    const colon = key.indexOf(":");
    if (colon < 0) continue;
    const file = key.slice(colon + 1);
    byFile.set(file, (byFile.get(file) ?? 0) + (scores.get(key) ?? 0));
  }
  return byFile;
};

const astExplore = (query: string, root: string, maxTokens: number): CodemapOpResult => {
  const { graph, disclosure, literals } = getCodeGraph(root);
  const lines: string[] = ["[ast explore: " + query + "]", "## skeleton"];
  lines.push(minimalSkeleton(disclosure, fileRankFromGraph(graph)));
  lines.push("## routed symbols");
  const r = route(query, { index: graph.index, literals });
  for (const s of r.symbols.slice(0, 12)) lines.push(s.name + " (" + s.symbolType + ") " + s.file + ":" + s.line);
  for (const l of r.literals.slice(0, 8)) lines.push("  " + l.kind + " " + l.file + ":" + l.line);
  const topSymbol = r.symbols[0];
  const topFile = topSymbol?.file ?? r.literals[0]?.file;
  if (topFile) {
    lines.push("## co-change tests for " + topFile);
    for (const p of predictFileCascade(topFile, { cwd: root, maxCommits: 200 }).slice(0, 10)) {
      if (/test|spec/i.test(p.file)) lines.push(p.file + "  " + p.score.toFixed(3));
    }
  }
  if (topSymbol) {
    const src = readSymbolSource(graph.index, root, topSymbol.name + ":" + topSymbol.file);
    if (src.found) lines.push("## source " + topSymbol.name + " (" + src.line + "-" + src.endLine + ")");
  }
  const t = truncateToTokens(lines.join("\n"), maxTokens);
  return { operation: "explore", text: t.text, tokens: t.tokens, entities: [], truncated: t.truncated };
};

const cgcOperation = (
  operation: CodemapOperation,
  args: CodemapOpArgs,
  opts: CodemapToolOptions | undefined,
  maxTokens: number,
): CodemapOpResult => {
  const cgc = cgcToolEnabled(opts, args);
  if (!cgc) {
    return {
      operation,
      text: "cgc mode is disabled (set codemap.cgc.enabled: true in fabric.json)",
      tokens: 0,
      entities: [],
      truncated: false,
    };
  }
  switch (operation) {
    case "search":
      return cgcSearch(args.query ?? "", cgc, maxTokens);
    case "skeleton":
      return cgcSkeleton(cgc, maxTokens);
    case "expand":
      return cgcExpand(args.entities ?? [], cgc, maxTokens);
    case "source":
      return cgcSource((args.entities ?? [])[0] ?? "", cgc, maxTokens);
    case "explore":
      return cgcExplore(args.query ?? "", cgc, maxTokens);
    default:
      return {
        operation,
        text: "cgc mode does not implement " + operation + "; use mode ast or explore",
        tokens: 0,
        entities: [],
        truncated: false,
      };
  }
};

export const codemapOperation = (
  operation: CodemapOperation,
  args: CodemapOpArgs,
  root: string,
  opts?: CodemapToolOptions,
): CodemapOpResult => {
  const maxTokens = args.maxTokens ?? 4000;
  const mode = args.mode ?? "ast";
  if (mode === "cgc") return cgcOperation(operation, args, opts, maxTokens);
  if (operation === "explore") return astExplore(args.query ?? "", root, maxTokens);
  const { graph, disclosure, literals } = getCodeGraph(root);

  if (operation === "skeleton") {
    const full = minimalSkeleton(disclosure, fileRankFromGraph(graph));
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
  // Static options or a getter resolved at execute time (so the tool picks up
  // codemap.cgc config after it loads). "ast" mode is unaffected.
  cgc?: CgcToolOptions | (() => CgcToolOptions | undefined);
}

export const createCodemapTool = (deps: CodemapToolDeps = {}): ToolDefinition<any, any, any> =>
  defineTool({
    name: "codemap",
    label: "Code Map",
    description:
      "AST-compressed code map for incremental navigation. Operations: skeleton (minimal map), search (route a query to symbols/literals), focus (heat-diffuse query seeds through the graph), dwell (expand an active field and return the delta), expand (greedy neighborhood disclosure), cascade (predict co-change cascade from a seed file or symbol), source (return the AST range text of a name:file symbol key), explore (bounded staged evidence pack: skeleton, routed symbols, hotspots, test-as-spec pointers, source). mode cgc (opt-in) dispatches search/skeleton/expand/source/explore to the installed CodeGraphContext database - a separate read-only namespace for reference repos such as inspo clones, never merged into the project graph. Each response is bounded by maxTokens.",
    promptSnippet: "AST code map: skeleton, search, focus, dwell, expand, cascade, source, explore; mode cgc for the CodeGraphContext reference graph",
    promptGuidelines: [
      "Use codemap for: symbol definitions, type signatures, function/class structure, call and import relationships, and dependency neighborhoods.",
      "Call focus with a query to center the map on a task, then dwell to expand it without re-extracting.",
      "Reserve grep for: literal text inside string literals, comments, configuration files, and patterns that are not valid identifiers or code symbols.",
      "Use explore with a task query for a bounded evidence pack (skeleton, routed symbols, hotspots, seam tests, source) instead of chaining many calls.",
      "Use mode cgc with a context path (e.g. /home/ryanj/work/inspo/<repo>) to query reference repos through the installed CodeGraphContext database; it is read-only and separate from the project graph.",
    ],
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("skeleton"), Type.Literal("search"), Type.Literal("focus"), Type.Literal("dwell"),
        Type.Literal("expand"), Type.Literal("cascade"), Type.Literal("source"), Type.Literal("explore"),
      ]),
      mode: Type.Optional(Type.Union([Type.Literal("ast"), Type.Literal("cgc")], {
        description: "ast (default) uses the project graph; cgc queries the CodeGraphContext database",
      })),
      context: Type.Optional(Type.String({
        description: "CGC path prefix or named context (mode: cgc)",
      })),
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
      const cgcDeps = typeof deps.cgc === "function" ? deps.cgc() : deps.cgc;
      const result = codemapOperation(params.operation, params, root, cgcDeps ? { cgc: cgcDeps } : undefined);
      return {
        content: [{ type: "text", text: result.text }],
        details: { tokens: result.tokens, entities: result.entities, truncated: result.truncated },
      };
    },
  });
