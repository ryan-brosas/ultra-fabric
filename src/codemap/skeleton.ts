import type { OutlineFile } from "./outline.js";

// AST-compressed signature view, the multi-language analogue of LocAgent's
// CompressTransformer (inspo/locagent/plugins/location_tools/utils/compress_file.py:
// "Replaces function body with ...", keeping ClassDef/FunctionDef). Where LocAgent
// uses libcst on Python, we render ast-grep outline: declarations and member names
// survive, bodies are elided. This is the "LSP but AST compressed" primitive.

// Cut a declaration signature at the first body-open marker ('{' block or '=>'
// arrow) and replace the body with '...'. Signatures with no body marker pass
// through unchanged.
const elideBody = (signature: string): string => {
  if (!signature) return "";
  const candidates: Array<[number, string]> = [];
  const brace = signature.indexOf("{");
  if (brace >= 0) candidates.push([brace, "{"]);
  const arrow = signature.indexOf("=>");
  if (arrow >= 0) candidates.push([arrow, "=>"]);
  if (candidates.length === 0) return signature.trim();
  candidates.sort((a, b) => a[0] - b[0]);
  const [cut, marker] = candidates[0]!;
  return signature.slice(0, cut).trimEnd() + " " + marker + " ...";
};

// Member-level disclosure (G5): render one symbol instead of the whole file.
// An item renders its elided signature and member names; a member renders as
// enclosing.member with its line. Unknown names render empty so the caller can
// fall back to charging the file path.
export const renderSymbolSkeleton = (file: OutlineFile, symbolName: string): string => {
  const item = file.items.find((i) => i.name === symbolName && !i.isImport);
  if (item) {
    const head = elideBody(item.signature) || item.name + " (" + item.symbolType + ")";
    const lines = [file.path + "\n  " + item.range.line + ": " + head];
    for (const m of item.members) lines.push("       " + m.name + " (" + m.symbolType + ")");
    return lines.join("\n");
  }
  for (const parent of file.items) {
    const member = parent.members.find((m) => m.name === symbolName);
    if (member) {
      return file.path + "\n  " + member.range.line + ": " + parent.name + "." + member.name + " (" + member.symbolType + ")";
    }
  }
  return "";
};

export const renderFileSkeleton = (file: OutlineFile): string => {
  const lines: string[] = [file.path];
  for (const item of file.items) {
    if (item.isImport) continue;
    const head = elideBody(item.signature) || item.name + " (" + item.symbolType + ")";
    lines.push("  " + item.range.line + ": " + head);
    for (const m of item.members) {
      lines.push("       " + m.name + " (" + m.symbolType + ")");
    }
  }
  return lines.join("\n");
};

