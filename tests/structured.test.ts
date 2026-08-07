import { describe, expect, it } from "vitest";
import { formatFabricValue } from "../src/ui/structured.js";

describe("formatFabricValue", () => {
  const value = { status: "completed", findings: [{ fixed: true }] };

  it("formats structured auto results as YAML", () => {
    const formatted = formatFabricValue(value, "auto");
    expect(formatted.language).toBe("yaml");
    expect(formatted.text).toContain("status: completed");
    expect(formatted.text).toContain("- fixed: true");
    expect(formatted.text).not.toContain("{\n");
  });

  it("preserves explicit JSON and text modes", () => {
    expect(formatFabricValue(value, "json")).toEqual({
      text: JSON.stringify(value, null, 2),
      language: "json",
    });
    expect(formatFabricValue({ text: "plain result", metadata: true }, "text")).toEqual({
      text: "plain result",
    });
  });

  it("keeps string values unchanged in auto mode", () => {
    expect(formatFabricValue("already textual", "auto")).toEqual({ text: "already textual" });
  });
});

describe("multi-line string fidelity", () => {
  // A multi-line string nested in a returned object must reach the model with
  // its exact bytes. YAML literal block scalars indent every content line, so
  // text transcribed from the display (e.g. into pi.edit oldText) does not
  // match the file on disk.
  const file = "function x() {\n    stopLoader();\n        deep();\n}";

  it("hoists multi-line strings so content keeps its exact bytes", () => {
    const formatted = formatFabricValue({ content: file }, "auto");
    // content appears verbatim: 4-space and 8-space indents intact
    expect(formatted.text).toContain("\n    stopLoader();\n");
    expect(formatted.text).toContain("\n        deep();\n");
    // never as a re-indented YAML block scalar
    expect(formatted.text).not.toContain("      stopLoader();");
    expect(formatted.text).not.toMatch(/\|\d?-/);
  });

  it("labels hoisted sections with their value path", () => {
    const formatted = formatFabricValue(
      { results: ["one\ntwo", { note: "a\nb" }] },
      "auto",
    );
    expect(formatted.text).toContain("results[0]");
    expect(formatted.text).toContain("results[1].note");
    expect(formatted.text).toContain("one\ntwo");
    expect(formatted.text).toContain("a\nb");
  });

  it("shares an output budget across every multiline section", () => {
    const section = (name: string) => `${name}-start\n${name.repeat(4_000)}\n${name}-end`;
    const formatted = formatFabricValue(
      { first: section("a"), middle: section("b"), last: section("c") },
      "auto",
      4_000,
    );

    expect(formatted.text.length).toBeLessThanOrEqual(4_000);
    for (const [path, name] of [["first", "a"], ["middle", "b"], ["last", "c"]]) {
      expect(formatted.text).toContain(`--- ${path}`);
      expect(formatted.text).toContain(`${name}-start`);
      expect(formatted.text).toContain(`${name}-end`);
    }
    expect(formatted.text.match(/chars omitted/g)).toHaveLength(3);
  });

  it("keeps single-line strings inline in the YAML skeleton", () => {
    const formatted = formatFabricValue({ a: "x", b: 1 }, "auto");
    expect(formatted).toEqual({ text: "a: x\nb: 1", language: "yaml" });
  });

  it("bounds YAML highlighting to the skeleton when raw sections are appended", () => {
    const formatted = formatFabricValue({ content: file }, "auto");
    expect(formatted.language).toBe("yaml");
    expect(formatted.highlightedLineCount).toBe(1);
    expect(formatted.text.split("\n")[formatted.highlightedLineCount! + 1]).toMatch(
      /^--- content/,
    );
  });
});

describe("pathological scalar-array elision", () => {
  it("elides oversized arrays of short scalars in YAML and JSON modes", () => {
    const keys = Array.from({ length: 10_000 }, (_, i) => `key-${i}`);
    const value = { keys };

    const yaml = formatFabricValue(value, "yaml", 100_000);
    expect(yaml.text.length).toBeLessThan(2_000);
    expect(yaml.text).toContain("elided");

    const json = formatFabricValue(value, "json", 100_000);
    expect(json.text.length).toBeLessThan(2_000);
    expect(json.text).toContain("elided");
  });

  it("leaves small arrays and structured arrays untouched", () => {
    const small = formatFabricValue({ a: [1, 2, 3], b: ["x", "y"] }, "yaml");
    expect(small.text).not.toContain("elided");

    // Arrays of objects are not elidable scalars; the sample must not break
    // the hoisted-section path for multiline content inside them.
    const nested = formatFabricValue(
      { rows: [{ file: "a.ts\nb" }, { file: "c.ts\nd" }] },
      "auto",
    );
    expect(nested.text).toContain("rows[0].file");
    expect(nested.text).not.toContain("elided");
  });
});
