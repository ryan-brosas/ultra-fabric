import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SymbolIndex } from "./symbols.js";

// The source operation: given a name:file symbol key, return the AST range text
// of that definition (line..endLine) instead of forcing an agent to sed the
// file. The range comes from the outline index; only the slice is read. The
// caller applies the token cap (truncateToTokens in tool.ts).

export interface SourceResult {
  file: string;
  line: number;
  endLine: number;
  text: string;
  found: boolean;
}

export const readSymbolSource = (index: SymbolIndex, root: string, key: string): SourceResult => {
  const sep = key.indexOf(":");
  const name = sep >= 0 ? key.slice(0, sep) : key;
  const file = sep >= 0 ? key.slice(sep + 1) : "";
  const defs = index.byName.get(name);
  const node = defs?.find((n) => n.file === file);
  if (!node) return { file, line: 0, endLine: 0, text: "", found: false };
  try {
    const lines = readFileSync(resolve(root, file), "utf8").split("\n");
    const slice = lines.slice(node.line - 1, node.endLine);
    return { file, line: node.line, endLine: node.endLine, text: slice.join("\n"), found: true };
  } catch {
    return { file, line: node.line, endLine: node.endLine, text: "", found: false };
  }
};
