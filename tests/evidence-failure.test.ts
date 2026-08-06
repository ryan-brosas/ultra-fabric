import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/evidence/failure.js";

// PALADIN-adapted failure taxonomy (sources/PALADIN/data/toolscan_taxonomy_map.json)
// with per-category recovery guidance (recovery_dictionary.json). Pure text rules.

const cases: Array<[string, string]> = [
  ["NoSuchToolError: tool omniroute_web_search not found", "tool-not-found"],
  ["Error: ENOENT: no such file or directory", "tool-not-found"],
  ["ModuleNotFoundError: No module named requests", "tool-not-found"],
  ["DNS resolution error for api.example.com", "tool-not-found"],
  ["InvalidToolArgumentsError: query is required", "bad-arguments"],
  ["ValueError: invalid literal", "bad-arguments"],
  ["Request failed with status 422 Unprocessable Entity", "bad-arguments"],
  ["HTTP 400 Bad Request", "http-invocation"],
  ["401 Unauthorized", "auth"],
  ["403 Forbidden", "auth"],
  ["404 Not Found", "http-invocation"],
  ["Error 500: Internal Server Error", "http-invocation"],
  ["502 Bad Gateway from upstream", "http-invocation"],
  ["Execution timed out after 120000ms", "timeout"],
  ["408 Request Timeout", "timeout"],
  ["429 Too Many Requests", "rate-limit"],
  ["rate limit exceeded, retry later", "rate-limit"],
  ["connect ECONNREFUSED 127.0.0.1:8080", "network"],
  ["TypeError: fetch failed", "network"],
  ["something inexplicable happened", "unknown"],
];

describe("classifyFailure", () => {
  it.each(cases)("classifies %j as expected", (text, category) => {
    expect(classifyFailure(text).category).toBe(category);
  });

  it("returns non-empty actionable recovery guidance for every category", () => {
    const seen = new Set<string>();
    for (const [text] of cases) {
      const { category, recovery } = classifyFailure(text);
      seen.add(category);
      expect(recovery.length).toBeGreaterThan(20);
    }
    expect(seen.size).toBeGreaterThanOrEqual(7);
  });

  it("auth guidance warns against blind retry and rate-limit guidance says back off", () => {
    expect(classifyFailure("401 Unauthorized").recovery.toLowerCase()).toContain("credential");
    expect(classifyFailure("429 Too Many Requests").recovery.toLowerCase()).toContain("back off");
  });
});
