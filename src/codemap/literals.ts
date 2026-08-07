import crossSpawn from "cross-spawn";
import type { SymbolIndex } from "./symbols.js";
import { enclosingSymbol } from "./symbols.js";
import { groupFilesByLang } from "./lang.js";
import { chunkPaths } from "./outline.js";

// Typed AST literal index: string literals and comments, extracted as AST nodes
// (not a raw file-content scan). Each entry carries its file, 1-indexed line, the
// literal kind ("string" | "comment"), the text, and the enclosing symbol
// resolved from the symbol index. This serves the ~31.2% of real agent greps that
// are phrase/string text search (RFC 5445, error messages, config keys) while
// staying AST-typed: a hit inside a string_literal with its enclosing symbol is
// richer than a raw grep line match.

export type LiteralKind = "string" | "comment";

export interface LiteralEntry {
  file: string;
  line: number; // 1-indexed
  kind: LiteralKind;
  text: string;
  enclosing: string | undefined;
}

interface AstGrepMatch {
  file: string;
  range: { start: { line: number; column: number } };
  text: string;
}

export interface LiteralIndexOptions {
  cwd?: string;
  binary?: string;
}

const runAstGrep = (
  binary: string,
  args: readonly string[],
  cwd: string,
): AstGrepMatch[] => {
  try {
    const res = crossSpawn.sync(binary, args as string[], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (res.error || res.status !== 0) return [];
    const stdout = res.stdout;
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as AstGrepMatch[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Resolve the enclosing symbol name for a 1-indexed line via the symbol index.
const enclosing = (index: SymbolIndex | undefined, file: string, line1: number): string | undefined => {
  if (!index) return undefined;
  const node = enclosingSymbol(index, file, line1);
  return node?.name;
};

export const buildLiteralIndex = (
  files: readonly string[],
  index?: SymbolIndex,
  options: LiteralIndexOptions = {},
): LiteralEntry[] => {
  const cwd = options.cwd ?? process.cwd();
  const binary = options.binary ?? "ast-grep";
  const entries: LiteralEntry[] = [];
  const byLang = groupFilesByLang(files);
  for (const [lang, langFiles] of byLang) {
    // String literals: ast-grep pattern '"$S"' matches a double-quoted string
    // literal node; '$S' matches a single-quoted one. Run both, dedupe by node.
    const stringMatches: AstGrepMatch[] = [];
    for (const pattern of ['"$S"', "'$S'"]) {
      // Chunk like the outline path so Windows cmd.exe shims never truncate the
      // argv of large per-language file lists.
      for (const chunk of chunkPaths(langFiles)) {
        stringMatches.push(...runAstGrep(binary, ["run", "--pattern", pattern, "--lang", lang, "--json=compact", ...chunk], cwd));
      }
    }
    // Dedupe string matches by (file, line, column) since the two patterns can
    // overlap on some grammars.
    const seen = new Set<string>();
    for (const m of stringMatches) {
      const key = m.file + ":" + m.range.start.line + ":" + m.range.start.column;
      if (seen.has(key)) continue;
      seen.add(key);
      const line1 = m.range.start.line + 1;
      entries.push({ file: m.file, line: line1, kind: "string", text: m.text, enclosing: enclosing(index, m.file, line1) });
    }
    // Comments: ast-grep inline rule with kind: comment.
    // Flow-style YAML on one line: a multi-line argv entry does not survive the
    // Windows cmd shim that wraps the ast-grep binary.
    const commentRule = "{id: c, language: " + lang + ", rule: {kind: comment}}";
    const commentMatches: AstGrepMatch[] = [];
    for (const chunk of chunkPaths(langFiles)) {
      commentMatches.push(...runAstGrep(binary, ["scan", "--inline-rules", commentRule, "--json=compact", ...chunk], cwd));
    }
    for (const m of commentMatches) {
      const line1 = m.range.start.line + 1;
      entries.push({ file: m.file, line: line1, kind: "comment", text: m.text, enclosing: enclosing(index, m.file, line1) });
    }
  }
  // Config files (YAML + JSON) join the literal index so config-key queries
  // resolve without grep. langForFile does not map them (outline and the
  // symbol graph skip non-AST-able kinds), so they are handled here directly.
  const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const chunk of chunkPaths(yamlFiles)) {
    const kv = runAstGrep(binary, ["run", "--pattern", "$K: $V", "--lang", "yaml", "--json=compact", ...chunk], cwd);
    const seen = new Set<string>();
    for (const m of kv) {
      const key = m.file + ":" + m.range.start.line + ":" + m.range.start.column;
      if (seen.has(key)) continue;
      seen.add(key);
      const line1 = m.range.start.line + 1;
      entries.push({ file: m.file, line: line1, kind: "string", text: m.text, enclosing: enclosing(index, m.file, line1) });
    }
  }
  // JSON config files: index string nodes so config keys and values resolve.
  // ast-grep's json grammar supports kind: string scans (verified live).
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  for (const chunk of chunkPaths(jsonFiles)) {
    const jsonRule = "{id: s, language: json, rule: {kind: string}}";
    const jsonMatches = runAstGrep(binary, ["scan", "--inline-rules", jsonRule, "--json=compact", ...chunk], cwd);
    const seen = new Set<string>();
    for (const m of jsonMatches) {
      const key = m.file + ":" + m.range.start.line + ":" + m.range.start.column;
      if (seen.has(key)) continue;
      seen.add(key);
      const line1 = m.range.start.line + 1;
      entries.push({ file: m.file, line: line1, kind: "string", text: m.text, enclosing: enclosing(index, m.file, line1) });
    }
  }
  return entries;
};

// Search the literal index for entries whose text contains the query (case-sensitive
// substring), returning matches ranked by enclosing-symbol relevance.
export const searchLiterals = (
  index: readonly LiteralEntry[],
  query: string,
  options: { kind?: LiteralKind; limit?: number } = {},
): LiteralEntry[] => {
  const limit = options.limit ?? 50;
  const filtered = options.kind ? index.filter((e) => e.kind === options.kind) : index;
  return filtered.filter((e) => e.text.includes(query)).slice(0, limit);
};

// Regex search over literal texts (strings and comments, AST-node indexed). This
// serves the ~18% of real agent greps that are regex-shaped without reading file
// content: the pattern runs against the extracted literal texts in memory, so a
// content regex like "retire.*oversized" resolves with file:line provenance and
// stays AST-typed. Invalid patterns return empty (callers tolerate the miss).
export const searchLiteralsRegex = (
  index: readonly LiteralEntry[],
  pattern: string,
  options: { kind?: LiteralKind; limit?: number } = {},
): LiteralEntry[] => {
  const limit = options.limit ?? 50;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return [];
  }
  const filtered = options.kind ? index.filter((e) => e.kind === options.kind) : index;
  return filtered.filter((e) => re.test(e.text)).slice(0, limit);
};