import { describe, expect, it } from "vitest";
import { countNewlines, isRecord, truncateMiddle } from "../src/util.js";

describe("countNewlines", () => {
  it("counts line-feed characters without normalizing other terminators", () => {
    expect(countNewlines("")).toBe(0);
    expect(countNewlines("one\ntwo\n")).toBe(2);
    expect(countNewlines("one\rtwo\r\nthree")).toBe(1);
  });
});

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1, nested: { b: "x" } })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it("rejects null, arrays, and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(Symbol("s"))).toBe(false);
  });

  it("narrows to a readable record", () => {
    const value: unknown = { key: "value" };
    if (isRecord(value)) {
      expect(value.key).toBe("value");
    } else {
      throw new Error("expected a record");
    }
  });
});

describe("truncateMiddle", () => {
  it("keeps short values and elides the middle of long ones", () => {
    expect(truncateMiddle("abc", 10)).toBe("abc");
    const out = truncateMiddle("abcdefghijklmnopqrstuvwxyz", 12);
    expect(out).toContain("characters omitted by Pi Fabric");
  });
});
