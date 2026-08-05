import type { FabricWorkPhase } from "./store.js";

const MAX_CONTRACT_CHARS = 1_200;

const CONTRACTS: Partial<Record<FabricWorkPhase, string>> = {
  research: [
    "Lifecycle phase: research.",
    "Delegate retrieval to scout or consult.run so workers spend their own context and return evidence locators.",
    "Store findings in .artifact/<slug>/research.md. Do not mutate code.",
  ].join(" "),
  create: [
    "Lifecycle phase: create.",
    "Produce a spec with ordered tasks, affected paths, test seams, and rollback boundaries.",
    "Each task should carry a verify command. Store the spec in .artifact/<slug>/spec.md. Do not implement.",
  ].join(" "),
  plan: [
    "Lifecycle phase: plan.",
    "Expand the spec into a TDD implementation plan with ordered tasks, file lists, and test seams.",
    "Store the plan in .artifact/<slug>/plan.md. Do not implement.",
  ].join(" "),
  ship: [
    "Lifecycle phase: ship.",
    "Before changing any signature, run find_callers and find_importers against graph_name ultra-fabric to sweep every call site.",
    "For reference patterns, query graph_name inspo. Use find_most_complex_functions to flag hot spots since fallow is unavailable.",
    "Drive prewalk per task with each task's verify command as the checklist validation. Do not use the worker role; the executor owns mutation.",
  ].join(" "),
  verify: [
    "Lifecycle phase: verify.",
    "Review the diff against the spec with a fresh-context reviewer. Gate on structured output, not string matching.",
    "Record the gate result in the work record. Set status to done only when all gates pass and no blocker remains.",
  ].join(" "),
};

export const phaseContract = (phase: FabricWorkPhase): string | undefined => {
  const contract = CONTRACTS[phase];
  if (!contract) return undefined;
  return contract.length > MAX_CONTRACT_CHARS ? contract.slice(0, MAX_CONTRACT_CHARS) : contract;
};