import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Guards the test harness from regressing to ambient developer state.
// AgentRoleRegistry loads user-scope role profiles from getAgentDir()/agents,
// which previously leaked the developer's ~/.pi/agent/agents/*.md model
// overrides into model-default assertions (4 failing tests on a real HOME).
describe("hermetic test harness", () => {
  it("isolates the Pi agent dir from the developer's real home", () => {
    // os.userInfo().homedir resolves from the system account (/etc/passwd),
    // not the HOME environment the setup file overrides, so it remains the
    // real developer home even under the hermetic harness.
    const realAgentDir = path.join(os.userInfo().homedir, ".pi", "agent");
    expect(getAgentDir()).not.toBe(realAgentDir);
  });

  it("isolates HOME from the developer's real home", () => {
    const realHome = os.userInfo().homedir;
    expect(process.env.HOME).not.toBe(realHome);
  });
});