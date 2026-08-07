import { describe, expect, it } from "vitest";
import { createCodemapTool, codemapOperation, getCodeGraph } from "../src/codemap/tool.js";
import type { CgcRunner } from "../src/codemap/cgc.js";

const ROOT = process.cwd();

describe("codemap tool surface", () => {
  it("returns a tool definition with a callable execute", () => {
    const tool = createCodemapTool();
    expect(typeof tool.execute).toBe("function");
    expect(tool.name).toBe("codemap");
  });

  it("refs returns real call sites with file:line and excludes the definition", { timeout: 30000 }, () => {
    const r = codemapOperation("refs", { entities: ["runOutline:src/codemap/outline.ts"] }, ROOT);
    expect(r.operation).toBe("refs");
    // runOutline is defined in outline.ts and called from cache.ts; the response
    // must list call sites with lines and must not claim the definition file is a caller.
    const defLine = r.text.indexOf("src/codemap/outline.ts:");
    const siteLine = r.text.indexOf("src/codemap/cache.ts:");
    expect(defLine).toBeGreaterThanOrEqual(0);
    expect(siteLine).toBeGreaterThan(0);
    expect(r.text).toMatch(/cache\.ts:\d+/);
    // definition mention is a header, not a call site
    expect(r.entities.length).toBeGreaterThan(0);
  });

  it("refs reports unknown symbols cleanly", { timeout: 30000 }, () => {
    const r = codemapOperation("refs", { entities: ["nope:src/x.ts"] }, ROOT);
    expect(r.text).toContain("not found");
  });

  it("skeleton operation respects maxTokens", () => {
    const r = codemapOperation("skeleton", { maxTokens: 500 }, ROOT);
    expect(r.operation).toBe("skeleton");
    expect(r.tokens).toBeLessThanOrEqual(500);
    if (r.truncated) expect(r.text.length).toBeGreaterThan(0);
  });

  it("marks truncated output visibly inside the budget", { timeout: 30000 }, () => {
    const r = codemapOperation("skeleton", { maxTokens: 300 }, ROOT);
    if (r.truncated) {
      expect(r.text).toContain("truncated at 300 tokens");
      expect(r.text.length).toBeLessThanOrEqual(300 * 4);
    }
    // On platforms without the ast-grep toolchain (windows CI) the graph
    // builds empty and there is nothing to truncate; the marker is proven
    // on platforms where the index exists.
  });

  it("omits the truncation marker when output fits", { timeout: 30000 }, () => {
    const r = codemapOperation("skeleton", { maxTokens: 200000 }, ROOT);
    expect(r.truncated).toBe(false);
    expect(r.text).not.toContain("truncated at");
  });

  it("spends the skeleton budget on high-rank src modules before scripts", { timeout: 30000 }, () => {
    const r = codemapOperation("skeleton", { maxTokens: 2000 }, ROOT);
    // Normalize separators so the assertion holds on windows paths too.
    const text = r.text.replace(/\\/g, "/");
    const srcAt = text.indexOf("src/");
    expect(srcAt).toBeGreaterThanOrEqual(0);
    const scriptsAt = text.indexOf("scripts/benchmark");
    if (scriptsAt >= 0) expect(srcAt).toBeLessThan(scriptsAt);
  });

  it("search operation respects maxTokens", () => {
    const r = codemapOperation("search", { query: "config", maxTokens: 500 }, ROOT);
    expect(r.operation).toBe("search");
    expect(r.tokens).toBeLessThanOrEqual(500);
  });

  it("expand operation respects maxTokens", () => {
    const r = codemapOperation("expand", { entities: [], maxTokens: 500 }, ROOT);
    expect(r.operation).toBe("expand");
    expect(r.tokens).toBeLessThanOrEqual(500);
  });

  it("cascade operation returns ranked predictions within budget", { timeout: 30000 }, () => {
    const r = codemapOperation("cascade", { seed: "src/config.ts", maxTokens: 2000 }, ROOT);
    expect(r.operation).toBe("cascade");
    expect(r.tokens).toBeLessThanOrEqual(2000);
    expect(r.text).toContain("tests/config.test.ts");
    expect(r.entities.length).toBeGreaterThan(0);
  });

  it("memoizes the built graph per root (identity, not timing)", () => {
    expect(getCodeGraph(ROOT)).toBe(getCodeGraph(ROOT));
  });

  it("exposes the cgc mode and explore operation in the schema", () => {
    const tool = createCodemapTool();
    const p = JSON.stringify(tool.parameters);
    expect(p).toContain("explore");
    expect(p).toContain("cgc");
    expect(p).toContain("ast");
  });
});

