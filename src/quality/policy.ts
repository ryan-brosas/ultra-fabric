export type QualityMode = "off" | "audit" | "enforce";
type QualityFileMode = "append" | "none";
export type QualityCheckOutcome = "passed" | "failed" | "timed_out" | "crashed";

export interface QualityCheckDefinition {
  id: string;
  languages: readonly string[];
  command: string;
  args: readonly string[];
  fileMode: QualityFileMode;
  timeoutMs: number;
}

export interface QualityChangedFile {
  path: string;
  language: string;
}

export interface PlannedQualityCheck {
  definition: QualityCheckDefinition;
  languages: string[];
  paths: string[];
}

export interface QualityCheckPlan {
  languages: string[];
  checks: PlannedQualityCheck[];
  uncoveredLanguages: string[];
}

export interface QualityCheckExecution {
  checkId: string;
  outcome: QualityCheckOutcome;
  exitCode?: number;
  output?: string;
  outputTruncated?: boolean;
  durationMs?: number;
}

type QualityPolicyIssue =
  | { kind: "uncovered"; language: string }
  | { kind: "check"; checkId: string; outcome: Exclude<QualityCheckOutcome, "passed"> };

export interface QualityPolicyEvaluation {
  decision: "off" | "pass" | "warn" | "block";
  issues: QualityPolicyIssue[];
}

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

export const planQualityChecks = (
  changedFiles: readonly QualityChangedFile[],
  definitions: readonly QualityCheckDefinition[],
  ignoredLanguages: readonly string[] = ["binary"],
): QualityCheckPlan => {
  const ignored = new Set(ignoredLanguages.map((language) => language.trim().toLowerCase()));
  const files = [...new Map(changedFiles.map((file) => [file.path, {
    path: file.path,
    language: file.language.trim().toLowerCase() || "unknown",
  }])).values()].filter((file) => !ignored.has(file.language));
  const languages = unique(files.map((file) => file.language));
  const covered = new Set<string>();
  const checks: PlannedQualityCheck[] = [];

  for (const definition of definitions) {
    const accepted = new Set(definition.languages.map((language) => language.trim().toLowerCase()));
    const matchesAll = accepted.has("*");
    const matchingFiles = files.filter((file) => matchesAll || accepted.has(file.language));
    if (matchingFiles.length === 0) continue;
    const matchedLanguages = unique(matchingFiles.map((file) => file.language));
    matchedLanguages.forEach((language) => covered.add(language));
    checks.push({
      definition,
      languages: matchedLanguages,
      paths: matchingFiles.map((file) => file.path),
    });
  }

  return {
    languages,
    checks,
    uncoveredLanguages: languages.filter((language) => !covered.has(language)),
  };
};

export const evaluateQualityPolicy = (
  mode: QualityMode,
  plan: QualityCheckPlan,
  executions: readonly QualityCheckExecution[],
): QualityPolicyEvaluation => {
  if (mode === "off") return { decision: "off", issues: [] };

  const results = new Map(executions.map((execution) => [execution.checkId, execution]));
  const issues: QualityPolicyIssue[] = plan.uncoveredLanguages.map((language) => ({
    kind: "uncovered",
    language,
  }));

  for (const check of plan.checks) {
    const outcome = results.get(check.definition.id)?.outcome ?? "crashed";
    if (outcome !== "passed") {
      issues.push({ kind: "check", checkId: check.definition.id, outcome });
    }
  }

  return {
    decision: issues.length === 0 ? "pass" : mode === "enforce" ? "block" : "warn",
    issues,
  };
};
