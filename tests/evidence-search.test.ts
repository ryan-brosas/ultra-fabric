import { describe, expect, it } from "vitest";
import { argsForIntent, runSearchWithDeps, type EvidenceExec, type EvidenceRecord } from "../src/evidence/execute.js";
import { updateHealth } from "../src/evidence/route.js";
import type { EvidenceToolShape } from "../src/evidence/classify.js";

const webA: EvidenceToolShape = { name: "exa.omniroute_web_search", description: "Performs web search using OmniRoute's search gateway.", inputSchema: { type: "object", properties: { query: { type: "string" } } } };
const webB: EvidenceToolShape = { name: "serena.web_search", description: "Searches the web for a query string and returns results.", inputSchema: { type: "object", properties: { query: { type: "string" } } } };
const fetchTool: EvidenceToolShape = { name: "exa.omniroute_web_fetch", description: "Fetches and extracts content from a URL.", inputSchema: { type: "object", properties: { url: { type: "string" } } } };

const enumerate = async () => [webA, webB, fetchTool];

describe("argsForIntent", () => {
  it("shapes args per intent", () => {
    expect(argsForIntent("web-fetch", "https://example.com/x")).toEqual({ url: "https://example.com/x" });
    expect(argsForIntent("repo-wiki", "how does github.com/facebook/react render?")).toEqual({ repoName: "facebook/react", question: "how does github.com/facebook/react render?" });
    expect(argsForIntent("web-search", "best way to test async")).toEqual({ query: "best way to test async" });
  });
});

describe("runSearchWithDeps", () => {
  it("falls back across attempts and returns provenance", async () => {
    const calls: string[] = [];
    const exec: EvidenceExec = async (server, tool) => {
      calls.push(tool);
      if (tool === webB.name) return "B-result";
      throw new Error("boom");
    };
    const records: Array<[string, boolean, number]> = [];
    const record: EvidenceRecord = (tool, ok, ms) => records.push([tool, ok, ms]);
    const out = await runSearchWithDeps("some web query", enumerate, new Map(), {}, { maxAttempts: 3 }, exec, record);
    expect(out.intent).toBe("web-search");
    expect(out.results).toBe("B-result");
    expect(calls).toEqual([webA.name, webB.name]);
    expect(out.provenance.attempts[0]!.ok).toBe(false);
    expect(out.provenance.attempts[0]!.category).toBeDefined();
    expect(out.provenance.attempts[0]!.recovery!.length).toBeGreaterThan(20);
    expect(out.provenance.attempts[1]!.ok).toBe(true);
    expect(out.provenance.attempts[1]!.recovery).toBeUndefined();
    expect(out.provenance.attempts[1]!.server).toBe("serena");
    expect(out.toolsAvailable).toBe(3);
    expect(records[0]![0]).toBe(webA.name);
    expect(records[0]![1]).toBe(false);
    expect(records[1]![0]).toBe(webB.name);
    expect(records[1]![1]).toBe(true);
  });

  it("reports total failure with provenance when every attempt errors", async () => {
    const exec: EvidenceExec = async () => { throw new Error("all down"); };
    const out = await runSearchWithDeps("q", enumerate, new Map(), {}, { maxAttempts: 2 }, exec, () => {});
    expect(out.results).toBeUndefined();
    expect(out.provenance.attempts).toHaveLength(2);
    expect(out.provenance.attempts.every((a) => !a.ok)).toBe(true);
  });

  it("feeds health so the next plan prefers the healthier tool", async () => {
    let health = new Map();
    const exec: EvidenceExec = async (server, tool) => { void server; return tool + "-ok"; };
    await runSearchWithDeps("q", enumerate, health, {}, { maxAttempts: 1 }, exec, (tool, ok, ms) => {
      health = updateHealth(health, tool, ok, 100);
    });
    // first plan used webA (tie-break by stable order); record a failure for it
    health = updateHealth(health, webA.name, false, 200);
    const { buildPlan } = await import("../src/evidence/route.js");
    const plan = buildPlan("web-search", [webA, webB], health);
    expect(plan.attempts[0]!.tool).toBe(webB.name);
  });
});
