import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionSeed } from "./types.js";


const materializeBranch = (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
): SessionManager => {
  if (!seed.sourceBranch) {
    throw new Error("In-memory trajectory handoff is missing its source branch");
  }
  const id = randomUUID();
  const sessionFile = path.join(directory, `handoff-${id}.jsonl`);
  const header = {
    type: "session" as const,
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd,
    ...(seed.sourceSessionFile ? { parentSession: seed.sourceSessionFile } : {}),
  };
  fs.writeFileSync(
    sessionFile,
    `${[header, ...seed.sourceBranch].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return SessionManager.open(sessionFile, directory, cwd);
};

const forkBranch = (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
): SessionManager => {
  if (!seed.sourceSessionFile) return materializeBranch(seed, cwd, directory);
  const fork = SessionManager.open(seed.sourceSessionFile, directory, cwd);
  if (!fork.getEntry(seed.sourceBranchLeafId)) {
    throw new Error(
      `Trajectory handoff branch point ${seed.sourceBranchLeafId} is missing from the persisted Pi session`,
    );
  }
  const sessionFile = fork.createBranchedSession(seed.sourceBranchLeafId);
  if (!sessionFile) {
    throw new Error("Trajectory handoff could not create a persisted Pi session branch");
  }
  return fork;
};

const synchronizeSourceSettings = (
  session: SessionManager,
  seed: AgentSessionSeed,
): void => {
  const context = session.buildSessionContext();
  if (
    seed.sourceModel &&
    (context.model?.provider !== seed.sourceModel.provider ||
      context.model.modelId !== seed.sourceModel.modelId)
  ) {
    session.appendModelChange(seed.sourceModel.provider, seed.sourceModel.modelId);
  }
  if (seed.sourceThinkingLevel && context.thinkingLevel !== seed.sourceThinkingLevel) {
    session.appendThinkingLevelChange(seed.sourceThinkingLevel);
  }
};

export const writeHandoffSession = (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
): string => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const session = forkBranch(seed, cwd, directory);
  synchronizeSourceSettings(session, seed);
  session.appendMessage(seed.outerToolResult);
  session.appendCustomEntry("pi-fabric-handoff", {
    sourceSessionId: seed.sourceSessionId,
    boundary: "fabric_exec_end",
  });
  const sessionFile = session.getSessionFile();
  if (!sessionFile) throw new Error("Trajectory handoff did not produce a Pi session file");
  fs.chmodSync(sessionFile, 0o600);
  return sessionFile;
};
