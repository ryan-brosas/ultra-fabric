import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FABRIC_CONFIG,
  MAX_EXECUTOR_MEMORY_LIMIT_BYTES,
  QUICKJS_MAX_MEMORY_LIMIT_BYTES,
  effectiveToolCaptureConfig,
  loadFabricConfig,
  normalizeFabricConfig,
  saveFabricConfig,
} from "../src/config.js";

const temporaryDirectories: string[] = [];
const originalCompactionEngineEnv = process.env.PI_FABRIC_COMPACTION_ENGINE;

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-config-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (originalCompactionEngineEnv === undefined) {
    delete process.env.PI_FABRIC_COMPACTION_ENGINE;
  } else {
    process.env.PI_FABRIC_COMPACTION_ENGINE = originalCompactionEngineEnv;
  }
});

describe("Fabric configuration", () => {
  it("keeps model-visible execution output at Pi read parity by default", () => {
    expect(DEFAULT_FABRIC_CONFIG.executor.maxOutputChars).toBe(50_000);
  });

  it("normalizes bounds and approval modes", () => {
    const config = normalizeFabricConfig({
      fullCodeMode: false,
      executor: {
        timeoutMs: 1,
        memoryLimitBytes: Number.MAX_SAFE_INTEGER,
        maxGateRevisions: 99,
        maxRunEvidence: 0,
        maxRunTransitions: 99_999,
      },
      approvals: { write: "auto", agent: "invalid", model: "anthropic/classifier" },
      agents: { maxConcurrent: 100, maxPerExecution: 5_000, transport: "herdr" },
      capture: {
        keepVisible: ["fabric_exec", "custom", "custom"],
        defaultRisk: "invalid",
        risks: { inspect: "read", mutate: "invalid" },
      },
      ui: {
        widget: "always",
        maxRows: 100,
        refreshMs: 1,
        eventHistory: 0,
      },
      mesh: {
        persistentAgentQueueLimit: 0,
        persistentAgentRunMaxAttempts: 99,
        persistentAgentRunBaseDelayMs: -1,
        persistentAgentRunMaxDelayMs: 99_999,
        persistentAgentRunJitterMs: 99_999,
        persistentAgentDeliveryMaxAttempts: 99,
        persistentAgentDeliveryBaseDelayMs: -1,
        persistentAgentDeliveryMaxDelayMs: 99_999,
        persistentAgentDeliveryJitterMs: 99_999,
        persistentAgentCircuitFailureThreshold: 0,
        persistentAgentCircuitCooldownMs: Number.MAX_SAFE_INTEGER,
        eventContextChars: 5_000_000,
      },
    });
    expect(config.fullCodeMode).toBe(false);
    expect(config.executor.timeoutMs).toBe(1_000);
    expect(config.executor.memoryLimitBytes).toBe(
      Math.min(QUICKJS_MAX_MEMORY_LIMIT_BYTES, MAX_EXECUTOR_MEMORY_LIMIT_BYTES),
    );
    expect(config.executor).toMatchObject({
      maxGateRevisions: 10,
      maxRunEvidence: 1,
      maxRunTransitions: 10_000,
    });
    expect(config.approvals.write).toBe("auto");
    expect(config.approvals.agent).toBe("allow");
    expect(config.approvals.model).toBe("anthropic/classifier");
    expect(config.agents.maxConcurrent).toBe(32);
    expect(config.agents.maxPerExecution).toBe(1_000);
    expect(config.agents.transport).toBe("herdr");
    expect(config.capture.keepVisible).toEqual(["fabric_exec", "custom"]);
    expect(config.capture.defaultRisk).toBe("execute");
    expect(config.capture.risks).toMatchObject({ inspect: "read", mutate: "execute" });
    expect(config.ui).toMatchObject({
      widget: "always",
      maxRows: 20,
      refreshMs: 100,
      eventHistory: 1,
    });
    expect(config.mesh.persistentAgentQueueLimit).toBe(1);
    expect(config.mesh).toMatchObject({
      persistentAgentRunMaxAttempts: 10,
      persistentAgentRunBaseDelayMs: 0,
      persistentAgentRunMaxDelayMs: 60_000,
      persistentAgentRunJitterMs: 60_000,
      persistentAgentDeliveryMaxAttempts: 10,
      persistentAgentDeliveryBaseDelayMs: 0,
      persistentAgentDeliveryMaxDelayMs: 60_000,
      persistentAgentDeliveryJitterMs: 60_000,
      persistentAgentCircuitFailureThreshold: 1,
      persistentAgentCircuitCooldownMs: 24 * 60 * 60 * 1_000,
    });
    expect(config.mesh.eventContextChars).toBe(1_000_000);
  });

  it("normalizes persistentAgent overflow policy", () => {
    expect(
      normalizeFabricConfig({ mesh: { persistentAgentOverflowPolicy: "dead-letter" } }).mesh
        .persistentAgentOverflowPolicy,
    ).toBe("dead-letter");
    expect(
      normalizeFabricConfig({ mesh: { persistentAgentOverflowPolicy: "discard" } }).mesh
        .persistentAgentOverflowPolicy,
    ).toBe("reject");
  });

  it("normalizes executor runtimes and their memory ceilings", () => {
    const native = normalizeFabricConfig({
      executor: { runtime: "node-process", memoryLimitBytes: Number.MAX_SAFE_INTEGER },
    });
    expect(native.executor.runtime).toBe("node-process");
    expect(native.executor.memoryLimitBytes).toBe(MAX_EXECUTOR_MEMORY_LIMIT_BYTES);

    const invalid = normalizeFabricConfig({ executor: { runtime: "repl" } });
    expect(invalid.executor.runtime).toBe("quickjs");
  });

  it("normalizes a dedicated prewalk executor model", () => {
    expect(
      normalizeFabricConfig({ prewalk: { model: "anthropic/executor" } }).prewalk,
    ).toEqual({
      model: "anthropic/executor",
      triggerRisks: [],
      triggerEffects: ["workspace"],
      triggerRefs: ["pi.edit", "pi.write", "schema.commit"],
      arm: "task",
      delegateContext: true,
      autoScout: true,
    });
    expect(normalizeFabricConfig({ prewalk: { model: "   " } }).prewalk).toEqual({
      triggerRisks: [],
      triggerEffects: ["workspace"],
      triggerRefs: ["pi.edit", "pi.write", "schema.commit"],
      arm: "task",
      delegateContext: true,
      autoScout: true,
    });
    expect(normalizeFabricConfig({ prewalk: { arm: "off" } }).prewalk).toEqual({
      triggerRisks: [],
      triggerEffects: ["workspace"],
      triggerRefs: ["pi.edit", "pi.write", "schema.commit"],
      arm: "off",
      delegateContext: true,
      autoScout: true,
    });
        // Arming defaults to per-task (the legacy always-rearm default) and only
    // stays off when the user explicitly opts out.
    expect(normalizeFabricConfig({ prewalk: { autoArm: true } }).prewalk).toMatchObject({
      arm: "session",
    });
    expect(normalizeFabricConfig({ prewalk: { arm: "task" } }).prewalk).toMatchObject({
      arm: "task",
    });
    expect(normalizeFabricConfig({}).prewalk).toHaveProperty("arm", "task");
    expect(normalizeFabricConfig({ prewalk: { arm: "off" } }).prewalk).toHaveProperty(
      "arm",
      "off",
    );
    // Failure memory is opt-in and absent by default.
    expect(normalizeFabricConfig({}).prewalk).not.toHaveProperty("failureMemory");
    expect(normalizeFabricConfig({ prewalk: { failureMemory: true } }).prewalk).toMatchObject({
      failureMemory: true,
    });
    expect(normalizeFabricConfig({ prewalk: { autoScout: true } }).prewalk).toMatchObject({
      autoScout: true,
    });
    // Agent-utilization levers default on (opencode-style task-first delegation);
    // an explicit false still disables each one. Learning and retirement levers
    // stay opt-in until the Slice 8 benchmark gate.
    expect(DEFAULT_FABRIC_CONFIG.prewalk).toMatchObject({ autoScout: true, delegateContext: true });
    expect(normalizeFabricConfig({}).prewalk).toMatchObject({ autoScout: true, delegateContext: true });
    expect(normalizeFabricConfig({ prewalk: { autoScout: false } }).prewalk).not.toHaveProperty(
      "autoScout",
    );
    expect(normalizeFabricConfig({ prewalk: { delegateContext: false } }).prewalk).not.toHaveProperty(
      "delegateContext",
    );
    // A configured run root must be absolute so agent evidence lands somewhere predictable.
    expect(normalizeFabricConfig({ agents: { runRoot: "/tmp/fabric-runs" } }).agents.runRoot).toBe(
      "/tmp/fabric-runs",
    );
    expect(normalizeFabricConfig({ agents: { runRoot: "relative/path" } }).agents).not.toHaveProperty(
      "runRoot",
    );
    expect(
      normalizeFabricConfig({
        prewalk: {
          fallbackModels: [
            " anthropic/fallback ",
            "invalid",
            "anthropic/fallback",
            "openai/backup",
          ],
        },
      }).prewalk,
    ).toMatchObject({
      fallbackModels: ["anthropic/fallback", "openai/backup"],
    });
  });

  it("normalizes bounded outcome learning policy", () => {
    expect(normalizeFabricConfig({
      outcomes: { enabled: false, maxRecords: 0, minRecommendationSamples: 1 },
    }).outcomes).toEqual({
      enabled: false,
      maxRecords: 100,
      minRecommendationSamples: 2,
    });
    expect(DEFAULT_FABRIC_CONFIG.outcomes).toEqual({
      enabled: true,
      maxRecords: 1_000,
      minRecommendationSamples: 5,
    });
  });

  it("normalizes bounded Ultra Consult policy", () => {
    expect(normalizeFabricConfig({
      consult: {
        enabled: false,
        maxWorkers: 99,
        contextPressureThreshold: 2,
        maxFindingsPerWorker: 0,
        maxEvidencePerFinding: 99,
        maxEvidenceFileBytes: 1,
        maxEvidenceBytesPerConsult: 1,
        maxTokensPerWorker: 0,
      },
    }).consult).toEqual({
      enabled: false,
      maxWorkers: 3,
      contextPressureThreshold: 0.95,
      maxFindingsPerWorker: 1,
      maxEvidencePerFinding: 16,
      maxEvidenceFileBytes: 1_024,
      maxEvidenceBytesPerConsult: 1_024,
      maxTokensPerWorker: 256,
    });
    expect(DEFAULT_FABRIC_CONFIG.consult).toEqual({
      enabled: true,
      maxWorkers: 3,
      contextPressureThreshold: 0.6,
      maxFindingsPerWorker: 8,
      maxEvidencePerFinding: 8,
      maxEvidenceFileBytes: 2 * 1024 * 1024,
      maxEvidenceBytesPerConsult: 8 * 1024 * 1024,
      maxTokensPerWorker: 8_000,
    });
  });

  it("normalizes admission and capability profiles", () => {
    expect(normalizeFabricConfig({
      agents: {
        requireAdmissionIntent: true,
        capabilityProfiles: {
          inspect: { tools: ["read", "grep", "read", 3], risks: ["read", "bad"] },
          "bad profile": { tools: ["bash"], risks: ["execute"] },
        },
      },
    }).agents).toMatchObject({
      requireAdmissionIntent: true,
      capabilityProfiles: {
        inspect: { tools: ["read", "grep"], risks: ["read"] },
      },
    });
    expect(DEFAULT_FABRIC_CONFIG.agents).toMatchObject({
      requireAdmissionIntent: false,
      capabilityProfiles: {},
    });
  });

  it("normalizes bounded agent routing policy", () => {
    expect(normalizeFabricConfig({
      agents: {
        fallbackModels: ["openai/gpt", "bad", "openai/gpt", "anthropic/sonnet"],
        allowQualityDowngrade: true,
      },
    }).agents).toMatchObject({
      fallbackModels: ["openai/gpt", "anthropic/sonnet"],
      allowQualityDowngrade: true,
    });
    expect(DEFAULT_FABRIC_CONFIG.agents).toMatchObject({
      fallbackModels: [],
      allowQualityDowngrade: false,
    });
  });

  it("normalizes configurable Prewalk effect triggers", () => {
    expect(normalizeFabricConfig({
      prewalk: {
        triggerRisks: ["write", "bad", "write"],
        triggerRefs: [" extensions.generated_write ", "bad", "pi.edit"],
      },
    }).prewalk).toMatchObject({
      triggerRisks: ["write"],
      triggerRefs: ["extensions.generated_write", "pi.edit"],
    });
    expect(DEFAULT_FABRIC_CONFIG.prewalk).toMatchObject({
      triggerRisks: [],
      triggerEffects: ["workspace"],
      triggerRefs: ["pi.edit", "pi.write", "schema.commit"],
    });
  });

  it("normalizes opt-in gated prewalk revisions", () => {
    expect(normalizeFabricConfig({}).prewalk).not.toHaveProperty("verificationMode");
    expect(normalizeFabricConfig({
      prewalk: { verificationMode: "gated", maxPhaseRevisions: 99 },
    }).prewalk).toMatchObject({
      verificationMode: "gated",
      maxPhaseRevisions: 8,
    });
    expect(normalizeFabricConfig({
      prewalk: { verificationMode: "prompt-only", maxPhaseRevisions: 3 },
    }).prewalk).not.toHaveProperty("verificationMode");
  });

  it("keeps a valid prewalk thinking level and drops invalid or empty ones", () => {
    expect(normalizeFabricConfig({ prewalk: { thinking: "high" } }).prewalk.thinking).toBe(
      "high",
    );
    expect(normalizeFabricConfig({ prewalk: { thinking: "xhigh" } }).prewalk.thinking).toBe(
      "xhigh",
    );
    expect(
      normalizeFabricConfig({ prewalk: { thinking: "extreme" } }).prewalk.thinking,
    ).toBeUndefined();
    expect(
      normalizeFabricConfig({ prewalk: { thinking: "" } }).prewalk.thinking,
    ).toBeUndefined();
    expect(normalizeFabricConfig({}).prewalk.thinking).toBeUndefined();
  });

  it("forces QuickJS in Schema enforce mode", () => {
    const config = normalizeFabricConfig({
      executor: { runtime: "node-process", memoryLimitBytes: Number.MAX_SAFE_INTEGER },
      schema: { mode: "enforce" },
    });
    expect(config.executor.runtime).toBe("quickjs");
    expect(config.executor.memoryLimitBytes).toBe(
      Math.min(QUICKJS_MAX_MEMORY_LIMIT_BYTES, MAX_EXECUTOR_MEMORY_LIMIT_BYTES),
    );
  });

  it("normalizes the default result format", () => {
    expect(DEFAULT_FABRIC_CONFIG.executor.resultFormat).toBe("auto");
    expect(normalizeFabricConfig({ executor: { resultFormat: "yaml" } }).executor.resultFormat).toBe("yaml");
    expect(normalizeFabricConfig({ executor: { resultFormat: "json" } }).executor.resultFormat).toBe("json");
    expect(normalizeFabricConfig({ executor: { resultFormat: "invalid" } }).executor.resultFormat).toBe("auto");
  });

  it("normalizes the agent cost budget", () => {
    const enabled = normalizeFabricConfig({ agents: { budgetUsd: 0.42 } });
    expect(enabled.agents.budgetUsd).toBe(0.42);
    const negative = normalizeFabricConfig({ agents: { budgetUsd: -5 } });
    expect(negative.agents.budgetUsd).toBe(0);
    const huge = normalizeFabricConfig({ agents: { budgetUsd: Number.MAX_VALUE } });
    expect(huge.agents.budgetUsd).toBe(1_000_000);
    expect(DEFAULT_FABRIC_CONFIG.agents.budgetUsd).toBe(0);
  });

  it("normalizes the agent default model and drops empty values", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.model).toBeUndefined();
    const set = normalizeFabricConfig({ agents: { model: "claude-sonnet-4-5" } });
    expect(set.agents.model).toBe("claude-sonnet-4-5");
    const blank = normalizeFabricConfig({ agents: { model: "  " } });
    expect(blank.agents.model).toBeUndefined();
    const nonString = normalizeFabricConfig({ agents: { model: 42 } });
    expect(nonString.agents.model).toBeUndefined();
  });


  it("defaults the agent thinking level to medium and validates the value", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.thinking).toBe("medium");
    const set = normalizeFabricConfig({ agents: { thinking: "high" } });
    expect(set.agents.thinking).toBe("high");
    const invalid = normalizeFabricConfig({ agents: { thinking: "turbo" } });
    expect(invalid.agents.thinking).toBe("medium");
    const nonString = normalizeFabricConfig({ agents: { thinking: 42 } });
    expect(nonString.agents.thinking).toBe("medium");
  });

  it("defaults and validates temporal retention windows", () => {
    expect(DEFAULT_FABRIC_CONFIG.retention).toEqual({
      orphanedTempRunMs: 6 * 60 * 60 * 1_000,
      oneShotRunMs: 24 * 60 * 60 * 1_000,
      persistentAgentRunArchiveMs: 7 * 24 * 60 * 60 * 1_000,
    });
    expect(
      normalizeFabricConfig({
        retention: {
          orphanedTempRunMs: 2 * 60 * 60 * 1_000,
          oneShotRunMs: 2 * 24 * 60 * 60 * 1_000,
          persistentAgentRunArchiveMs: 30 * 24 * 60 * 60 * 1_000,
        },
      }).retention,
    ).toEqual({
      orphanedTempRunMs: 2 * 60 * 60 * 1_000,
      oneShotRunMs: 2 * 24 * 60 * 60 * 1_000,
      persistentAgentRunArchiveMs: 30 * 24 * 60 * 60 * 1_000,
    });
    expect(
      normalizeFabricConfig({ retention: { orphanedTempRunMs: 1 } }).retention.orphanedTempRunMs,
    ).toBe(60 * 60 * 1_000);
  });

  it("defaults persistentAgent scope to project and validates the value", () => {
    expect(DEFAULT_FABRIC_CONFIG.mesh.persistentAgentScope).toBe("project");
    const session = normalizeFabricConfig({ mesh: { persistentAgentScope: "session" } });
    expect(session.mesh.persistentAgentScope).toBe("session");
    const invalid = normalizeFabricConfig({ mesh: { persistentAgentScope: "untrusted" } });
    expect(invalid.mesh.persistentAgentScope).toBe("project");
    const nonString = normalizeFabricConfig({ mesh: { persistentAgentScope: 42 } });
    expect(nonString.mesh.persistentAgentScope).toBe("project");
  });

  it("normalizes the ESC halt toggle for persistentAgents", () => {
    expect(DEFAULT_FABRIC_CONFIG.ui.haltOnEscape).toBe(true);
    const disabled = normalizeFabricConfig({ ui: { haltOnEscape: false } });
    expect(disabled.ui.haltOnEscape).toBe(false);
    const invalid = normalizeFabricConfig({ ui: { haltOnEscape: "off" } });
    expect(invalid.ui.haltOnEscape).toBe(true);
  });

  it("normalizes nested-tool visibility and the global debounce", () => {
    expect(DEFAULT_FABRIC_CONFIG.ui.showNestedToolCalls).toBe(true);
    expect(DEFAULT_FABRIC_CONFIG.ui.nestedToolDebounceMs).toBe(100);
    expect(
      normalizeFabricConfig({
        ui: { showNestedToolCalls: false, nestedToolDebounceMs: 0 },
      }).ui,
    ).toMatchObject({ showNestedToolCalls: false, nestedToolDebounceMs: 0 });
    expect(
      normalizeFabricConfig({ ui: { nestedToolDebounceMs: -10 } }).ui.nestedToolDebounceMs,
    ).toBe(0);
    expect(
      normalizeFabricConfig({ ui: { nestedToolDebounceMs: 99_999 } }).ui.nestedToolDebounceMs,
    ).toBe(2_000);
    expect(
      normalizeFabricConfig({
        ui: { showNestedToolCalls: "off", nestedToolDebounceMs: "fast" },
      }).ui,
    ).toMatchObject({ showNestedToolCalls: true, nestedToolDebounceMs: 100 });
  });

  it("normalizes strict Schema mode, transaction bounds, and trusted command definitions", () => {
    const config = normalizeFabricConfig({
      schema: {
        mode: "enforce",
        certificateTtlMs: 1,
        maxFiles: 10_000,
        maxBytes: Number.MAX_SAFE_INTEGER,
        trustedCommands: {
          tests: {
            command: "pnpm",
            args: ["test", 42, "--run"] as unknown[],
            shell: true,
            timeoutMs: 999_999,
          },
          "bad name": { command: "ignored" },
          empty: { command: " " },
        },
      },
    });
    expect(config.schema).toEqual({
      mode: "enforce",
      certificateTtlMs: 1_000,
      maxFiles: 1_000,
      maxBytes: 100 * 1024 * 1024,
      trustedCommands: {
        tests: {
          command: "pnpm",
          args: [],
          shell: true,
          timeoutMs: 300_000,
        },
      },
    });
    expect(normalizeFabricConfig({ schema: { mode: "strict" } }).schema.mode).toBe("off");
    expect(DEFAULT_FABRIC_CONFIG.schema.mode).toBe("off");
  });

  it("forces fabric_exec to be the only capture visibility exception in enforce mode", () => {
    const capture = effectiveToolCaptureConfig({
      fullCodeMode: false,
      schema: { ...DEFAULT_FABRIC_CONFIG.schema, mode: "enforce" },
      capture: {
        ...DEFAULT_FABRIC_CONFIG.capture,
        enabled: false,
        hideFromModel: false,
        keepVisible: ["fabric_exec", "bash", "custom"],
      },
    });
    expect(capture).toMatchObject({
      enabled: true,
      hideFromModel: true,
      keepVisible: ["fabric_exec"],
    });
  });

  it("preserves native tool registration in orchestration-only mode", () => {
    const capture = effectiveToolCaptureConfig({
      fullCodeMode: false,
      capture: DEFAULT_FABRIC_CONFIG.capture,
    });
    expect(capture).toMatchObject({ enabled: false, hideFromModel: false });
    expect(DEFAULT_FABRIC_CONFIG.capture).toMatchObject({ enabled: true, hideFromModel: true });
  });

  it("never leaves Pi core tools model-visible in full code mode", () => {
    expect(DEFAULT_FABRIC_CONFIG.capture.keepVisible).toEqual(["fabric_exec"]);
    const capture = effectiveToolCaptureConfig({
      fullCodeMode: true,
      capture: {
        ...DEFAULT_FABRIC_CONFIG.capture,
        keepVisible: ["fabric_exec", "read", "bash", "custom"],
      },
    });
    expect(capture.keepVisible).toEqual(["fabric_exec", "custom"]);
  });

  it("merges global and trusted project configuration", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "fabric.json"),
      JSON.stringify({ approvals: { network: "allow" }, agents: { maxConcurrent: 2 } }),
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({ agents: { transport: "localterm" } }),
    );
    const config = loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(config.approvals.network).toBe("allow");
    expect(config.agents.maxConcurrent).toBe(2);
    expect(config.agents.transport).toBe("localterm");
  });

  it("updates the compaction engine environment across config re-initialization", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const projectConfig = path.join(cwd, ".pi", "fabric.json");
    fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(projectConfig, JSON.stringify({ compaction: { engine: "fabric" } }));

    loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(process.env.PI_FABRIC_COMPACTION_ENGINE).toBe("fabric");

    fs.writeFileSync(projectConfig, JSON.stringify({ compaction: { engine: "pi" } }));
    loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(process.env.PI_FABRIC_COMPACTION_ENGINE).toBeUndefined();
  });

  it("loads trusted commands only from trusted Fabric configuration", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "fabric.json"),
      JSON.stringify({ schema: { trustedCommands: { global: { command: "node", args: ["--version"] } } } }),
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({ schema: { trustedCommands: { project: { command: "git", args: ["status"] } } } }),
    );
    const untrusted = loadFabricConfig({ cwd, agentDir, projectTrusted: false });
    expect(Object.keys(untrusted.schema.trustedCommands)).toEqual(["global"]);
    const trusted = loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(Object.keys(trusted.schema.trustedCommands).sort()).toEqual(["global", "project"]);
  });

  it("ignores project configuration when the project is untrusted", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({ approvals: { execute: "deny" } }),
    );
    const config = loadFabricConfig({ cwd, agentDir, projectTrusted: false });
    expect(config.approvals.execute).toBe("allow");
  });

  it("saves partial overrides into the project fabric.json when trusted", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({ agents: { transport: "localterm" } }),
    );

    const result = saveFabricConfig(
      { cwd, agentDir, projectTrusted: true },
      { agents: { maxConcurrent: 8 }, fullCodeMode: false },
    );

    expect(result.scope).toBe("project");
    expect(result.path).toBe(path.join(cwd, ".pi", "fabric.json"));
    const saved = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8"));
    expect(saved).toEqual({
      configVersion: 3,
      agents: { transport: "localterm", maxConcurrent: 8 },
      fullCodeMode: false,
    });
    const config = loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(config.agents.maxConcurrent).toBe(8);
    expect(config.agents.transport).toBe("localterm");
    expect(config.fullCodeMode).toBe(false);
  });

  it("saves into the global fabric.json when the project is untrusted", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    const result = saveFabricConfig(
      { cwd, agentDir, projectTrusted: false },
      { executor: { timeoutMs: 30_000 } },
    );

    expect(result.scope).toBe("global");
    expect(result.path).toBe(path.join(agentDir, "fabric.json"));
    expect(fs.existsSync(path.join(cwd, ".pi", "fabric.json"))).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(agentDir, "fabric.json"), "utf8"));
    expect(saved).toEqual({ configVersion: 3, executor: { timeoutMs: 30_000 } });
  });

  it("persists and clears the dedicated prewalk model", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const location = { cwd, agentDir, projectTrusted: true };

    saveFabricConfig(location, {
      prewalk: { model: "anthropic/claude-sonnet-4-5" },
    });
    expect(loadFabricConfig(location).prewalk.model).toBe(
      "anthropic/claude-sonnet-4-5",
    );

    saveFabricConfig(location, { prewalk: { model: "" } });
    expect(loadFabricConfig(location).prewalk).toEqual({
      triggerRisks: [],
      triggerEffects: ["workspace"],
      triggerRefs: ["pi.edit", "pi.write", "schema.commit"],
      arm: "task",
      delegateContext: true,
      autoScout: true,
    });
  });

  it("saves array overrides by replacing the array while preserving siblings", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({
        agents: { transport: "tmux", defaultTools: ["read", "bash"] },
        capture: { defaultRisk: "read", keepVisible: ["fabric_exec"] },
      }),
    );

    saveFabricConfig(
      { cwd, agentDir, projectTrusted: true },
      {
        agents: { defaultTools: ["read", "edit", "grep"] },
        capture: { keepVisible: ["fabric_exec", "custom-tool"] },
      },
    );

    const saved = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8"));
    // Arrays are replaced, not concatenated; sibling object keys are preserved.
    expect(saved.agents).toEqual({ transport: "tmux", defaultTools: ["read", "edit", "grep"] });
    expect(saved.capture).toEqual({
      defaultRisk: "read",
      keepVisible: ["fabric_exec", "custom-tool"],
    });
    const config = loadFabricConfig({ cwd, agentDir, projectTrusted: true });
    expect(config.agents.defaultTools).toEqual(["read", "edit", "grep"]);
    expect(config.capture.keepVisible).toEqual(["fabric_exec", "custom-tool"]);
    expect(config.agents.transport).toBe("tmux");
  });

  it("defaults the agent timeout to 60 minutes and clamps to the 24-hour bound", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.timeoutMs).toBe(3_600_000);
    expect(normalizeFabricConfig({}).agents.timeoutMs).toBe(3_600_000);
    expect(
      normalizeFabricConfig({ agents: { timeoutMs: 99_999_999 } }).agents.timeoutMs,
    ).toBe(86_400_000);
    expect(
      normalizeFabricConfig({ agents: { timeoutMs: 1_200_000 } }).agents.timeoutMs,
    ).toBe(1_200_000);
  });

  it("parses prewalk.researchAgent, keeping valid role names and dropping invalid ones", () => {
    expect(DEFAULT_FABRIC_CONFIG.prewalk.researchAgent).toBeUndefined();
    const valid = normalizeFabricConfig({ prewalk: { researchAgent: "scout" } }).prewalk.researchAgent;
    expect(valid).toBe("scout");
    const invalid = normalizeFabricConfig({ prewalk: { researchAgent: "123bad" } }).prewalk.researchAgent;
    expect(invalid).toBeUndefined();
    const empty = normalizeFabricConfig({ prewalk: { researchAgent: "  " } }).prewalk.researchAgent;
    expect(empty).toBeUndefined();
  });

  it("normalizes per-role model overrides, keeping only valid role names and provider/model strings", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.roleModels).toEqual({});
    const valid = normalizeFabricConfig({
      agents: {
        roleModels: {
          scout: "makora/zai-org/GLM-5.2-NVFP4",
          reviewer: "claude-bridge/claude-haiku-4-5",
          worker: "openai/gpt-5",
        },
      },
    }).agents.roleModels;
    expect(valid).toEqual({
      scout: "makora/zai-org/GLM-5.2-NVFP4",
      reviewer: "claude-bridge/claude-haiku-4-5",
      worker: "openai/gpt-5",
    });

    const filtered = normalizeFabricConfig({
      agents: {
        roleModels: {
          "123start": "openai/gpt-5",
          scout: "not-a-model",
          explorer: "  ",
          planner: "provider/",
        },
      },
    }).agents.roleModels;
    expect(filtered).toEqual({});
  });

  it("normalizes the per-child token limit and treats zero as disabled", () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.maxTokensPerChild).toBe(0);
    const set = normalizeFabricConfig({ agents: { maxTokensPerChild: 50_000 } });
    expect(set.agents.maxTokensPerChild).toBe(50_000);
    const negative = normalizeFabricConfig({ agents: { maxTokensPerChild: -5 } });
    expect(negative.agents.maxTokensPerChild).toBe(0);
    const huge = normalizeFabricConfig({ agents: { maxTokensPerChild: Number.MAX_VALUE } });
    expect(huge.agents.maxTokensPerChild).toBe(100_000_000);
  });
});
