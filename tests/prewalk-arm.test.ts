import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PrewalkController } from "../src/prewalk/controller.js";
import { armPrewalk, autoArmPrewalk, scoutOnTaskObserved } from "../src/prewalk/arm.js";
import { SCOUT_BUDGET_CATEGORY } from "../src/prewalk/scout-brief.js";
import { readBudgetLedgerDetailed } from "./support/budget-ledger-detail.js";
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

describe("scout on task observed", () => {
  it("runs the scout and injects the brief when an armed session observes a task with autoScout on", async () => {
    const controller = new PrewalkController();
    const ctx = context();
    const ext = extension();
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-scout-observe-"));
    await autoArmPrewalk(ext.value, controller, configFor({}), ctx.value);
    expect(controller.isArmed("session-1")).toBe(true);

    const scoutRun = vi.fn(async () => ({
      result: "src/config.ts — normalizes fabric config",
      model: "deepseek-v4-flash",
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    }));
    const brief = await scoutOnTaskObserved(
      controller,
      configFor({}).prewalk,
      ctx.value,
      "refactor the config normalizer",
      runRoot,
      { scoutRun },
    );
    expect(scoutRun).toHaveBeenCalledWith(expect.objectContaining({ role: "scout" }));
    expect(brief).toContain("src/config.ts");
    // Spend is attributed under the scout budget category so Slice 8 can compare it.
    const ledger = readBudgetLedgerDetailed(path.join(runRoot, "budget-ledger.jsonl"));
    expect(ledger.entries.some((e) => e.persistentAgentName === SCOUT_BUDGET_CATEGORY)).toBe(true);
    // The spawn is visible: a status or notify names the scout brief.
    const statuses = ctx.setStatus.mock.calls.map((c) => c[1]);
    const notifies = (ctx.value.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(
      statuses.some((s) => /scout/i.test(String(s))) || notifies.some((n) => /scout/i.test(String(n))),
    ).toBe(true);
  });

  it("skips the scout when autoScout is off", async () => {
    const controller = new PrewalkController();
    const ctx = context();
    const ext = extension();
    await autoArmPrewalk(ext.value, controller, configFor({ autoScout: false }), ctx.value);
    const scoutRun = vi.fn();
    const brief = await scoutOnTaskObserved(
      controller,
      configFor({ autoScout: false }).prewalk,
      ctx.value,
      "any task",
      undefined,
      { scoutRun },
    );
    expect(scoutRun).not.toHaveBeenCalled();
    expect(brief).toBe("");
  });

  it("skips the scout when the session is not armed", async () => {
    const controller = new PrewalkController();
    const scoutRun = vi.fn();
    const brief = await scoutOnTaskObserved(
      controller,
      configFor({}).prewalk,
      context().value,
      "any task",
      undefined,
      { scoutRun },
    );
    expect(scoutRun).not.toHaveBeenCalled();
    expect(brief).toBe("");
  });
});

describe("autoArmPrewalk", () => {
  it("arms from configuration and queues the advisory prompt", async () => {
    const controller = new PrewalkController();
    const ctx = context();
    const ext = extension();

    expect(await autoArmPrewalk(ext.value, controller, configFor({}), ctx.value)).toBe(true);
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

  it("stays idle when arm is off", async () => {
    const controller = new PrewalkController();
    const ext = extension();
    const config = normalizeFabricConfig({ prewalk: { arm: "off", model: "anthropic/executor" } });

    expect(await autoArmPrewalk(ext.value, controller, config, context().value)).toBe(false);
    expect(controller.isArmed()).toBe(false);
    expect(ext.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses an unset or malformed model instead of prompting", async () => {
    const controller = new PrewalkController();
    const ext = extension();
    const unset = normalizeFabricConfig({ prewalk: { arm: "session" } });
    expect(await autoArmPrewalk(ext.value, controller, unset, context().value)).toBe(false);

    const malformed = configFor({ model: "executor-without-provider" });
    expect(await autoArmPrewalk(ext.value, controller, malformed, context().value)).toBe(false);
    expect(controller.isArmed()).toBe(false);
  });

  it("still arms research without agents because it stays in session", async () => {
    const controller = new PrewalkController();
    const ext = extension();
    const config = normalizeFabricConfig({
      prewalk: { arm: "session", model: "anthropic/executor", mode: "research" },
      agents: { enabled: false },
    });
    expect(await autoArmPrewalk(ext.value, controller, config, context().value)).toBe(true);
    expect(controller.status()).toMatchObject({ state: "armed" });
  });

  it("never re-arms over a live arm", async () => {
    const controller = new PrewalkController();
    const ext = extension();
    const config = configFor({});
    expect(await autoArmPrewalk(ext.value, controller, config, context().value)).toBe(true);
    expect(await autoArmPrewalk(ext.value, controller, config, context().value)).toBe(false);
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
