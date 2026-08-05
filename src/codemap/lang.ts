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

import { execFileSync } from "node:child_process";

// Discover source files under `src/` for any supported language. Replaces the
// hardcoded `find src -name "*.ts"` so the index covers a polyglot tree.
export const findSourceFiles = (root: string, extensions?: readonly string[]): string[] => {
  const exts = extensions ?? SUPPORTED_EXTS;
  const args = ["src", "-type", "f"];
  for (let i = 0; i < exts.length; i++) {
    args.push(i === 0 ? "(" : "-o");
    args.push("-name", "*" + exts[i]!);
  }
  args.push(")");
  return execFileSync("find", args, { encoding: "utf8", cwd: root, maxBuffer: 10 * 1024 * 1024 })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
};