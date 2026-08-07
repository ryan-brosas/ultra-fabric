import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PrewalkController } from "../src/prewalk/controller.js";
import { armPrewalk } from "../src/prewalk/arm.js";
import { normalizeFabricConfig } from "../src/config.js";
import {
  buildScoutBrief,
  runScoutBrief,
  SCOUT_BUDGET_CATEGORY,
} from "../src/prewalk/scout-brief.js";
import { readBudgetLedgerDetailed } from "./support/budget-ledger-detail.js";

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

describe("prewalk scout brief", () => {
  it("runs the cheap scout and injects the brief ahead of planning", async () => {
    const controller = new PrewalkController();
    const ctx = context();
    const ext = extension();
    const scoutRun = vi.fn(async () => ({
      result: "src/prewalk/arm.ts — arms prewalk\nsrc/prewalk/checklist.ts — parses checklist",
      model: "omniroute/opencode-go/deepseek-v4-flash",
      usage: { input: 500, output: 40 },
    }));

    await armPrewalk(
      ext.value,
      controller,
      configFor({ autoScout: true }).prewalk,
      ctx.value,
      "anthropic/executor",
      "refactor the prewalk controller state machine",
      "/tmp/run-root",
      { scoutRun },
    );

    expect(scoutRun).toHaveBeenCalledWith(expect.objectContaining({ role: "scout" }));
    const sent = ext.sendMessage.mock.calls[0]?.[0] as { content: string };
    expect(sent.content).toContain("Scout brief");
    expect(sent.content).toContain("src/prewalk/arm.ts");
  });

  it("records scout token spend into the budget ledger", async () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-scout-"));
    const controller = new PrewalkController();
    const ctx = context();
    const ext = extension();
    const scoutRun = vi.fn(async () => ({
      result: "brief",
      model: "deepseek-v4-flash",
      usage: { input: 500, output: 40 },
    }));

    await armPrewalk(
      ext.value,
      controller,
      configFor({ autoScout: true }).prewalk,
      ctx.value,
      "anthropic/executor",
      "non-trivial refactor",
      runRoot,
      { scoutRun },
    );

    const detail = readBudgetLedgerDetailed(path.join(runRoot, "budget-ledger.jsonl"));
    const scoutEntries = detail.entries.filter(
      (e) => e.persistentAgentName === SCOUT_BUDGET_CATEGORY,
    );
    expect(scoutEntries.length).toBeGreaterThan(0);
    expect(scoutEntries[0]?.input).toBe(500);
    expect(scoutEntries[0]?.output).toBe(40);
  });

  it("skips the scout entirely when autoScout is off", async () => {
    // autoScout defaults on, so the opt-out must be explicit.
    const controller = new PrewalkController();
    const ctx = context();
    const ext = extension();
    const scoutRun = vi.fn();

    await armPrewalk(
      ext.value,
      controller,
      configFor({ autoScout: false }).prewalk,
      ctx.value,
      "anthropic/executor",
      "any task",
      "/tmp/run-root",
      { scoutRun },
    );

    expect(scoutRun).not.toHaveBeenCalled();
    const sent = ext.sendMessage.mock.calls[0]?.[0] as { content: string };
    expect(sent.content).not.toContain("Scout brief");
  });

  it("still arms cleanly when the scout run fails", async () => {
    const controller = new PrewalkController();
    const ctx = context();
    const ext = extension();
    const scoutRun = vi.fn(async () => {
      throw new Error("scout unavailable");
    });

    await armPrewalk(
      ext.value,
      controller,
      configFor({ autoScout: true }).prewalk,
      ctx.value,
      "anthropic/executor",
      "non-trivial task",
      "/tmp/run-root",
      { scoutRun },
    );

    expect(controller.isArmed("session-1")).toBe(true);
    expect(ext.sendMessage).toHaveBeenCalled();
  });
});

describe("buildScoutBrief", () => {
  it("bounds the brief to a token-safe size", () => {
    const long = "x".repeat(5000);
    const brief = buildScoutBrief({ result: long });
    expect(brief.length).toBeLessThanOrEqual(2030);
    expect(brief).toContain("truncated");
  });

  it("returns empty for an empty scout result", () => {
    expect(buildScoutBrief({ result: "   " })).toBe("");
  });
});

describe("runScoutBrief", () => {
  it("propagates the runner request shape", async () => {
    const runner = vi.fn(async (req: { task: string; role: string; maxTokens: number; timeoutMs: number }) => ({ result: "brief", usage: {} }));
    const brief = await runScoutBrief(runner, "task text");
    expect(brief).toBe("brief");
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      role: "scout",
      maxTokens: 512,
    });
    expect(String(runner.mock.calls[0]?.[0]?.task)).toContain("TASK: task text");
  });

  it("returns empty when the runner throws", async () => {
    const runner = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await runScoutBrief(runner, "task")).toBe("");
  });
});
