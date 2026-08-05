import { mineCoChange } from "./cochange.js";
import { extractImportEdges } from "./imports.js";
import type { SymbolIndex } from "./symbols.js";
import type { RankEdge } from "./rank.js";

// Feature-pattern cascade prediction: given a seed change, predict the rest of
// the feature pattern by blending the two families compared in Change Impact
// Recommendation (arXiv 2606.21187) — history-based evolutionary coupling
// (cochange.ts) and dependency-based analysis (the AST call/import graph). The
// blend is an explicit weight so either family can be isolated.

export interface CascadeOptions {
  cwd?: string;
  historyWeight?: number; // 0..1; 1 = pure history, 0 = pure dependency
  maxCommits?: number;
}

export interface CascadePrediction {
  file: string;
  score: number;
  historyRate: number;
  dependencyScore: number;
}

const normalizeMax = (scores: Map<string, number>): Map<string, number> => {
  let max = 0;
  for (const v of scores.values()) if (v > max) max = v;
  const out = new Map<string, number>();
  for (const [k, v] of scores) out.set(k, max > 0 ? v / max : 0);
  return out;
};

// History channel: evolutionary-coupling co-change rates for a seed file.
const historyChannel = (seedFile: string, options: CascadeOptions): Map<string, number> => {
  const cwd = options.cwd ?? process.cwd();
  const maxCommits = options.maxCommits;
  const opts = maxCommits !== undefined ? { cwd, maxCommits } : { cwd };
  const entries = mineCoChange(seedFile, opts);
  const out = new Map<string, number>();
  for (const e of entries) out.set(e.file, e.rate);
  return out;
};

// File-level dependency channel: files that import or are imported by the seed.
const fileDependencyChannel = (seedFile: string, cwd: string): Map<string, number> => {
  const { edges } = extractImportEdges(cwd);
  const scores = new Map<string, number>();
  for (const e of edges) {
    if (e.from === seedFile) scores.set(e.to, (scores.get(e.to) ?? 0) + e.weight);
    if (e.to === seedFile) scores.set(e.from, (scores.get(e.from) ?? 0) + e.weight);
  }
  return normalizeMax(scores);
};

// Symbol-level dependency channel: files reachable from the seed symbol via the
// AST graph (invokes/imports/contains/inherits edges), scored by edge count.
const symbolDependencyChannel = (
  seedSymbolKey: string,
  _index: SymbolIndex,
  edges: readonly RankEdge[],
): Map<string, number> => {
  const seedFile = seedSymbolKey.split(":").slice(1).join(":");
  const scores = new Map<string, number>();
  for (const e of edges) {
    if (e.from === seedSymbolKey) {
      const f = e.to.split(":").slice(1).join(":");
      if (f !== seedFile) scores.set(f, (scores.get(f) ?? 0) + e.weight);
    }
    if (e.to === seedSymbolKey) {
      const f = e.from.split(":").slice(1).join(":");
      if (f !== seedFile) scores.set(f, (scores.get(f) ?? 0) + e.weight);
    }
  }
  return normalizeMax(scores);
};

const blend = (
  history: Map<string, number>,
  dependency: Map<string, number>,
  historyWeight: number,
): CascadePrediction[] => {
  const files = new Set<string>([...history.keys(), ...dependency.keys()]);
  const preds: CascadePrediction[] = [];
  for (const file of files) {
    const h = history.get(file) ?? 0;
    const d = dependency.get(file) ?? 0;
    preds.push({ file, score: historyWeight * h + (1 - historyWeight) * d, historyRate: h, dependencyScore: d });
  }
  return preds.sort((a, b) => b.score - a.score);
};

// Predict the cascade for a seed FILE change.
export const predictFileCascade = (seedFile: string, options: CascadeOptions = {}): CascadePrediction[] => {
  const cwd = options.cwd ?? process.cwd();
  const hw = options.historyWeight ?? 0.5;
  const history = hw > 0 ? historyChannel(seedFile, options) : new Map<string, number>();
  const dependency = hw < 1 ? fileDependencyChannel(seedFile, cwd) : new Map<string, number>();
  return blend(history, dependency, hw);
};

// Predict the cascade for a seed SYMBOL change. Uses the symbol's file for the
// history channel and the AST graph for the dependency channel, so a symbol
// with no commit history still yields dependency-derived candidates.
export const predictSymbolCascade = (
  seedSymbolKey: string,
  graph: { index: SymbolIndex; edges: readonly RankEdge[] },
  options: CascadeOptions = {},
): CascadePrediction[] => {
  const seedFile = seedSymbolKey.split(":").slice(1).join(":");
  const hw = options.historyWeight ?? 0.5;
  const history = hw > 0 ? historyChannel(seedFile, options) : new Map<string, number>();
  const dependency = hw < 1 ? symbolDependencyChannel(seedSymbolKey, graph.index, graph.edges) : new Map<string, number>();
  return blend(history, dependency, hw);
};