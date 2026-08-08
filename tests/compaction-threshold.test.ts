import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerCompactionHook } from "../src/compaction/hook.js";
import { compactAtConfiguredThreshold, modelCompactionKey, resetThresholdCooldown } from "../src/compaction/threshold.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";

const contextWithUsage = (
  percent: number | null,
  messageCount = 0,
): ExtensionContext => ({
  model: { provider: "anthropic", id: "sonnet" },
  getContextUsage: () => ({ tokens: percent === null ? null : percent * 1_000, contextWindow: 100_000, percent }),
  sessionManager: {
    buildContextEntries: () =>
      Array.from({ length: messageCount }, () => ({
        type: "message",
        message: { role: "user", content: "x" },
      })),
  },
  compact: vi.fn((options) => options?.onComplete?.({} as never)),
  hasUI: true,
  ui: { notify: vi.fn() },
} as unknown as ExtensionContext);

describe("model-linked compaction thresholds", () => {
  it("builds canonical provider/model keys", () => {
    expect(modelCompactionKey({ provider: "openai", id: "gpt-5" } as never)).toBe("openai/gpt-5");
    expect(modelCompactionKey(undefined)).toBeUndefined();
  });

  it("compacts when the active model reaches its configured threshold", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.thresholds["anthropic/sonnet"] = 0.8;
    const context = contextWithUsage(80);

    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(true);
    expect(context.compact).toHaveBeenCalledOnce();
  });

  it("defers Pi's earlier automatic threshold for the active model", () => {
    let handler: ((event: SessionBeforeCompactEvent, context: ExtensionContext) => unknown) | undefined;
    const pi = {
      on(name: string, candidate: unknown) {
        if (name === "session_before_compact") {
          handler = candidate as typeof handler;
        }
      },
    } as unknown as ExtensionAPI;
    registerCompactionHook(pi, {
      getEngine: () => "pi",
      getThresholdContextRatio: (key) => key === "anthropic/sonnet" ? 0.8 : undefined,
    });
    const context = {
      model: { provider: "anthropic", id: "sonnet", contextWindow: 100_000 },
    } as unknown as ExtensionContext;
    const event = {
      reason: "threshold",
      preparation: { tokensBefore: 70_000 },
      branchEntries: [],
    } as unknown as SessionBeforeCompactEvent;

    expect(handler?.(event, context)).toEqual({ cancel: true });
    expect(handler?.({ ...event, preparation: { tokensBefore: 80_000 } } as SessionBeforeCompactEvent, context))
      .toBeUndefined();
    expect(handler?.({ ...event, reason: "overflow" } as SessionBeforeCompactEvent, context))
      .toBeUndefined();
  });

  it("does not compact below threshold or for an unconfigured model", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.thresholds["anthropic/sonnet"] = 0.85;
    const context = contextWithUsage(80);

    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(false);
    expect(context.compact).not.toHaveBeenCalled();

    config.compaction.thresholds = {};
    config.compaction.threshold = 0.95;
    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(false);
    expect(context.compact).not.toHaveBeenCalled();
  });

  it("compacts before a provider message-count cap even at low token occupancy", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.messageThreshold = 700;

    const below = contextWithUsage(10, 699);
    await expect(compactAtConfiguredThreshold(below, config)).resolves.toBe(false);
    expect(below.compact).not.toHaveBeenCalled();

    const reached = contextWithUsage(10, 700);
    await expect(compactAtConfiguredThreshold(reached, config)).resolves.toBe(true);
    expect(reached.compact).toHaveBeenCalledOnce();
  });

  it("compacts at the global default threshold for a model with no entry", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.thresholds = {};
    config.compaction.threshold = 0.85;
    await expect(compactAtConfiguredThreshold(contextWithUsage(84), config)).resolves.toBe(false);
    await expect(compactAtConfiguredThreshold(contextWithUsage(85), config)).resolves.toBe(true);
  });

  it("lets a per-model entry win over the global default", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.thresholds["anthropic/sonnet"] = 0.8;
    config.compaction.threshold = 0.9;
    await expect(compactAtConfiguredThreshold(contextWithUsage(82), config)).resolves.toBe(true);
    await expect(compactAtConfiguredThreshold(contextWithUsage(88), config)).resolves.toBe(true);
  });
});

describe("threshold compaction cooldown (opt-in policy)", () => {
  it("skips a second trigger inside the cooldown window", async () => {
    resetThresholdCooldown();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.cooldownMs = 60_000;
    const context = contextWithUsage(85);
    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(true);
    expect(context.compact).toHaveBeenCalledOnce();
    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(false);
    expect(context.compact).toHaveBeenCalledOnce();
  });

  it("allows another trigger after the cooldown is reset", async () => {
    resetThresholdCooldown();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.cooldownMs = 60_000;
    const context = contextWithUsage(85);
    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(true);
    resetThresholdCooldown();
    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(true);
    expect(context.compact).toHaveBeenCalledTimes(2);
  });

  it("cooldownMs 0 disables the guard", async () => {
    resetThresholdCooldown();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.cooldownMs = 0;
    const context = contextWithUsage(85);
    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(true);
    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(true);
    expect(context.compact).toHaveBeenCalledTimes(2);
  });

  it("normalizes the cooldown window with bounded defaults", () => {
    expect(normalizeFabricConfig({ compaction: { cooldownMs: 5_000 } }).compaction.cooldownMs).toBe(5_000);
    expect(normalizeFabricConfig({ compaction: { cooldownMs: -1 } }).compaction.cooldownMs).toBe(0);
    expect(normalizeFabricConfig({ compaction: { cooldownMs: 99_999_999 } }).compaction.cooldownMs).toBe(3_600_000);
    expect(normalizeFabricConfig({}).compaction.cooldownMs).toBe(0);
  });
});
