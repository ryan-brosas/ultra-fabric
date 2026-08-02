export interface AgentTurnBudget {
  maxTurns: number;
  graceTurns: number;
}

const DEFAULT_GRACE_TURNS = 1;
const MAX_TURNS = 200;
const MAX_GRACE_TURNS = 5;

export const resolveAgentTurnBudget = (
  value: unknown,
  label = "turnBudget",
): AgentTurnBudget => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object with maxTurns and optional graceTurns`);
  }
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).find(
    (key) => key !== "maxTurns" && key !== "graceTurns",
  );
  if (unsupported) throw new Error(`${label}.${unsupported} is not supported`);
  if (
    typeof record.maxTurns !== "number" ||
    !Number.isInteger(record.maxTurns) ||
    record.maxTurns < 1 ||
    record.maxTurns > MAX_TURNS
  ) {
    throw new Error(`${label}.maxTurns must be an integer between 1 and ${MAX_TURNS}`);
  }
  const graceTurns = record.graceTurns ?? DEFAULT_GRACE_TURNS;
  if (
    typeof graceTurns !== "number" ||
    !Number.isInteger(graceTurns) ||
    graceTurns < 0 ||
    graceTurns > MAX_GRACE_TURNS
  ) {
    throw new Error(
      `${label}.graceTurns must be an integer between 0 and ${MAX_GRACE_TURNS}`,
    );
  }
  return { maxTurns: record.maxTurns, graceTurns };
};

export const agentTurnBudgetDecision = (
  budget: AgentTurnBudget,
  turns: number,
): "continue" | "wrap-up" | "stop" => {
  if (turns < budget.maxTurns) return "continue";
  if (turns < budget.maxTurns + budget.graceTurns) return "wrap-up";
  return "stop";
};

export const appendAgentTurnBudgetPrompt = (
  systemPrompt: string,
  budget: AgentTurnBudget,
): string => {
  const grace = budget.graceTurns === 1
    ? "one final wrap-up turn"
    : `${budget.graceTurns} final wrap-up turns`;
  const block = [
    "## Bounded execution",
    `This Agent has a soft limit of ${budget.maxTurns} assistant turns and ${grace}.`,
    "When the soft limit is reached, stop starting new work and return the best complete result immediately.",
    "At the hard boundary the run must stop and may return partial output.",
  ].join("\n");
  return systemPrompt.trim() ? `${systemPrompt.trim()}\n\n${block}` : block;
};
