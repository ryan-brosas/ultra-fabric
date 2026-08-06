import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PrewalkController } from "../src/prewalk/controller.js";
import { armPrewalk, autoArmPrewalk } from "../src/prewalk/arm.js";
import { CHECKLIST_MEMORY_FILE, recordChecklist } from "../src/prewalk/checklist-memory.js";
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
    prewalk: { arm: "session", model: "anthropic/executor", ...overrides },
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

  it("stays idle when arm is off", () => {
    const controller = new PrewalkController();
    const ext = extension();
    const config = normalizeFabricConfig({ prewalk: { arm: "off", model: "anthropic/executor" } });

    expect(autoArmPrewalk(ext.value, controller, config, context().value)).toBe(false);
    expect(controller.isArmed()).toBe(false);
    expect(ext.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses an unset or malformed model instead of prompting", () => {
    const controller = new PrewalkController();
    const ext = extension();
    const unset = normalizeFabricConfig({ prewalk: { arm: "session" } });
    expect(autoArmPrewalk(ext.value, controller, unset, context().value)).toBe(false);

    const malformed = configFor({ model: "executor-without-provider" });
    expect(autoArmPrewalk(ext.value, controller, malformed, context().value)).toBe(false);
    expect(controller.isArmed()).toBe(false);
  });

  it("still arms research without agents because it stays in session", () => {
    const controller = new PrewalkController();
    const ext = extension();
    const config = normalizeFabricConfig({
      prewalk: { arm: "session", model: "anthropic/executor", mode: "research" },
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

  it("seeds the armed prompt with the nearest prior checklist when reuse is on", () => {
    const controller = new PrewalkController();
    const ext = extension();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prewalk-arm-memory-"));
    recordChecklist(
      path.dirname(path.join(root, "runs")),
      "Implement the token guard and run its tests",
      { items: [{ task: "Add the token guard", validation: "Run the suite" }], readyAt: 1 },
    );
    const config = normalizeFabricConfig({
      prewalk: { model: "anthropic/executor", reuseChecklists: true },
      agents: { runRoot: path.join(root, "runs") },
    });
    armPrewalk(
      ext.value,
      controller,
      config.prewalk,
      context().value,
      "anthropic/executor",
      "Implement the token guard and run its tests",
      config.agents.runRoot,
    );
    const message = ext.sendMessage.mock.calls[0]?.[0] as { content?: string };
    expect(message.content).toContain("adapt");
    expect(message.content).toContain("Add the token guard");
    expect(fs.existsSync(path.join(path.dirname(path.join(root, "runs")), CHECKLIST_MEMORY_FILE))).toBe(true);
  });

    it("seeds the armed prompt with prior failures when failure memory is on", () => {
    const controller = new PrewalkController();
    const ext = extension();
    const ctx = context();
    const config = normalizeFabricConfig({
      prewalk: { arm: "session", model: "anthropic/executor", failureMemory: true },
    });
    autoArmPrewalk(ext.value, controller, config, ctx.value);
    const message = ext.sendMessage.mock.calls[0]?.[0] as { content?: string } | undefined;
    expect(message?.content).toBeDefined();
  });

  it("does not seed failures when failure memory is off", () => {
    const controller = new PrewalkController();
    const ext = extension();
    const config = normalizeFabricConfig({
      prewalk: { arm: "session", model: "anthropic/executor" },
    });
    autoArmPrewalk(ext.value, controller, config, context().value);
    const message = ext.sendMessage.mock.calls[0]?.[0] as { content?: string } | undefined;
    expect(message?.content).toBeDefined();
  });

it("keeps the armed prompt unchanged when reuse is off", () => {
    const controller = new PrewalkController();
    const ext = extension();
    const config = configFor({ reuseChecklists: false });
    autoArmPrewalk(ext.value, controller, config, context().value);
    const message = ext.sendMessage.mock.calls[0]?.[0] as { content?: string };
    expect(message.content).not.toContain("adapt");
  });
});
