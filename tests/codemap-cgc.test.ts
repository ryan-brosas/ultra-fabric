import { describe, expect, it, vi } from "vitest";
import {
  cgcQuery,
  cypher,
  defaultCgcRunner,
  extractCgcJson,
  runCgc,
  type CgcRunner,
} from "../src/codemap/cgc.js";

describe("cgc runner", () => {
  it("returns unavailable for a missing binary", () => {
    const runner: CgcRunner = () => {
      throw Object.assign(new Error("spawn cgc ENOENT"), { code: "ENOENT" });
    };
    const r = runCgc(runner, ["query", "x"], 30_000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("unavailable");
      expect(r.message).toMatch(/not found/i);
    }
  });

  it("returns timeout for an ETIMEDOUT subprocess", () => {
    const runner: CgcRunner = () => {
      throw Object.assign(new Error("killed"), { code: "ETIMEDOUT" });
    };
    const r = runCgc(runner, ["query", "x"], 30_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("timeout");
  });

  it("returns error with the stderr tail for a failing query", () => {
    const runner: CgcRunner = () => {
      throw Object.assign(new Error("boom"), {
        stderr: "line1\nline2\nline3\nQuery Error: bad cypher",
      });
    };
    const r = runCgc(runner, ["query", "x"], 30_000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("error");
      expect(r.message).toContain("Query Error: bad cypher");
      expect(r.message.length).toBeLessThanOrEqual(300);
    }
  });

  it("prefers a stdout diagnostic over bootstrap stderr lines when both are present", () => {
    // The cgc CLI writes "Error: Context 'x' is not registered" to stdout while
    // stderr carries only bootstrap lines; the failure message must surface the
    // actionable diagnostic, not the config noise.
    const runner: CgcRunner = () => {
      throw Object.assign(new Error("cgc exited 1"), {
        stderr: "Loaded configuration from: /home/ryanj/.codegraphcontext/.env\nUsing database: falkordb-remote\nhost: 127.0.0.1",
        stdout: "Resolving context...\nError: Context 'omniroute' is not registered. Create it with: cgc context create omniroute",
      });
    };
    const r = runCgc(runner, ["query", "x"], 30_000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("error");
      expect(r.message).toContain("not registered");
      expect(r.message).not.toContain("Loaded configuration");
      expect(r.message.length).toBeLessThanOrEqual(300);
    }
  });

  it("passes through valid stdout as ok text", () => {
    const runner: CgcRunner = () => "bootstrap\n[{\"a\":1}]";
    const r = runCgc(runner, ["query", "x"], 30_000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("[{\"a\":1}]");
  });
});

describe("extractCgcJson", () => {
  it("parses the JSON array tail after bootstrap lines", () => {
    const out = "Resolving context...\nInitializing services...\n[{\"f.name\":\"main\",\"f.path\":\"/a.ts\"}]";
    expect(extractCgcJson(out)).toEqual([{ "f.name": "main", "f.path": "/a.ts" }]);
  });

  it("strips ANSI codes before parsing", () => {
    const out = "\x1b[32m[{\"a\":1}]\x1b[0m";
    expect(extractCgcJson(out)).toEqual([{ a: 1 }]);
  });

  it("returns null for output without a JSON array", () => {
    expect(extractCgcJson("no results here")).toBeNull();
    expect(extractCgcJson("[not json]")).toBeNull();
  });

  it("repairs Rich-wrapped string values so long paths still parse", () => {
    // The cgc CLI prints query results with Rich's print_json, which wraps long
    // string values at the console width by embedding a real newline inside the
    // string literal (invalid JSON). The extractor must repair those wraps.
    const out =
      "Resolving context...\n[\n  {\n    \"f.path\": \n\"/home/ryanj/work/inspo/omniroute/open-sse/servic\nes/components/NinerouterModelList.tsx\"\n  }\n]";
    expect(extractCgcJson(out)).toEqual([
      { "f.path": "/home/ryanj/work/inspo/omniroute/open-sse/services/components/NinerouterModelList.tsx" },
    ]);
  });
});

describe("cgcQuery", () => {
  it("invokes the runner with query args and an explicit context", () => {
    const spy = vi.fn<CgcRunner>(() => "[]");
    const r = cgcQuery("MATCH (n) RETURN n", { runner: spy, context: "work" });
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(["query", "MATCH (n) RETURN n", "--context", "work"]);
  });

  it("omits --context when none is configured", () => {
    const spy = vi.fn<CgcRunner>(() => "[]");
    cgcQuery("MATCH (n) RETURN n", { runner: spy });
    expect(spy).toHaveBeenCalledWith(["query", "MATCH (n) RETURN n"]);
  });

  it("never passes a path-prefix context as --context (in-cypher scoping only)", () => {
    const spy = vi.fn<CgcRunner>(() => "[]");
    cgcQuery("MATCH (n) RETURN n", { runner: spy, context: "/home/ryanj/work/inspo/omniroute" });
    expect(spy).toHaveBeenCalledWith(["query", "MATCH (n) RETURN n"]);
  });

  it("still passes a registered CGC context name as --context", () => {
    const spy = vi.fn<CgcRunner>(() => "[]");
    cgcQuery("MATCH (n) RETURN n", { runner: spy, context: "work" });
    expect(spy).toHaveBeenCalledWith(["query", "MATCH (n) RETURN n", "--context", "work"]);
  });
});

describe("defaultCgcRunner", () => {
  it("is a function (host subprocess; never invoked in unit tests)", () => {
    expect(typeof defaultCgcRunner).toBe("function");
  });
});

describe("cypher templates", () => {
  it("tokenizes multi-word symbol searches so every token matches independently", () => {
    const q = cypher.symbolSearch("PrewalkController claimChecklistReminder");
    expect(q).toContain('"PrewalkController"');
    expect(q).toContain('"claimChecklistReminder"');
    expect(q).not.toContain('"PrewalkController claimChecklistReminder"');
  });

  it("keeps single-token symbol search shape", () => {
    const q = cypher.symbolSearch("armPrewalk");
    expect(q).toContain('f.name CONTAINS "armPrewalk"');
  });

  it("searches classes alongside functions", () => {
    const q = cypher.classSearch("PrewalkController");
    expect(q).toContain("Class");
    expect(q).toContain('"PrewalkController"');
  });

  it("scopes sourceOf by file qualifier when provided", () => {
    const q = cypher.sourceOf("execute", undefined, "src/execution-service.ts");
    expect(q).toContain('f.name = "execute"');
    expect(q).toContain('f.path CONTAINS "src/execution-service.ts"');
  });

  it("keeps name-only sourceOf unqualified", () => {
    const q = cypher.sourceOf("execute");
    expect(q).toContain('f.name = "execute"');
    expect(q).not.toContain("f.path CONTAINS");
  });

  it("excludes vendored paths from hotspots when scoped by path prefix", () => {
    const q = cypher.hotspots(20, "/repo/checkout");
    expect(q).toContain('STARTS WITH "/repo/checkout"');
    for (const noise of ["/sources/", "/bench/", "node_modules", ".min.js"]) {
      expect(q).toContain(noise);
    }
  });

  it("keeps unscoped hotspots free of exclusions", () => {
    const q = cypher.hotspots(20);
    expect(q).not.toContain("/bench/");
  });

  it("excludes vendored paths from scoped symbol search", () => {
    const q = cypher.symbolSearch("execute", "/repo/checkout");
    expect(q).toContain("/bench/");
    expect(q).toContain("/sources/");
  });
});
