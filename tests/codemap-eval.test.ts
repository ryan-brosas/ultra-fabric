import { describe, expect, it } from "vitest";
import { extractQueryIdentifiers } from "../src/codemap/eval.js";



describe("extractQueryIdentifiers", () => {
  it("yields settleContinuation and drops fix, keeps scope prewalk and guard", () => {
    const ids = extractQueryIdentifiers("fix(prewalk): guard settleContinuation");
    expect(ids).toContain("settleContinuation");
    expect(ids).not.toContain("fix");
    // guard is 5 chars and not a stopword, so it stays
    expect(ids).toContain("guard");
    // prewalk is the conventional-commit scope, extracted separately
    expect(ids).toContain("prewalk");
  });

  it("drops stopwords and short tokens", () => {
    const ids = extractQueryIdentifiers("add the new config field for roleModels");
    expect(ids).toContain("roleModels");
    expect(ids).toContain("config");
    expect(ids).toContain("field");
    expect(ids).not.toContain("add");
    expect(ids).not.toContain("the");
    expect(ids).not.toContain("new");
    expect(ids).not.toContain("for");
  });

  it("handles messages without conventional-commit prefixes", () => {
    const ids = extractQueryIdentifiers("Close Fabric control loop without discarding runtime");
    expect(ids).toContain("Fabric");
    expect(ids).toContain("control");
    expect(ids).toContain("loop");
    expect(ids).toContain("discarding");
    expect(ids).toContain("runtime");
    // Close is 5 chars and not a stopword, so it stays
    expect(ids).toContain("Close");
    // without is 7 chars and not a stopword, so it stays
    expect(ids).toContain("without");
  });
});