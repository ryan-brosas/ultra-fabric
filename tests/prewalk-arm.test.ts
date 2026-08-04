import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PrewalkController } from "../src/prewalk/controller.js";
import { autoArmPrewalk } from "../src/prewalk/arm.js";
import { normalizeFabricConfig } from "../src/config.js";

const context = () => {
  const setStatus = vi.fn();
  return {
    value: {
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
      ui: { setStatus, notify: vi.fn() },
    } as unknown as ExtensionContext,
    setStatus,
  };
};

const extension = () => {
  const sendMessage = vi.fn();
  return { value: { sendMessage } as unknown as ExtensionAPI, sendMessage };
};

const configFor = (overrides: Record<string, unknown>) =>
  normalizeFabricConfig({
    prewalk: { autoArm: true, model: "anthropic/executor", ...overrides },
  });

describe("autoArmPrewalk", () => {
  it("arms from configuration and queues the advisory prompt", () => {
    const controller = new PrewalkController();
    const ctx = context();
    const ext = extension();

    expect(autoArmPrewalk(ext.value, controller, configFor({}), ctx.value)).toBe(true);
    expect(controller.isArmed("session-1")).toBe(true);
    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
    });
    expect(ext.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        display: false,
        details: { model: "anthropic/executor" },
      }),
      { deliverAs: "nextTurn" },
    );
    expect(ctx.setStatus).toHaveBeenCalledWith(
      "fabric-prewalk",
      "armed → anthropic/executor",
    );
  });

  it("stays idle when auto-arm is off", () => {
    const controller = new PrewalkController();
    const ext = extension();
    const config = normalizeFabricConfig({ prewalk: { model: "anthropic/executor" } });

    expect(autoArmPrewalk(ext.value, controller, config, context().value)).toBe(false);
    expect(controller.isArmed()).toBe(false);
    expect(ext.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses an unset or malformed model instead of prompting", () => {
    const controller = new PrewalkController();
    const ext = extension();
    const unset = normalizeFabricConfig({ prewalk: { autoArm: true } });
    expect(autoArmPrewalk(ext.value, controller, unset, context().value)).toBe(false);

    const malformed = configFor({ model: "executor-without-provider" });
    expect(autoArmPrewalk(ext.value, controller, malformed, context().value)).toBe(false);
    expect(controller.isArmed()).toBe(false);
  });

  it("still arms research without agents because it stays in session", () => {
    const controller = new PrewalkController();
    const ext = extension();
    const config = normalizeFabricConfig({
      prewalk: { autoArm: true, model: "anthropic/executor", mode: "research" },
      agents: { enabled: false },
    });
    expect(autoArmPrewalk(ext.value, controller, config, context().value)).toBe(true);
    expect(controller.status()).toMatchObject({ state: "armed" });
  });

  it("never re-arms over a live arm", () => {
    const controller = new PrewalkController();
    const ext = extension();
    const config = configFor({});
    expect(autoArmPrewalk(ext.value, controller, config, context().value)).toBe(true);
    expect(autoArmPrewalk(ext.value, controller, config, context().value)).toBe(false);
    expect(ext.sendMessage).toHaveBeenCalledTimes(1);
  });
});
