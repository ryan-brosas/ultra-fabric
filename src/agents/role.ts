const AGENT_ROLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export type FabricAgentRole = string;

export const normalizeFabricAgentRole = (
  value: unknown,
  fallback: FabricAgentRole = "worker",
): FabricAgentRole => {
  const role = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!AGENT_ROLE_PATTERN.test(role)) {
    throw new Error(
      "Invalid Fabric agent role: expected a lowercase identifier using letters, numbers, or hyphens",
    );
  }
  return role;
};
