import type { FabricConfig } from "../config.js";
import type { FabricPrewalkRearmDefaults } from "./lifecycle.js";

// Snapshot of the arm-shaping configuration, taken when a task settles so a
// task-rearming prewalk adopts the current mode and model rather than repeating
// the arm that just finished.
export const prewalkRearmDefaults = (
  config: FabricConfig,
): FabricPrewalkRearmDefaults => {
  const prewalk = config.prewalk;
  const model = prewalk.model?.trim();
  return {
    arm: prewalk.arm,
    ...(model ? { model } : {}),
    ...(prewalk.fallbackModels && prewalk.fallbackModels.length > 0
      ? { fallbackModels: [...prewalk.fallbackModels] }
      : {}),
    ...(prewalk.thinking ? { thinking: prewalk.thinking } : {}),
    ...(prewalk.verificationMode
      ? {
          verificationMode: prewalk.verificationMode,
          maxPhaseRevisions: prewalk.maxPhaseRevisions ?? 2,
        }
      : {}),
    ...(prewalk.delegateContext ? { delegateContext: true } : {}),
  };
};
