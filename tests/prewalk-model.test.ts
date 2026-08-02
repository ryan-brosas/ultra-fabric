import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { restorePrewalkModel } from "../src/prewalk/model.js";

const context = (available = true): ExtensionContext => ({
  modelRegistry: {
    find: vi.fn((provider: string, id: string) =>
      available && provider === "anthropic" && id === "planner"
        ? { provider, id }
        : undefined),
  },
} as unknown as ExtensionContext);

const extension = (setModel: ReturnType<typeof vi.fn>): ExtensionAPI => ({
  setModel,
} as unknown as ExtensionAPI);

describe("restorePrewalkModel", () => {
  it("restores an available authenticated model", async () => {
    const setModel = vi.fn().mockResolvedValue(true);

    const result = await restorePrewalkModel(
      extension(setModel),
      context(),
      "anthropic/planner",
    );

    expect(result).toEqual({ status: "restored", model: "anthropic/planner" });
    expect(setModel).toHaveBeenCalledWith({ provider: "anthropic", id: "planner" });
  });

  it("reports an unavailable return model without calling setModel", async () => {
    const setModel = vi.fn();

    const result = await restorePrewalkModel(
      extension(setModel),
      context(false),
      "anthropic/missing",
    );

    expect(result).toEqual({
      status: "unavailable",
      model: "anthropic/missing",
      error: "Prewalk model is unavailable: anthropic/missing",
    });
    expect(setModel).not.toHaveBeenCalled();
  });

  it("keeps authentication failure distinct from provider failure", async () => {
    const unauthenticated = await restorePrewalkModel(
      extension(vi.fn().mockResolvedValue(false)),
      context(),
      "anthropic/planner",
    );
    const failed = await restorePrewalkModel(
      extension(vi.fn().mockRejectedValue(new Error("provider offline"))),
      context(),
      "anthropic/planner",
    );

    expect(unauthenticated).toMatchObject({
      status: "unauthenticated",
      model: "anthropic/planner",
    });
    expect(failed).toEqual({
      status: "failed",
      model: "anthropic/planner",
      error: "provider offline",
    });
  });
});
