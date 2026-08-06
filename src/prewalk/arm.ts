import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
export const armPrewalk = (
  extension: ExtensionAPI,
  controller: PrewalkController,
  prewalk: FabricConfig["prewalk"],
  context: ExtensionContext,
  model: string,
  task?: string,
  runRoot?: string,
): void => {
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
    ...(prewalk.delegateContext ? { delegateContext: true } : {}),
  });
  const armedPrompt = prewalkArmedPrompt(model, {
    ...(prewalk.delegateContext ? { delegateContext: true } : {}),
  });
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
  const armedMessageType = prewalkArmedMessageType();
  if (
    !hasPrewalkArmedPrompt(context.sessionManager.getBranch(), armedPrompt, armedMessageType)
  ) {
    extension.sendMessage(
      {
        customType: armedMessageType,
        content: armedPromptFinal,
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
export const autoArmPrewalk = (
  extension: ExtensionAPI,
  controller: PrewalkController,
  config: FabricConfig,
  context: ExtensionContext,
): boolean => {
  const prewalk = config.prewalk;
  if (prewalk.arm === "off") return false;
  const model = prewalk.model?.trim();
  if (!model || !model.includes("/")) return false;
  if (controller.isArmed(context.sessionManager.getSessionId())) return false;
  armPrewalk(extension, controller, prewalk, context, model, undefined, config.agents.runRoot);
  return true;
};
