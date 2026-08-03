import {
  DynamicBorder,
  getAgentDir,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  SelectList,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  SettingsList,
  type SettingItem,
  type SettingsListTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { FabricModelSelector } from "./fabric-model-selector.js";
import {
  buildClaudeModelSource,
  buildModelSource,
  INHERIT_VALUE,
  modelKey,
  type ModelSource,
} from "./model-picker.js";
import {
  maxExecutorMemoryLimitBytes,
  QUICKJS_MAX_MEMORY_LIMIT_BYTES,
  saveFabricConfig,
  type FabricConfig,
} from "../config.js";
import { THINKING_LEVELS, thinkingLabel } from "../thinking.js";
import type { CapturedToolCatalog } from "../capture/catalog.js";
import type { FabricState } from "../fabric-state.js";

const SUBMENU_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
};

const BOOLEANS = ["true", "false"] as const;
const APPROVAL_MODES = ["allow", "ask", "auto", "deny"] as const;
const RUNNERS = ["pi", "claude"] as const;
const TRANSPORTS = ["auto", "process", "tmux", "screen", "localterm", "herdr"] as const;
const WIDGET_MODES = ["auto", "always", "hidden"] as const;
const RESULT_FORMATS = ["auto", "yaml", "json", "text"] as const;
const EXECUTOR_RUNTIMES = ["quickjs", "node-process"] as const;
const COMPACTION_ENGINES = ["fabric", "pi"] as const;
const COMPACTION_THRESHOLD_SETTING_ID = "compaction.threshold";
const COMPACTION_DEFAULT_THRESHOLD_LABEL = "Pi default";
const COMPACTION_THRESHOLDS = [
  COMPACTION_DEFAULT_THRESHOLD_LABEL,
  ...Array.from({ length: 15 }, (_, index) => `${25 + index * 5}%`),
];
const CONTEXT_QOS_TURN_WINDOWS = [1, 2, 3, 4, 5, 8, 12, 20].map(String);
const CONTEXT_QOS_RESULT_CHARS = [256, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000].map(String);
const COMPACTION_TARGET_RATIOS = Array.from(
  { length: 13 },
  (_, index) => String((25 + index * 5) / 100),
);
const CONSULT_PRESSURE_RATIOS = Array.from(
  { length: 15 },
  (_, index) => (25 + index * 5) / 100,
);
const PERSISTENT_AGENT_SCOPES = ["project", "session"] as const;
const RISKS = ["read", "write", "execute", "network", "agent"] as const;
const CORE_RISK_TOOLS = ["read", "grep", "find", "edit", "write", "bash"] as const;
const CORE_DEFAULT_TOOL_CANDIDATES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BUDGET_VALUES = [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const TOKEN_VALUES = [0, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000];
const PREWALK_MODEL_UNSET_LABEL = "Ask each time";
const PREWALK_THINKING_INHERIT_LABEL = "Agents default";
const PREWALK_MODES = ["research", "in-place", "trajectory"] as const;
const PREWALK_RETURN_POLICIES = ["executor", "previous"] as const;
const PREWALK_VERIFICATION_MODES = ["legacy", "gated"] as const;
const PREWALK_REVISION_LIMITS = Array.from({ length: 9 }, (_, index) => String(index));
const ROOT_ITEM_IDS = [
  "fullCodeMode",
  "executor",
  "approvals",
  "mcp",
  "prewalk",
  "agents",
  "consult",
  "capture",
  "ui",
  "compaction",
  "outcomes",
  "retention",
  "mesh",
] as const;
const RELOAD_SECTIONS = new Set(["mesh", "agents", "mcp", "outcomes", "retention"]);

const unique = (values: readonly string[]): string[] => [...new Set(values)];

type SettingsSubmenu = (currentValue: string, done: (selectedValue?: string) => void) => Component;

const settingsListTheme = (theme: Theme): SettingsListTheme => ({
  label: (text, selected) => (selected ? theme.fg("accent", text) : text),
  value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
  description: (text) => theme.fg("dim", text),
  cursor: theme.fg("accent", "→ "),
  hint: (text) => theme.fg("dim", text),
});

const selectListTheme = (theme: Theme): SelectListTheme => ({
  selectedPrefix: (text) => theme.fg("accent", text),
  selectedText: (text) => theme.fg("accent", text),
  description: (text) => theme.fg("muted", text),
  scrollInfo: (text) => theme.fg("muted", text),
  noMatch: (text) => theme.fg("muted", text),
});

const formatDebounce = (ms: number): string =>
  ms === 0 ? "Off" : ms < 1_000 ? `${ms}ms` : `${ms / 1_000}s`;

const formatMs = (ms: number): string =>
  ms < 1_000
    ? `${ms}ms`
    : ms < 60_000
      ? `${ms / 1_000}s`
      : ms < 3_600_000
        ? `${ms / 60_000}m`
        : `${ms / 3_600_000}h`;

const formatRetention = (ms: number): string =>
  ms >= 24 * 60 * 60 * 1_000 && ms % (24 * 60 * 60 * 1_000) === 0
    ? `${ms / (24 * 60 * 60 * 1_000)}d`
    : formatMs(ms);

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${Number((bytes / (1024 * 1024 * 1024)).toFixed(2))} GB`
    : bytes >= 1024 * 1024
      ? `${Number((bytes / (1024 * 1024)).toFixed(2))} MB`
      : `${Number((bytes / 1024).toFixed(2))} KB`;

export const executorMemoryLimitOptions = (
  maximumBytes = QUICKJS_MAX_MEMORY_LIMIT_BYTES,
): number[] => {
  const minimumBytes = 16 * 1024 * 1024;
  const values: number[] = [];
  for (let value = minimumBytes; value <= maximumBytes; value *= 2) values.push(value);
  if (maximumBytes >= minimumBytes && values.at(-1) !== maximumBytes) values.push(maximumBytes);
  return values;
};

const formatUsd = (value: number): string =>
  value <= 0 ? "Off" : `$${value.toFixed(2)}`;

const formatTokens = (value: number): string =>
  value <= 0
    ? "Off"
    : value >= 1_000_000
      ? `${value / 1_000_000}M`
      : value >= 1_000
        ? `${value / 1_000}k`
        : String(value);

const formatToolCount = (count: number): string =>
  `${count} ${count === 1 ? "tool" : "tools"}`;

const numericOptions = (
  values: readonly number[],
  format: (value: number) => string,
  currentValue: string,
): SelectItem[] => {
  const options: SelectItem[] = values.map((value) => ({
    value: String(value),
    label: format(value),
  }));
  if (!options.some((option) => option.value === currentValue || option.label === currentValue)) {
    options.unshift({ value: currentValue, label: currentValue });
  }
  return options;
};

const getPath = (config: FabricConfig, id: string): unknown => {
  const segments = id.split(".");
  let current: unknown = config;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

export const parseBudgetValue = (value: string): number => {
  if (value === "Off") return 0;
  const digits = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(digits) ? digits : 0;
};

export const parseFormattedNumericValue = (value: string): number => {
  const normalized = value.trim();
  if (normalized === "Off") return 0;
  if (normalized.startsWith("$")) return parseBudgetValue(normalized);

  const bytes = normalized.match(/^([0-9]+(?:\.[0-9]+)?) (KB|MB|GB)$/);
  if (bytes) {
    const amount = Number(bytes[1]);
    const units = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;
    return Math.round(amount * units[bytes[2] as keyof typeof units]);
  }

  const duration = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)$/);
  if (duration) {
    const amount = Number(duration[1]);
    const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
    return Math.round(amount * units[duration[2] as keyof typeof units]);
  }

  const tokens = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(k|M)$/);
  if (tokens) return Math.round(Number(tokens[1]) * (tokens[2] === "M" ? 1_000_000 : 1_000));
  return Number(normalized.replaceAll(",", ""));
};

const coerceValue = (id: string, value: string, config: FabricConfig): unknown => {
  if (id === COMPACTION_THRESHOLD_SETTING_ID) {
    if (value === COMPACTION_DEFAULT_THRESHOLD_LABEL) return null;
    return Number(value.replace("%", "")) / 100;
  }
  if (id === "consult.contextPressureThreshold") {
    return Number(value.replace("%", "")) / 100;
  }
  const current = getPath(config, id);
  if (typeof current === "boolean") return value === "true";
  if (typeof current === "number") return parseFormattedNumericValue(value);
  // The model picker stores the canonical "provider/id" string, or "Inherit"
  // for no override; persist an empty string so normalizeFabricConfig drops it.
  // Agents inherit; prewalk asks interactively when it is armed.
  if (
    id === "approvals.model" ||
    id === "prewalk.model" ||
    id === "agents.model" ||
    id === "agents.claude.model"
  ) {
    return value === INHERIT_VALUE || value === PREWALK_MODEL_UNSET_LABEL ? "" : value;
  }
  if (id === "prewalk.thinking" && value === PREWALK_THINKING_INHERIT_LABEL) return "";
  if (id === "prewalk.maxPhaseRevisions") return parseFormattedNumericValue(value);
  if (id === "agents.thinking" || id === "prewalk.thinking") {
    return THINKING_LEVELS.find((level) => thinkingLabel(level) === value) ?? value;
  }
  return value;
};

const buildPartial = (id: string, value: unknown): Record<string, unknown> => {
  const segments = id.split(".");
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (segment === undefined) break;
    const next: Record<string, unknown> = {};
    current[segment] = next;
    current = next;
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) current[last] = value;
  return root;
};

const summaryFor = (id: string, config: FabricConfig): string => {
  switch (id) {
    case "fullCodeMode":
      return config.fullCodeMode ? "true" : "false";
    case "executor":
      return `${config.executor.runtime} · ${formatMs(config.executor.timeoutMs)}`;
    case "approvals":
      return config.approvals.execute;
    case "mcp":
      return config.mcp.enabled ? "enabled" : "disabled";
    case "prewalk":
      return `${config.prewalk.mode} · ${config.prewalk.model || PREWALK_MODEL_UNSET_LABEL}${config.prewalk.verificationMode === "gated" ? ` · gated/${config.prewalk.maxPhaseRevisions ?? 2}` : ""}${config.prewalk.returnPolicy === "executor" ? " · return executor" : ""}${config.prewalk.thinking ? ` · ${thinkingLabel(config.prewalk.thinking)}` : ""}${config.prewalk.alwaysRearm ? " · repeat" : ""}`;
    case "agents":
      return `${config.agents.runner}/${config.agents.transport}${config.agents.fallbackModels.length > 0 ? ` · ${config.agents.fallbackModels.length} routes` : ""}${config.agents.allowQualityDowngrade ? " · downgrade" : ""}`;
    case "consult":
      return config.consult.enabled
        ? `${config.consult.maxWorkers} workers · ${Math.round(config.consult.contextPressureThreshold * 100)}%`
        : "disabled";
    case "capture":
      return config.capture.enabled ? "enabled" : "disabled";
    case "ui":
      return config.ui.widget;
    case "compaction":
      return `${config.compaction.engine} · QoS ${config.compaction.contextQos.enabled ? "on" : "off"}`;
    case "outcomes":
      return config.outcomes.enabled
        ? `learning · min ${config.outcomes.minRecommendationSamples}`
        : "disabled";
    case "retention":
      return `${formatRetention(config.retention.orphanedTempRunMs)} · ${formatRetention(config.retention.oneShotRunMs)} · ${formatRetention(config.retention.persistentAgentRunArchiveMs)}`;
    case "mesh":
      return config.mesh.enabled ? "enabled" : "disabled";
    default:
      return "";
  }
};

const setting = (
  id: string,
  label: string,
  currentValue: string,
  rest: {
    description?: string;
    values?: readonly string[];
    submenu?: SettingsSubmenu;
  } = {},
): SettingItem => {
  const item: SettingItem = { id, label, currentValue };
  if (rest.description !== undefined) item.description = rest.description;
  if (rest.values !== undefined) item.values = [...rest.values];
  if (rest.submenu !== undefined) item.submenu = rest.submenu;
  return item;
};

const numericSubmenu = (
  theme: Theme,
  values: readonly number[],
  format: (value: number) => string,
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) => {
  const options = numericOptions(values, format, currentValue);
  const selectedValue =
    options.find((option) => option.value === currentValue || option.label === currentValue)?.value ??
    currentValue;
  return new SelectSubmenu(
    theme,
    title,
    description,
    options,
    selectedValue,
    (value) => done(options.find((option) => option.value === value)?.label ?? value),
    () => done(),
  );
};

const listSubmenu = (
  theme: Theme,
  id: string,
  title: string,
  description: string,
  candidates: readonly string[],
  currentList: readonly string[],
  onCommit: (selected: string[]) => void,
): SettingsSubmenu => {
  const prefix = `${id}.`;
  return (_currentValue, done) => {
    const items = unique([...candidates, ...currentList]).map((name) =>
      setting(`${id}.${name}`, name, currentList.includes(name) ? "true" : "false", {
        description: `Toggle ${name}.`,
        values: BOOLEANS,
      }),
    );
    const onChange = (_itemId: string, _newValue: string): void => {
      const selected = items
        .filter((item) => item.currentValue === "true")
        .map((item) => item.id.slice(prefix.length));
      onCommit(selected);
    };
    return new SectionSubmenu(theme, title, description, items, onChange, () => done(), true);
  };
};

// Append a › to the label of every item that opens a submenu, so it is
// obvious which rows drill in (vs. inline value cycling). Mutates in place to
// preserve the shared item references that listSubmenu updates live.
const markDrillIn = (items: SettingItem[]): SettingItem[] => {
  for (const item of items) {
    if (item.submenu && !item.label.endsWith("›")) item.label = `${item.label} ›`;
  }
  return items;
};

const sectionSubmenu = (
  theme: Theme,
  title: string,
  description: string,
  items: SettingItem[],
  persist: (id: string, value: string) => void,
): SettingsSubmenu => (_currentValue, done) =>
  new SectionSubmenu(theme, title, description, markDrillIn(items), persist, () => done());

class SelectSubmenu extends Container {
  readonly selectList: SelectList;

  constructor(
    theme: Theme,
    title: string,
    description: string | undefined,
    options: SelectItem[],
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.selectList = new SelectList(
      options,
      Math.min(options.length, 10),
      selectListTheme(theme),
      SUBMENU_LAYOUT,
    );
    const index = options.findIndex((option) => option.value === currentValue);
    if (index !== -1) this.selectList.setSelectedIndex(index);
    this.selectList.onSelect = (item) => onSelect(item.value);
    this.selectList.onCancel = onCancel;
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }
}

const thinkingSubmenu = (
  theme: Theme,
  overrides: {
    title?: string;
    description?: string;
    // Label of an extra first option that clears the override (persists "").
    inheritLabel?: string;
  } = {},
): SettingsSubmenu => (currentValue, done) => {
  const canonicalCurrent =
    THINKING_LEVELS.find((level) => thinkingLabel(level) === currentValue) ?? currentValue;
  const options: SelectItem[] = THINKING_LEVELS.map((level) => ({
    value: level,
    label: thinkingLabel(level),
  }));
  if (overrides.inheritLabel) {
    options.unshift({ value: overrides.inheritLabel, label: overrides.inheritLabel });
  }
  if (!options.some((option) => option.value === canonicalCurrent)) {
    options.unshift({ value: canonicalCurrent, label: currentValue });
  }
  return new SelectSubmenu(
    theme,
    overrides.title ?? "Default thinking",
    overrides.description ??
      "Reasoning effort forwarded to agents across both lifecycles when a call does not specify one. The level is clamped to each model's supported levels (next highest if unsupported).",
    options,
    canonicalCurrent,
    (value) => done(options.find((option) => option.value === value)?.label ?? value),
    () => done(),
  );
};

const modelPickerSubmenu = (
  theme: Theme,
  source: ModelSource,
  options: {
    headerText?: string;
    inheritLabel?: string;
    inheritName?: string;
  } = {},
): SettingsSubmenu => (currentValue, done) => {
  const canonicalCurrent =
    options.inheritLabel && currentValue === options.inheritLabel
      ? INHERIT_VALUE
      : currentValue;
  return new FabricModelSelector({
    theme,
    source,
    currentValue: canonicalCurrent,
    onSelect: (value) =>
      done(
        value === INHERIT_VALUE && options.inheritLabel
          ? options.inheritLabel
          : value,
      ),
    onCancel: () => done(),
    ...(options.headerText ? { headerText: options.headerText } : {}),
    ...(options.inheritLabel ? { inheritLabel: options.inheritLabel } : {}),
    ...(options.inheritName ? { inheritName: options.inheritName } : {}),
  });
};

class SectionSubmenu extends Container {
  readonly settingsList: SettingsList;

  constructor(
    theme: Theme,
    title: string,
    description: string | undefined,
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    enableSearch = false,
  ) {
    super();
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.settingsList = new SettingsList(
      items,
      Math.min(items.length, 16),
      settingsListTheme(theme),
      onChange,
      onCancel,
      { enableSearch },
    );
    this.addChild(this.settingsList);
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }
}

export class FabricSettingsComponent extends Container {
  readonly settingsList: SettingsList;

  constructor(
    theme: Theme,
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.settingsList = new SettingsList(items, 10, settingsListTheme(theme), onChange, onCancel, {
      enableSearch: true,
    });
    this.addChild(this.settingsList);
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }
}

export const populateClaudeModelSource = async (
  source: ModelSource,
  load: () => Promise<Parameters<typeof buildClaudeModelSource>[0]>,
): Promise<void> => {
  const loaded = buildClaudeModelSource(await load());
  source.models.splice(0, source.models.length, ...loaded.models);
  source.lastUsed = loaded.lastUsed;
};

export const buildFabricSettingsItems = (
  theme: Theme,
  config: FabricConfig,
  apply: (id: string, value: unknown) => void,
  options: {
    keepVisibleCandidates: readonly string[];
    modelSource: ModelSource;
    claudeModelSource?: ModelSource;
    activeModelKey?: string;
  },
): SettingItem[] => {
  const persist = (id: string, newValue: string): void =>
    apply(id, coerceValue(id, newValue, config));
  const envFullCode = process.env.PI_FABRIC_FULL_CODE_MODE;
  const fullCodeDescription = envFullCode
    ? "Fabric owns Pi core tools (read, bash, edit, write, grep, find, ls) via fabric_exec. Currently overridden by the PI_FABRIC_FULL_CODE_MODE environment variable."
    : "Fabric owns Pi core tools (read, bash, edit, write, grep, find, ls) via fabric_exec. Disable to keep native tools model-facing (orchestration-only mode).";
  const executorMemoryDescription = (): string =>
    config.executor.runtime === "quickjs"
      ? "Maximum QuickJS heap size. WASM32 limits this to less than 4 GiB."
      : "V8 old-generation heap limit for the disposable Node process. Large allocations may destabilize the system.";

  const defaultToolsItem = setting(
    "agents.defaultTools",
    "Default tools",
    formatToolCount(config.agents.defaultTools.length),
    { description: "Pi core tools exposed to spawned agents by default." },
  );
  defaultToolsItem.submenu = listSubmenu(
    theme,
    "agents.defaultTools",
    "Default tools",
    "Pi core tools exposed to spawned agents by default.",
    CORE_DEFAULT_TOOL_CANDIDATES,
    config.agents.defaultTools,
    (selected) => {
      apply("agents.defaultTools", selected);
      defaultToolsItem.currentValue = formatToolCount(selected.length);
    },
  );

  const keepVisibleItem = setting(
    "capture.keepVisible",
    "Keep visible",
    formatToolCount(config.capture.keepVisible.length),
    { description: "Captured tool names that stay model-visible despite hideFromModel." },
  );
  keepVisibleItem.submenu = listSubmenu(
    theme,
    "capture.keepVisible",
    "Keep visible",
    "Captured tool names that stay model-visible despite hideFromModel.",
    options.keepVisibleCandidates,
    config.capture.keepVisible,
    (selected) => {
      apply("capture.keepVisible", selected);
      keepVisibleItem.currentValue = formatToolCount(selected.length);
    },
  );

  const items = [
    setting("fullCodeMode", "Full code mode", config.fullCodeMode ? "true" : "false", {
      description: fullCodeDescription,
      values: BOOLEANS,
    }),
    setting("executor", "Executor", summaryFor("executor", config), {
      description: "Runtime and resource limits for fabric_exec programs.",
      submenu: sectionSubmenu(
        theme,
        "Executor",
        "Runtime and resource limits for fabric_exec programs.",
        [
          setting("executor.runtime", "Runtime", config.executor.runtime, {
            description:
              config.schema.mode === "enforce"
                ? "Schema enforce mode requires the isolated QuickJS runtime."
                : "QuickJS is isolated and limited by WASM32. Node process supports larger heaps but is an unsafe trusted-code escape hatch, not a security sandbox.",
            values: config.schema.mode === "enforce" ? ["quickjs"] : EXECUTOR_RUNTIMES,
          }),
          setting("executor.timeoutMs", "Timeout", formatMs(config.executor.timeoutMs), {
            description: "Maximum wall-clock time for a single fabric_exec program.",
            submenu: numericSubmenu(
              theme,
              [15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
              formatMs,
              "Executor timeout",
              "Maximum wall-clock time for a single fabric_exec program.",
            ),
          }),
          setting(
            "executor.memoryLimitBytes",
            "Memory limit",
            formatBytes(config.executor.memoryLimitBytes),
            {
              description: executorMemoryDescription(),
              submenu: (currentValue, done) =>
                numericSubmenu(
                  theme,
                  executorMemoryLimitOptions(maxExecutorMemoryLimitBytes(config.executor.runtime)),
                  formatBytes,
                  "Executor memory limit",
                  executorMemoryDescription(),
                )(currentValue, done),
            },
          ),
          setting("executor.maxOutputChars", "Max output chars", config.executor.maxOutputChars.toLocaleString(), {
            description: "Character cap applied to the final fabric_exec return value shown to the model.",
            submenu: numericSubmenu(
              theme,
              [20_000, 50_000, 100_000, 200_000, 500_000],
              (n) => n.toLocaleString(),
              "Max output chars",
              "Character cap applied to the final fabric_exec return value shown to the model.",
            ),
          }),
          setting("executor.resultFormat", "Result format", config.executor.resultFormat, {
            description:
              "Default formatting for fabric_exec return values. Auto renders structured values as syntax-highlighted YAML; each call can override this.",
            values: RESULT_FORMATS,
          }),
          setting(
            "executor.maxNestedResultChars",
            "Max nested result chars",
            config.executor.maxNestedResultChars.toLocaleString(),
            {
              description: "Character cap applied to results returned by nested tool calls inside the sandbox.",
              submenu: numericSubmenu(
                theme,
                [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000],
                (n) => n.toLocaleString(),
                "Max nested result chars",
                "Character cap applied to results returned by nested tool calls inside the sandbox.",
              ),
            },
          ),
          setting(
            "executor.maxGateRevisions",
            "Gate revision limit",
            String(config.executor.maxGateRevisions),
            {
              description: "Maximum revise dispositions in one Fabric run before the host aborts the gate chain.",
              values: ["0", "1", "2", "3", "5", "10"],
            },
          ),
          setting(
            "executor.maxRunEvidence",
            "Run evidence limit",
            config.executor.maxRunEvidence.toLocaleString(),
            {
              description: "Maximum evidence references retained by one Fabric run.",
              submenu: numericSubmenu(
                theme,
                [32, 64, 128, 256, 512, 1_000],
                (n) => n.toLocaleString(),
                "Run evidence limit",
                "Maximum evidence references retained by one Fabric run.",
              ),
            },
          ),
          setting(
            "executor.maxRunTransitions",
            "Run transition limit",
            config.executor.maxRunTransitions.toLocaleString(),
            {
              description: "Maximum typed lifecycle transitions retained by one Fabric run.",
              submenu: numericSubmenu(
                theme,
                [64, 128, 256, 512, 1_000, 2_000],
                (n) => n.toLocaleString(),
                "Run transition limit",
                "Maximum typed lifecycle transitions retained by one Fabric run.",
              ),
            },
          ),
        ],
        persist,
      ),
    }),
    setting("approvals", "Approvals", summaryFor("approvals", config), {
      description: "Per-action approval policy for Fabric and model-requested native tool calls.",
      submenu: sectionSubmenu(
        theme,
        "Approvals",
        "Approval policy for Fabric and model-requested native tool calls. Auto routes each call through a dedicated safety classifier and escalates uncertain actions to you.",
        [
          setting("approvals.model", "Auto model", config.approvals.model || INHERIT_VALUE, {
            description:
              "Pi model used as the auto-mode safety classifier. Inherit uses the active session model. The classifier has no executable tools and returns a structured allow-or-escalate verdict.",
            submenu: modelPickerSubmenu(
              theme,
              options.modelSource,
              {
                headerText:
                  "Safety classifier for auto approval policies. Pick Inherit to use the active Pi session model.",
                inheritName: "Use the active Pi session model",
              },
            ),
          }),
          setting("approvals.read", "Read", config.approvals.read, {
            description: "Approval policy for read operations. Read is normally safe to leave allowed.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.write", "Write", config.approvals.write, {
            description: "Approval policy for write and edit operations. Auto classifies each call.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.execute", "Execute", config.approvals.execute, {
            description: "Approval policy for shell execution. Auto classifies each command.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.network", "Network", config.approvals.network, {
            description: "Approval policy for network operations. Auto classifies each destination and payload.",
            values: APPROVAL_MODES,
          }),
          setting("approvals.agent", "Agent", config.approvals.agent, {
            description: "Approval policy for agent operations across both lifecycles. Auto classifies each request.",
            values: APPROVAL_MODES,
          }),
        ],
        persist,
      ),
    }),
    setting("mcp", "MCP", summaryFor("mcp", config), {
      description: "Model Context Protocol provider discovery and invocation.",
      submenu: sectionSubmenu(
        theme,
        "MCP",
        "Model Context Protocol provider discovery and invocation.",
        [
          setting("mcp.enabled", "Enabled", config.mcp.enabled ? "true" : "false", {
            description: "Enable the MCP provider inside fabric_exec.",
            values: BOOLEANS,
          }),
          setting("mcp.disableOAuth", "Disable OAuth", config.mcp.disableOAuth ? "true" : "false", {
            description: "Skip MCP OAuth flows.",
            values: BOOLEANS,
          }),
          setting("mcp.allowDynamicServers", "Dynamic servers", config.mcp.allowDynamicServers ? "true" : "false", {
            description: "Allow servers to be added at runtime via the MCP protocol.",
            values: BOOLEANS,
          }),
          setting("mcp.callTimeoutMs", "Call timeout", formatMs(config.mcp.callTimeoutMs), {
            description: "Timeout for individual MCP tool calls.",
            submenu: numericSubmenu(
              theme,
              [15_000, 30_000, 60_000, 120_000, 300_000],
              formatMs,
              "MCP call timeout",
              "Timeout for individual MCP tool calls.",
            ),
          }),
        ],
        persist,
      ),
    }),
    setting("prewalk", "Prewalk", summaryFor("prewalk", config), {
      description: "Choose research-compatible first-mutation switching, legacy in-place continuation, or a child trajectory handoff.",
      submenu: sectionSubmenu(
        theme,
        "Prewalk",
        "Research mode stops at the first successful host-observed mutation; legacy modes continue at the completed outer fabric_exec boundary.",
        [
          setting("prewalk.mode", "Mode", config.prewalk.mode, {
            description:
              "Research requires a host-accepted 5-9 item checklist, stops after the first successful configured mutation, and keeps the executor selected through verification. In-place switches after the outer call completes. Trajectory moves a completed snapshot to a child executor.",
            values: PREWALK_MODES,
          }),
          setting(
            "prewalk.returnPolicy",
            "After in-place task",
            config.prewalk.returnPolicy,
            {
              description:
                "Keep the executor model, or restore the previous Main model after a legacy in-place continuation settles. Research always keeps the executor; trajectory never changes Main's model.",
              values: PREWALK_RETURN_POLICIES,
            },
          ),
          setting(
            "prewalk.verificationMode",
            "Verification",
            config.prewalk.verificationMode ?? "legacy",
            {
              description:
                "Legacy keeps the existing prompt-only continuation. Gated requires host-observed evidence, returns failed revise gates to the executor, and blocks on crash, abort, or a missing acceptance gate.",
              values: PREWALK_VERIFICATION_MODES,
            },
          ),
          setting(
            "prewalk.maxPhaseRevisions",
            "Max revisions",
            String(config.prewalk.maxPhaseRevisions ?? 2),
            {
              description:
                "Maximum gated verify-to-execute revision cycles for one task. Zero makes the first revise result terminal.",
              values: PREWALK_REVISION_LIMITS,
            },
          ),
          setting(
            "prewalk.alwaysRearm",
            "Always re-arm",
            config.prewalk.alwaysRearm ? "true" : "false",
            {
              description:
                "After a task settles or continues, arm prewalk again for the next user task until explicitly cancelled.",
              values: BOOLEANS,
            },
          ),
          setting(
            "prewalk.thinking",
            "Thinking",
            config.prewalk.thinking
              ? thinkingLabel(config.prewalk.thinking)
              : PREWALK_THINKING_INHERIT_LABEL,
            {
              description:
                "Reasoning effort for the trajectory child executor. Agents default inherits Agents › Default thinking; research and in-place keep Main's session level. The level is clamped to each model's supported levels.",
              submenu: thinkingSubmenu(theme, {
                title: "Prewalk thinking",
                description:
                  "Reasoning effort for the trajectory child executor. Agents default uses the Agents section's Default thinking; research and in-place keep Main's session level. Clamped to each model's supported levels (next highest if unsupported).",
                inheritLabel: PREWALK_THINKING_INHERIT_LABEL,
              }),
            },
          ),
          setting(
            "prewalk.model",
            "Executor model",
            config.prewalk.model || PREWALK_MODEL_UNSET_LABEL,
            {
              description:
                "Pi provider/model used by /fabric prewalk. Research and in-place select it for Main; trajectory uses it for the child executor. Ask each time is interactive only.",
              submenu: modelPickerSubmenu(
                theme,
                options.modelSource,
                {
                  headerText:
                    "Executor model for automatic /fabric prewalk continuation. Pick Ask each time to open the model picker for every prewalk.",
                  inheritLabel: PREWALK_MODEL_UNSET_LABEL,
                  inheritName: "Open the model picker whenever prewalk is armed",
                },
              ),
            },
          ),
        ],
        persist,
      ),
    }),
    setting("agents", "Agents", summaryFor("agents", config), {
      description: "One-shot and persistent agent lifecycles.",
      submenu: sectionSubmenu(
        theme,
        "Agents",
        "One-shot and persistent agent lifecycles.",
        [
          setting("agents.enabled", "Enabled", config.agents.enabled ? "true" : "false", {
            description: "Enable agent spawning via workflow.agent() and agents.run().",
            values: BOOLEANS,
          }),
          setting("agents.runner", "Default runner", config.agents.runner, {
            description: "Execution harness used when agents.run/create does not specify runner.",
            values: RUNNERS,
          }),
          setting("agents.transport", "Transport", config.agents.transport, {
            description: "Preferred transport for spawned agents.",
            values: TRANSPORTS,
          }),
          setting("agents.model", "Default model", config.agents.model || INHERIT_VALUE, {
            description:
              "Model forwarded to Pi-backed agents across both lifecycles when a call does not specify one. Pick Inherit to use the host session's default. Order matches pi-model-sort (most recently used first).",
            submenu: modelPickerSubmenu(
              theme,
              options.modelSource,
            ),
          }),
          setting(
            "agents.allowQualityDowngrade",
            "Allow quality downgrade",
            config.agents.allowQualityDowngrade ? "true" : "false",
            {
              description:
                "Permit a capability-compatible fallback with a smaller context, output ceiling, reasoning support, or input modalities. Requests cannot elevate this host policy.",
              values: BOOLEANS,
            },
          ),
          setting(
            "agents.requireAdmissionIntent",
            "Require admission intent",
            config.agents.requireAdmissionIntent ? "true" : "false",
            {
              description:
                "Require every one-shot agent or handoff to name an independent-context, separable, capability-gap, long-running, or verification justification and expected artifact.",
              values: BOOLEANS,
            },
          ),
          setting(
            "agents.claude.model",
            "Claude model",
            config.agents.claude.model || INHERIT_VALUE,
            {
              description:
                "Claude Code model used by Claude-backed agents across both lifecycles. Models are enumerated from the installed claude runtime; Inherit uses Claude Code's default.",
              submenu: modelPickerSubmenu(
                theme,
                options.claudeModelSource ?? { models: [], lastUsed: {} },
                {
                  headerText:
                    "Default model for Claude-backed Fabric agents across both lifecycles. Pick Inherit to use Claude Code's runtime default.",
                  inheritName: "Use Claude Code's runtime default model",
                },
              ),
            },
          ),
          setting("agents.thinking", "Default thinking", thinkingLabel(config.agents.thinking), {
            description:
              "Reasoning effort forwarded to agents across both lifecycles when a call does not specify one. Clamped to each model's supported levels (next highest if unsupported).",
            submenu: thinkingSubmenu(theme),
          }),
          setting("agents.maxConcurrent", "Max concurrent", String(config.agents.maxConcurrent), {
            description: "Maximum number of agents that may run at the same time.",
            submenu: numericSubmenu(
              theme,
              [1, 2, 4, 8, 16, 32],
              String,
              "Agent concurrency",
              "Maximum number of agents that may run at the same time.",
            ),
          }),
          setting("agents.maxPerExecution", "Max per execution", String(config.agents.maxPerExecution), {
            description: "Maximum number of agent calls allowed within a single fabric_exec program.",
            submenu: numericSubmenu(
              theme,
              [10, 25, 50, 100, 200, 500],
              String,
              "Agents per execution",
              "Maximum number of agent calls allowed within a single fabric_exec program.",
            ),
          }),
          setting("agents.maxDepth", "Max depth", String(config.agents.maxDepth), {
            description: "Maximum nesting depth for recursive agent calls.",
            submenu: numericSubmenu(
              theme,
              [0, 1, 2, 3, 4, 6],
              String,
              "Agent depth",
              "Maximum nesting depth for recursive agent calls.",
            ),
          }),
          setting("agents.budgetUsd", "Recursion budget", formatUsd(config.agents.budgetUsd), {
            description:
              "Maximum USD spend for agent work across the whole recursion tree. 0 disables the budget.",
            submenu: numericSubmenu(
              theme,
              BUDGET_VALUES,
              formatUsd,
              "Recursion budget",
              "Maximum USD spend for agent work across the whole recursion tree. 0 disables the budget.",
            ),
          }),
          setting("agents.maxTokensPerChild", "Token limit", formatTokens(config.agents.maxTokensPerChild), {
            description:
              "Maximum cumulative tokens a single agent may use before it is terminated (0 disables). Caps a runaway child before the host session compacts.",
            submenu: numericSubmenu(
              theme,
              TOKEN_VALUES,
              formatTokens,
              "Agent token limit",
              "Maximum cumulative tokens a single agent may use before it is terminated (0 disables).",
            ),
          }),
          setting("agents.timeoutMs", "Timeout", formatMs(config.agents.timeoutMs), {
            description: "Default wall-clock timeout and minimum for per-call agent timeouts.",
            submenu: numericSubmenu(
              theme,
              [
                60_000,
                120_000,
                300_000,
                600_000,
                1_800_000,
                3_600_000,
                7_200_000,
                14_400_000,
                28_800_000,
                86_400_000,
              ],
              formatMs,
              "Agent timeout",
              "Default wall-clock timeout and minimum for per-call agent timeouts.",
            ),
          }),
          setting("agents.extensions", "Extensions", config.agents.extensions ? "true" : "false", {
            description: "Allow agents to load registered extensions, including Pi model-provider plugins.",
            values: BOOLEANS,
          }),
          defaultToolsItem,
          setting("agents.retainRuns", "Retain runs", config.agents.retainRuns ? "true" : "false", {
            description: "Keep completed agent run artifacts for later inspection.",
            values: BOOLEANS,
          }),
          setting("agents.notifyOnComplete", "Notify on complete", config.agents.notifyOnComplete ? "true" : "false", {
            description: "Post a message when a background agent completes.",
            values: BOOLEANS,
          }),
        ],
        persist,
      ),
    }),
    setting("consult", "Ultra Consult", summaryFor("consult", config), {
      description: "Context-aware, read-only fresh-worker consultation with host-validated evidence.",
      submenu: sectionSubmenu(
        theme,
        "Ultra Consult",
        "Host admission defaults to zero workers. Admitted workers are read-only, depth one, and deterministically reduced.",
        [
          setting("consult.enabled", "Enabled", config.consult.enabled ? "true" : "false", {
            description: "Permit consult.run to admit bounded fresh workers; disabled calls return not_admitted.",
            values: BOOLEANS,
          }),
          setting("consult.maxWorkers", "Max workers", String(config.consult.maxWorkers), {
            description: "Hard ceiling for one consult.run call.",
            submenu: numericSubmenu(
              theme,
              [1, 2, 3],
              String,
              "Consult workers",
              "Hard ceiling for one consult.run call.",
            ),
          }),
          setting(
            "consult.contextPressureThreshold",
            "Context pressure",
            `${Math.round(config.consult.contextPressureThreshold * 100)}%`,
            {
              description: "Host context occupancy required for unscoped context-capacity delegation.",
              submenu: numericSubmenu(
                theme,
                CONSULT_PRESSURE_RATIOS,
                (value) => `${Math.round(value * 100)}%`,
                "Consult context pressure",
                "Host context occupancy required for unscoped context-capacity delegation.",
              ),
            },
          ),
          setting(
            "consult.maxFindingsPerWorker",
            "Max findings",
            String(config.consult.maxFindingsPerWorker),
            {
              description: "Maximum structured findings accepted from one worker.",
              submenu: numericSubmenu(
                theme,
                [1, 2, 4, 8, 12, 16],
                String,
                "Findings per worker",
                "Maximum structured findings accepted from one worker.",
              ),
            },
          ),
          setting(
            "consult.maxEvidencePerFinding",
            "Evidence per finding",
            String(config.consult.maxEvidencePerFinding),
            {
              description: "Maximum file addresses validated for one finding.",
              submenu: numericSubmenu(
                theme,
                [1, 2, 4, 8, 12, 16],
                String,
                "Evidence per finding",
                "Maximum file addresses validated for one finding.",
              ),
            },
          ),
          setting(
            "consult.maxEvidenceFileBytes",
            "Evidence file size",
            formatBytes(config.consult.maxEvidenceFileBytes),
            {
              description: "Maximum file size read to validate cited line ranges.",
              submenu: numericSubmenu(
                theme,
                [64 * 1024, 256 * 1024, 1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024, 16 * 1024 * 1024],
                formatBytes,
                "Evidence file size",
                "Maximum file size read to validate cited line ranges.",
              ),
            },
          ),
          setting(
            "consult.maxEvidenceBytesPerConsult",
            "Evidence byte budget",
            formatBytes(config.consult.maxEvidenceBytesPerConsult),
            {
              description: "Cumulative bytes read while validating cited line ranges in one Consult.",
              submenu: numericSubmenu(
                theme,
                [1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024, 16 * 1024 * 1024, 32 * 1024 * 1024, 64 * 1024 * 1024],
                formatBytes,
                "Consult evidence byte budget",
                "Cumulative bytes read while validating cited line ranges in one Consult.",
              ),
            },
          ),
          setting(
            "consult.maxTokensPerWorker",
            "Worker token limit",
            formatTokens(config.consult.maxTokensPerWorker),
            {
              description: "Per-worker token ceiling before the execution-wide budget is applied.",
              submenu: numericSubmenu(
                theme,
                [256, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000],
                formatTokens,
                "Consult worker token limit",
                "Per-worker token ceiling before the execution-wide budget is applied.",
              ),
            },
          ),
        ],
        persist,
      ),
    }),
    setting("capture", "Capture", summaryFor("capture", config), {
      description: "Registered tool capture and model visibility policy.",
      submenu: sectionSubmenu(
        theme,
        "Capture",
        "Registered tool capture and model visibility policy.",
        [
          setting("capture.enabled", "Enabled", config.capture.enabled ? "true" : "false", {
            description: "Capture registered extension tools so they are callable from fabric_exec.",
            values: BOOLEANS,
          }),
          setting("capture.hideFromModel", "Hide from model", config.capture.hideFromModel ? "true" : "false", {
            description: "Hide captured tools from the parent model's tool schema.",
            values: BOOLEANS,
          }),
          setting("capture.defaultRisk", "Default risk", config.capture.defaultRisk, {
            description: "Approval risk level applied to registered tools without an explicit override.",
            values: RISKS,
          }),
          keepVisibleItem,
          ...CORE_RISK_TOOLS.map((tool) =>
            setting(`capture.risks.${tool}`, `${tool} risk`, config.capture.risks[tool] ?? config.capture.defaultRisk, {
              description: `Approval risk level for the ${tool} tool on native and captured paths.`,
              values: RISKS,
            }),
          ),
        ],
        persist,
      ),
    }),
    setting("ui", "UI", summaryFor("ui", config), {
      description: "Fabric activity widget and dashboard.",
      submenu: sectionSubmenu(
        theme,
        "UI",
        "Fabric activity widget and dashboard.",
        [
          setting("ui.enabled", "Enabled", config.ui.enabled ? "true" : "false", {
            description: "Show the Fabric activity widget and dashboard.",
            values: BOOLEANS,
          }),
          setting("ui.widget", "Widget", config.ui.widget, {
            description: "When to show the activity widget above the editor.",
            values: WIDGET_MODES,
          }),
          setting(
            "ui.showNestedToolCalls",
            "Nested tool calls",
            config.ui.showNestedToolCalls ? "true" : "false",
            {
              description: "Show one-shot and persistent agent tool activity in Fabric tool-call previews.",
              values: BOOLEANS,
            },
          ),
          setting(
            "ui.nestedToolDebounceMs",
            "Nested tool debounce",
            formatDebounce(config.ui.nestedToolDebounceMs),
            {
              description: "One global coalescing window for regular nested-tool UI updates.",
              submenu: numericSubmenu(
                theme,
                [0, 16, 50, 100, 150, 250, 500, 1000],
                formatDebounce,
                "Nested tool debounce",
                "One global coalescing window for regular nested-tool UI updates. Off emits every update.",
              ),
            },
          ),
          setting("ui.maxRows", "Max rows", String(config.ui.maxRows), {
            description: "Maximum rows rendered by the activity widget.",
            submenu: numericSubmenu(
              theme,
              [1, 2, 3, 5, 6, 8, 10, 15, 20],
              String,
              "Widget max rows",
              "Maximum rows rendered by the activity widget.",
            ),
          }),
          setting("ui.refreshMs", "Refresh interval", formatMs(config.ui.refreshMs), {
            description: "Refresh interval for the activity widget.",
            submenu: numericSubmenu(
              theme,
              [100, 250, 500, 1000, 2000],
              formatMs,
              "Widget refresh interval",
              "Refresh interval for the activity widget.",
            ),
          }),
          setting("ui.eventHistory", "Event history", String(config.ui.eventHistory), {
            description: "Number of mesh events kept in the dashboard history.",
            submenu: numericSubmenu(
              theme,
              [20, 40, 80, 120, 200, 500],
              String,
              "Event history",
              "Number of mesh events kept in the dashboard history.",
            ),
          }),
        ],
        persist,
      ),
    }),
    setting("compaction", "Compaction", summaryFor("compaction", config), {
      description: "Compaction engine used at session compaction boundaries.",
      submenu: sectionSubmenu(
        theme,
        "Compaction",
        "Choose Fabric model-aware compaction with a portable summary, or Pi core compaction.",
        [
          ...(options.activeModelKey
            ? [setting(
                COMPACTION_THRESHOLD_SETTING_ID,
                "Threshold",
                config.compaction.thresholds[options.activeModelKey] === undefined
                  ? COMPACTION_DEFAULT_THRESHOLD_LABEL
                  : `${Math.round(config.compaction.thresholds[options.activeModelKey]! * 100)}%`,
                {
                  description: `Context occupancy that triggers compaction for ${options.activeModelKey}.`,
                  values: COMPACTION_THRESHOLDS,
                },
              )]
            : []),
          setting("compaction.engine", "Engine", config.compaction.engine, {
            description:
              "Fabric routes compatible native backends and keeps a deterministic portable summary; Pi delegates to Pi core.",
            values: COMPACTION_ENGINES,
          }),
          setting(
            "compaction.contextQos.enabled",
            "Context QoS",
            config.compaction.contextQos.enabled ? "true" : "false",
            {
              description:
                "Before each model request, retire only old superseded read-result bodies while preserving call/result pairs, recent turns, failures, mutations, and evidence.",
              values: BOOLEANS,
            },
          ),
          setting(
            "compaction.contextQos.turnWindow",
            "Protected turns",
            String(config.compaction.contextQos.turnWindow),
            {
              description: "Number of most-recent user turns Context QoS never retires.",
              values: CONTEXT_QOS_TURN_WINDOWS,
            },
          ),
          setting(
            "compaction.contextQos.minResultChars",
            "Retire after chars",
            String(config.compaction.contextQos.minResultChars),
            {
              description: "Minimum text-result size eligible for deterministic retirement.",
              values: CONTEXT_QOS_RESULT_CHARS,
            },
          ),
          setting(
            "compaction.targetContextRatio",
            "Target occupancy",
            String(config.compaction.targetContextRatio),
            {
              description:
                "Fraction of the advertised model window Fabric targets after compaction.",
              values: COMPACTION_TARGET_RATIOS,
            },
          ),
        ],
        persist,
      ),
    }),
    setting("outcomes", "Outcomes", summaryFor("outcomes", config), {
      description: "Bounded run metrics, evaluation scores, and sample-gated route recommendations.",
      submenu: sectionSubmenu(
        theme,
        "Outcomes",
        "Persist derived metrics only. Prompts, result bodies, gate reasons, and judge prose are never stored.",
        [
          setting("outcomes.enabled", "Enabled", config.outcomes.enabled ? "true" : "false", {
            description: "Record terminal Fabric run outcomes in project mesh state.",
            values: BOOLEANS,
          }),
          setting("outcomes.maxRecords", "Max records", String(config.outcomes.maxRecords), {
            description: "Bounded ledger capacity; new records stop when capacity is reached.",
            submenu: numericSubmenu(
              theme,
              [100, 250, 500, 1_000, 2_000, 5_000, 10_000],
              String,
              "Outcome records",
              "Maximum derived run outcomes retained in project mesh state.",
            ),
          }),
          setting(
            "outcomes.minRecommendationSamples",
            "Recommendation samples",
            String(config.outcomes.minRecommendationSamples),
            {
              description: "Minimum samples for a model before it can be recommended.",
              submenu: numericSubmenu(
                theme,
                [2, 3, 5, 10, 20, 50, 100],
                String,
                "Recommendation samples",
                "Minimum outcome samples required before a model route can be recommended.",
              ),
            },
          ),
        ],
        persist,
      ),
    }),
    setting("retention", "Retention", summaryFor("retention", config), {
      description: "Age-based cleanup for inactive Fabric run artifacts.",
      submenu: sectionSubmenu(
        theme,
        "Retention",
        "Cleanup only removes dead temporary roots and terminal run artifacts. Active runs and persistent-agent session.jsonl files are never modified.",
        [
          setting(
            "retention.orphanedTempRunMs",
            "Orphaned temp runs",
            formatRetention(config.retention.orphanedTempRunMs),
            {
              description: "Remove temporary run roots this long after their owner process dies.",
              submenu: numericSubmenu(
                theme,
                [3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000],
                formatRetention,
                "Orphaned temp runs",
                "Remove temporary run roots this long after their owner process dies.",
              ),
            },
          ),
          setting(
            "retention.oneShotRunMs",
            "One-shot runs",
            formatRetention(config.retention.oneShotRunMs),
            {
              description: "Retain completed one-shot agent run artifacts for this duration.",
              submenu: numericSubmenu(
                theme,
                [6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000, 2 * 86_400_000, 3 * 86_400_000, 7 * 86_400_000],
                formatRetention,
                "One-shot runs",
                "Retain completed one-shot agent run artifacts for this duration.",
              ),
            },
          ),
          setting(
            "retention.persistentAgentRunArchiveMs",
            "Persistent agent run archives",
            formatRetention(config.retention.persistentAgentRunArchiveMs),
            {
              description: "Retain terminal persistent-agent run archives for this duration; the latest run is always preserved.",
              submenu: numericSubmenu(
                theme,
                [86_400_000, 3 * 86_400_000, 7 * 86_400_000, 14 * 86_400_000, 30 * 86_400_000, 90 * 86_400_000],
                formatRetention,
                "Persistent agent run archives",
                "Retain terminal persistent-agent run archives for this duration; the latest run is always preserved.",
              ),
            },
          ),
        ],
        persist,
      ),
    }),
    setting("mesh", "Mesh", summaryFor("mesh", config), {
      description: "Durable mesh coordination store and persistent agents.",
      submenu: sectionSubmenu(
        theme,
        "Mesh",
        "Durable mesh coordination store and persistent agents.",
        [
          setting("mesh.enabled", "Enabled", config.mesh.enabled ? "true" : "false", {
            description: "Enable the durable mesh store and persistent-agent provider.",
            values: BOOLEANS,
          }),
          setting("mesh.persistentAgentScope", "Persistent agent scope", config.mesh.persistentAgentScope, {
            description:
              'Where persistent-agent definitions, mailboxes, and sessions are stored. "project" shares them across all Pi sessions in this project (survives /new); "session" isolates them per Pi session (the previous default).',
            values: PERSISTENT_AGENT_SCOPES,
          }),
          setting("mesh.maxReadEvents", "Max read events", String(config.mesh.maxReadEvents), {
            description: "Maximum events returned by a single mesh read.",
            submenu: numericSubmenu(
              theme,
              [100, 200, 500, 1000, 5000],
              String,
              "Max read events",
              "Maximum events returned by a single mesh read.",
            ),
          }),
          setting("mesh.persistentAgentPollMs", "Persistent agent poll fallback", formatMs(config.mesh.persistentAgentPollMs), {
            description: "Fallback polling interval for persistent agents when mesh filesystem notifications are unavailable.",
            submenu: numericSubmenu(
              theme,
              [50, 100, 250, 500, 1000],
              formatMs,
              "Persistent agent poll fallback",
              "Fallback polling interval for persistent agents when mesh filesystem notifications are unavailable.",
            ),
          }),
          setting("mesh.persistentAgentQueueLimit", "Persistent agent queue limit", String(config.mesh.persistentAgentQueueLimit), {
            description: "Maximum messages queued per persistent-agent mailbox.",
            submenu: numericSubmenu(
              theme,
              [4, 8, 16, 32, 64, 128],
              String,
              "Persistent agent queue limit",
              "Maximum messages queued per persistent-agent mailbox.",
            ),
          }),
          setting(
            "mesh.persistentAgentOverflowPolicy",
            "Persistent agent overflow policy",
            config.mesh.persistentAgentOverflowPolicy,
            {
              description:
                "Reject, source-coalesce, drop the oldest queued activation, or dead-letter the oldest queued activation when the mailbox is full.",
              values: ["reject", "coalesce", "drop-oldest", "dead-letter"],
            },
          ),
          setting(
            "mesh.persistentAgentRunMaxAttempts",
            "Persistent agent startup attempts",
            String(config.mesh.persistentAgentRunMaxAttempts),
            {
              description: "Maximum attempts for zero-effect persistent-agent startup failures. Runs with model/tool activity never replay automatically.",
              values: ["1", "2", "3", "4", "5"],
            },
          ),
          setting(
            "mesh.persistentAgentRunBaseDelayMs",
            "Persistent agent startup retry base",
            formatMs(config.mesh.persistentAgentRunBaseDelayMs),
            {
              description: "Initial delay for safe zero-effect persistent-agent run retry.",
              submenu: numericSubmenu(
                theme,
                [0, 100, 250, 500, 1_000, 2_000],
                formatMs,
                "Persistent agent startup retry base",
                "Initial delay for safe zero-effect persistent-agent run retry.",
              ),
            },
          ),
          setting(
            "mesh.persistentAgentRunMaxDelayMs",
            "Persistent agent startup retry max",
            formatMs(config.mesh.persistentAgentRunMaxDelayMs),
            {
              description: "Maximum exponential delay for safe persistent-agent run retry.",
              submenu: numericSubmenu(
                theme,
                [0, 500, 1_000, 2_000, 5_000, 10_000],
                formatMs,
                "Persistent agent startup retry max",
                "Maximum exponential delay for safe persistent-agent run retry.",
              ),
            },
          ),
          setting(
            "mesh.persistentAgentRunJitterMs",
            "Persistent agent startup retry jitter",
            formatMs(config.mesh.persistentAgentRunJitterMs),
            {
              description: "Random jitter added to safe persistent-agent run retry delays.",
              submenu: numericSubmenu(
                theme,
                [0, 50, 100, 250, 500, 1_000],
                formatMs,
                "Persistent agent startup retry jitter",
                "Random jitter added to safe persistent-agent run retry delays.",
              ),
            },
          ),
          setting(
            "mesh.persistentAgentDeliveryMaxAttempts",
            "Persistent agent delivery attempts",
            String(config.mesh.persistentAgentDeliveryMaxAttempts),
            {
              description: "Maximum idempotent mesh/Main delivery attempts before dead-lettering.",
              values: ["1", "2", "3", "4", "5"],
            },
          ),
          setting(
            "mesh.persistentAgentDeliveryBaseDelayMs",
            "Persistent agent retry base delay",
            formatMs(config.mesh.persistentAgentDeliveryBaseDelayMs),
            {
              description: "Initial persistent-agent delivery retry delay before exponential growth.",
              submenu: numericSubmenu(
                theme,
                [0, 50, 100, 250, 500, 1_000],
                formatMs,
                "Persistent agent retry base delay",
                "Initial persistent-agent delivery retry delay before exponential growth.",
              ),
            },
          ),
          setting(
            "mesh.persistentAgentDeliveryMaxDelayMs",
            "Persistent agent retry max delay",
            formatMs(config.mesh.persistentAgentDeliveryMaxDelayMs),
            {
              description: "Maximum exponential component of persistent-agent delivery backoff.",
              submenu: numericSubmenu(
                theme,
                [250, 500, 1_000, 2_000, 5_000, 10_000],
                formatMs,
                "Persistent agent retry max delay",
                "Maximum exponential component of persistent-agent delivery backoff.",
              ),
            },
          ),
          setting(
            "mesh.persistentAgentDeliveryJitterMs",
            "Persistent agent retry jitter",
            formatMs(config.mesh.persistentAgentDeliveryJitterMs),
            {
              description: "Random jitter added to persistent-agent delivery retry delays.",
              submenu: numericSubmenu(
                theme,
                [0, 25, 50, 100, 250, 500],
                formatMs,
                "Persistent agent retry jitter",
                "Random jitter added to persistent-agent delivery retry delays.",
              ),
            },
          ),
          setting(
            "mesh.persistentAgentCircuitFailureThreshold",
            "Persistent agent circuit threshold",
            String(config.mesh.persistentAgentCircuitFailureThreshold),
            {
              description: "Consecutive terminal Main delivery failures before the persistent-agent circuit opens.",
              values: ["1", "2", "3", "5", "10"],
            },
          ),
          setting(
            "mesh.persistentAgentCircuitCooldownMs",
            "Persistent agent circuit cooldown",
            formatMs(config.mesh.persistentAgentCircuitCooldownMs),
            {
              description: "Wait before one half-open persistent-agent delivery probe is allowed.",
              submenu: numericSubmenu(
                theme,
                [0, 1_000, 5_000, 15_000, 30_000, 60_000, 300_000],
                formatMs,
                "Persistent agent circuit cooldown",
                "Wait before one half-open persistent-agent delivery probe is allowed.",
              ),
            },
          ),
          setting("mesh.persistentAgentContextEntries", "Persistent agent context entries", String(config.mesh.persistentAgentContextEntries), {
            description: "Transcript entries forwarded to persistent agents as context.",
            submenu: numericSubmenu(
              theme,
              [3, 5, 10, 14, 20, 50],
              String,
              "Persistent agent context entries",
              "Transcript entries forwarded to persistent agents as context.",
            ),
          }),
          setting("mesh.eventContextChars", "Event context chars", config.mesh.eventContextChars.toLocaleString(), {
            description: "Character cap applied to host events dispatched to persistent agents.",
            submenu: numericSubmenu(
              theme,
              [10_000, 20_000, 40_000, 80_000, 160_000],
              (n) => n.toLocaleString(),
              "Event context chars",
              "Character cap applied to host events dispatched to persistent agents.",
            ),
          }),
        ],
        persist,
      ),
    }),
  ];
  return markDrillIn(items);
};

export interface FabricSettingsDeps {
  state: FabricState;
  applyFabricMode: () => void;
  capturedTools: CapturedToolCatalog;
}

export async function openFabricSettings(
  context: ExtensionContext,
  deps: FabricSettingsDeps,
): Promise<void> {
  if (context.mode !== "tui") {
    context.ui.notify("Fabric settings are available in TUI mode", "warning");
    return;
  }
  await deps.state.ensure(context);

  const agentDir = getAgentDir();
  let rootList: SettingsList | undefined;
  const changedSections = new Set<string>();
  let dirty = false;

  const activeModelKey = context.model
    ? modelKey(context.model.provider, context.model.id)
    : undefined;

  const apply = (id: string, value: unknown): void => {
    const partial = id === COMPACTION_THRESHOLD_SETTING_ID && activeModelKey
      ? { compaction: { thresholds: { [activeModelKey]: value } } }
      : buildPartial(id, value);
    try {
      saveFabricConfig(
        { cwd: context.cwd, agentDir, projectTrusted: context.isProjectTrusted() },
        partial,
      );
    } catch (error) {
      context.ui.notify(
        `Failed to save Fabric settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    deps.state.reloadConfig(context);
    dirty = true;
    changedSections.add(id.split(".")[0] ?? id);
    const list = rootList;
    if (list) {
      for (const rootId of ROOT_ITEM_IDS) {
        list.updateValue(rootId, summaryFor(rootId, deps.state.config));
      }
    }
  };

  const persist = (id: string, newValue: string): void =>
    apply(id, coerceValue(id, newValue, deps.state.config));

  const keepVisibleCandidates = unique([
    "fabric_exec",
    ...deps.capturedTools.list().map((tool) => tool.name),
  ]);
  const modelSource = buildModelSource(context.modelRegistry);
  const configuredClaudeModel = deps.state.config.agents.claude.model;
  const claudeModelSource: ModelSource = {
    models: configuredClaudeModel
      ? [{ provider: "claude", id: configuredClaudeModel.replace(/^claude\//, "") }]
      : [],
    lastUsed: {},
  };
  void populateClaudeModelSource(
    claudeModelSource,
    () => deps.state.agents.claudeModels(),
  ).catch((error: unknown) => {
    if (deps.state.config.agents.runner === "claude") {
      context.ui.notify(
        `Claude model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });

  await context.ui.custom<void>(
    (_tui, theme, _keybindings, done) => {
      const items = buildFabricSettingsItems(theme, deps.state.config, apply, {
        keepVisibleCandidates,
        modelSource,
        claudeModelSource,
        ...(activeModelKey ? { activeModelKey } : {}),
      });
      const component = new FabricSettingsComponent(theme, items, persist, () => done());
      rootList = component.settingsList;
      return component;
    },
  );

  if (dirty) {
    deps.applyFabricMode();
    const needsReload = [...changedSections].some((section) => RELOAD_SECTIONS.has(section));
    if (needsReload) {
      context.ui.notify(
        "Fabric settings saved. Run /fabric reload to apply mesh, agent, and MCP changes.",
        "info",
      );
    } else {
      context.ui.notify("Fabric settings saved.", "info");
    }
  }
}
