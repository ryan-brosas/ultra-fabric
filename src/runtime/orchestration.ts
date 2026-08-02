// Static detection lets Fabric start known orchestration programs with the
// longer agent deadline. The runtime also extends the deadline when a
// blocking host ref is discovered dynamically, so
// computed and aliased refs cannot fall back to the short executor timeout.
const BLOCKING_ORCHESTRATION_REFS = new Set([
  "agents.run",
  "agents.wait",
  "agents.ask",
  "fabric.$consultWorker",
]);

export const isBlockingOrchestrationRef = (ref: string): boolean =>
  BLOCKING_ORCHESTRATION_REFS.has(ref);

// Match blocking guest entry points as call sites (a trailing "("), and
// tolerate a single-level generic such as agent<{ items: string[] }>(...).
// agents.handoff is excluded because it only schedules work at the completed
// outer fabric_exec boundary.
const ORCHESTRATION_RE =
  /\b(?:workflow\.agent|agents\.(?:run|wait|ask)|council\.run|rlm\.query|consult\.run)\s*\(|(?<!\.)\bagent\s*(?:<[^<>]*>)?\s*\(/;

export const codeUsesOrchestration = (code: string): boolean =>
  ORCHESTRATION_RE.test(code);