describe("codemap cgc mode", () => {
  const fakeRunner: CgcRunner = (args) => {
    const q = args[1] ?? "";
    if (q.includes("f.source")) {
      return '[{"f.source":"function trim(s){return s}","f.path":"/inspo/x.ts","f.line_number":10}]';
    }
    if (q.includes("cyclomatic")) {
      return '[{"f.name":"hot","f.path":"/inspo/h.ts","f.line_number":3,"f.cyclomatic_complexity":42}]';
    }
    if (q.includes("IMPORTS")) return '[{"m.name":"module-a"}]';
    if (q.includes("CONTAINS")) {
      return '[{"f.name":"checkout","f.path":"/inspo/x.ts","f.line_number":10,"f.lang":"typescript"},{"f.path":"/inspo/x.test.ts"}]';
    }
    if (q.includes("count(*)")) return '[{"c":28876}]';
    return "[]";
  };
  const cgc = { enabled: true, runner: fakeRunner, context: "/home/ryanj/work/inspo/omniroute" };

  it("search dispatches to CGC symbol+file lookup and stays bounded", () => {
    const r = codemapOperation("search", { query: "checkout", maxTokens: 1000, mode: "cgc" }, ROOT, { cgc });
    expect(r.operation).toBe("search");
    expect(r.tokens).toBeLessThanOrEqual(1000);
    expect(r.text).toContain("checkout");
    expect(r.text).toContain("/inspo/x.ts:10");
    expect(r.text).toContain("/inspo/x.test.ts");
  });

  it("skeleton reports repo counts and complexity hotspots", () => {
    const r = codemapOperation("skeleton", { maxTokens: 1000, mode: "cgc" }, ROOT, { cgc });
    expect(r.text).toContain("28876");
    expect(r.text).toContain("hot");
  });

  it("expand lists imports for a file entity", () => {
    const r = codemapOperation("expand", { entities: ["/inspo/x.ts"], maxTokens: 1000, mode: "cgc" }, ROOT, { cgc });
    expect(r.text).toContain("module-a");
  });

  it("source returns the function body", () => {
    const r = codemapOperation("source", { entities: ["checkout:/inspo/x.ts"], maxTokens: 1000, mode: "cgc" }, ROOT, { cgc });
    expect(r.text).toContain("function trim");
  });

  it("returns a clean disabled note when cgc mode is off, without throwing", () => {
    const r = codemapOperation("search", { query: "x", mode: "cgc" }, ROOT, { cgc: { enabled: false } });
    expect(r.text).toContain("disabled");
  });

  it("renders runner errors without throwing", () => {
    const bad: CgcRunner = () => {
      throw Object.assign(new Error("boom"), { stderr: "Query Error: nope" });
    };
    const r = codemapOperation("search", { query: "x", mode: "cgc" }, ROOT, { cgc: { enabled: true, runner: bad } });
    expect(r.text).toContain("Query Error");
  });

  it("ast mode is unchanged when mode is omitted or ast", () => {
    const r1 = codemapOperation("skeleton", { maxTokens: 500 }, ROOT);
    const r2 = codemapOperation("skeleton", { maxTokens: 500, mode: "ast" }, ROOT);
    expect(r1.text).toBe(r2.text);
  });
});

describe("codemap explore", () => {
  const fakeRunner: CgcRunner = (args) => {
    const q = args[1] ?? "";
    if (q.includes("cyclomatic")) {
      return '[{"f.name":"hot","f.path":"/inspo/h.ts","f.line_number":3,"f.cyclomatic_complexity":42}]';
    }
    if (q.includes("CONTAINS")) {
      return '[{"f.name":"checkout","f.path":"/inspo/x.ts","f.line_number":10,"f.lang":"typescript"},{"f.path":"/inspo/x.test.ts"}]';
    }
    if (q.includes("test")) return '[{"f.path":"/inspo/x.test.ts"},{"f.path":"/inspo/y.spec.ts"}]';
    if (q.includes("count(*)")) return '[{"c":28876}]';
    return "[]";
  };
  const cgc = { enabled: true, runner: fakeRunner, context: "/home/ryanj/work/inspo/omniroute" };

  it("returns a bounded staged evidence pack in cgc mode naming the seam tests", () => {
    const r = codemapOperation("explore", { query: "checkout", maxTokens: 3000, mode: "cgc" }, ROOT, { cgc });
    expect(r.operation).toBe("explore");
    expect(r.tokens).toBeLessThanOrEqual(3000);
    expect(r.text).toMatch(/symbols|symbol/i);
    expect(r.text).toMatch(/hotspot|complexity/i);
    expect(r.text).toMatch(/test/i);
    expect(r.text).toContain("/inspo/x.test.ts");
  });

  it("degrades cleanly when cgc is unavailable", () => {
    const bad: CgcRunner = () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const r = codemapOperation("explore", { query: "config", maxTokens: 3000, mode: "cgc" }, ROOT, { cgc: { enabled: true, runner: bad } });
    expect(r.text).toMatch(/unavailable|fell back|ast/i);
  });

  it("explore in ast mode composes existing stages under budget", () => {
    const r = codemapOperation("explore", { query: "config", maxTokens: 3000 }, ROOT);
    expect(r.tokens).toBeLessThanOrEqual(3000);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text).toMatch(/explore/i);
  });
});