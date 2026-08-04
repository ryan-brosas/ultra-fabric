import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricState } from "../src/fabric-state.js";
import type { ModelSource } from "../src/ui/model-picker.js";
import {
  buildFabricSettingsItems,
  executorMemoryLimitOptions,
  FabricSettingsComponent,
  openFabricSettings,
  parseBudgetValue,
  parseFormattedNumericValue,
  populateClaudeModelSource,
} from "../src/ui/settings.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const borderLine = (width: number): string => "─".repeat(width);

const fakeModelSource: ModelSource = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
  ],
  lastUsed: { "anthropic/claude-sonnet-4-5": 200, "openai/gpt-5.5": 100 },
};

const buildItems = (keepVisibleCandidates: string[] = ["fabric_exec"]) =>
  buildFabricSettingsItems(theme, DEFAULT_FABRIC_CONFIG, () => {}, {
    keepVisibleCandidates,
    modelSource: fakeModelSource,
    activeModelKey: "anthropic/claude-sonnet-4-5",
  });

describe("FabricSettingsComponent", () => {
  it("populates Claude models asynchronously without requiring startup discovery", async () => {
    const source: ModelSource = {
      models: [{ provider: "claude", id: "configured" }],
      lastUsed: {},
    };
    let resolveModels!: (models: Array<{ value: string; displayName: string }>) => void;
    const models = new Promise<Array<{ value: string; displayName: string }>>((resolve) => {
      resolveModels = resolve;
    });

    const loading = populateClaudeModelSource(source, () => models);
    expect(source.models.map((model) => model.id)).toEqual(["configured"]);

    resolveModels([{ value: "haiku", displayName: "Haiku" }]);
    await loading;
    expect(source.models).toEqual([
      { provider: "claude", id: "haiku", name: "Haiku" },
    ]);
  });

  it("offers executor memory limits through the machine capacity", () => {
    const machineCapacity = 24 * 1024 * 1024 * 1024;
    const values = executorMemoryLimitOptions(machineCapacity);

    expect(values).toContain(512 * 1024 * 1024);
    expect(values.at(-1)).toBe(machineCapacity);
  });

  it("surfaces the unsafe Node process executor and its larger memory range", () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.executor.runtime = "node-process";
    const items = buildFabricSettingsItems(theme, config, () => {}, {
      keepVisibleCandidates: ["fabric_exec"],
      modelSource: fakeModelSource,
    });
    const executor = items.find((item) => item.id === "executor")!;
    const lines = executor.submenu!("", () => {}).render(100).join("\n");

    expect(lines).toContain("node-process");
    expect(lines).toContain("unsafe");
    expect(lines).toContain("trusted-code escape hatch");
  });

  it("renders the pi-core style top and bottom borders with search", () => {
    const component = new FabricSettingsComponent(theme, buildItems(), () => {}, () => {});
    const lines = component.render(80);

    expect(lines[0]).toBe(borderLine(80));
    expect(lines[lines.length - 1]).toBe(borderLine(80));
    expect(lines.some((line) => line.includes("Type to search"))).toBe(true);
    expect(lines.some((line) => line.includes("Full code mode"))).toBe(true);
    expect(lines.some((line) => line.includes("Executor"))).toBe(true);
  });

  it("renders every section", () => {
    const items = buildItems();
    const component = new FabricSettingsComponent(theme, items, () => {}, () => {});
    const lines = component.render(80).join("\n");
    const labels = items.map((item) => item.label).join("\n");

    const visible = [
      "Full code mode",
      "Executor",
      "Approvals",
      "MCP",
      "Prewalk",
      "Agents",
      "Ultra Consult",
      "Capture",
      "UI",
      "Compaction",
    ];
    for (const label of [...visible, "Retention", "Mesh"]) {
      expect(labels).toContain(label);
    }
    // The list pages: only the first rows render, with the rest reachable
    // through the position counter.
    for (const label of visible) {
      expect(lines).toContain(label);
    }
    expect(lines).toContain("(1/13)");
    expect(items.length).toBe(13);
  });

  it("marks submenu rows with a drill-in marker and leaves inline toggles plain", () => {
    const items = buildItems();
    const labels = items.map((item) => item.label);
    // Top-level sections open a submenu.
    expect(labels).toContain("Executor ›");
    expect(labels).toContain("Prewalk ›");
    expect(labels).toContain("Agents ›");
    // Full code mode cycles values inline; no drill-in marker.
    expect(labels).toContain("Full code mode");
    expect(labels).not.toContain("Full code mode ›");

    // Inside a section, submenu fields are marked but inline value toggles are not.
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default model ›");
    expect(lines).toContain("Max concurrent ›");
    expect(lines).toContain("Default tools ›");
    // Inline value-cycle rows stay plain.
    expect(lines).toContain("Transport");
    expect(lines).not.toContain("Transport ›");
    expect(lines).toContain("Enabled");
    expect(lines).not.toContain("Enabled ›");
  });

  it("opening a section submenu renders its fields", () => {
    const items = buildItems();
    const executor = items.find((item) => item.id === "executor");
    expect(executor?.submenu).toBeDefined();
    const submenu = executor!.submenu!("", () => {});
    const lines = submenu.render(80).join("\n");
    expect(lines).toContain("Runtime");
    expect(lines).toContain("quickjs");
    expect(lines).toContain("Timeout");
    expect(lines).toContain("Memory limit");
    expect(lines).toContain("Max output chars");
    expect(lines).toContain("Result format");
    expect(lines).toContain("auto");
  });

  it("exposes the compaction engine", () => {
    const items = buildItems();
    const compaction = items.find((item) => item.id === "compaction");
    expect(compaction?.currentValue).toBe("fabric · QoS on");
    const lines = compaction!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Threshold");
    expect(lines).toContain("Pi default");
    expect(lines).toContain("anthropic/claude-sonnet-4-5");
    expect(lines).toContain("Engine");
    expect(lines).toContain("fabric");
    expect(lines).toContain("Target occupancy");
    expect(lines).toContain("0.65");
    expect(lines).toContain("Context QoS");
    expect(lines).toContain("Protected turns");
    expect(lines).toContain("Retire after chars");
    const section = compaction!.submenu!("", () => {}) as any;
    const target = section.settingsList.items.find(
      (item: { id: string }) => item.id === "compaction.targetContextRatio",
    );
    expect(target.values).toEqual(
      Array.from({ length: 13 }, (_, index) => String((25 + index * 5) / 100)),
    );
  });

  it("persists the active model's compaction threshold as a ratio", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildFabricSettingsItems(
      theme,
      structuredClone(DEFAULT_FABRIC_CONFIG),
      (id, value) => applied.push({ id, value }),
      {
        keepVisibleCandidates: ["fabric_exec"],
        modelSource: fakeModelSource,
        activeModelKey: "openai/gpt-5.5",
      },
    );
    const section = items.find((item) => item.id === "compaction")!.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    list.selectedIndex = list.items.findIndex((item: { id: string }) => item.id === "compaction.threshold");
    expect(list.items[list.selectedIndex].values).toEqual([
      "Pi default",
      ...Array.from({ length: 15 }, (_, index) => `${25 + index * 5}%`),
    ]);
    for (let index = 0; index < 12; index++) list.activateItem();

    expect(applied.at(-1)).toEqual({ id: "compaction.threshold", value: 0.8 });
    expect(list.items[list.selectedIndex].currentValue).toBe("80%");
  });

  it("exposes temporal retention defaults", () => {
    const items = buildItems();
    const retention = items.find((item) => item.id === "retention");
    expect(retention?.currentValue).toBe("6h · 1d · 7d");
    const lines = retention!.submenu!("", () => {}).render(100).join("\n");
    expect(lines).toContain("Orphaned temp runs");
    expect(lines).toContain("6h");
    expect(lines).toContain("One-shot runs");
    expect(lines).toContain("1d");
    expect(lines).toContain("Persistent agent run archives");
    expect(lines).toContain("7d");
    expect(lines).toContain("session.jsonl");
  });

  it("surfaces nested-tool visibility and the global debounce in UI settings", () => {
    const items = buildItems();
    const ui = items.find((item) => item.id === "ui");
    expect(ui?.submenu).toBeDefined();
    const lines = ui!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Nested tool calls");
    expect(lines).toContain("Nested tool debounce");
    expect(lines).toContain("100ms");
  });

  it("presents one Agent concept with one-shot and persistent lifecycles", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    const lines = agents!.submenu!("", () => {}).render(100).join("\n");
    expect(lines).toContain("One-shot and persistent agent lifecycles");
    expect(lines).not.toContain("agents and persistentAgents");
  });

  it("surfaces the recursion budget in the Agents section", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const lines = agents!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Recursion budget");
    expect(lines).toContain("Off");
  });

  it("surfaces bounded Ultra Consult policy", () => {
    const items = buildItems();
    const consult = items.find((item) => item.id === "consult");
    expect(consult?.currentValue).toBe("3 workers · 60%");
    expect(consult?.submenu).toBeDefined();
    const lines = consult!.submenu!("", () => {}).render(100).join("\n");
    expect(lines).toContain("Enabled");
    expect(lines).toContain("Max workers");
    expect(lines).toContain("Context pressure");
    expect(lines).toContain("Max findings");
    expect(lines).toContain("Evidence per finding");
    expect(lines).toContain("Evidence file size");
    expect(lines).toContain("Evidence byte budget");
    expect(lines).toContain("Worker token limit");
    expect(lines).toContain("8k");
  });

  it("shows the configured budget as a currency value", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, agents: { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0.25 } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Recursion budget");
    expect(lines).toContain("$0.25");
  });

  it("persists formatted numeric settings while keeping their normalized labels", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildFabricSettingsItems(
      theme,
      structuredClone(DEFAULT_FABRIC_CONFIG),
      (id, value) => applied.push({ id, value }),
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const executor = items.find((item) => item.id === "executor")!;
    const section = executor.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "executor.memoryLimitBytes",
    );
    list.activateItem();
    list.submenuComponent.selectList.onSelect({
      value: String(128 * 1024 * 1024),
      label: "128 MB",
    });

    expect(applied.at(-1)).toEqual({
      id: "executor.memoryLimitBytes",
      value: 128 * 1024 * 1024,
    });
    expect(list.items[list.selectedIndex].currentValue).toBe("128 MB");
    expect(section.render(100).join("\n")).not.toContain("134217728");
  });

  it("persists labeled thinking levels using their canonical values", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildFabricSettingsItems(
      theme,
      structuredClone(DEFAULT_FABRIC_CONFIG),
      (id, value) => applied.push({ id, value }),
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const section = agents.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "agents.thinking",
    );
    list.activateItem();
    list.submenuComponent.selectList.onSelect({ value: "high", label: "High" });

    expect(applied.at(-1)).toEqual({ id: "agents.thinking", value: "high" });
    expect(list.items[list.selectedIndex].currentValue).toBe("High");
  });

  it("parses every formatted numeric settings style", () => {
    expect(parseFormattedNumericValue("128 MB")).toBe(128 * 1024 * 1024);
    expect(parseFormattedNumericValue("250ms")).toBe(250);
    expect(parseFormattedNumericValue("2m")).toBe(120_000);
    expect(parseFormattedNumericValue("7d")).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(parseFormattedNumericValue("$0.25")).toBe(0.25);
    expect(parseFormattedNumericValue("500k")).toBe(500_000);
    expect(parseFormattedNumericValue("2M")).toBe(2_000_000);
    expect(parseFormattedNumericValue("2,000,000")).toBe(2_000_000);
    expect(parseFormattedNumericValue("Off")).toBe(0);
  });

  it("parses currency-formatted budget values back to numbers", () => {
    expect(parseBudgetValue("$0.25")).toBe(0.25);
    expect(parseBudgetValue("$0.10")).toBe(0.1);
    expect(parseBudgetValue("Off")).toBe(0);
    expect(parseBudgetValue("0.5")).toBe(0.5);
    expect(parseBudgetValue("$5.00")).toBe(5);
  });

  it("surfaces the default thinking level in the Agents section as Medium by default", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const lines = agents!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default thinking");
    expect(lines).toContain("Medium");
    expect(lines).toContain("Allow quality downgrade");
  });

  it("shows a configured thinking level in the Agents section", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, agents: { ...DEFAULT_FABRIC_CONFIG.agents, thinking: "high" } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default thinking");
    expect(lines).toContain("High");
  });

  it("offers auto policies and a dedicated classifier model picker", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.write = "auto";
    const items = buildFabricSettingsItems(
      theme,
      config,
      (id, value) => applied.push({ id, value }),
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const approvals = items.find((item) => item.id === "approvals")!;
    const section = approvals.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    const write = list.items.find((item: { id: string }) => item.id === "approvals.write");
    expect(write.currentValue).toBe("auto");
    expect(write.values).toContain("auto");
    expect(section.render(100).join("\n")).toContain("Auto model ›");
    expect(section.render(100).join("\n")).toContain("Inherit");

    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "approvals.model",
    );
    list.activateItem();
    list.submenuComponent.handleInput("\x1b[B");
    list.submenuComponent.handleInput("\r");

    expect(applied.at(-1)).toEqual({
      id: "approvals.model",
      value: "anthropic/claude-sonnet-4-5",
    });
  });

  it("persists a Prewalk model selection and reopens with its checkmark", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildFabricSettingsItems(
      theme,
      structuredClone(DEFAULT_FABRIC_CONFIG),
      (id, value) => applied.push({ id, value }),
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const prewalk = items.find((item) => item.id === "prewalk")!;
    expect(prewalk.currentValue).toBe("Ask each time · repeat");
    const section = prewalk.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "prewalk.model",
    );

    list.activateItem();
    list.submenuComponent.handleInput("\x1b[B");
    list.submenuComponent.handleInput("\r");

    expect(applied.at(-1)).toEqual({
      id: "prewalk.model",
      value: "anthropic/claude-sonnet-4-5",
    });
    expect(list.items[list.selectedIndex].currentValue).toBe(
      "anthropic/claude-sonnet-4-5",
    );

    list.activateItem();
    const reopened = list.submenuComponent.render(100).join("\n");
    const modelLine = reopened
      .split("\n")
      .find((line: string) => line.includes("claude-sonnet-4-5"));
    const unsetLine = reopened
      .split("\n")
      .find(
        (line: string) =>
          line.includes("Ask each time") && !line.includes("Pick Ask each time"),
      );
    expect(modelLine).toContain("✓");
    expect(unsetLine).not.toContain("✓");

    list.submenuComponent.handleInput("\x1b[A");
    list.submenuComponent.handleInput("\r");
    expect(applied.at(-1)).toEqual({ id: "prewalk.model", value: "" });
    expect(list.items[list.selectedIndex].currentValue).toBe("Ask each time");

    list.activateItem();
    const cleared = list.submenuComponent.render(100).join("\n");
    const clearedUnsetLine = cleared
      .split("\n")
      .find(
        (line: string) =>
          line.includes("Ask each time") && !line.includes("Pick Ask each time"),
      );
    expect(clearedUnsetLine).toContain("✓");
  });

  it("persists a Prewalk thinking selection and clears it back to Agents default", () => {
    const applied: Array<{ id: string; value: unknown }> = [];
    const items = buildFabricSettingsItems(
      theme,
      structuredClone(DEFAULT_FABRIC_CONFIG),
      (id, value) => applied.push({ id, value }),
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const prewalk = items.find((item) => item.id === "prewalk")!;
    expect(prewalk.currentValue).toBe("Ask each time · repeat");
    const section = prewalk.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    const row = list.items.find((item: { id: string }) => item.id === "prewalk.thinking");
    expect(row.currentValue).toBe("Agents default");
    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "prewalk.thinking",
    );

    list.activateItem();
    list.submenuComponent.selectList.onSelect({ value: "high", label: "High" });

    expect(applied.at(-1)).toEqual({ id: "prewalk.thinking", value: "high" });
    expect(list.items[list.selectedIndex].currentValue).toBe("High");

    list.activateItem();
    list.submenuComponent.selectList.onSelect({
      value: "Agents default",
      label: "Agents default",
    });

    expect(applied.at(-1)).toEqual({ id: "prewalk.thinking", value: "" });
    expect(list.items[list.selectedIndex].currentValue).toBe("Agents default");
  });

  it("exposes a dedicated prewalk executor model picker", () => {
    const config = {
      ...DEFAULT_FABRIC_CONFIG,
      prewalk: {
        ...DEFAULT_FABRIC_CONFIG.prewalk,
        model: "anthropic/claude-sonnet-4-5",
        alwaysRearm: false,
      },
    };
    const items = buildFabricSettingsItems(theme, config, () => {}, {
      keepVisibleCandidates: ["fabric_exec"],
      modelSource: fakeModelSource,
    });
    const prewalk = items.find((item) => item.id === "prewalk")!;
    const lines = prewalk.submenu!("", () => {}).render(100).join("\n");

    expect(lines).toContain("Always re-arm");
    expect(lines).toContain("Verification");
    expect(lines).toContain("Max revisions");
    expect(lines).toContain("Executor model ›");
    expect(lines).toContain("anthropic/claude-sonnet-4-5");
  });

  it("reopens the shared agent model picker at its live selection", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents")!;
    const section = agents.submenu!("", () => {}) as any;
    const list = section.settingsList as any;
    list.selectedIndex = list.items.findIndex(
      (item: { id: string }) => item.id === "agents.model",
    );

    list.activateItem();
    list.submenuComponent.handleInput("\x1b[B");
    list.submenuComponent.handleInput("\r");
    list.activateItem();

    const reopened = list.submenuComponent.render(100).join("\n");
    const modelLine = reopened
      .split("\n")
      .find((line: string) => line.includes("claude-sonnet-4-5"));
    const inheritLine = reopened
      .split("\n")
      .find((line: string) => line.includes("Inherit"));
    expect(modelLine).toContain("✓");
    expect(inheritLine).not.toContain("✓");
  });

  it("surfaces the default model in the Agents section as Inherit by default", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const lines = agents!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default model");
    expect(lines).toContain("Inherit");
  });

  it("shows the configured default model value in the Agents section", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, agents: { ...DEFAULT_FABRIC_CONFIG.agents, model: "claude-sonnet-4-5" } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Default model");
    expect(lines).toContain("claude-sonnet-4-5");
    expect(lines).not.toContain("Default model ›      Inherit");
  });

  it("renders the list-editor rows with counts in their sections", () => {
    const items = buildItems(["fabric_exec", "custom-tool"]);
    const agents = items.find((item) => item.id === "agents")!;
    expect(agents.submenu!("", () => {}).render(80).join("\n")).toContain("Default tools");
    expect(agents.submenu!("", () => {}).render(80).join("\n")).toContain("7 tools");
    const capture = items.find((item) => item.id === "capture")!;
    const captureLines = capture.submenu!("", () => {}).render(80).join("\n");
    expect(captureLines).toContain("Keep visible");
    expect(captureLines).toContain("1 tool");
  });

  it("keep-visible candidates include existing entries plus fabric_exec", () => {
    const items = buildItems(["fabric_exec", "custom-tool"]);
    const capture = items.find((item) => item.id === "capture")!;
    const captureSub = capture.submenu!("", () => {});
    const lines = captureSub.render(80).join("\n");
    expect(lines).toContain("Keep visible");
  });

  it("surfaces the per-child token limit in the Agents section", () => {
    const items = buildItems();
    const agents = items.find((item) => item.id === "agents");
    expect(agents?.submenu).toBeDefined();
    const lines = agents!.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Token limit");
    expect(lines).toContain("Off");
  });

  it("shows a configured token limit formatted compactly", () => {
    const items = buildFabricSettingsItems(
      theme,
      { ...DEFAULT_FABRIC_CONFIG, agents: { ...DEFAULT_FABRIC_CONFIG.agents, maxTokensPerChild: 500_000 } },
      () => {},
      { keepVisibleCandidates: ["fabric_exec"], modelSource: fakeModelSource },
    );
    const agents = items.find((item) => item.id === "agents")!;
    const lines = agents.submenu!("", () => {}).render(80).join("\n");
    expect(lines).toContain("Token limit");
    expect(lines).toContain("500k");
  });

  it("persists a picked Prewalk thinking level through the real settings dialog flow", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-settings-thinking-"));
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      const applyFabricMode = vi.fn();
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => {
          const saved = JSON.parse(
            fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8"),
          ) as { prewalk?: { thinking?: import("../src/thinking.js").FabricThinking } };
          config.prewalk = {
            ...config.prewalk,
            ...(saved.prewalk?.thinking ? { thinking: saved.prewalk.thinking } : {}),
          };
        }),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      let rootList: any;
      let nestedList: any;
      const notify = vi.fn();
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify,
          custom: vi.fn(async (fpersistentAgenty) => {
            const component = fpersistentAgenty({}, theme, {}, () => {}) as FabricSettingsComponent;
            rootList = component.settingsList;
            rootList.selectedIndex = rootList.items.findIndex(
              (item: { id: string }) => item.id === "prewalk",
            );
            rootList.activateItem();
            nestedList = rootList.submenuComponent.settingsList;
            nestedList.selectedIndex = nestedList.items.findIndex(
              (item: { id: string }) => item.id === "prewalk.thinking",
            );
            nestedList.activateItem();
            nestedList.submenuComponent.selectList.onSelect({ value: "xhigh", label: "XHigh" });
          }),
        },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode,
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(
        JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8")),
      ).toMatchObject({
        prewalk: { thinking: "xhigh" },
      });
      expect(config.prewalk.thinking).toBe("xhigh");
      expect(
        rootList.items.find((item: { id: string }) => item.id === "prewalk").currentValue,
      ).toBe("Ask each time · XHigh · repeat");
      expect(applyFabricMode).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith("Fabric settings saved.", "info");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("persists a picked Prewalk model through the real settings dialog flow", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-settings-model-"));
    try {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      const applyFabricMode = vi.fn();
      const state = {
        config,
        ensure: vi.fn().mockResolvedValue(undefined),
        reloadConfig: vi.fn(() => {
          const saved = JSON.parse(
            fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8"),
          ) as {
            prewalk?: {
              model?: string;
              alwaysRearm?: boolean;
            };
          };
          config.prewalk = {
            ...config.prewalk,
            ...(saved.prewalk?.model ? { model: saved.prewalk.model } : {}),
            alwaysRearm: saved.prewalk?.alwaysRearm === true,
          };
        }),
        agents: { claudeModels: vi.fn().mockResolvedValue([]) },
      } as unknown as FabricState;
      let rootList: any;
      let nestedList: any;
      const notify = vi.fn();
      const context = {
        mode: "tui",
        cwd,
        isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => fakeModelSource.models },
        ui: {
          notify,
          custom: vi.fn(async (fpersistentAgenty) => {
            const component = fpersistentAgenty({}, theme, {}, () => {}) as FabricSettingsComponent;
            rootList = component.settingsList;
            rootList.selectedIndex = rootList.items.findIndex(
              (item: { id: string }) => item.id === "prewalk",
            );
            rootList.activateItem();
            nestedList = rootList.submenuComponent.settingsList;
            nestedList.selectedIndex = nestedList.items.findIndex(
              (item: { id: string }) => item.id === "prewalk.model",
            );
            nestedList.activateItem();
            nestedList.submenuComponent.handleInput("\x1b[B");
            nestedList.submenuComponent.handleInput("\r");
          }),
        },
      } as unknown as ExtensionContext;

      await openFabricSettings(context, {
        state,
        applyFabricMode,
        capturedTools: { list: () => [] } as unknown as CapturedToolCatalog,
      });

      expect(
        JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8")),
      ).toMatchObject({
        prewalk: { model: "anthropic/claude-sonnet-4-5" },
      });
      expect(config.prewalk.model).toBe("anthropic/claude-sonnet-4-5");
      expect(
        rootList.items.find((item: { id: string }) => item.id === "prewalk").currentValue,
      ).toBe("anthropic/claude-sonnet-4-5");
      expect(nestedList.items[nestedList.selectedIndex].currentValue).toBe(
        "anthropic/claude-sonnet-4-5",
      );
      expect(applyFabricMode).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith("Fabric settings saved.", "info");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
