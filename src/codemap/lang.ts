// Language resolution for ast-grep. `ast-grep outline` auto-detects language from
// file extension, but `ast-grep run`/`scan` require an explicit `--lang`. This
// maps file extensions to the ast-grep language names verified to work (go,
// python, rust, java, ts). json and markdown are not AST-able and stay out of
// scope (see docs/code-map-research.md sec 9).

export const langForFile = (file: string): string | undefined => {
  const f = file.toLowerCase();
  if (f.endsWith(".ts") || f.endsWith(".tsx")) return "ts";
  if (f.endsWith(".js") || f.endsWith(".jsx") || f.endsWith(".mjs") || f.endsWith(".cjs")) return "js";
  if (f.endsWith(".go")) return "go";
  if (f.endsWith(".py")) return "python";
  if (f.endsWith(".rs")) return "rust";
  if (f.endsWith(".java")) return "java";
  return undefined;
};

// Group files by their ast-grep language, dropping files with no known language.
export const groupFilesByLang = (files: readonly string[]): Map<string, string[]> => {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const lang = langForFile(f);
    if (!lang) continue;
    const list = groups.get(lang);
    if (list) list.push(f);
    else groups.set(lang, [f]);
  }
  return groups;
};

export const SUPPORTED_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".py", ".rs", ".java"];

// Config-file extensions discovered for the literal index only: YAML/JSON keys
// and values resolve from AST nodes (not content scans) so config-key queries
// are served by codemap search instead of grep. They never enter the symbol
// graph (outline skips non-AST-able kinds per docs/code-map-research.md).
export const CONFIG_EXTS = [".yaml", ".yml", ".json"];

import { readdirSync } from "node:fs";
import { join } from "node:path";

// Discover source files under `src/`, `tests/`, and `scripts/` for any supported
// language. Paths come back root-relative with forward slashes on every platform,
// because the code map keys its graph on POSIX paths.
const SOURCE_ROOTS = ["src", "tests", "scripts"];

// Directories that never contribute to the first-party symbol graph even when a
// root walk would reach them (mirrors .cgcignore: sources/ and bench/ hold
// vendored clones and benchmark artifacts).
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".pi", "sources", "bench"]);

export const findSourceFiles = (root: string, extensions?: readonly string[]): string[] => {
  const exts = extensions ?? SUPPORTED_EXTS;
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const childRel = rel + "/" + entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(childRel);
      } else if (exts.some((ext) => entry.name.endsWith(ext))) found.push(childRel);
    }
  };
  for (const r of SOURCE_ROOTS) walk(r);
  return found.sort();
};

// Discover root-level and .pi config files for the literal index (bounded: only
// the first-party config surface, never node_modules or vendored clones).
export const findConfigFiles = (root: string): string[] => {
  const found: string[] = [];
  const configRoots = [".", ".pi"];
  for (const dir of configRoots) {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (CONFIG_EXTS.some((ext) => entry.name.endsWith(ext))) found.push(dir === "." ? entry.name : dir + "/" + entry.name);
    }
  }
  return found.sort();
};