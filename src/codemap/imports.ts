import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import type { RankEdge } from "./rank.js";
import { SUPPORTED_EXTS } from "./lang.js";

// Limitation: ast-grep outline emits zero items with isImport=true even on files
// whose first line is an import statement (verified on src/lifecycle/store.ts —
// 21 definition items, 0 import items). CodeGraphContext find_importers also
// returns empty without a forced index. So import edges are extracted directly
// by scanning source files for relative import specifiers and resolving them to
// sibling .ts files. This is deterministic, dependency-free, and covers the
// first-party graph that matters for ranking.

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".pi"]);

const walkSources = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkSources(full, acc);
    else if (SUPPORTED_EXTS.some((ext) => entry.endsWith(ext))) acc.push(full);
  }
  return acc;
};

// Match static from-imports, CommonJS require(), dynamic import(), and
// bare side-effect imports (import "./polyfill.js").
const IMPORT_RE = /(?:from\s+|require\(\s*|import\(\s*|import\s+)["']([^"']+)["']/g;

export interface ImportEdgeResult {
  nodes: string[];
  edges: RankEdge[];
}

export const extractImportEdges = (root: string): ImportEdgeResult => {
  const absRoot = resolve(root);
  const toRel = (abs: string): string => relative(absRoot, abs).split(sep).join("/");
  const files = walkSources(absRoot);
  const nodes = files.map(toRel);
  const nodeSet = new Set(nodes);
  const edges: RankEdge[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(src)) !== null) {
      const spec = match[1]!;
      // Skip bare package specifiers (node:fs, vitest, etc.)
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      const target = resolve(dirname(file), spec).replace(/\.js$/, ".ts");
      // Extensionless specifiers resolve by trying the supported source
      // extensions in order against the indexed node set.
      const candidates = /\.(ts|tsx|js|jsx|mts|cts)$/.test(target)
        ? [target]
        : SUPPORTED_EXTS.map((ext) => target + ext);
      for (const candidate of candidates) {
        const rel = toRel(candidate);
        if (nodeSet.has(rel)) {
          edges.push({ from: toRel(file), to: rel, weight: 1, kind: "imports" });
          break;
        }
      }
    }
  }
  return { nodes, edges };
};

// Unit-testable helpers for the specifier rewrite logic.