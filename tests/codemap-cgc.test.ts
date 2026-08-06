import { describe, expect, it, vi } from "vitest";
import {
  cgcQuery,
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
