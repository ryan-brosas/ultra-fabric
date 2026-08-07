import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runOutline } from "../src/codemap/outline.js";
import { buildSymbolIndex } from "../src/codemap/symbols.js";
import { buildAllEdges } from "../src/codemap/build.js";
import { langForFile } from "../src/codemap/lang.js";

const dir = join("/tmp", "codemap-polyglot");

describe("polyglot index", () => {
  it("indexes symbols from ts, go, py, rs, and java using per-language ast-grep", () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // Each language declares polyglotFoo; go/rs/py also call it from main so
    // buildAllEdges exercises per-language ast-grep run.
    writeFileSync(join(dir, "a.ts"), "export function polyglotFoo() {}\nfunction main() { polyglotFoo(); }\n");
    writeFileSync(join(dir, "a.go"), "package main\nfunc polyglotFoo() {}\nfunc main() { polyglotFoo() }\n");
    writeFileSync(join(dir, "a.py"), "def polyglotFoo():\n    pass\ndef main():\n    polyglotFoo()\n");
    writeFileSync(join(dir, "a.rs"), "fn polyglotFoo() {}\nfn main() { polyglotFoo(); }\n");
    writeFileSync(join(dir, "a.java"), "public class A { public static void polyglotFoo() {} void main() { polyglotFoo(); } }\n");

    const files = ["a.ts", "a.go", "a.py", "a.rs", "a.java"];
    // Each file maps to a known ast-grep language (not a constant 'ts').
    const langs = new Set(files.map((f) => langForFile(f)));
    expect(langs.has("ts")).toBe(true);
    expect(langs.has("go")).toBe(true);
    expect(langs.has("python")).toBe(true);
    expect(langs.has("rust")).toBe(true);
    expect(langs.has("java")).toBe(true);

    const outline = runOutline(files, { cwd: dir });
    const index = buildSymbolIndex(outline);
    const fooNodes = index.byName.get("polyglotFoo") ?? [];
    const fooFiles = new Set(fooNodes.map((n) => n.file));
    // At least one symbol from each language appears in the index.
    for (const f of files) expect(fooFiles.has(f)).toBe(true);

    // Per-language call extraction produces at least one invokes edge
    // (main -> polyglotFoo) from the polyglot tree.
    const edges = buildAllEdges(index, dir);
    const invokes = edges.filter((e) => e.kind === "invokes");
    expect(invokes.length).toBeGreaterThan(0);
    expect(invokes.some((e) => e.to.includes("polyglotFoo"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});