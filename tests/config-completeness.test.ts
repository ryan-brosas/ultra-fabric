import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { runOutline, findInterface, readMemberOptionality } from "../src/codemap/outline.js";

const checkCompleteness = (
  interfaceName: string,
  defaults: Record<string, unknown>,
  configKey: string,
): { missing: string[]; optional: string[] } => {
  const files = runOutline(["src/config.ts"]);
  const iface = findInterface(files, interfaceName);
  if (!iface) throw new Error("Interface " + interfaceName + " not found");
  const missing: string[] = [];
  const optional: string[] = [];
  const filePath = files[0]?.path ?? "src/config.ts";
  for (const member of iface.members) {
    const isOptional = readMemberOptionality(filePath, member);
    if (isOptional) {
      optional.push(member.name);
    } else {
      const defaultsObj = defaults[configKey] as Record<string, unknown> | undefined;
      if (!defaultsObj || !(member.name in defaultsObj)) {
        missing.push(member.name);
      }
    }
  }
  return { missing, optional };
};

describe("config completeness lint", () => {
  it("every required FabricAgentConfig field has a default", () => {
    const result = checkCompleteness("FabricAgentConfig", DEFAULT_FABRIC_CONFIG as unknown as Record<string, unknown>, "agents");
    expect(result.missing).toEqual([]);
  });

  it("every required FabricPrewalkConfig field has a default", () => {
    const result = checkCompleteness("FabricPrewalkConfig", DEFAULT_FABRIC_CONFIG as unknown as Record<string, unknown>, "prewalk");
    expect(result.missing).toEqual([]);
  });

  it("the lint fails when a required default is removed", () => {
    const fakeDefaults = { ...DEFAULT_FABRIC_CONFIG, agents: { ...DEFAULT_FABRIC_CONFIG.agents } };
    delete (fakeDefaults.agents as Record<string, unknown>).transport;
    const result = checkCompleteness("FabricAgentConfig", fakeDefaults as unknown as Record<string, unknown>, "agents");
    expect(result.missing).toContain("transport");
  });
});