import { describe, expect, it } from "vitest";
import { normalizeRunDisplay } from "../src/run-display.js";

describe("normalizeRunDisplay", () => {
  it("passes canonical objects through with both fields", () => {
    expect(normalizeRunDisplay({ name: "ship it", description: "objective" })).toEqual({
      name: "ship it",
      description: "objective",
    });
  });

  it("keeps partial objects", () => {
    expect(normalizeRunDisplay({ description: "objective" })).toEqual({ description: "objective" });
  });

  it("ignores unknown keys on objects, as the schema always has", () => {
    expect(normalizeRunDisplay({ name: "n", extra: 1 })).toEqual({ name: "n" });
  });

  it("repairs a bare objective string to { name }", () => {
    expect(normalizeRunDisplay("Collect package.json stats")).toEqual({ name: "Collect package.json stats" });
  });

  it("parses a JSON-stringified object, a common escaped-JSON near-miss", () => {
    expect(normalizeRunDisplay('{"name": "Probe", "description": "d"}')).toEqual({ name: "Probe", description: "d" });
  });

  it("falls back to the raw string when JSON-looking text is not a usable object", () => {
    expect(normalizeRunDisplay("{not json}")).toEqual({ name: "{not json}" });
    expect(normalizeRunDisplay("{}")).toEqual({ name: "{}" });
  });

  it("returns undefined for empty and whitespace-only strings", () => {
    expect(normalizeRunDisplay("")).toBeUndefined();
    expect(normalizeRunDisplay("   ")).toBeUndefined();
  });

  it("returns undefined for junk shapes", () => {
    expect(normalizeRunDisplay(undefined)).toBeUndefined();
    expect(normalizeRunDisplay(null)).toBeUndefined();
    expect(normalizeRunDisplay(42)).toBeUndefined();
    expect(normalizeRunDisplay(["a"])).toBeUndefined();
    expect(normalizeRunDisplay({ name: 42 })).toBeUndefined();
  });
});
