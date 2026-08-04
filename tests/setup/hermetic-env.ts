import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect the home and Pi agent directories before any test module imports.
// AgentRoleRegistry loads user-scope role profiles from getAgentDir()/agents,
// so a developer's real ~/.pi/agent/agents/*.md would otherwise override the
// model defaults these tests assert on.
const workerId = process.env.VITEST_WORKER_ID ?? "0";
const home = fs.mkdtempSync(path.join(os.tmpdir(), `ultra-fabric-home-${workerId}-`));
const agentDir = path.join(home, ".pi", "agent");
fs.mkdirSync(agentDir, { recursive: true });

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
