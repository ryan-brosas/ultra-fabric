import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildCodeGraph, type CodeGraph } from "./build.js";
import { buildLiteralIndex } from "./literals.js";
import { route } from "./route.js";
import { expand, buildDisclosureGraph, minimalSkeleton, type Direction } from "./disclose.js";
import { predictFileCascade, predictSymbolCascade } from "./cascade.js";

// The codemap as an agent tool: "incremental mapping through agent discovery on
// the tools." Three operations, each bounded by an explicit token budget:
//   skeleton  - the minimal compressed map to start from
//   search    - route a query to the symbol/literal index
//   expand    - disclose more of the graph around given entities
// The graph is built once (mtime-cached) and reused across operations.

export type CodemapOperation = "skeleton" | "search" | "expand" | "cascade";

export interface CodemapOpArgs {
  query?: string;
  entities?: readonly string[];
  direction?: Direction;
  depth?: number;
  maxTokens?: number;
  seed?: string;
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
      "AST-compressed code map for incremental navigation. Operations: skeleton (minimal map), search (route a query to symbols/literals), expand (disclose graph neighbors of entities), cascade (predict co-change cascade from a seed file or symbol). Each response is bounded by maxTokens.",
    promptSnippet: "AST code map: skeleton, search, expand, cascade",
    promptGuidelines: [
      "Use codemap for: symbol definitions, type signatures, function/class structure, call and import relationships, and dependency neighborhoods.",
      "Reserve grep for: literal text inside string literals, comments, configuration files, and patterns that are not valid identifiers or code symbols.",
    ],
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("skeleton"), Type.Literal("search"), Type.Literal("expand"), Type.Literal("cascade")]),
      seed: Type.Optional(Type.String({ description: "file path or name:file symbol key to seed the cascade (operation: cascade)" })),
      query: Type.Optional(Type.String({ description: "search query (operation: search)" })),
      entities: Type.Optional(Type.Array(Type.String(), { description: "symbol keys name:file to expand from (operation: expand)" })),
      direction: Type.Optional(Type.Union([Type.Literal("upstream"), Type.Literal("downstream"), Type.Literal("both")])),
      depth: Type.Optional(Type.Number({ minimum: 1, maximum: 2 })),
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