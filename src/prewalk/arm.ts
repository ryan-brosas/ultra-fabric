import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricConfig } from "../config.js";
import type { PrewalkController } from "./controller.js";
import {
  hasPrewalkArmedPrompt,
  prewalkArmedMessageType,
  prewalkArmedPrompt,
} from "./handoff.js";

// In-place and trajectory both run their executor as an off-session child, so
// only research can arm without agents available.
const prewalkModeNeedsAgents = (mode: FabricConfig["prewalk"]["mode"]): boolean =>
  mode !== "research";

// One arming path for the explicit /fabric prewalk command and for configured
// auto-arming, so both produce the same arm, advisory prompt, and status.
export const armPrewalk = (
  extension: ExtensionAPI,
  controller: PrewalkController,
  prewalk: FabricConfig["prewalk"],
  context: ExtensionContext,
  model: string,
  task?: string,
): void => {
  controller.arm({
    model,
    mode: prewalk.mode,
    sessionId: context.sessionManager.getSessionId(),
    ...(task ? { task } : {}),
    ...(prewalk.thinking ? { thinking: prewalk.thinking } : {}),
    ...(prewalk.verificationMode === "gated"
      ? {
          verificationMode: "gated" as const,
          maxPhaseRevisions: prewalk.maxPhaseRevisions,
        }
      : {}),
    alwaysRearm: prewalk.alwaysRearm,
    returnPolicy: prewalk.returnPolicy,
    ...(prewalk.fallbackModels ? { fallbackModels: prewalk.fallbackModels } : {}),
  });
  const armedPrompt = prewalkArmedPrompt(prewalk.mode, model);
  const armedMessageType = prewalkArmedMessageType(prewalk.mode);
  if (
    !hasPrewalkArmedPrompt(context.sessionManager.getBranch(), armedPrompt, armedMessageType)
  ) {
    extension.sendMessage(
      {
        customType: armedMessageType,
        content: armedPrompt,
        display: false,
        details: { mode: prewalk.mode, model },
      },
      { deliverAs: "nextTurn" },
    );
  }
  context.ui.setStatus("fabric-prewalk", `armed (${prewalk.mode}) → ${model}`);
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
  if (!prewalk.autoArm) return false;
  const model = prewalk.model?.trim();
  if (!model || !model.includes("/")) return false;
  if (prewalkModeNeedsAgents(prewalk.mode) && !config.agents.enabled) return false;
  if (controller.isArmed(context.sessionManager.getSessionId())) return false;
  armPrewalk(extension, controller, prewalk, context, model);
  return true;
};
