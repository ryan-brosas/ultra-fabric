import { describe, expect, it } from "vitest";
import { classifyIntent, buildPlan, updateHealth } from "../src/evidence/route.js";
import { executePlan } from "../src/evidence/execute.js";

const webA = { name: "exa.omniroute_web_search", description: "Performs web search using OmniRoute's search gateway.", inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "integer" } } } };
const webB = { name: "serena.web_search", description: "Searches the web for a query string and returns results.", inputSchema: { type: "object", properties: { query: { type: "string" } } } };
const fetchTool = { name: "exa.omniroute_web_fetch", description: "Fetches and extracts content from a URL.", inputSchema: { type: "object", properties: { url: { type: "string" } } } };
const wikiTool = { name: "deepwiki.ask_question", description: "Ask any question about a GitHub repository.", inputSchema: { type: "object", properties: { repoName: { type: "string" }, question: { type: "string" } } } };

const tools = [webA, webB, fetchTool, wikiTool];

describe("classifyIntent", () => {
  it("classifies URL, repo, docs, and bare queries", () => {
    expect(classifyIntent("https://example.com/page")).toBe("web-fetch");
    expect(classifyIntent("how does github.com/facebook/react handle state?")).toBe("repo-wiki");
    expect(classifyIntent("cloudflare workers documentation")).toBe("docs-search");
    expect(classifyIntent("best way to test async code")).toBe("web-search");
  });
});

describe("buildPlan", () => {
  it("ranks capable tools and ignores incapable ones", () => {
    const plan = buildPlan("web-search", tools, new Map());
    expect(plan.intent).toBe("web-search");
    expect(plan.attempts.map((a) => a.tool).sort()).toEqual([webA.name, webB.name]);
  });

  it("rotates fairly: a recently used tool is deprioritized on the next plan", () => {
    let health = new Map();
    const first = buildPlan("web-search", tools, health);
    // simulate using the first attempt successfully at t=100
    health = updateHealth(health, first.attempts[0]!.tool, true, 100, 0.3);
    const second = buildPlan("web-search", tools, health);
    expect(second.attempts[0]!.tool).not.toBe(first.attempts[0]!.tool);
  });

  it("falls back to a healthier tool after a recorded failure", () => {
    const health = updateHealth(new Map(), webA.name, false, 100, 0.3);
    const plan = buildPlan("web-search", tools, health);
    expect(plan.attempts[0]!.tool).toBe(webB.name);
  });

  it("applies deny, pin, and maxAttempts", () => {
    const denied = buildPlan("web-search", tools, new Map(), { deny: [webA.name] });
    expect(denied.attempts.map((a) => a.tool)).toEqual([webB.name]);
    const pinned = buildPlan("web-search", tools, new Map(), { pin: [webB.name] });
    expect(pinned.attempts[0]!.tool).toBe(webB.name);
    const capped = buildPlan("web-search", tools, new Map(), {}, { maxAttempts: 1 });
    expect(capped.attempts).toHaveLength(1);
  });
});

describe("updateHealth", () => {
  it("is deterministic with explicit now and alpha", () => {
    const h = updateHealth(new Map(), "x", true, 1000, 0.3);
    const e = h.get("x")!;
    expect(e.successRate).toBeCloseTo(1.0);
    expect(e.lastUsedAt).toBe(1000);
    expect(e.usedCount).toBe(1);
    const f = updateHealth(h, "x", false, 2000, 0.3);
    expect(f.get("x")!.successRate).toBeCloseTo(0.7);
  });
});

describe("executePlan", () => {
  it("returns the first success and records provenance", async () => {
    const calls: string[] = [];
    const exec = async (server: string, tool: string) => {
      calls.push(tool);
      if (tool === webB.name) return "B-result";
      throw new Error("boom");
    };
    const plan = buildPlan("web-search", tools, new Map());
    const out = await executePlan(plan, exec, () => {});
    expect(out.results).toBe("B-result");
    expect(calls).toEqual([webA.name, webB.name]);
    expect(out.provenance.attempts).toHaveLength(2);
    expect(out.provenance.attempts[0]!.ok).toBe(false);
    expect(out.provenance.attempts[1]!.ok).toBe(true);
  });

  it("reports failure provenance when every attempt errors", async () => {
    const exec = async () => { throw new Error("all down"); };
    const plan = buildPlan("web-search", tools, new Map());
    const out = await executePlan(plan, exec, () => {});
    expect(out.results).toBeUndefined();
    expect(out.provenance.attempts.every((a) => !a.ok)).toBe(true);
  });
});
