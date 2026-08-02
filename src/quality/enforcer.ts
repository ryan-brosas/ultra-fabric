import { runQualityChecks } from "./command-runner.js";
import {
  evaluateQualityPolicy,
  planQualityChecks,
  type QualityCheckDefinition,
  type QualityCheckExecution,
  type QualityCheckPlan,
  type QualityMode,
  type QualityPolicyEvaluation,
} from "./policy.js";
import {
  collectQualityChangedFiles,
  type QualityMutationAudit,
} from "./tracker.js";

interface QualityEnforcementConfig {
  mode: QualityMode;
  maxOutputChars: number;
  maxProbeBytes: number;
  ignoredLanguages: readonly string[];
  languageOverrides: Readonly<Record<string, string>>;
  checks: readonly QualityCheckDefinition[];
}

interface RunQualityEnforcementOptions {
  cwd: string;
  audits: readonly QualityMutationAudit[];
  config: QualityEnforcementConfig;
}

export interface QualityEnforcementResult {
  plan: QualityCheckPlan;
  executions: QualityCheckExecution[];
  evaluation: QualityPolicyEvaluation;
  summary: string;
}

const boundedSummary = (value: string): string =>
  value.length <= 4_096 ? value : `${value.slice(0, 4_095)}…`;

const qualitySummary = (
  plan: QualityCheckPlan,
  executions: readonly QualityCheckExecution[],
  evaluation: QualityPolicyEvaluation,
): string => {
  if (evaluation.decision === "pass") {
    return `passed ${executions.length} check(s) for ${plan.languages.join(", ")}`;
  }

  const byId = new Map(executions.map((execution) => [execution.checkId, execution]));
  const details = evaluation.issues.map((issue) => {
    if (issue.kind === "uncovered") return `${issue.language}: no configured check`;
    const execution = byId.get(issue.checkId);
    const exit = execution?.exitCode === undefined ? "" : ` (exit ${execution.exitCode})`;
    const output = execution?.output?.trim();
    return `${issue.checkId}: ${issue.outcome}${exit}${output ? `\n${output}` : ""}`;
  });
  return boundedSummary(details.join("\n"));
};

export const runQualityEnforcement = async (
  options: RunQualityEnforcementOptions,
): Promise<QualityEnforcementResult | undefined> => {
  if (options.config.mode === "off") return undefined;
  const files = collectQualityChangedFiles({
    cwd: options.cwd,
    audits: options.audits,
    languageOverrides: options.config.languageOverrides,
    maxProbeBytes: options.config.maxProbeBytes,
  });
  const plan = planQualityChecks(
    files,
    options.config.checks,
    options.config.ignoredLanguages,
  );
  if (plan.languages.length === 0) return undefined;
  const executions = await runQualityChecks({
    cwd: options.cwd,
    checks: plan.checks,
    maxOutputChars: options.config.maxOutputChars,
  });
  const evaluation = evaluateQualityPolicy(options.config.mode, plan, executions);
  return {
    plan,
    executions,
    evaluation,
    summary: qualitySummary(plan, executions, evaluation),
  };
};
