import { describe, expect, it } from "vitest";
// @ts-expect-error Release helpers are dependency-free JavaScript used directly by Node.
import { extractChangelogSection, previousVersion, buildReleaseTitle, buildReleaseBody } from "../scripts/release-notes.mjs";

const CHANGELOG = `# Changelog

## 0.31.1-ultra.13 - 2026-08-07

- exec: carry namespace.
- prewalk: handoff fix.

## 0.31.1-ultra.12 - 2026-08-07

- compaction: global threshold.

## 0.31.0 - 2026-07-30

- first release.
`;

describe("release notes", () => {
  it("extracts exactly the requested version section and stops before the next heading", () => {
    expect(extractChangelogSection(CHANGELOG, "0.31.1-ultra.13")).toBe(
      "- exec: carry namespace.\n- prewalk: handoff fix.",
    );
  });

  it("extracts a middle section without bleeding into neighbors", () => {
    const section = extractChangelogSection(CHANGELOG, "0.31.1-ultra.12");
    expect(section).toContain("global threshold");
    expect(section).not.toContain("carry namespace");
    expect(section).not.toContain("first release");
  });

  it("returns undefined for a missing version", () => {
    expect(extractChangelogSection(CHANGELOG, "9.9.9")).toBeUndefined();
  });

  it("finds the previous version heading for compare links", () => {
    expect(previousVersion(CHANGELOG, "0.31.1-ultra.13")).toBe("0.31.1-ultra.12");
    expect(previousVersion(CHANGELOG, "0.31.0")).toBeUndefined();
  });

  it("builds a detailed body with install, compare, and npm links", () => {
    const body = buildReleaseBody({
      version: "0.31.1-ultra.13",
      section: extractChangelogSection(CHANGELOG, "0.31.1-ultra.13")!,
      previousVersion: "0.31.1-ultra.12",
      repository: "https://github.com/ryan-brosas/ultra-fabric",
    });
    expect(body).toContain("pi install npm:ultra-fabric@0.31.1-ultra.13");
    expect(body).toContain("compare/v0.31.1-ultra.12...v0.31.1-ultra.13");
    expect(body).toContain("carry namespace");
    expect(buildReleaseTitle("0.31.1-ultra.13")).toBe("ultra-fabric 0.31.1-ultra.13");
  });
});
