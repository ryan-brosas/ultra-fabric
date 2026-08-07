import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runScoutBrief, type ScoutRunner } from "./scout-brief.js";
import type { FabricConfig } from "../config.js";
import { checklistSeed, nearestChecklist, prewalkMemoryDir } from "./checklist-memory.js";
import { failureSeed, nearestFailures, prewalkFailureDir } from "./failure-memory.js";
import type { PrewalkController } from "./controller.js";
import {
  hasPrewalkArmedPrompt,
  prewalkArmedMessageType,
  prewalkArmedPrompt,
} from "./handoff.js";

// One arming path for the explicit /fabric prewalk command and for configured
// auto-arming, so both produce the same arm, advisory prompt, and status.
export interface ArmPrewalkDeps {
  // Host-supplied cheap-model runner. When absent, the scout is skipped so
  // host wiring decides whether this host can spawn agents at arm time.
  scoutRun?: ScoutRunner;
}

export const armPrewalk = async (
  extension: ExtensionAPI,
  controller: PrewalkController,
  prewalk: FabricConfig["prewalk"],
  context: ExtensionContext,
  model: string,
  task?: string,
  runRoot?: string,
  deps: ArmPrewalkDeps = {},
): Promise<void> => {
  controller.arm({
    model,
    sessionId: context.sessionManager.getSessionId(),
    ...(task ? { task } : {}),
    ...(prewalk.thinking ? { thinking: prewalk.thinking } : {}),
    ...(prewalk.verificationMode === "gated"
      ? {
          verificationMode: "gated" as const,
          maxPhaseRevisions: prewalk.maxPhaseRevisions,
        }
      : {}),
    arm: prewalk.arm,
    ...(prewalk.fallbackModels ? { fallbackModels: prewalk.fallbackModels } : {}),
  });
  const armedPrompt = prewalkArmedPrompt(model);
  // Checklist memory: seed the planning phase with the nearest prior accepted
  // checklist for a similar task so Main adapts instead of re-deriving.
  const memoryDir = prewalkMemoryDir(runRoot);
  const seeded = prewalk.reuseChecklists === true && task
    ? nearestChecklist(memoryDir, task)
    : undefined;
  const seededPrompt = seeded
    ? `${armedPrompt}\n\n${checklistSeed(seeded)}`
    : armedPrompt;
  // Failure memory: inherit the failure modes of similar prior tasks so the
  // planning phase plans around them instead of re-discovering them. Bounded
  // (at most 4 patterns) and opt-in. Trivial tasks never reach the gate, so
  // no trivial check is needed here.
  const failureBlock =
    prewalk.failureMemory === true && task
      ? failureSeed(nearestFailures(prewalkFailureDir(runRoot), task))
      : "";
  const armedPromptFinal = failureBlock
    ? `${seededPrompt}\n\n${failureBlock}`
    : seededPrompt;
  // Auto-scout: a cheap small-model pass gathers a compressed context brief
  // before the frontier model plans. Opt-in (prewalk.autoScout), bounded
  // output, and never blocks arming. The host supplies the runner; without
  // one the scout is skipped.
  const scoutBrief =
    prewalk.autoScout === true && task && deps.scoutRun
      ? await runScoutBrief(deps.scoutRun, task, runRoot, {
          timeoutMs: prewalk.scoutTimeoutMs,
          maxTokens: prewalk.scoutMaxTokens,
        })
      : undefined;
  const armedPromptScouted = scoutBrief
    ? `${armedPromptFinal}\n\nScout brief:\n${scoutBrief}`
    : armedPromptFinal;
  const armedMessageType = prewalkArmedMessageType();
  if (
    !hasPrewalkArmedPrompt(context.sessionManager.getBranch(), armedPrompt, armedMessageType)
  ) {
    extension.sendMessage(
      {
        customType: armedMessageType,
        content: armedPromptScouted,
        display: false,
        details: { model },
      },
      { deliverAs: "nextTurn" },
    );
  }
  context.ui.setStatus("fabric-prewalk", `armed → ${model}`);
};

// Configured auto-arming: silent, non-interactive, and only when the arm can
// actually fire. An unset or malformed model, a missing agent runtime, or an
// existing arm leaves the session untouched.
export const autoArmPrewalk = async (
  extension: ExtensionAPI,
  controller: PrewalkController,
  config: FabricConfig,
  context: ExtensionContext,
  deps: ArmPrewalkDeps = {},
): Promise<boolean> => {
  const prewalk = config.prewalk;
  if (prewalk.arm === "off") return false;
  const model = prewalk.model?.trim();
  if (!model || !model.includes("/")) return false;
  if (controller.isArmed(context.sessionManager.getSessionId())) return false;
  await armPrewalk(
    extension,
    controller,
    prewalk,
    context,
    model,
    undefined,
    config.agents.runRoot,
    deps,
  );
  return true;
};

// Fire the cheap auto-scout when a task is observed on an already-armed
// session. Session and task-less command arms carry no task, so the scout
// cannot fire inside armPrewalk for them; the input handler calls this with
// the observed task text so the scout still runs before the frontier model
// plans. The caller injects the returned brief on the prewalk armed channel
// (PREWALK_ARMED_MESSAGE_TYPE) so the existing lifecycle filter retires it
// once planning completes instead of lingering as context noise. Spend lands
// in the budget ledger under prewalk:scout and a status/notify makes the
// spawn visible.
export const scoutOnTaskObserved = async (
  controller: PrewalkController,
  prewalk: FabricConfig["prewalk"],
  context: ExtensionContext,
  task: string,
  runRoot?: string,
  deps: ArmPrewalkDeps = {},
): Promise<string> => {
  if (prewalk.autoScout !== true || !deps.scoutRun) return "";
  if (!controller.isArmed(context.sessionManager.getSessionId())) return "";
  const trimmed = task.trim();
  if (!trimmed) return "";
  const brief = await runScoutBrief(deps.scoutRun, trimmed, runRoot, {
    timeoutMs: prewalk.scoutTimeoutMs,
    maxTokens: prewalk.scoutMaxTokens,
  });
  if (!brief) return "";
  // Make the spawn visible: the cheap model ran on its own context budget.
  context.ui.notify("auto-scout brief gathered (" + brief.length + " chars, prewalk:scout)", "info");
  context.ui.setStatus("fabric-prewalk", "armed · scout briefed");
  return brief;
};
