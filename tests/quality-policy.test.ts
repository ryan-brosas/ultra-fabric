import { describe, expect, it } from "vitest";
import {
  evaluateQualityPolicy,
  planQualityChecks,
  type QualityCheckDefinition,
} from "../src/quality/policy.js";

const check = (
  id: string,
  languages: string[],
  fileMode: "append" | "none" = "append",
): QualityCheckDefinition => ({
  id,
  languages,
  command: "quality-tool",
  args: [id],
  fileMode,
  timeoutMs: 30_000,
});

describe("quality policy", () => {
  it("plans each matching check once with only its changed files", () => {
    const checks = [
      check("web", ["typescript", "html", "css"]),
      check("types", ["typescript"], "none"),
    ];

    const plan = planQualityChecks(
      [
        { path: "src/app.ts", language: "typescript" },
        { path: "public/index.html", language: "html" },
        { path: "public/site.css", language: "css" },
        { path: "src/app.ts", language: "typescript" },
      ],
      checks,
    );

    expect(plan.languages).toEqual(["typescript", "html", "css"]);
    expect(plan.uncoveredLanguages).toEqual([]);
    expect(plan.checks).toEqual([
      {
        definition: checks[0],
        languages: ["typescript", "html", "css"],
        paths: ["src/app.ts", "public/index.html", "public/site.css"],
      },
      {
        definition: checks[1],
        languages: ["typescript"],
        paths: ["src/app.ts"],
      },
    ]);
  });

  it("uses a wildcard check for custom languages and ignores binary files", () => {
    const fallback = check("fallback", ["*"]);
    const plan = planQualityChecks(
      [
        { path: "views/page.templ", language: "go-template" },
        { path: "assets/logo.bin", language: "binary" },
      ],
      [fallback],
    );

    expect(plan.languages).toEqual(["go-template"]);
    expect(plan.uncoveredLanguages).toEqual([]);
    expect(plan.checks[0]).toMatchObject({
      definition: fallback,
      languages: ["go-template"],
      paths: ["views/page.templ"],
    });
  });

  it("reports every changed language without a configured check", () => {
    const plan = planQualityChecks(
      [
        { path: "src/app.ts", language: "typescript" },
        { path: "public/index.html", language: "html" },
        { path: "notes.custom", language: "unknown" },
      ],
      [check("types", ["typescript"])],
    );

    expect(plan.uncoveredLanguages).toEqual(["html", "unknown"]);
  });

  it("passes only when every planned check succeeds and every language is covered", () => {
    const plan = planQualityChecks(
      [{ path: "src/app.ts", language: "typescript" }],
      [check("types", ["typescript"])],
    );

    expect(evaluateQualityPolicy("enforce", plan, [
      { checkId: "types", outcome: "passed", exitCode: 0 },
    ])).toEqual({ decision: "pass", issues: [] });
  });

  it("warns in audit mode and blocks in enforce mode without collapsing failure states", () => {
    const plan = planQualityChecks(
      [
        { path: "src/app.ts", language: "typescript" },
        { path: "public/index.html", language: "html" },
      ],
      [check("types", ["typescript"])],
    );
    const executions = [{ checkId: "types", outcome: "timed_out" as const }];

    const audit = evaluateQualityPolicy("audit", plan, executions);
    expect(audit.decision).toBe("warn");
    expect(audit.issues).toEqual([
      { kind: "uncovered", language: "html" },
      { kind: "check", checkId: "types", outcome: "timed_out" },
    ]);
    expect(evaluateQualityPolicy("enforce", plan, executions).decision).toBe("block");
  });

  it("treats a missing execution result as a crash and keeps off mode explicit", () => {
    const plan = planQualityChecks(
      [{ path: "styles/site.css", language: "css" }],
      [check("styles", ["css"])],
    );

    expect(evaluateQualityPolicy("audit", plan, []).issues).toEqual([
      { kind: "check", checkId: "styles", outcome: "crashed" },
    ]);
    expect(evaluateQualityPolicy("off", plan, []).decision).toBe("off");
  });
});
