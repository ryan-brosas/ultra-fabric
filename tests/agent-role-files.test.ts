import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgentRoleProfile } from "../src/agents/role-profiles.js";

// The shipped .pi/agents/<role>.md files are the discoverable role definitions
// (role-profiles.ts:357 tells users to "define .pi/agents/<role>.md"). This
// locks the contract of the two small-task roles the prewalk handoff names:
// scout (external research) and explorer (codebase cartography).

const profilesDir = path.join(process.cwd(), ".pi", "agents");

const loadProfile = (role: string) => {
  const filePath = path.join(profilesDir, role + ".md");
  const source = fs.readFileSync(filePath, "utf8");
  return parseAgentRoleProfile(source, filePath, "project");
};

const MUTATING_TOOLS = new Set(["write", "edit", "bash", "patch", "apply_patch"]);

describe(".pi/agents role files", () => {
  it.each(["scout", "explorer"])("%s.md parses as a bounded read-only one-shot profile", (role) => {
    const p = loadProfile(role);
    expect(p.name).toBe(role);
    expect(p.lifecycle).toBe("one-shot");
    expect(p.turnBudget.maxTurns).toBeGreaterThanOrEqual(1);
    expect(p.turnBudget.maxTurns).toBeLessThanOrEqual(12);
    expect(p.turnBudget.graceTurns).toBeGreaterThanOrEqual(1);
    expect(p.goal.length).toBeGreaterThan(10);
    expect(p.completion.length).toBeGreaterThan(10);
  });

  it.each(["scout", "explorer"])("%s.md allows only read-only tools", (role) => {
    const p = loadProfile(role);
    expect(p.tools).toBeDefined();
    for (const tool of p.tools ?? []) {
      expect(MUTATING_TOOLS.has(tool), "mutation tool allowed: " + tool).toBe(false);
    }
    expect(p.tools).toContain("read");
  });

  it.each(["scout", "explorer"])("%s.md pins an omniroute auto-tier model", (role) => {
    const p = loadProfile(role);
    expect(p.model).toMatch(/^omniroute\/auto\//);
  });

  it.each(["scout", "explorer"])("%s.md behavior: codemap-first, findings+locators, no whole files", (role) => {
    const p = loadProfile(role);
    expect(p.behavior.toLowerCase()).toContain("codemap");
    expect(p.behavior.toLowerCase()).toContain("findings");
    expect(p.behavior.toLowerCase()).toContain("locators");
    expect(p.behavior.toLowerCase()).toContain("whole files");
  });
});
