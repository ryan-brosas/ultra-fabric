import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const modelParts = (key: string): { provider: string; id: string } | undefined => {
  const separator = key.indexOf("/");
  if (separator <= 0 || separator === key.length - 1) return undefined;
  return {
    provider: key.slice(0, separator),
    id: key.slice(separator + 1),
  };
};

export const requirePrewalkModel = (
  key: string,
  context: ExtensionContext,
) => {
  const parts = modelParts(key);
  if (!parts) throw new Error("Prewalk requires a provider/model executor target");
  const model = context.modelRegistry.find(parts.provider, parts.id);
  if (!model) throw new Error(`Prewalk model is unavailable: ${key}`);
  return model;
};

export type PrewalkModelRestoreResult =
  | { status: "restored"; model: string }
  | { status: "unavailable" | "unauthenticated" | "failed"; model: string; error: string };

export const restorePrewalkModel = async (
  extension: ExtensionAPI,
  context: ExtensionContext,
  key: string,
): Promise<PrewalkModelRestoreResult> => {
  let model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
  try {
    model = requirePrewalkModel(key, context);
  } catch (error) {
    return {
      status: "unavailable",
      model: key,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const restored = await extension.setModel(model);
    return restored
      ? { status: "restored", model: key }
      : {
          status: "unauthenticated",
          model: key,
          error: `No authentication configured for prewalk return model: ${key}`,
        };
  } catch (error) {
    return {
      status: "failed",
      model: key,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
