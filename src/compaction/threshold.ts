import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricConfig } from "../config.js";

export const modelCompactionKey = (
  model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id"> | undefined,
): string | undefined => model ? `${model.provider}/${model.id}` : undefined;

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
  if (usage?.percent === null || usage === undefined) return false;
  if (usage.percent / 100 < threshold) return false;

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
