import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricConfig } from "../config.js";

export const modelCompactionKey = (
  model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id"> | undefined,
): string | undefined => model ? `${model.provider}/${model.id}` : undefined;

let lastThresholdCompactAt = 0;

// Test/session hook: clear the cooldown timestamp. Wired to session_start so a
// long-lived extension never carries throttling across sessions.
export const resetThresholdCooldown = (): void => {
  lastThresholdCompactAt = 0;
};

const configuredCompactionThreshold = (
  config: FabricConfig,
  model: ExtensionContext["model"],
): number | undefined => {
  const key = modelCompactionKey(model);
  return key === undefined ? undefined : config.compaction.thresholds[key];
};

export const compactAtConfiguredThreshold = async (
  context: ExtensionContext,
  config: FabricConfig,
): Promise<boolean> => {
  const threshold = configuredCompactionThreshold(config, context.model) ?? config.compaction.threshold;
  const usage = context.getContextUsage();
  // Proactive message-count guard: providers cap request history by message
  // count (for example 800 messages). Compacting before dispatch keeps a long
  // session from being rejected with a 413 chat_history_too_large error, which
  // token-pressure compaction alone cannot predict or recover from.
  const activeEntries = context.sessionManager?.buildContextEntries?.() ?? [];
  // Providers cap the whole request message array (user, assistant, and tool
  // results), so count every active message entry, not just user turns.
  const activeMessages = activeEntries.filter((entry) => entry.type === "message").length;
  const messageLimit = Math.max(1, Math.floor(config.compaction.messageThreshold));
  const messageTriggered = activeMessages >= messageLimit;
  if (!messageTriggered) {
    if (usage?.percent === null || usage === undefined) return false;
    if (usage.percent / 100 < threshold) return false;
  }

  // Opt-in throttle between threshold-triggered compactions (adopted concept:
  // pi-vcc-tom proactive-threshold cooldown / pi-dcp nudge throttling). The
  // timestamp is set at trigger time, so a failing compact cannot hammer the
  // provider on consecutive agent_settled boundaries. 0 disables the guard.
  const cooldownMs = Math.max(0, Math.floor(config.compaction.cooldownMs));
  if (cooldownMs > 0 && Date.now() - lastThresholdCompactAt < cooldownMs) return false;
  lastThresholdCompactAt = Date.now();

  return new Promise<boolean>((resolve) => {
    context.compact({
      onComplete: () => resolve(true),
      onError: (error) => {
        if (context.hasUI) {
          context.ui.notify(`Fabric threshold compaction failed: ${error.message}`, "warning");
        }
        resolve(false);
      },
    });
  });
};
