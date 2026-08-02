#!/usr/bin/env node

const claimPattern = /\b(?:implemented|complete(?:d)?|fixed|success(?:ful(?:ly)?)?|tests?\s+pass(?:ed)?|verified)\b/i;
const validationPattern = /\b(?:run|test|check|verify|assert|inspect|build|typecheck)\b/i;

const structuralPlanScore = (payload) => {
  const items = Array.isArray(payload.checklist) ? payload.checklist : [];
  const validCount = items.length >= 5 && items.length <= 9;
  const tasks = items.map((item) => typeof item?.task === "string" ? item.task.trim() : "");
  const validations = items.map((item) => typeof item?.validation === "string" ? item.validation.trim() : "");
  const concrete = tasks.every(Boolean) && validations.every(Boolean);
  const unique = new Set(tasks.map((value) => value.toLowerCase())).size === tasks.length &&
    new Set(validations.map((value) => value.toLowerCase())).size === validations.length;
  const specificValidation = validations.every((value) => validationPattern.test(value));
  const artifacts = [...String(payload.objective ?? "").matchAll(/[A-Za-z0-9_./-]+\.(?:mjs|js|ts|json|md)/g)]
    .map((match) => match[0].toLowerCase());
  const planText = `${tasks.join(" ")} ${validations.join(" ")}`.toLowerCase();
  const artifactCoverage = new Set(artifacts.filter((artifact) => planText.includes(artifact))).size >= 2;
  return [validCount && concrete, unique, specificValidation, artifactCoverage]
    .filter(Boolean).length / 4;
};

const unsupportedClaims = (payload) => {
  if (payload.oracle?.missedConstraints === 0 &&
      payload.oracle?.acceptance?.completed === payload.oracle?.acceptance?.total) return 0;
  return String(payload.finalResponse ?? "")
    .split(/[.!?\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && claimPattern.test(sentence))
    .length;
};

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input);
    if (payload?.format !== 1 || (payload.variant !== "in-place" && payload.variant !== "research")) {
      throw new Error("invalid evaluator payload");
    }
    const result = { unsupportedClaims: unsupportedClaims(payload) };
    if (payload.variant === "research") result.planQualityScore = structuralPlanScore(payload);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`Prewalk reference evaluator failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
