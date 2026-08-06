import { extractImportEdges } from "./imports.js";
import type { SymbolIndex, SymbolNode } from "./symbols.js";

// Import-scoped name resolution. Scope graphs (github/stack-graphs) solve this
// with per-language rule sets; the first-party import graph from imports.ts is
// the pragmatic 80%: a reference resolves to definitions in the caller's own
// file or in files the caller imports. Files whose imports are unresolvable
// (no import edge) keep the previous global-definer behavior, so recall is not
// lost where the import graph is silent (Go/Python/Rust/Java, dynamic imports).

export type ImportScope = Map<string, Set<string>>;

// Adapter: derive the per-file import scope from the file-level import graph.
export const buildImportScope = (root: string): ImportScope => {
  const { edges } = extractImportEdges(root);
  const scope: ImportScope = new Map();
  for (const e of edges) {
    if (e.kind !== "imports") continue;
    const list = scope.get(e.from);
    if (list) list.add(e.to);
    else scope.set(e.from, new Set([e.to]));
  }
  return scope;
};

export interface ResolvedDefiners {
  defs: SymbolNode[];
  // true when the import scope applied (possibly dropping definers);
  // false when the caller has no resolvable imports and global definers are used.
  scoped: boolean;
}

// Pure resolution: restrict ident definers to the caller's file plus imported
// files. Falls back to all definers when the caller has no import edges.
export const resolveDefiners = (
  index: SymbolIndex,
  scope: ImportScope,
  caller: string,
  ident: string,
): ResolvedDefiners => {
  const defs = index.byName.get(ident);
  if (!defs || defs.length === 0) return { defs: [], scoped: true };
  const imported = scope.get(caller);
  const hasScope = imported !== undefined && imported.size > 0;
  if (!hasScope) return { defs, scoped: false };
  const scoped = defs.filter((d) => d.file === caller || imported.has(d.file));
  return { defs: scoped, scoped: true };
};
