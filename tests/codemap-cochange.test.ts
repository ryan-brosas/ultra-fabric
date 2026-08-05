import { describe, expect, it } from "vitest";
import { mineCoChange } from "../src/codemap/cochange.js";

describe("mineCoChange", () => {
  it("finds tests/config.test.ts co-changing with src/config.ts above 50 percent", { timeout: 30000 }, () => {
    const entries = mineCoChange("src/config.ts", { maxCommits: 50 });
    const configTest = entries.find((e) => e.file === "tests/config.test.ts");
    expect(configTest).toBeDefined();
    expect(configTest!.rate).toBeGreaterThan(0.5);
  });

  it("excludes the anchor file from results", { timeout: 30000 }, () => {
    const entries = mineCoChange("src/config.ts", { maxCommits: 30 });
    expect(entries.find((e) => e.file === "src/config.ts")).toBeUndefined();
  });

  it("returns empty for a nonexistent file", () => {
    const entries = mineCoChange("nonexistent/file.ts", { maxCommits: 10 });
    expect(entries).toEqual([]);
  });
});