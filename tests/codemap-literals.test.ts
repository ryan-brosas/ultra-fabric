import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runOutline } from "../src/codemap/outline.js";
import { buildSymbolIndex } from "../src/codemap/symbols.js";
import { buildLiteralIndex, searchLiterals } from "../src/codemap/literals.js";

const root = process.cwd();
const files = ["src/codemap/calls.ts"];
const outline = runOutline(files, { cwd: root });
const index = buildSymbolIndex(outline);
const literals = buildLiteralIndex(files, index, { cwd: root });

describe("buildLiteralIndex", () => {
  it("indexes a string literal with correct line, kind, and enclosing symbol", () => {
    const hit = literals.find((e) => e.kind === "string" && e.text.includes("ast-grep"));
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("string");
    expect(hit!.enclosing).toBe("extractCallEdges");
    // "correct line": the source line at entry.line contains the literal text.
    const srcLine = readFileSync(join(root, hit!.file), "utf8").split("\n")[hit!.line - 1] ?? "";
    expect(srcLine).toContain("ast-grep");
  });

  it("indexes a comment with kind 'comment' and its enclosing symbol", () => {
    const hit = literals.find((e) => e.kind === "comment" && e.text.includes("ast-grep lines are 0-indexed"));
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("comment");
    expect(hit!.enclosing).toBe("extractCallEdges");
    expect(hit!.line).toBeGreaterThan(0);
  });

  it("does not return a declaration name as a literal", () => {
    // extractCallEdges is a function identifier, not a string literal or comment;
    // its name must not appear as a literal entry's text.
    const exact = literals.filter((e) => e.text === "extractCallEdges");
    expect(exact.length).toBe(0);
    // And searching literals for the declaration name yields no string-kind hit.
    const found = searchLiterals(literals, "extractCallEdges");
    expect(found.filter((e) => e.kind === "string").length).toBe(0);
  });
});