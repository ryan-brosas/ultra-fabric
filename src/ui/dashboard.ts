import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewSettings } from "./code-preview.js";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import {
  Editor,
  getKeybindings,
  Markdown,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type EditorTheme,
  type MarkdownTheme,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { FabricActivityCall, FabricActivityRun } from "../activity/types.js";
import type { MeshEvent } from "../mesh/store.js";
import type { FabricAgentMessageDelivery } from "../main-agent.js";
import type { FabricPersistentAgentDelivery, FabricPersistentAgentHostEvent } from "../agents/persistent/types.js";
import { isFabricThinking, type FabricThinking } from "../thinking.js";
import {
  entitiesForOverview,
  filters,
  groupEntities,
  matchesFilter,
  phasePanels,
  tokensFor,
  type Entity,
  type EntityGroup,
  type OverviewView,
  type Pane,
  type PhasePanel,
  type StatusFilter,
} from "./dashboard-model.js";
import { colorStatus, entityTail, statusGlyph } from "./dashboard-presentation.js";
import {
  directionalGraphTarget,
  renderFabricTopologyPanel,
  type FabricGraphPoint,
} from "./dashboard-fabric-graph.js";
import { FabricHostEventSelector } from "./fabric-host-event-selector.js";
import { FabricPersistentAgentDeliverySelector } from "./fabric-persistent-agent-delivery-selector.js";
import { FabricPersistentAgentToolSelector } from "./fabric-persistent-agent-tool-selector.js";
import { FabricModelSelector } from "./fabric-model-selector.js";
import { coreToolTitle, renderCoreToolBody } from "./core-tool-render.js";
import { nestedEditDiff, renderBoundedLines } from "./fabric-render.js";
import { FabricThinkingSelector } from "./fabric-thinking-selector.js";
import { formatClock, formatDuration, formatTokens, padToWidth, safeText, wrapPlainText } from "./format.js";
import { highlightCode } from "./highlight.js";
import { INHERIT_VALUE, type ModelSource } from "./model-picker.js";
import { formatJsonAsYaml } from "./structured.js";
import { loadStateFilePreview, renderStateFilePreview } from "./state-file-preview.js";
import {
  buildProjectMeshTopology,
  type FabricProjectMeshModel,
  type FabricProjectMeshRoute,
} from "./topology.js";
import type { FabricAgentTranscript, FabricTranscriptEntry } from "./transcript.js";
import type { FabricDashboardSnapshot, FabricUiPersistentAgent, FabricUiAgent } from "./types.js";
import { isActiveStatus } from "./types.js";

const editorTheme = (theme: Theme): EditorTheme => ({
  borderColor: (value: string) => theme.fg("borderMuted", value),
  selectList: {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  },
});

const transcriptMarkdownTheme = (theme: Theme, invalidate: () => void): MarkdownTheme => ({
  heading: (text) => theme.fg("mdHeading", text),
  link: (text) => theme.fg("mdLink", text),
  linkUrl: (text) => theme.fg("mdLinkUrl", text),
  code: (text) => theme.fg("mdCode", text),
  codeBlock: (text) => theme.fg("mdCodeBlock", text),
  codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
  quote: (text) => theme.fg("mdQuote", text),
  quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
  hr: (text) => theme.fg("mdHr", text),
  listBullet: (text) => theme.fg("mdListBullet", text),
  bold: (text) => theme.bold(text),
  italic: (text) => theme.italic(text),
  underline: (text) => theme.underline(text),
  strikethrough: (text) => theme.strikethrough(text),
  highlightCode: (code, lang) =>
    highlightCode(code, lang ?? "", invalidate) ??
    code.split("\n").map((line) => theme.fg("mdCodeBlock", line)),
});

const TRANSCRIPT_EXPANDED_TOOL_LINES = 40;
const TRANSCRIPT_STRUCTURED_LINES = 40;
const DASHBOARD_OVERLAY_HEIGHT_PERCENT = 90;
const DASHBOARD_OVERLAY_VERTICAL_MARGIN = 1;

const dashboardOverlayRows = (terminalRows: number): number =>
  Math.max(
    1,
    Math.min(
      Math.floor((terminalRows * DASHBOARD_OVERLAY_HEIGHT_PERCENT) / 100),
      terminalRows - DASHBOARD_OVERLAY_VERTICAL_MARGIN * 2,
    ),
  );

const safeMarkdownText = (value: string): string =>
  value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f]/g, " ");

export interface FabricDashboardMessageTarget {
  id: string;
  name: string;
  kind: "main" | "peer" | "agent" | "persistentAgent" | "meshParticipant";
}

type FabricTranscriptTarget = FabricUiAgent | FabricUiPersistentAgent;

interface FabricDashboardKeybindings {
  matches(data: string, keybinding: "app.tools.expand"): boolean;
  getKeys(keybinding: "app.tools.expand"): string[];
}

export class FabricDashboard implements Component, Focusable {
  focused = false;
  private pane: Pane = "phases";
  private overviewView: OverviewView = "activity";
  private graphPositions = new Map<string, FabricGraphPoint>();
  private graphCamera: FabricGraphPoint = { x: 0, y: 0 };
  private graphCameraTarget: FabricGraphPoint = { x: 0, y: 0 };
  private graphVelocity: FabricGraphPoint = { x: 0, y: 0 };
  private graphCameraInitialized = false;
  private graphAnimation: ReturnType<typeof setInterval> | undefined;
  private graphAnimationAt = 0;
  private graphEffectsAnimation: ReturnType<typeof setInterval> | undefined;
  private graphReducedMotion = false;
  private graphShowHistory = false;
  private graphReplayIndex: number | undefined;
  private graphReplayPlaying = false;
  private graphReplaySpeed = 1;
  private graphReplayAdvancedAt = 0;
  private graphReplayLength = 0;
  private graphReplayLabel: string | undefined;
  private phaseIndex = 0;
  private entityIndex = 0;
  private runIndex = 0;
  private selectedRunId: string | undefined;
  private runSelectionTouched = false;
  private selectedEntityId: string | undefined;
  private filter: StatusFilter = "all";
  private phaseSelectionTouched = false;
  private selectedPhaseId: string | undefined;
  private detailId: string | undefined;
  private detailScroll = 0;
  private detailMaxScroll = 0;
  private transcriptPageAnchor: "start" | "end" | undefined;
  private transcriptToolsExpanded = false;
  private detailSelectionRestore:
    | { runSelectionTouched: boolean; phaseSelectionTouched: boolean }
    | undefined;
  private detailView: "summary" | "transcript" = "summary";
  private transcriptFollowing = true;
  private readonly transcriptMarkdown = new Map<string, { text: string; component: Markdown }>();
  private readonly highlightInvalidate = (): void => this.tui.requestRender();
  private mode:
    | "overview"
    | "detail"
    | "modelPicker"
    | "thinkingPicker"
    | "deliveryPicker"
    | "eventsPicker"
    | "toolsPicker"
    | "instructionsEditor"
    | "agentMessageEditor"
    | "help" = "overview";
  private picker:
    | FabricModelSelector
    | FabricThinkingSelector
    | FabricPersistentAgentDeliverySelector
    | FabricHostEventSelector
    | FabricPersistentAgentToolSelector
    | undefined;
  private editor: Editor | undefined;
  private editorPersistentAgentName: string | undefined;
  private agentMessageTarget:
    | (FabricDashboardMessageTarget & { delivery: FabricAgentMessageDelivery })
    | undefined;
  private pendingStop: { id: string; expiresAt: number } | undefined;
  private readonly modelSource: ModelSource | undefined;
  private readonly claudeModelSource: ModelSource | undefined;
  private readonly onAgentSteer: ((agentId: string, message: string) => void) | undefined;
  private readonly onAgentFollowUp: ((agentId: string, message: string) => void) | undefined;
  private readonly onAgentStop: ((agentId: string) => void) | undefined;
  private readonly onTargetMessage:
    | ((
        target: FabricDashboardMessageTarget,
        message: string,
        delivery: FabricAgentMessageDelivery,
      ) => void)
    | undefined;
  private readonly agentTranscript:
    | ((agent: FabricUiAgent, followLatest: boolean) => FabricAgentTranscript)
    | undefined;
  private readonly persistentAgentTranscript:
    | ((persistentAgent: FabricUiPersistentAgent, followLatest: boolean) => FabricAgentTranscript)
    | undefined;
  private readonly loadOlderTranscript: ((target: FabricTranscriptTarget) => boolean) | undefined;
  private readonly loadNewerTranscript: ((target: FabricTranscriptTarget) => boolean) | undefined;
  private readonly loadLatestTranscript: ((target: FabricTranscriptTarget) => boolean) | undefined;
  private readonly onPersistentAgentModel:
    | ((persistentAgentId: string, model: string | undefined) => void)
    | undefined;
  private readonly onPersistentAgentThinking:
    | ((persistentAgentId: string, thinking: FabricThinking | undefined) => void)
    | undefined;
  private readonly onPersistentAgentEvents:
    | ((persistentAgentId: string, events: FabricPersistentAgentHostEvent[]) => void)
    | undefined;
  private readonly onPersistentAgentDeliveryPolicy:
    | ((persistentAgentId: string, delivery: FabricPersistentAgentDelivery, triggerTurn: boolean) => void)
    | undefined;
  private readonly onGlobalDeliveryPolicy:
    | ((persistentAgentId: string, delivery: FabricPersistentAgentDelivery, triggerTurn: boolean) => void)
    | undefined;
  private readonly onPersistentAgentTools: ((persistentAgentId: string, tools: string[]) => void) | undefined;
  private readonly persistentAgentDefaultTools: string[];
  private readonly onClearMessages: ((persistentAgentId: string) => void) | undefined;
  private readonly onPersistentAgentInstructions:
    | ((persistentAgentId: string, instructions: string) => void)
    | undefined;
  private readonly onGlobalInstructions:
    | ((agentTemplateId: string, instructions: string) => void)
    | undefined;
  private readonly onImportPersistentAgent: ((agentTemplateId: string) => void) | undefined;
  private readonly onExportPersistentAgent: ((persistentAgentId: string) => void) | undefined;
  private readonly onRemoveAgentTemplate: ((agentTemplateId: string) => void) | undefined;
  private readonly codePreviewSettings: CodePreviewSettings | undefined;
  private readonly keybindings: FabricDashboardKeybindings | undefined;
  private pickerPersistentAgentName: string | undefined;

  constructor(
    readonly tui: TUI,
    readonly theme: Theme,
    readonly snapshot: () => FabricDashboardSnapshot,
    readonly done: () => void,
    options: {
      modelSource?: ModelSource;
      codePreviewSettings?: CodePreviewSettings;
      keybindings?: FabricDashboardKeybindings;
      claudeModelSource?: ModelSource;
      onAgentSteer?: (agentId: string, message: string) => void;
      onAgentFollowUp?: (agentId: string, message: string) => void;
      onAgentStop?: (agentId: string) => void;
      onTargetMessage?: (
        target: FabricDashboardMessageTarget,
        message: string,
        delivery: FabricAgentMessageDelivery,
      ) => void;
      agentTranscript?: (
        agent: FabricUiAgent,
        followLatest: boolean,
      ) => FabricAgentTranscript;
      persistentAgentTranscript?: (
        persistentAgent: FabricUiPersistentAgent,
        followLatest: boolean,
      ) => FabricAgentTranscript;
      loadOlderTranscript?: (target: FabricTranscriptTarget) => boolean;
      loadNewerTranscript?: (target: FabricTranscriptTarget) => boolean;
      loadLatestTranscript?: (target: FabricTranscriptTarget) => boolean;
      onPersistentAgentModel?: (persistentAgentId: string, model: string | undefined) => void;
      onPersistentAgentThinking?: (persistentAgentId: string, thinking: FabricThinking | undefined) => void;
      onPersistentAgentEvents?: (persistentAgentId: string, events: FabricPersistentAgentHostEvent[]) => void;
      onPersistentAgentDeliveryPolicy?: (
        persistentAgentId: string,
        delivery: FabricPersistentAgentDelivery,
        triggerTurn: boolean,
      ) => void;
      onGlobalDeliveryPolicy?: (
        persistentAgentId: string,
        delivery: FabricPersistentAgentDelivery,
        triggerTurn: boolean,
      ) => void;
      onPersistentAgentTools?: (persistentAgentId: string, tools: string[]) => void;
      persistentAgentDefaultTools?: string[];
      onClearMessages?: (persistentAgentId: string) => void;
      onPersistentAgentInstructions?: (persistentAgentId: string, instructions: string) => void;
      onGlobalInstructions?: (agentTemplateId: string, instructions: string) => void;
      onImportPersistentAgent?: (agentTemplateId: string) => void;
      onExportPersistentAgent?: (persistentAgentId: string) => void;
      onRemoveAgentTemplate?: (agentTemplateId: string) => void;
    } = {},
  ) {
    this.focused = true;
    this.modelSource = options.modelSource;
    this.codePreviewSettings = options.codePreviewSettings;
    this.keybindings = options.keybindings;
    this.claudeModelSource = options.claudeModelSource;
    this.onAgentSteer = options.onAgentSteer;
    this.onAgentFollowUp = options.onAgentFollowUp;
    this.onAgentStop = options.onAgentStop;
    this.onTargetMessage = options.onTargetMessage;
    this.agentTranscript = options.agentTranscript;
    this.persistentAgentTranscript = options.persistentAgentTranscript;
    this.loadOlderTranscript = options.loadOlderTranscript;
    this.loadNewerTranscript = options.loadNewerTranscript;
    this.loadLatestTranscript = options.loadLatestTranscript;
    this.onPersistentAgentModel = options.onPersistentAgentModel;
    this.onPersistentAgentThinking = options.onPersistentAgentThinking;
    this.onPersistentAgentEvents = options.onPersistentAgentEvents;
    this.onPersistentAgentDeliveryPolicy = options.onPersistentAgentDeliveryPolicy;
    this.onGlobalDeliveryPolicy = options.onGlobalDeliveryPolicy;
    this.onPersistentAgentTools = options.onPersistentAgentTools;
    this.persistentAgentDefaultTools = options.persistentAgentDefaultTools ?? [];
    this.onClearMessages = options.onClearMessages;
    this.onPersistentAgentInstructions = options.onPersistentAgentInstructions;
    this.onGlobalInstructions = options.onGlobalInstructions;
    this.onImportPersistentAgent = options.onImportPersistentAgent;
    this.onExportPersistentAgent = options.onExportPersistentAgent;
    this.onRemoveAgentTemplate = options.onRemoveAgentTemplate;
  }

  readonly #modeInputHandlers: Partial<Record<string, (data: string) => boolean>> = {
    help: (data) => {
      if (
        data === "?" ||
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c"))
      ) {
        this.mode = this.detailId ? "detail" : "overview";
      }
      this.tui.requestRender();
      return true;
    },
    agentMessageEditor: (data) => {
      if (!this.editor) return false;
      if (getKeybindings().matches(data, "tui.select.cancel")) this.closeAgentMessageEditor();
      else this.editor.handleInput(data);
      this.tui.requestRender();
      return true;
    },
    instructionsEditor: (data) => {
      if (!this.editor) return false;
      if (getKeybindings().matches(data, "tui.select.cancel")) this.closeInstructionsEditor();
      else this.editor.handleInput(data);
      this.tui.requestRender();
      return true;
    },
    modelPicker: (data) => this.#handlePickerModeInput(data),
    thinkingPicker: (data) => this.#handlePickerModeInput(data),
    deliveryPicker: (data) => this.#handlePickerModeInput(data),
    eventsPicker: (data) => this.#handlePickerModeInput(data),
    toolsPicker: (data) => this.#handlePickerModeInput(data),
  };

  handleInput(data: string): void {
    if (this.#handleModeInput(data)) return;

    const snapshot = this.snapshot();
    const run = this.selectRun(snapshot);
    const panels = phasePanels(snapshot, run);
    this.syncPhase(run, panels);
    const panel = panels[this.phaseIndex];
    const projectMesh = this.projectMesh(snapshot);
    const allEntities = entitiesForOverview(
      snapshot,
      run,
      panel,
      this.overviewView,
      projectMesh,
    );
    const entities = allEntities.filter(
      (entity) => entity.kind === "main" || matchesFilter(entity.status, this.filter),
    );
    this.syncEntitySelection(entities, this.overviewView !== "activity");

    if (data === "?") {
      this.mode = "help";
      this.tui.requestRender();
      return;
    }

    if (this.detailId) {
      this.#handleDetailInput(data, allEntities);
      return;
    }

    this.#handleOverviewInput(data, { snapshot, run, panels, panel, projectMesh, entities });
  }

  #handlePickerModeInput(data: string): boolean {
    if (!this.picker) return false;
    this.picker.handleInput(data);
    this.tui.requestRender();
    return true;
  }

  #handleModeInput(data: string): boolean {
    return this.#modeInputHandlers[this.mode]?.(data) ?? false;
  }

  #handleDetailInput(data: string, allEntities: Entity[]): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      matchesKey(data, Key.left) ||
      data === "h"
    ) {
      this.closeDetail();
    } else if (data === "t") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail && this.hasTranscript(detail)) {
        this.detailView = this.detailView === "summary" ? "transcript" : "summary";
        this.detailScroll = 0;
        this.transcriptPageAnchor = undefined;
        this.transcriptFollowing = true;
      }
    } else if (
      this.detailView === "transcript" &&
      this.matchesTranscriptToolToggle(data)
    ) {
      this.transcriptToolsExpanded = !this.transcriptToolsExpanded;
    } else if (matchesKey(data, Key.up) || data === "k") {
      if (this.detailScroll > 0) {
        if (this.detailView === "transcript") this.transcriptFollowing = false;
        this.detailScroll--;
      } else if (this.detailView === "transcript") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        const target = detail ? this.transcriptTarget(detail) : undefined;
        if (target && this.loadOlderTranscript?.(target)) {
          this.transcriptPageAnchor = "end";
          this.transcriptFollowing = false;
        }
      }
    } else if (matchesKey(data, Key.down) || data === "j") {
      if (this.detailScroll < this.detailMaxScroll) {
        if (this.detailView === "transcript") this.transcriptFollowing = false;
        this.detailScroll++;
      } else if (this.detailView === "transcript") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        const target = detail ? this.transcriptTarget(detail) : undefined;
        if (target && this.loadNewerTranscript?.(target)) {
          this.transcriptPageAnchor = "start";
          this.transcriptFollowing = false;
        }
      }
    } else if (data === "G" && this.detailView === "transcript") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      const target = detail ? this.transcriptTarget(detail) : undefined;
      if (target) this.loadLatestTranscript?.(target);
      this.transcriptPageAnchor = undefined;
      this.transcriptFollowing = true;
      this.detailScroll = this.detailMaxScroll;
    } else if (matchesKey(data, Key.home) || data === "g") {
      if (this.detailView === "transcript") {
        this.transcriptPageAnchor = undefined;
        this.transcriptFollowing = false;
      }
      this.detailScroll = 0;
    } else if (data === "s" || data === "u") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      const delivery = data === "s" ? "steer" : "followUp";
      if (detail && this.canMessage(detail, delivery)) {
        this.openAgentMessageEditor(detail, delivery);
      }
    } else if (data === "m") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail && detail.kind === "persistentAgent" && detail.status !== "stopped") {
        this.openModelPicker(detail);
      }
    } else if (data === "e") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail && detail.kind === "persistentAgent" && detail.status !== "stopped") {
        this.openThinkingPicker(detail);
      }
    } else if (data === "y") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail && (detail.kind === "persistentAgent" || detail.kind === "agentTemplate")) {
        this.openDeliveryPicker(detail);
      }
    } else if (data === "v") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail && detail.kind === "persistentAgent" && detail.status !== "stopped") {
        this.openEventsPicker(detail);
      }
    } else if (data === "o") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail && detail.kind === "persistentAgent" && detail.status !== "stopped") {
        this.openToolsPicker(detail);
      }
    } else if (data === "c") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (
        detail &&
        detail.kind === "persistentAgent" &&
        detail.status !== "stopped" &&
        this.onClearMessages
      ) {
        this.onClearMessages(detail.value.id);
      }
    } else if (data === "i") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail && (detail.kind === "persistentAgent" || detail.kind === "agentTemplate")) {
        this.openInstructionsEditor(detail);
      }
    } else if (data === "x") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail && this.canStop(detail)) {
        this.requestParticipantStop(detail);
      } else if (
        detail &&
        detail.kind === "persistentAgent" &&
        detail.status !== "stopped" &&
        this.onExportPersistentAgent
      ) {
        this.onExportPersistentAgent(detail.value.id);
      }
    } else if (data === "p") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail && detail.kind === "agentTemplate" && this.onImportPersistentAgent) {
        this.onImportPersistentAgent(detail.value.id);
      }
    } else if (data === "d") {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail && detail.kind === "agentTemplate" && this.onRemoveAgentTemplate) {
        this.onRemoveAgentTemplate(detail.value.id);
      }
    }
    this.tui.requestRender();
    return;
  }

  #handleOverviewInput(
    data: string,
    ctx: {
      snapshot: FabricDashboardSnapshot;
      run: FabricActivityRun | undefined;
      panels: PhasePanel[];
      panel: PhasePanel | undefined;
      projectMesh: FabricProjectMeshModel | undefined;
      entities: Entity[];
    },
  ): void {
    const { snapshot, run, panels, panel, projectMesh, entities } = ctx;
    if (data === "1" || data === "2") {
      const nextOverview: OverviewView = data === "1" ? "activity" : "topology";
      if (nextOverview !== this.overviewView) {
        if (nextOverview === "activity") {
          this.stopGraphAnimation();
          this.stopGraphEffectsAnimation();
        }
        this.overviewView = nextOverview;
        this.pane = nextOverview === "activity" ? "phases" : "entities";
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
        this.pendingStop = undefined;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.overviewView === "activity" && this.pane === "entities") {
        this.pane = "phases";
      } else {
        this.done();
        return;
      }
    } else if (this.overviewView === "topology" && data === "r") {
      this.toggleGraphReplay(snapshot, projectMesh);
      this.startGraphEffectsAnimation();
      this.tui.requestRender();
      return;
    } else if (
      this.overviewView === "topology" &&
      this.graphReplayIndex !== undefined &&
      data === " "
    ) {
      this.graphReplayPlaying = !this.graphReplayPlaying;
      this.graphReplayAdvancedAt = Date.now();
      this.startGraphEffectsAnimation();
      this.tui.requestRender();
      return;
    } else if (
      this.overviewView === "topology" &&
      this.graphReplayIndex !== undefined &&
      (matchesKey(data, Key.left) || matchesKey(data, Key.right))
    ) {
      this.stepGraphReplay(matchesKey(data, Key.left) ? -1 : 1);
      this.tui.requestRender();
      return;
    } else if (this.overviewView === "topology" && (data === "+" || data === "=" || data === "-")) {
      const speeds = [0.5, 1, 2, 4];
      const current = speeds.indexOf(this.graphReplaySpeed);
      const direction = data === "-" ? -1 : 1;
      this.graphReplaySpeed = speeds[Math.max(0, Math.min(speeds.length - 1, current + direction))] ?? 1;
      this.graphReplayAdvancedAt = Date.now();
      this.tui.requestRender();
      return;
    } else if (this.overviewView === "topology" && data === "H") {
      this.graphShowHistory = !this.graphShowHistory;
      this.tui.requestRender();
      return;
    } else if (this.overviewView === "topology" && data === "M") {
      this.graphReducedMotion = !this.graphReducedMotion;
      this.tui.requestRender();
      return;
    } else if (
      this.overviewView === "topology" &&
      (matchesKey(data, Key.left) || matchesKey(data, Key.right) ||
        matchesKey(data, Key.up) || matchesKey(data, Key.down) || data === "h" || data === "l")
    ) {
      const direction =
        matchesKey(data, Key.left) || data === "h"
          ? "left"
          : matchesKey(data, Key.right) || data === "l"
            ? "right"
            : matchesKey(data, Key.up)
              ? "up"
              : "down";
      const target = directionalGraphTarget(this.graphPositions, this.selectedEntityId, direction);
      const targetIndex = target ? entities.findIndex((entity) => entity.id === target) : -1;
      if (targetIndex >= 0) {
        this.entityIndex = targetIndex;
        this.selectedEntityId = target;
        this.pendingStop = undefined;
      }
      this.tui.requestRender();
      return;
    } else if (matchesKey(data, Key.tab) && this.overviewView === "topology") {
      this.entityIndex = entities.length > 0 ? (this.entityIndex + 1) % entities.length : 0;
      this.selectedEntityId = entities[this.entityIndex]?.id;
      this.pendingStop = undefined;
      this.tui.requestRender();
      return;
    } else if (matchesKey(data, Key.tab) && this.overviewView === "activity") {
      this.pane = this.pane === "phases" ? "entities" : "phases";
    } else if (
      this.overviewView === "activity" &&
      (matchesKey(data, Key.left) || data === "h")
    ) {
      this.pane = "phases";
    } else if (
      this.overviewView === "activity" &&
      (matchesKey(data, Key.right) || data === "l")
    ) {
      this.pane = "entities";
    } else if (matchesKey(data, Key.up) || data === "k") {
      if (this.overviewView === "activity" && this.pane === "phases") {
        this.phaseIndex = Math.max(0, this.phaseIndex - 1);
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = Math.max(0, this.entityIndex - 1);
      }
    } else if (matchesKey(data, Key.down) || data === "j") {
      if (this.overviewView === "activity" && this.pane === "phases") {
        this.phaseIndex = Math.min(Math.max(0, panels.length - 1), this.phaseIndex + 1);
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = Math.min(Math.max(0, entities.length - 1), this.entityIndex + 1);
      }
    } else if (
      ["m", "e", "y", "v", "o", "i", "c", "s", "u", "x", "p", "d"].includes(data) &&
      this.pane === "entities"
    ) {
      const selected = entities[this.entityIndex];
      if (selected) {
        if (
          (data === "s" || data === "u") &&
          this.canMessage(selected, data === "s" ? "steer" : "followUp")
        ) {
          this.detailId = selected.id;
          this.openAgentMessageEditor(selected, data === "s" ? "steer" : "followUp");
        } else if (data === "x" && this.canStop(selected)) {
          this.requestParticipantStop(selected);
        } else if (
          data === "x" &&
          selected.kind === "persistentAgent" &&
          selected.status !== "stopped" &&
          this.onExportPersistentAgent
        ) {
          this.onExportPersistentAgent(selected.value.id);
        } else if (data === "m" && selected.kind === "persistentAgent" && selected.status !== "stopped") {
          this.detailId = selected.id;
          this.openModelPicker(selected);
        } else if (data === "e" && selected.kind === "persistentAgent" && selected.status !== "stopped") {
          this.detailId = selected.id;
          this.openThinkingPicker(selected);
        } else if (
          data === "y" &&
          (selected.kind === "agentTemplate" ||
            (selected.kind === "persistentAgent" && selected.status !== "stopped"))
        ) {
          this.detailId = selected.id;
          this.openDeliveryPicker(selected);
        } else if (data === "v" && selected.kind === "persistentAgent" && selected.status !== "stopped") {
          this.detailId = selected.id;
          this.openEventsPicker(selected);
        } else if (data === "o" && selected.kind === "persistentAgent" && selected.status !== "stopped") {
          this.detailId = selected.id;
          this.openToolsPicker(selected);
        } else if (
          data === "c" &&
          selected.kind === "persistentAgent" &&
          selected.status !== "stopped" &&
          this.onClearMessages
        ) {
          this.onClearMessages(selected.value.id);
        } else if (data === "i" && (selected.kind === "persistentAgent" || selected.kind === "agentTemplate")) {
          this.detailId = selected.id;
          this.openInstructionsEditor(selected);
        } else if (data === "p" && selected.kind === "agentTemplate" && this.onImportPersistentAgent) {
          this.onImportPersistentAgent(selected.value.id);
        } else if (data === "d" && selected.kind === "agentTemplate" && this.onRemoveAgentTemplate) {
          this.onRemoveAgentTemplate(selected.value.id);
        }
      }
    } else if (data === " " && this.pane === "entities") {
      const selected = entities[this.entityIndex];
      if (selected && this.hasTranscript(selected)) {
        this.detailId = selected.id;
        this.detailView = "transcript";
        this.detailScroll = 0;
        this.transcriptPageAnchor = undefined;
        this.transcriptFollowing = true;
      }
    } else if (matchesKey(data, Key.enter)) {
      if (this.overviewView === "activity" && this.pane === "phases") {
        this.pane = "entities";
      } else {
        const selected = entities[this.entityIndex];
        if (selected) {
          this.detailId = selected.id;
          this.detailView = "summary";
          this.detailScroll = 0;
          this.transcriptFollowing = true;
        }
      }
    } else if (data === "f") {
      const next = (filters.indexOf(this.filter) + 1) % filters.length;
      this.filter = filters[next] ?? "all";
      this.entityIndex = 0;
      this.selectedEntityId = undefined;
      this.tui.requestRender();
      return;
    } else if (data === "[") {
      this.runIndex = Math.min(Math.max(0, snapshot.runs.length - 1), this.runIndex + 1);
      this.selectedRunId = snapshot.runs[this.runIndex]?.id;
      this.runSelectionTouched = true;
      this.resetSelection();
      this.tui.requestRender();
      return;
    } else if (data === "]") {
      this.runIndex = Math.max(0, this.runIndex - 1);
      this.selectedRunId = snapshot.runs[this.runIndex]?.id;
      this.runSelectionTouched = true;
      this.resetSelection();
      this.tui.requestRender();
      return;
    } else if (data === "G") {
      if (this.overviewView === "activity" && this.pane === "phases") {
        this.phaseIndex = Math.max(0, panels.length - 1);
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = Math.max(0, entities.length - 1);
      }
    } else if (data === "g") {
      if (this.overviewView === "activity" && this.pane === "phases") {
        this.phaseIndex = 0;
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = 0;
      }
    }
    if (this.phaseSelectionTouched) this.selectedPhaseId = panels[this.phaseIndex]?.id;
    if (this.detailId) {
      this.pinDetailSelection(run, panel, this.overviewView === "activity");
    }
    if (this.pane === "entities") {
      this.selectedEntityId = entities[this.entityIndex]?.id;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.mode === "help") return this.renderHelp(width);
    if (this.mode === "agentMessageEditor") return this.renderAgentMessageEditor(width);
    if (this.mode === "instructionsEditor") {
      return this.renderInstructionsEditor(width);
    }
    if (
      (this.mode === "modelPicker" ||
        this.mode === "thinkingPicker" ||
        this.mode === "deliveryPicker" ||
        this.mode === "eventsPicker" ||
        this.mode === "toolsPicker") &&
      this.picker
    ) {
      return this.renderPicker(width);
    }
    const snapshot = this.snapshot();
    const run = this.selectRun(snapshot);
    const panels = phasePanels(snapshot, run);
    this.syncPhase(run, panels);
    const panel = panels[this.phaseIndex];
    const projectMesh = this.projectMesh(snapshot);
    const allEntities = entitiesForOverview(
      snapshot,
      run,
      panel,
      this.overviewView,
      projectMesh,
    );
    const entities = allEntities.filter(
      (entity) => entity.kind === "main" || matchesFilter(entity.status, this.filter),
    );
    this.syncEntitySelection(entities, this.overviewView !== "activity");
    if (this.detailId) {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail) return this.renderDetail(width, snapshot, detail);
      this.closeDetail();
    }
    return this.renderOverview(
      width,
      snapshot,
      run,
      panels,
      entities,
      allEntities,
      projectMesh,
    );
  }

  invalidate(): void {
    this.transcriptMarkdown.clear();
  }

  dispose(): void {
    this.picker = undefined;
    this.editor = undefined;
    this.editorPersistentAgentName = undefined;
    this.agentMessageTarget = undefined;
    this.pendingStop = undefined;
    this.stopGraphAnimation();
    this.stopGraphEffectsAnimation();
    this.transcriptMarkdown.clear();
    this.mode = "overview";
  }

  private transcriptTarget(entity: Entity): FabricTranscriptTarget | undefined {
    if (entity.kind === "agent" || entity.kind === "persistentAgent") return entity.value;
    return undefined;
  }

  private hasTranscript(entity: Entity): boolean {
    return (
      (entity.kind === "agent" && this.agentTranscript !== undefined) ||
      (entity.kind === "persistentAgent" && this.persistentAgentTranscript !== undefined)
    );
  }

  private transcriptFor(entity: Entity): FabricAgentTranscript | undefined {
    if (entity.kind === "agent") {
      return this.agentTranscript?.(entity.value, this.transcriptFollowing);
    }
    if (entity.kind === "persistentAgent") {
      return this.persistentAgentTranscript?.(entity.value, this.transcriptFollowing);
    }
    return undefined;
  }

  private matchesTranscriptToolToggle(data: string): boolean {
    if (this.keybindings) return this.keybindings.matches(data, "app.tools.expand");
    const keybindings = getKeybindings();
    const keys = keybindings.getKeys("app.tools.expand");
    return keys.length > 0
      ? keybindings.matches(data, "app.tools.expand")
      : matchesKey(data, Key.ctrl("o"));
  }

  private transcriptToolToggleHint(): string {
    const keys = (this.keybindings ?? getKeybindings()).getKeys("app.tools.expand");
    const key = keys.length > 0 ? keys.join("/") : this.keybindings ? "unbound" : "ctrl+o";
    return `${key} ${this.transcriptToolsExpanded ? "collapse" : "expand"} tools`;
  }

  private messageTarget(entity: Entity): FabricDashboardMessageTarget | undefined {
    if (entity.kind === "main") {
      return { id: entity.value.id, name: "Main", kind: "main" };
    }
    if (entity.kind === "peer") {
      return { id: entity.value.id, name: entity.value.name, kind: "peer" };
    }
    if (entity.kind === "agent") {
      return { id: entity.value.id, name: entity.value.name, kind: "agent" };
    }
    if (entity.kind === "persistentAgent") {
      return { id: entity.value.id, name: entity.value.name, kind: "persistentAgent" };
    }
    if (entity.kind === "meshParticipant") {
      return { id: entity.value.id, name: entity.value.name, kind: "meshParticipant" };
    }
    return undefined;
  }

  private canMessage(entity: Entity, delivery: FabricAgentMessageDelivery): boolean {
    const target = this.messageTarget(entity);
    if (!target) return false;
    if (target.kind === "agent") {
      if (!isActiveStatus(entity.status)) return false;
      if (
        entity.kind === "agent" &&
        entity.value.capabilities &&
        !entity.value.capabilities.includes(delivery)
      ) {
        return false;
      }
      return Boolean(
        this.onTargetMessage ||
          (delivery === "steer" ? this.onAgentSteer : this.onAgentFollowUp),
      );
    }
    if (!this.onTargetMessage) return false;
    if (target.kind === "persistentAgent") return entity.status !== "stopped";
    if (target.kind === "meshParticipant" && entity.kind === "meshParticipant") {
      const participant = entity.value.participant;
      return participant
        ? !participant.stale && participant.capabilities.includes(delivery)
        : true;
    }
    return true;
  }

  private openAgentMessageEditor(
    entity: Entity,
    delivery: FabricAgentMessageDelivery,
  ): void {
    const target = this.messageTarget(entity);
    if (!target || !this.canMessage(entity, delivery)) return;
    const editor = new Editor(this.tui, editorTheme(this.theme));
    editor.focused = true;
    editor.onSubmit = (text) => {
      const message = text.trim();
      if (!message) return;
      if (this.onTargetMessage) {
        this.onTargetMessage(target, message, delivery);
      } else if (target.kind === "agent") {
        if (delivery === "steer") this.onAgentSteer?.(target.id, message);
        else this.onAgentFollowUp?.(target.id, message);
      }
      this.closeAgentMessageEditor();
    };
    this.editor = editor;
    this.agentMessageTarget = { ...target, delivery };
    this.mode = "agentMessageEditor";
  }

  private closeAgentMessageEditor(): void {
    this.editor = undefined;
    this.agentMessageTarget = undefined;
    this.mode = this.detailId ? "detail" : "overview";
  }

  private canStop(entity: Entity): entity is Extract<
    Entity,
    { kind: "agent" } | { kind: "meshParticipant" }
  > {
    if (!this.onAgentStop) return false;
    if (entity.kind === "agent") {
      return (
        isActiveStatus(entity.status) &&
        (!entity.value.capabilities || entity.value.capabilities.includes("stop"))
      );
    }
    if (entity.kind === "meshParticipant") {
      const participant = entity.value.participant;
      return Boolean(
        participant &&
          !participant.stale &&
          participant.capabilities.includes("stop"),
      );
    }
    return false;
  }

  private requestParticipantStop(
    entity: Extract<Entity, { kind: "agent" } | { kind: "meshParticipant" }>,
  ): void {
    if (!this.onAgentStop || !this.canStop(entity)) return;
    const now = Date.now();
    if (this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > now) {
      this.pendingStop = undefined;
      this.onAgentStop(entity.value.id);
      return;
    }
    this.pendingStop = { id: entity.value.id, expiresAt: now + 2_000 };
  }

  private renderAgentMessageEditor(width: number): string[] {
    if (!this.editor || !this.agentMessageTarget) return [];
    if (width < 24) return this.renderNarrowFallback(width, `${this.agentMessageTarget.delivery} · ${this.agentMessageTarget.name}`, "esc cancel");
    const target = this.agentMessageTarget;
    const label =
      target.kind === "persistentAgent"
        ? target.delivery === "steer"
          ? "queue persistent agent message"
          : "queue persistent agent follow-up"
        : target.delivery === "steer"
          ? target.kind === "main"
            ? "message or steer Main"
            : "steer now"
          : "queue follow-up";
    const innerWidth = width - 2;
    const lines = [this.topBorder(width, `${label} · ${target.name}`)];
    for (const line of this.editor.render(innerWidth)) lines.push(this.row(width, line));
    lines.push(this.middleBorder(width));
    lines.push(
      this.row(
        width,
        this.theme.fg("dim", "  enter send · shift+enter newline · esc cancel"),
      ),
    );
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private renderHelp(width: number): string[] {
    if (width < 24) return this.renderNarrowFallback(width, "dashboard help", "? or esc close");
    const lines = [this.topBorder(width, "Fabric dashboard help")];
    const mainActions = [
      this.onTargetMessage ? "s message/steer" : undefined,
      this.onTargetMessage ? "u queue follow-up" : undefined,
      "enter details",
    ].filter((value): value is string => Boolean(value));
    const agentActions = [
      this.agentTranscript ? "space transcript peek" : undefined,
      this.onTargetMessage || this.onAgentSteer ? "s steer now" : undefined,
      this.onTargetMessage || this.onAgentFollowUp ? "u queue follow-up" : undefined,
      this.onAgentStop ? "x twice stop" : undefined,
      "enter details",
    ].filter((value): value is string => Boolean(value));
    const persistentAgentActions = [
      this.persistentAgentTranscript ? "space transcript peek" : undefined,
      this.onTargetMessage ? "s queue message" : undefined,
      this.onTargetMessage ? "u queue follow-up" : undefined,
      (this.modelSource || this.claudeModelSource) && this.onPersistentAgentModel ? "m model" : undefined,
      this.onPersistentAgentThinking ? "e thinking" : undefined,
      this.onPersistentAgentDeliveryPolicy ? "y delivery policy" : undefined,
      this.onPersistentAgentEvents ? "v events" : undefined,
      this.onPersistentAgentTools ? "o tools" : undefined,
      this.onPersistentAgentInstructions ? "i instructions" : undefined,
      this.onClearMessages ? "c clear mailbox" : undefined,
      this.onExportPersistentAgent ? "x export" : undefined,
    ].filter((value): value is string => Boolean(value));
    const templateActions = [
      this.onGlobalDeliveryPolicy ? "y delivery policy" : undefined,
      this.onGlobalInstructions ? "i instructions" : undefined,
      this.onImportPersistentAgent ? "p import" : undefined,
      this.onRemoveAgentTemplate ? "d delete" : undefined,
    ].filter((value): value is string => Boolean(value));
    const help = [
      ["Navigate", "Topology: arrows/h/l move spatially · j/k ordered selection · tab next · enter inspect · esc back"],
      ["Views", "1 Activity · 2 unified Topology"],
      ["Topology", "Main branches into Participants (sessions and agents across both lifecycles) and Mesh (namespaced topics and hierarchical state); traffic travels on decaying edges"],
      ["Motion", "r replay/live · space pause/play · ←/→ step · +/- speed · H history · M reduced motion"],
      ["Runs", "[ older · ] newer · f cycle status filter"],
      ["Commands", "/fabric health runtime summary · /fabric leases inspect or release write leases · /fabric outcomes model report"],
      ...(mainActions.length > 1 ? [["Main", mainActions.join(" · ")]] : []),
      ...(agentActions.length > 1 ? [["Agents", agentActions.join(" · ")]] : []),
      ...(persistentAgentActions.length > 0 ? [["Persistent agents", persistentAgentActions.join(" · ")]] : []),
      ...(templateActions.length > 0 ? [["Templates", templateActions.join(" · ")]] : []),
      [
        "Details",
        `↑↓/jk lazy scroll · g page top · G live tail · ${this.transcriptToolToggleHint()} · t transcript/summary · ? close help`,
      ],
    ];
    for (const [label, value] of help) {
      const prefix = `${this.theme.fg("accent", `${label}:`)} `;
      const wrapped = wrapPlainText(value ?? "", Math.max(1, width - 2 - visibleWidth(prefix)), 3);
      if (wrapped[0]) lines.push(this.row(width, prefix + wrapped[0]));
      for (const continuation of wrapped.slice(1)) {
        lines.push(this.row(width, " ".repeat(visibleWidth(prefix)) + continuation));
      }
    }
    lines.push(this.middleBorder(width));
    lines.push(this.row(width, this.theme.fg("dim", "  ? or esc close")));
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private modelSourceForPersistentAgent(persistentAgent: FabricUiPersistentAgent): ModelSource | undefined {
    return this.modelSource;
  }

  private openModelPicker(entity: Entity): void {
    if (entity.kind !== "persistentAgent" || !this.onPersistentAgentModel) return;
    const persistentAgent = entity.value;
    const source = this.modelSourceForPersistentAgent(persistentAgent);
    if (!source) return;
    this.pickerPersistentAgentName = persistentAgent.name;
    this.picker = new FabricModelSelector({
      theme: this.theme,
      source,
      currentValue: persistentAgent.model ?? INHERIT_VALUE,
      headerText: `Model for persistent agent "${persistentAgent.name}". Pick Inherit to use the Fabric Pi default.`,
      inheritName: "Use the Fabric Pi model (or host default)",
      onSelect: (value) => {
        const model = value === INHERIT_VALUE ? undefined : value;
        this.onPersistentAgentModel!(persistentAgent.id, model);
        this.closeModelPicker();
      },
      onCancel: () => this.closeModelPicker(),
    });
    this.picker.focused = true;
    this.mode = "modelPicker";
  }

  private openThinkingPicker(entity: Entity): void {
    if (entity.kind !== "persistentAgent" || !this.onPersistentAgentThinking) return;
    const persistentAgent = entity.value;
    this.pickerPersistentAgentName = persistentAgent.name;
    this.picker = new FabricThinkingSelector({
      theme: this.theme,
      currentValue: persistentAgent.thinking ?? INHERIT_VALUE,
      headerText: `Thinking level for persistent agent "${persistentAgent.name}". Pick Inherit to use the Fabric default.`,
      inheritName: "Use the Fabric default thinking level",
      onSelect: (value) => {
        const thinking = value === INHERIT_VALUE ? undefined : value;
        this.onPersistentAgentThinking!(persistentAgent.id, isFabricThinking(thinking) ? thinking : undefined);
        this.closeModelPicker();
      },
      onCancel: () => this.closeModelPicker(),
    });
    this.picker.focused = true;
    this.mode = "thinkingPicker";
  }

  private openDeliveryPicker(entity: Entity): void {
    if (entity.kind !== "persistentAgent" && entity.kind !== "agentTemplate") return;
    const target = entity.value;
    const callback =
      entity.kind === "persistentAgent" ? this.onPersistentAgentDeliveryPolicy : this.onGlobalDeliveryPolicy;
    if (!callback || (entity.kind === "persistentAgent" && entity.status === "stopped")) return;
    this.pickerPersistentAgentName = target.name;
    this.picker = new FabricPersistentAgentDeliverySelector({
      theme: this.theme,
      currentValue: { delivery: target.delivery, triggerTurn: target.triggerTurn },
      headerText: `Delivery policy for ${entity.kind === "persistentAgent" ? "persistent agent" : "template"} "${target.name}". Active delivery requires an explicit resume choice.`,
      onSelect: (policy) => {
        callback(target.id, policy.delivery, policy.triggerTurn);
        this.closeModelPicker();
      },
      onCancel: () => this.closeModelPicker(),
    });
    this.picker.focused = true;
    this.mode = "deliveryPicker";
  }

  private openEventsPicker(entity: Entity): void {
    if (entity.kind !== "persistentAgent" || !this.onPersistentAgentEvents) return;
    const persistentAgent = entity.value;
    this.pickerPersistentAgentName = persistentAgent.name;
    this.picker = new FabricHostEventSelector({
      theme: this.theme,
      currentValue: persistentAgent.events,
      headerText: `Host events for persistent agent "${persistentAgent.name}". Toggle with space, Enter to apply, Esc to cancel.`,
      onSelect: (events) => {
        this.onPersistentAgentEvents!(persistentAgent.id, events);
        this.closeModelPicker();
      },
      onCancel: () => this.closeModelPicker(),
    });
    this.picker.focused = true;
    this.mode = "eventsPicker";
  }

  private openToolsPicker(entity: Entity): void {
    if (entity.kind !== "persistentAgent" || !this.onPersistentAgentTools) return;
    const persistentAgent = entity.value;
    this.pickerPersistentAgentName = persistentAgent.name;
    this.picker = new FabricPersistentAgentToolSelector({
      theme: this.theme,
      currentValue: persistentAgent.tools ?? this.persistentAgentDefaultTools,
      headerText: `Tools for persistent agent "${persistentAgent.name}". Toggle with space, Enter to apply, Esc to cancel. Pi persistent agents always retain fabric_exec.`,
      onSelect: (tools) => {
        this.onPersistentAgentTools!(persistentAgent.id, tools);
        this.closeModelPicker();
      },
      onCancel: () => this.closeModelPicker(),
    });
    this.picker.focused = true;
    this.mode = "toolsPicker";
  }

  private closeModelPicker(): void {
    this.picker = undefined;
    this.pickerPersistentAgentName = undefined;
    this.mode = "detail";
  }

  /**
   * Open the embedded multi-line editor for an persistentAgent's default instruction.
   * Matches Pi's editor dialog convention (Enter submit, Shift+Enter newline,
   * Esc/Ctrl+C cancel) so a steering user edits the persona with the same
   * muscle memory as the chat input. Works for both live project persistentAgents and
   * global templates; the submit routes to the scope-appropriate callback.
   */
  private openInstructionsEditor(entity: Entity): void {
    let kind: "persistentAgent" | "agentTemplate";
    let id: string;
    let name: string;
    let instructions: string;
    if (entity.kind === "persistentAgent") {
      if (entity.status === "stopped" || !this.onPersistentAgentInstructions) return;
      kind = "persistentAgent";
      id = entity.value.id;
      name = entity.value.name;
      instructions = entity.value.instructions;
    } else if (entity.kind === "agentTemplate") {
      if (!this.onGlobalInstructions) return;
      kind = "agentTemplate";
      id = entity.value.id;
      name = entity.value.name;
      instructions = entity.value.instructions;
    } else {
      return;
    }
    const editor = new Editor(this.tui, editorTheme(this.theme));
    editor.focused = true;
    editor.setText(instructions);
    editor.onSubmit = (text) => {
      if (kind === "persistentAgent") this.onPersistentAgentInstructions?.(id, text);
      else this.onGlobalInstructions?.(id, text);
      this.closeInstructionsEditor();
    };
    this.editor = editor;
    this.editorPersistentAgentName = name;
    this.mode = "instructionsEditor";
  }

  private closeInstructionsEditor(): void {
    this.editor = undefined;
    this.editorPersistentAgentName = undefined;
    this.mode = "detail";
  }

  private renderPicker(width: number): string[] {
    if (!this.picker) return [];
    if (width < 24) return this.renderNarrowFallback(width, `persistent agent · ${this.pickerPersistentAgentName ?? ""}`, "esc cancel");
    const kind =
      this.mode === "thinkingPicker"
        ? "thinking"
        : this.mode === "deliveryPicker"
          ? "delivery"
          : this.mode === "eventsPicker"
            ? "events"
            : this.mode === "toolsPicker"
              ? "tools"
              : "model";
    const lines = [
      this.topBorder(width, `persistent agent · ${this.pickerPersistentAgentName ?? ""} · ${kind}`),
    ];
    const inner = this.picker.render(width - 2);
    for (const line of inner) lines.push(this.row(width, line));
    lines.push(this.middleBorder(width));
    const filterHint =
      this.mode === "thinkingPicker" ||
      this.mode === "deliveryPicker" ||
      this.mode === "eventsPicker" ||
      this.mode === "toolsPicker"
        ? ""
        : " · type to filter";
    lines.push(
      this.row(
        width,
        this.theme.fg("dim", `  Enter to select · Esc to cancel${filterHint}`),
      ),
    );
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private renderInstructionsEditor(width: number): string[] {
    if (!this.editor) return [];
    if (width < 24) return this.renderNarrowFallback(width, `instructions · ${this.editorPersistentAgentName ?? ""}`, "esc cancel");
    const innerWidth = width - 2;
    const lines = [this.topBorder(width, `instructions · ${this.editorPersistentAgentName ?? ""}`)];
    for (const line of this.editor.render(innerWidth)) {
      lines.push(this.row(width, line));
    }
    lines.push(this.middleBorder(width));
    lines.push(
      this.row(
        width,
        this.theme.fg("dim", "  enter submit · shift+enter newline · esc cancel"),
      ),
    );
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private projectMesh(snapshot: FabricDashboardSnapshot): FabricProjectMeshModel | undefined {
    if (this.overviewView !== "topology") return undefined;
    return buildProjectMeshTopology({
      main: snapshot.main,
      persistentAgents: snapshot.persistentAgents,
      agents: snapshot.agents,
      state: snapshot.state,
      events: snapshot.events,
      ...(snapshot.participants ? { participants: snapshot.participants } : {}),
      now: snapshot.now,
    });
  }

  private replayFrames(
    snapshot: FabricDashboardSnapshot,
    topology: FabricProjectMeshModel,
  ): Array<{ event: MeshEvent; route: FabricProjectMeshRoute }> {
    return snapshot.events.flatMap((event) => {
      const route = topology.routes.find(
        (candidate) =>
          candidate.topic === event.topic &&
          candidate.kind === event.kind &&
          (candidate.fromId === event.from.id || candidate.fromName === event.from.name),
      );
      return route ? [{ event, route }] : [];
    });
  }

  private startGraphEffectsAnimation(): void {
    if (this.graphEffectsAnimation) return;
    this.graphReplayAdvancedAt = Date.now();
    this.graphEffectsAnimation = setInterval(() => {
      const now = Date.now();
      if (
        this.graphReplayPlaying &&
        this.graphReplayIndex !== undefined &&
        this.graphReplayLength > 0 &&
        now - this.graphReplayAdvancedAt >= 850 / this.graphReplaySpeed
      ) {
        if (this.graphReplayIndex < this.graphReplayLength - 1) {
          this.graphReplayIndex++;
          this.graphReplayAdvancedAt = now;
        } else {
          this.graphReplayPlaying = false;
        }
      }
      this.tui.requestRender();
    }, 80);
    this.graphEffectsAnimation.unref?.();
  }

  private stopGraphEffectsAnimation(): void {
    if (this.graphEffectsAnimation) clearInterval(this.graphEffectsAnimation);
    this.graphEffectsAnimation = undefined;
    this.graphReplayPlaying = false;
  }

  private toggleGraphReplay(snapshot: FabricDashboardSnapshot, topology?: FabricProjectMeshModel): void {
    const model = topology ?? this.projectMesh(snapshot);
    const frames = model ? this.replayFrames(snapshot, model) : [];
    this.graphReplayLength = frames.length;
    if (frames.length === 0) return;
    if (this.graphReplayIndex === undefined) {
      this.graphReplayIndex = 0;
      this.graphReplayPlaying = true;
    } else {
      this.graphReplayIndex = undefined;
      this.graphReplayPlaying = false;
    }
    this.graphReplayAdvancedAt = Date.now();
  }

  private stepGraphReplay(delta: number): void {
    if (this.graphReplayIndex === undefined || this.graphReplayLength === 0) return;
    this.graphReplayIndex = Math.max(
      0,
      Math.min(this.graphReplayLength - 1, this.graphReplayIndex + delta),
    );
    this.graphReplayPlaying = false;
    this.graphReplayAdvancedAt = Date.now();
  }

  private setGraphCameraTarget(point: FabricGraphPoint): void {
    if (!this.graphCameraInitialized) {
      this.graphCamera = { ...point };
      this.graphCameraTarget = { ...point };
      this.graphCameraInitialized = true;
      return;
    }
    if (this.graphCameraTarget.x === point.x && this.graphCameraTarget.y === point.y) return;
    this.graphCameraTarget = { ...point };
    this.graphAnimationAt = Date.now();
    if (this.graphAnimation) return;
    this.graphAnimation = setInterval(() => this.stepGraphCamera(), 16);
    this.graphAnimation.unref?.();
  }

  private stopGraphAnimation(): void {
    if (this.graphAnimation) clearInterval(this.graphAnimation);
    this.graphAnimation = undefined;
    this.graphAnimationAt = 0;
    this.graphVelocity = { x: 0, y: 0 };
    this.graphCameraTarget = { ...this.graphCamera };
  }

  private stepGraphCamera(): void {
    const now = Date.now();
    const elapsed = this.graphAnimationAt > 0 ? (now - this.graphAnimationAt) / 1_000 : 0.016;
    const dt = Math.max(0.008, Math.min(0.032, elapsed));
    this.graphAnimationAt = now;
    const stiffness = 115;
    const damping = 19;
    const stepAxis = (position: number, target: number, velocity: number): [number, number] => {
      const acceleration = stiffness * (target - position) - damping * velocity;
      const nextVelocity = velocity + acceleration * dt;
      return [position + nextVelocity * dt, nextVelocity];
    };
    [this.graphCamera.x, this.graphVelocity.x] = stepAxis(
      this.graphCamera.x,
      this.graphCameraTarget.x,
      this.graphVelocity.x,
    );
    [this.graphCamera.y, this.graphVelocity.y] = stepAxis(
      this.graphCamera.y,
      this.graphCameraTarget.y,
      this.graphVelocity.y,
    );
    const distance = Math.hypot(
      this.graphCameraTarget.x - this.graphCamera.x,
      this.graphCameraTarget.y - this.graphCamera.y,
    );
    const speed = Math.hypot(this.graphVelocity.x, this.graphVelocity.y);
    if (distance < 0.025 && speed < 0.025) {
      this.graphCamera = { ...this.graphCameraTarget };
      this.graphVelocity = { x: 0, y: 0 };
      if (this.graphAnimation) clearInterval(this.graphAnimation);
      this.graphAnimation = undefined;
    }
    this.tui.requestRender();
  }

  private renderOverview(
    width: number,
    snapshot: FabricDashboardSnapshot,
    run: FabricActivityRun | undefined,
    panels: PhasePanel[],
    entities: Entity[],
    allEntities: Entity[],
    meshModel?: FabricProjectMeshModel,
  ): string[] {
    if (width < 24) {
      return [truncateToWidth("too narrow · need 24 cols", width)];
    }
    const innerWidth = width - 2;
    const terminalRows = Math.max(
      1,
      this.tui.terminal?.rows ?? process.stdout.rows ?? 28,
    );
    const overlayRows = dashboardOverlayRows(terminalRows);
    const lines: string[] = [];
    const title =
      this.overviewView === "activity"
        ? `Fabric · ${run?.name ?? "session"} · Activity`
        : "Fabric · Topology";
    lines.push(this.topBorder(width, title));

    const runAgents = run
      ? snapshot.agents.filter((agent) => agent.runId === run.id)
      : snapshot.agents;
    const activeAgents = runAgents.filter((agent) => isActiveStatus(agent.status)).length;
    const hasDetachedWork = activeAgents > 0;
    const runTokens = tokensFor(snapshot, run);
    const largeRun = runAgents.length > 25 || runTokens > 1_500_000;
    const elapsed = run
      ? formatDuration(((hasDetachedWork ? snapshot.now : run.finishedAt) ?? snapshot.now) - run.startedAt)
      : undefined;
    const activePersistentAgents = snapshot.persistentAgents.filter((persistentAgent) => isActiveStatus(persistentAgent.status)).length;
    const summary = (
      meshModel
        ? [
            run?.name ? `focus ${run.name}` : undefined,
            run?.currentPhaseId
              ? `current ${run.phases.find((phase) => phase.id === run.currentPhaseId)?.name ?? run.currentPhaseId}`
              : undefined,
            `Participants ${snapshot.agents.filter((agent) => isActiveStatus(agent.status)).length}/${snapshot.agents.length} one-shot · ${activePersistentAgents}/${snapshot.persistentAgents.length} persistent · ${meshModel.participants.length} remote`,
            `Mesh ${meshModel.topics.length} topics · ${snapshot.state.length} state`,
            this.graphReplayIndex !== undefined
              ? `${this.graphReplayPlaying ? "▶" : "Ⅱ"} replay ${this.graphReplayIndex + 1}/${Math.max(1, this.graphReplayLength)} · ${this.graphReplaySpeed}×`
              : undefined,
            snapshot.runs.length > 1 ? `run ${this.runIndex + 1}/${snapshot.runs.length}` : undefined,
          ]
        : [
            this.overviewView === "topology" ? run?.name : undefined,
            run?.status,
            largeRun ? "⚠ large run" : undefined,
            `${activeAgents}/${runAgents.length} run agents active`,
            `${snapshot.persistentAgents.length} persistent`,
            snapshot.observability
              ? [
                  `health ${snapshot.observability.outcomes.verified}/${snapshot.observability.outcomes.records} verified`,
                  `${snapshot.observability.persistentAgentBudgets.rejectedActivations} quota rejects`,
                  `${snapshot.observability.contextQos.retiredResults} retired`,
                  snapshot.observability.pathLeases > 0
                    ? `${snapshot.observability.pathLeases} write lease${snapshot.observability.pathLeases === 1 ? "" : "s"}`
                    : undefined,
                ].filter(Boolean).join(" · ")
              : undefined,
            runTokens > 0 ? `${formatTokens(runTokens)} tok` : undefined,
            elapsed,
            snapshot.runs.length > 1
              ? `run ${this.runIndex + 1}/${snapshot.runs.length}`
              : undefined,
          ]
    )
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    const summaryText = safeText(summary);
    let headerLine = summaryText;
    if (
      run?.description &&
      this.overviewView === "activity"
    ) {
      const gap = "  ";
      const availableDescription = innerWidth - visibleWidth(summaryText) - gap.length;
      headerLine =
        availableDescription >= 12
          ? `${padToWidth(
              this.theme.fg("muted", safeText(run.description)),
              availableDescription,
            )}${gap}${this.theme.fg("dim", summaryText)}`
          : this.theme.fg("dim", summaryText);
    } else if (summaryText) {
      headerLine = this.theme.fg("dim", summaryText);
    }
    const minimumRows = 8;
    if (overlayRows < minimumRows) {
      return [
        title,
        summaryText || "No Fabric activity yet",
        "1 activity · 2 topology · arrows move · esc close",
      ]
        .slice(0, overlayRows)
        .map((line) => truncateToWidth(line, width, ""));
    }
    lines.push(this.row(width, headerLine || this.theme.fg("muted", "No Fabric activity yet")));
    lines.push(this.middleBorder(width));

    const desiredRunEvents = run?.events.slice(-2) ?? [];
    const desiredMeshEventCount = Math.max(0, 2 - desiredRunEvents.length);
    const desiredMeshEvents =
      desiredMeshEventCount > 0 ? snapshot.events.slice(-desiredMeshEventCount) : [];
    const optionalEventRoom = Math.max(0, overlayRows - minimumRows);
    const eventRows = optionalEventRoom >= 2 ? Math.min(2, optionalEventRoom - 1) : 0;
    const runEventRows = Math.min(desiredRunEvents.length, eventRows);
    const meshEventRows = Math.max(0, eventRows - runEventRows);
    const runEvents = runEventRows > 0 ? desiredRunEvents.slice(-runEventRows) : [];
    const meshEvents =
      meshEventRows > 0 ? desiredMeshEvents.slice(-meshEventRows) : [];
    const eventChromeRows = eventRows > 0 ? eventRows + 1 : 0;
    const maxBody = Math.max(
      1,
      Math.min(this.overviewView === "topology" ? 30 : 22, overlayRows - 7 - eventChromeRows),
    );
    if (this.overviewView === "topology") {
      const topology = meshModel ?? buildProjectMeshTopology({
        main: snapshot.main,
        persistentAgents: snapshot.persistentAgents,
        agents: snapshot.agents,
        state: snapshot.state,
        events: snapshot.events,
        ...(snapshot.participants ? { participants: snapshot.participants } : {}),
        now: snapshot.now,
      });
      this.startGraphEffectsAnimation();
      const replayFrames = this.replayFrames(snapshot, topology);
      this.graphReplayLength = replayFrames.length;
      if (this.graphReplayIndex !== undefined && replayFrames.length === 0) {
        this.graphReplayIndex = undefined;
        this.graphReplayPlaying = false;
      } else if (this.graphReplayIndex !== undefined) {
        this.graphReplayIndex = Math.min(this.graphReplayIndex, replayFrames.length - 1);
      }
      const replayFrame = this.graphReplayIndex === undefined
        ? undefined
        : replayFrames[this.graphReplayIndex];
      this.graphReplayLabel = replayFrame?.event.kind;
      const renderGraph = () => renderFabricTopologyPanel({
        theme: this.theme,
        filter: this.filter,
        selectedEntityId: this.selectedEntityId,
        snapshot,
        run,
        mesh: topology,
        allEntities,
        entities,
        width: innerWidth,
        height: maxBody,
        camera: this.graphCamera,
        invalidate: this.highlightInvalidate,
        animation: {
          now: Date.now(),
          reducedMotion: this.graphReducedMotion,
          showHistory: this.graphShowHistory,
          ...(replayFrame
            ? { replayRouteId: replayFrame.route.id, replayLabel: replayFrame.event.kind }
            : {}),
        },
      });
      const cameraWasInitialized = this.graphCameraInitialized;
      let rendered = renderGraph();
      this.graphPositions = rendered.positions;
      if (rendered.selectedPosition) this.setGraphCameraTarget(rendered.selectedPosition);
      if (!cameraWasInitialized && this.graphCameraInitialized) rendered = renderGraph();
      for (const line of rendered.lines) lines.push(this.row(width, line));
    } else if (innerWidth >= 88) {
      const leftWidth = Math.min(38, Math.max(28, Math.floor((innerWidth - 1) * 0.34)));
      const rightWidth = innerWidth - leftWidth - 1;
      const leftLines = this.renderPhasePanel(panels, leftWidth, maxBody);
      const rightLines = this.renderEntityPanel(entities, rightWidth, maxBody, snapshot.now);
      for (let index = 0; index < maxBody; index++) {
        const left = leftLines[index] ?? "";
        const right = rightLines[index] ?? "";
        lines.push(
          this.row(
            width,
            `${padToWidth(left, leftWidth)}${this.theme.fg("borderMuted", "│")}${padToWidth(
              right,
              rightWidth,
            )}`,
          ),
        );
      }
    } else {
      const panelRows = Math.max(2, maxBody - 1);
      const phaseHeight = Math.max(1, Math.min(panels.length + 1, Math.floor(panelRows * 0.45)));
      const entityHeight = Math.max(1, panelRows - phaseHeight);
      for (const line of this.renderPhasePanel(panels, innerWidth, phaseHeight)) {
        lines.push(this.row(width, line));
      }
      lines.push(this.row(width, this.theme.fg("borderMuted", "─".repeat(innerWidth))));
      for (const line of this.renderEntityPanel(entities, innerWidth, entityHeight, snapshot.now)) {
        lines.push(this.row(width, line));
      }
    }

    if (eventRows > 0) {
      lines.push(this.middleBorder(width));
      let renderedEventRows = 0;
      for (const event of runEvents) {
        lines.push(
          this.row(
            width,
            colorStatus(
              this.theme,
              event.level === "success" ? "completed" : event.level,
              `[${formatClock(event.createdAt)}] ${safeText(event.message)}`,
            ),
          ),
        );
        renderedEventRows++;
      }
      for (const event of meshEvents) {
        const target = event.to ? ` → ${event.to}` : "";
        const text = event.text ? ` · ${safeText(event.text)}` : "";
        lines.push(
          this.row(
            width,
            this.theme.fg(
              "dim",
              `[${formatClock(event.createdAt)}] ${event.topic} · ${event.from.name}${target}${text}`,
            ),
          ),
        );
        renderedEventRows++;
      }
      while (renderedEventRows < eventRows) {
        lines.push(this.row(width, ""));
        renderedEventRows++;
      }
    }

    lines.push(this.middleBorder(width));
    const navigationHint =
      this.overviewView === "topology"
        ? this.graphReplayIndex !== undefined
          ? `replay ${this.graphReplayIndex + 1}/${Math.max(1, this.graphReplayLength)}${this.graphReplayLabel ? ` · ${safeText(this.graphReplayLabel)}` : ""} · r live · space ${this.graphReplayPlaying ? "pause" : "play"} · ←/→ step · +/- speed:${this.graphReplaySpeed}× · H history · M motion:${this.graphReducedMotion ? "reduced" : "full"} · ? help`
          : `arrows/h/l move · j/k order · r replay · H history · M motion:${this.graphReducedMotion ? "reduced" : "full"} · f filter:${this.filter} · 1 activity · ? help`
        : `↑↓/jk select · ←→/tab pane · enter inspect · f filter:${this.filter} · 2 topology · [ older · ] newer · ? help`;
    lines.push(this.row(width, this.theme.fg("dim", navigationHint)));
    const selectedEntity = entities[this.entityIndex];
    const actionHint =
      this.pane === "entities" && selectedEntity
        ? this.theme.fg("muted", `  ${this.overviewActionHint(selectedEntity)}`)
        : "";
    lines.push(this.row(width, actionHint));
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private overviewActionHint(entity: Entity): string {
    if (entity.kind === "main") {
      const actions = [
        this.canMessage(entity, "steer") ? "s message/steer" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up" : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `Main actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "peer") {
      const actions = [
        this.canMessage(entity, "steer") ? "s steer" : undefined,
        this.canMessage(entity, "followUp") ? "u follow-up" : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `peer actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "persistentAgent" && entity.status !== "stopped") {
      const actions = [
        this.persistentAgentTranscript
          ? `space ${isActiveStatus(entity.status) ? "live " : ""}transcript peek`
          : undefined,
        this.canMessage(entity, "steer") ? "s queue message" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up" : undefined,
        this.modelSourceForPersistentAgent(entity.value) && this.onPersistentAgentModel ? "m model" : undefined,
        this.onPersistentAgentThinking ? "e thinking" : undefined,
        this.onPersistentAgentDeliveryPolicy ? "y delivery policy" : undefined,
        this.onPersistentAgentEvents ? "v events" : undefined,
        this.onPersistentAgentTools ? "o tools" : undefined,
        this.onPersistentAgentInstructions ? "i instructions" : undefined,
        this.onClearMessages ? "c clear mailbox" : undefined,
        this.onExportPersistentAgent ? "x export" : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `persistent agent actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "agentTemplate") {
      const actions = [
        this.onGlobalDeliveryPolicy ? "y delivery policy" : undefined,
        this.onGlobalInstructions ? "i instructions" : undefined,
        this.onImportPersistentAgent ? "p import" : undefined,
        this.onRemoveAgentTemplate ? "d delete" : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `template actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "agent") {
      const armed =
        this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > Date.now();
      const actions = [
        this.agentTranscript
          ? `space ${isActiveStatus(entity.status) ? "live " : ""}transcript peek`
          : undefined,
        this.canMessage(entity, "steer") ? "s steer" : undefined,
        this.canMessage(entity, "followUp") ? "u follow-up" : undefined,
        this.canStop(entity)
          ? armed
            ? "x again to stop"
            : "x stop"
          : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `agent actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "meshParticipant") {
      const actions = [
        this.canMessage(entity, "steer") ? "s steer" : undefined,
        this.canMessage(entity, "followUp") ? "u follow-up" : undefined,
        this.canStop(entity) ? "x twice to stop" : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `participant actions: ${actions.join(" · ")}`;
    }
    return "enter details";
  }

  private renderPhasePanel(panels: PhasePanel[], width: number, height: number): string[] {
    const lines = [
      truncateToWidth(
        `${this.pane === "phases" ? this.theme.fg("accent", "▸ ") : "  "}${this.theme.fg(
          "accent",
          "Activity",
        )}`,
        width,
      ),
    ];
    const available = Math.max(0, height - 1);
    const start = Math.max(
      0,
      Math.min(this.phaseIndex - Math.floor(available / 2), Math.max(0, panels.length - available)),
    );
    for (let index = start; index < Math.min(panels.length, start + available); index++) {
      const panel = panels[index];
      if (!panel) continue;
      const selected = index === this.phaseIndex;
      const prefix = selected ? "› " : "  ";
      const count = panel.total > 0 ? `${panel.completed}/${panel.total}` : "";
      const raw = `${prefix}${colorStatus(this.theme, panel.status, statusGlyph(panel.status))} ${safeText(
        panel.name,
      )}`;
      const countWidth = visibleWidth(count);
      const contentWidth = Math.max(0, width - countWidth - (count ? 1 : 0));
      let line = `${padToWidth(raw, contentWidth)}${count ? ` ${this.theme.fg("dim", count)}` : ""}`;
      if (selected && this.pane === "phases") {
        line = this.theme.bg("selectedBg", padToWidth(line, width));
      }
      lines.push(truncateToWidth(line, width, ""));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderEntityPanel(
    entities: Entity[],
    width: number,
    height: number,
    now: number,
  ): string[] {
    const lines: string[] = [];
    const available = Math.max(0, height);
    const groupedRows: Array<
      | { type: "group"; group: EntityGroup }
      | { type: "spacer" }
      | { type: "entity"; entity: Entity; entityIndex: number }
    > = [];
    const groups = groupEntities(entities);
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex]!;
      if (groupIndex > 0) groupedRows.push({ type: "spacer" });
      groupedRows.push({ type: "group", group });
      for (const entry of group.entries) {
        groupedRows.push({ type: "entity", entity: entry.entity, entityIndex: entry.index });
      }
    }
    const selectedRow = Math.max(
      0,
      groupedRows.findIndex(
        (row) => row.type === "entity" && row.entityIndex === this.entityIndex,
      ),
    );
    const start = Math.max(
      0,
      Math.min(
        selectedRow - Math.floor(available / 2),
        Math.max(0, groupedRows.length - available),
      ),
    );
    for (let index = start; index < Math.min(groupedRows.length, start + available); index++) {
      const row = groupedRows[index];
      if (!row) continue;
      if (row.type === "spacer") {
        lines.push("");
        continue;
      }
      if (row.type === "group") {
        lines.push(
          truncateToWidth(
            this.theme.fg(
              "muted",
              `  ${this.theme.bold(row.group.label)} (${row.group.entries.length})`,
            ),
            width,
            "",
          ),
        );
        continue;
      }
      const entity = row.entity;
      const selected = row.entityIndex === this.entityIndex;
      const prefix = selected ? "› " : "  ";
      const lead = `${prefix}${colorStatus(this.theme, entity.status, statusGlyph(entity.status))} ${safeText(
        entity.label,
      )}`;
      const tail = safeText(entityTail(entity, now));
      let line = tail ? `${lead}  ${this.theme.fg("dim", tail)}` : lead;
      if (selected && this.pane === "entities") {
        line = this.theme.bg("selectedBg", padToWidth(line, width));
      }
      lines.push(truncateToWidth(line, width, ""));
    }
    if (entities.length === 0 && available > 0) {
      const label = this.filter === "all" ? "activity" : `${this.filter} activity`;
      lines.push(this.theme.fg("dim", `  (no ${label}; press f to change filter)`));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderDetail(
    width: number,
    snapshot: FabricDashboardSnapshot,
    entity: Entity,
  ): string[] {
    if (width < 24) return this.renderNarrowDetail(width, snapshot, entity);
    const innerWidth = width - 2;
    const transcriptView =
      (entity.kind === "agent" || entity.kind === "persistentAgent") && this.detailView === "transcript";
    const actionLines = wrapPlainText(this.detailActionHint(entity), Math.max(1, innerWidth - 2), 3);
    const viewLabel = transcriptView
      ? ` · transcript · ${isActiveStatus(entity.status) ? "live" : entity.status}`
      : "";
    const kindLabel =
      entity.kind === "main"
        ? "main agent"
        : entity.kind === "peer"
          ? "peer session"
          : entity.kind === "meshParticipant"
            ? "project participant"
            : entity.kind === "meshTopic"
              ? "topic"
              : entity.kind === "meshRoute"
                ? "route"
                : entity.kind === "persistentAgent"
            ? "persistent agent"
            : entity.kind;
    const lines = [this.topBorder(width, `${kindLabel} · ${entity.label}${viewLabel}`)];
    const content = transcriptView
      ? this.transcriptLines(entity, innerWidth)
      : this.detailLines(entity, innerWidth, snapshot.now, snapshot.main.cwd ?? process.cwd());
    const terminalRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 28;
    const maxBody = Math.max(1, Math.min(24, terminalRows - 8 - actionLines.length));
    const maxScroll = Math.max(0, content.length - maxBody);
    this.detailMaxScroll = maxScroll;
    if (transcriptView && this.transcriptFollowing) {
      this.detailScroll = maxScroll;
    } else if (transcriptView && this.transcriptPageAnchor) {
      this.detailScroll = this.transcriptPageAnchor === "end" ? maxScroll : 0;
      this.transcriptPageAnchor = undefined;
    } else {
      this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));
    }
    const visible = content.slice(this.detailScroll, this.detailScroll + maxBody);
    for (const line of visible) lines.push(this.row(width, line));
    while (lines.length < maxBody + 1) lines.push(this.row(width, ""));
    lines.push(this.middleBorder(width));
    const range =
      content.length > maxBody
        ? ` · ${this.detailScroll + 1}-${Math.min(content.length, this.detailScroll + maxBody)}/${content.length}`
        : "";
    const navigation = transcriptView
      ? `↑↓/jk lazy scroll · ${this.transcriptToolToggleHint()} · g page top · G follow:${this.transcriptFollowing ? "on" : "off"}/live tail · t summary · esc back${range}`
      : `↑↓/jk scroll · ${this.hasTranscript(entity) ? "t transcript · " : ""}esc back${range}`;
    lines.push(this.row(width, this.theme.fg("dim", navigation)));
    for (const actionLine of actionLines) {
      lines.push(this.row(width, this.theme.fg("muted", `  ${actionLine}`)));
    }
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private transcriptLines(entity: Entity, width: number): string[] {
    const transcript = this.transcriptFor(entity);
    const transcriptCwd =
      entity.kind === "agent"
        ? entity.value.cwd
        : entity.kind === "persistentAgent"
          ? entity.value.worker?.cwd
          : undefined;
    if (!transcript || transcript.entries.length === 0) {
      return [
        this.theme.fg(
          "dim",
          isActiveStatus(entity.status)
            ? "Waiting for streamed agent activity…"
            : "No retained transcript is available for this one-shot or persistent Agent.",
        ),
      ];
    }
    const lines: string[] = [];
    if (transcript.hasMore ?? transcript.truncated) {
      lines.push(this.theme.fg("dim", "↑ older activity available · scroll past the top to load"));
    }
    let firstTool = true;
    for (const entry of transcript.entries) {
      if (entry.kind === "tool") {
        if (this.transcriptToolsExpanded && !firstTool) lines.push("");
        firstTool = false;
        lines.push(...this.transcriptToolLines(entry, width, transcriptCwd));
        continue;
      }
      const glyph =
        entry.kind === "assistant"
          ? this.theme.fg("accent", "◆")
          : entry.kind === "user"
            ? this.theme.fg("muted", "›")
            : entry.kind === "error"
              ? this.theme.fg("error", "✗")
              : colorStatus(
                  this.theme,
                  entry.status ?? "completed",
                  statusGlyph(entry.status ?? "completed"),
                );
      lines.push(
        truncateToWidth(
          `${glyph} ${this.theme.fg(
            entry.kind === "assistant" ? "accent" : "muted",
            safeText(entry.label),
          )}`,
          width,
          "",
        ),
      );
      if (!entry.text) continue;
      if (entry.kind === "assistant" || entry.kind === "user") {
        lines.push(
          ...this.markdownTranscriptLines(
            this.transcriptTarget(entity)?.id ?? entity.id,
            entry.id,
            entry.text,
            width,
          ),
        );
        continue;
      }
      for (const paragraph of entry.text.split("\n")) {
        const wrapped = wrapPlainText(paragraph, Math.max(1, width - 2), 10_000);
        for (const line of wrapped) lines.push(truncateToWidth(`  ${line}`, width, ""));
      }
    }
    if (transcript.hasNewer) {
      lines.push(this.theme.fg("dim", "↓ newer activity available · scroll past the bottom to load"));
    }
    return lines;
  }

  private transcriptToolLines(
    entry: FabricTranscriptEntry,
    width: number,
    transcriptCwd?: string,
  ): string[] {
    const depth = Math.max(0, entry.depth ?? 0);
    const padding = "  ".repeat(depth);
    const bodyPadding = `${padding}  `;
    const glyph = colorStatus(
      this.theme,
      entry.status ?? "completed",
      statusGlyph(entry.status ?? "completed"),
    );
    const status =
      entry.status === "running" ? " · running" : entry.status === "failed" ? " · failed" : "";
    const audit = this.transcriptToolAudit(entry);
    const context = this.codePreviewSettings
      ? {
          cwd: transcriptCwd ?? this.snapshot().main.cwd ?? process.cwd(),
          settings: this.codePreviewSettings,
          invalidate: this.highlightInvalidate,
        }
      : undefined;
    const title = context ? coreToolTitle(audit, this.theme, context) : null;
    const headline = title ?? this.theme.fg("toolTitle", this.theme.bold(entry.toolName ?? entry.label));
    const collapsedSummary =
      !this.transcriptToolsExpanded && entry.text
        ? ` · ${safeText(entry.text).replace(/\s+/g, " ").trim()}`
        : "";
    const lines = [
      truncateToWidth(
        `${padding}${glyph} ${headline}${this.theme.fg("dim", `${status}${collapsedSummary}`)}`,
        width,
        "",
      ),
    ];
    if (!this.transcriptToolsExpanded) return lines;

    const rendered = context
      ? renderCoreToolBody(audit, this.theme, {
          ...context,
          expanded: true,
          maxLines: TRANSCRIPT_EXPANDED_TOOL_LINES,
        })
      : null;
    if (rendered) {
      for (const row of renderBoundedLines(
        rendered.lines,
        this.theme,
        this.codePreviewSettings?.diffIntensity ?? "off",
      ).render(Math.max(1, width - visibleWidth(bodyPadding)))) {
        lines.push(truncateToWidth(`${bodyPadding}${row}`, width, ""));
      }
      if (rendered.hidden > 0) {
        lines.push(this.theme.fg("dim", `${bodyPadding}… ${rendered.hidden} more lines`));
      }
      return lines;
    }
    if (entry.args && Object.keys(entry.args).length > 0) {
      lines.push(...this.transcriptStructuredLines("input", entry.args, width, bodyPadding));
    } else if (entry.text) {
      for (const row of wrapPlainText(
        entry.text,
        Math.max(1, width - visibleWidth(bodyPadding)),
        10_000,
      )) {
        lines.push(truncateToWidth(`${bodyPadding}${row}`, width, ""));
      }
    }
    if (entry.result !== undefined) {
      lines.push(...this.transcriptStructuredLines("result", entry.result, width, bodyPadding));
    }
    return lines;
  }

  private transcriptToolAudit(entry: FabricTranscriptEntry): {
    ref: string;
    provider: string;
    tool: string;
    args?: Record<string, unknown>;
    result?: unknown;
    success?: boolean;
  } {
    const rawName = entry.toolName ?? entry.label;
    const normalizedName = rawName.toLowerCase();
    const tool =
      normalizedName === "glob"
        ? "find"
        : ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(normalizedName)
          ? normalizedName
          : rawName;
    const rawArgs = entry.args ?? {};
    const args: Record<string, unknown> = { ...rawArgs };
    if (typeof rawArgs.file_path === "string" && typeof args.path !== "string") {
      args.path = rawArgs.file_path;
    }
    if (tool === "edit" && !Array.isArray(args.edits)) {
      const oldText = typeof rawArgs.old_string === "string" ? rawArgs.old_string : undefined;
      const newText = typeof rawArgs.new_string === "string" ? rawArgs.new_string : undefined;
      if (oldText !== undefined && newText !== undefined) args.edits = [{ oldText, newText }];
    }
    return {
      ref: typeof tool === "string" ? `pi.${tool}` : `tool.${rawName}`,
      provider: "pi",
      tool,
      ...(Object.keys(args).length > 0 ? { args } : {}),
      ...(entry.result !== undefined ? { result: entry.result } : {}),
      ...(entry.status !== "running" ? { success: entry.status !== "failed" } : {}),
    };
  }

  private transcriptStructuredLines(
    label: string,
    value: unknown,
    width: number,
    padding: string,
  ): string[] {
    const yaml = formatJsonAsYaml(value) ?? safeText(value);
    if (!yaml) return [];
    const yamlLines = yaml.split("\n");
    const shownYamlLines = yamlLines.slice(0, TRANSCRIPT_STRUCTURED_LINES);
    const highlighted =
      highlightCode(shownYamlLines.join("\n"), "yaml", this.highlightInvalidate) ??
      shownYamlLines.map((line) => this.theme.fg("mdCodeBlock", line || " "));
    const lines = [truncateToWidth(`${padding}${this.theme.fg("dim", `${label}:`)}`, width, "")];
    const nestedPadding = `${padding}  `;
    for (const row of highlighted) {
      for (const wrapped of wrapTextWithAnsi(row, Math.max(1, width - visibleWidth(nestedPadding)))) {
        lines.push(truncateToWidth(`${nestedPadding}${wrapped}`, width, ""));
        if (lines.length > TRANSCRIPT_STRUCTURED_LINES) break;
      }
      if (lines.length > TRANSCRIPT_STRUCTURED_LINES) break;
    }
    const hiddenLines = Math.max(0, yamlLines.length - shownYamlLines.length);
    if (hiddenLines > 0) {
      lines.push(this.theme.fg("dim", `${nestedPadding}… ${hiddenLines} more lines`));
    }
    return lines;
  }

  private markdownTranscriptLines(
    agentId: string,
    entryId: string,
    text: string,
    width: number,
  ): string[] {
    return this.markdownLines(`transcript:${agentId}:${entryId}`, text, width);
  }

  private markdownLines(key: string, text: string, width: number, indent = 2): string[] {
    const markdown = safeMarkdownText(text);
    if (!markdown.trim()) return [];
    let cached = this.transcriptMarkdown.get(key);
    if (!cached || cached.text !== markdown) {
      cached = {
        text: markdown,
        component: new Markdown(
          markdown,
          0,
          0,
          transcriptMarkdownTheme(this.theme, () => {
            this.transcriptMarkdown.delete(key);
            this.tui.requestRender();
          }),
        ),
      };
      this.transcriptMarkdown.delete(key);
      this.transcriptMarkdown.set(key, cached);
      while (this.transcriptMarkdown.size > 128) {
        const oldest = this.transcriptMarkdown.keys().next().value as string | undefined;
        if (!oldest) break;
        this.transcriptMarkdown.delete(oldest);
      }
    }
    const padding = " ".repeat(Math.max(0, indent));
    return cached.component
      .render(Math.max(1, width - visibleWidth(padding)))
      .map((line) => truncateToWidth(`${padding}${line}`, width, ""));
  }

  private detailActionHint(entity: Entity): string {
    if (entity.kind === "main") {
      const actions = [
        this.canMessage(entity, "steer") ? "s message/steer now" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up" : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0
        ? `Main Pi agent actions: ${actions.join(" · ")}`
        : "Main Pi agent controls are unavailable in this session.";
    }
    if (entity.kind === "peer") {
      const actions = [
        this.canMessage(entity, "steer") ? "s steer over mesh" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up over mesh" : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0
        ? `Peer session actions: ${actions.join(" · ")}`
        : "Peer session is read-only.";
    }
    if (entity.kind === "agent") {
      const armed =
        this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > Date.now();
      const actions = [
        this.canMessage(entity, "steer") ? "s steer now" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up" : undefined,
        this.canStop(entity)
          ? armed
            ? "x again to confirm stop"
            : "x stop"
          : undefined,
      ].filter((value): value is string => Boolean(value));
      const controls =
        actions.length > 0
          ? `One-shot agent actions: ${actions.join(" · ")}. `
          : "One-shot agent. ";
      return `${controls}Model and thinking are fixed at spawn; use a persistent agent for editable runtime settings.`;
    }
    if (entity.kind === "persistentAgent" && entity.status !== "stopped") {
      const actions = [
        this.canMessage(entity, "steer") ? "s queue message" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up" : undefined,
        this.modelSourceForPersistentAgent(entity.value) && this.onPersistentAgentModel ? "m model" : undefined,
        this.onPersistentAgentThinking ? "e thinking" : undefined,
        this.onPersistentAgentDeliveryPolicy ? "y delivery policy" : undefined,
        this.onPersistentAgentEvents ? "v events" : undefined,
        this.onPersistentAgentTools ? "o tools" : undefined,
        this.onClearMessages ? "c clear mailbox" : undefined,
        this.onPersistentAgentInstructions ? "i instructions" : undefined,
        this.onExportPersistentAgent ? "x export→global" : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0
        ? `Persistent agent actions: ${actions.join(" · ")}`
        : "Persistent agent settings are read-only in this session.";
    }
    if (entity.kind === "meshParticipant") {
      const actions = [
        this.canMessage(entity, "steer") ? "s steer over mesh" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up over mesh" : undefined,
        this.canStop(entity) ? "x twice to stop" : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0
        ? `Remote participant actions: ${actions.join(" · ")}`
        : "Remote participant is read-only.";
    }
    if (entity.kind === "agentTemplate") {
      const actions = [
        this.onGlobalDeliveryPolicy ? "y delivery policy" : undefined,
        this.onGlobalInstructions ? "i instructions" : undefined,
        this.onImportPersistentAgent ? "p import" : undefined,
        this.onRemoveAgentTemplate ? "d delete" : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0
        ? `Template actions: ${actions.join(" · ")}`
        : "Global template is read-only in this session.";
    }
    return "Read-only detail.";
  }

  private detailLines(entity: Entity, width: number, now: number, cwd: string): string[] {
    const lines: string[] = [];
    const field = (label: string, value: unknown): void => {
      const text = safeText(value);
      if (!text) return;
      const prefix = `${this.theme.fg("dim", `${label}:`)} `;
      const wrapped = wrapPlainText(text, Math.max(1, width - visibleWidth(prefix)), 12);
      if (wrapped[0]) lines.push(truncateToWidth(prefix + wrapped[0], width));
      for (const continuation of wrapped.slice(1)) {
        lines.push(truncateToWidth(" ".repeat(visibleWidth(prefix)) + continuation, width));
      }
    };
    const markdownField = (label: string, value: string | undefined, key: string): void => {
      if (!value?.trim()) return;
      lines.push(this.theme.fg("dim", `${label}:`));
      lines.push(...this.markdownLines(`detail:${entity.id}:${key}`, value, width));
    };
    const structuredField = (label: string, value: unknown): void => {
      if (value === undefined) return;
      const yaml = formatJsonAsYaml(value);
      if (yaml === undefined) {
        field(label, value);
        return;
      }
      lines.push(this.theme.fg("dim", `${label}:`));
      const highlighted =
        highlightCode(yaml, "yaml", this.highlightInvalidate) ??
        yaml.split("\n").map((line) => this.theme.fg("mdCodeBlock", line || " "));
      for (const highlightedLine of highlighted) {
        for (const wrapped of wrapTextWithAnsi(highlightedLine, Math.max(1, width - 2))) {
          lines.push(truncateToWidth(`  ${wrapped}`, width, ""));
        }
      }
    };
    const stringOutputField = (label: string, value: unknown): void => {
      if (typeof value !== "string") return;
      markdownField(label, value, label.toLowerCase());
    };
    const objectOutputField = (label: string, value: Record<string, unknown>): void => {
      if (typeof value.output === "string" || typeof value.text === "string" || typeof value.content === "string") {
        stringOutputField(label, value.output ?? value.text ?? value.content);
        return;
      }
      structuredField(label, value);
    };
    const outputField = (label: string, value: unknown): void => {
      if (value === undefined) return;
      if (typeof value === "string") {
        stringOutputField(label, value);
        return;
      }
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        objectOutputField(label, value as Record<string, unknown>);
        return;
      }
      structuredField(label, value);
    };
    const coreCallPreview = (call: FabricActivityCall): boolean => {
      const settings = this.codePreviewSettings;
      const tool = call.ref.startsWith("pi.") ? call.ref.slice(3) : "";
      if (!settings || !["bash", "read", "write", "edit", "grep", "find", "ls"].includes(tool)) {
        return false;
      }
      const success = call.status === "completed"
        ? true
        : call.status === "failed"
          ? false
          : undefined;
      const audit = {
        ref: call.ref,
        provider: "pi",
        tool,
        ...(call.args !== undefined ? { args: call.args } : {}),
        ...(call.result !== undefined ? { result: call.result } : {}),
        ...(call.preview !== undefined ? { preview: call.preview } : {}),
        ...(success !== undefined ? { success } : {}),
        startedAt: call.startedAt,
        ...(call.finishedAt !== undefined ? { endedAt: call.finishedAt } : {}),
      };
      const context = {
        cwd: this.snapshot().main.cwd ?? process.cwd(),
        settings,
        invalidate: this.highlightInvalidate,
      };
      const title = coreToolTitle(audit, this.theme, context);
      const rendered = renderCoreToolBody(audit, this.theme, {
        ...context,
        expanded: true,
        maxLines: 200,
      });
      if (!rendered) return false;
      lines.push(this.theme.fg("dim", "Preview:"));
      const body = renderBoundedLines(
        [...(title ? [title] : []), ...rendered.lines],
        this.theme,
        settings.diffIntensity,
      ).render(Math.max(1, width - 2));
      for (const row of body) lines.push(truncateToWidth(`  ${row}`, width, ""));
      if (rendered.hidden > 0) {
        lines.push(this.theme.fg("muted", `  … ${rendered.hidden} more lines`));
      }
      return true;
    };
    const argumentField = (call: FabricActivityCall): void => {
      const args = call.args;
      if (!args || Object.keys(args).length === 0) return;
      const stringValue = (key: string): string | undefined =>
        typeof args[key] === "string" ? args[key] : undefined;
      if (call.ref === "pi.bash") {
        const command = stringValue("command");
        if (command) markdownField("Command", "```bash\n" + command + "\n```", "command");
      }
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (call.ref === "pi.edit" && edits.length > 0) {
        lines.push(this.theme.fg("dim", "Edits:"));
        const diff = nestedEditDiff(
          {
            ref: call.ref,
            tool: call.ref.split(".")[1] ?? call.ref,
            args,
          },
          this.theme,
          this.highlightInvalidate,
        );
        if (diff) {
          for (const line of diff) lines.push(truncateToWidth(`  ${line}`, width, ""));
        } else {
          structuredField("Edits", edits);
        }
      }
      const content = stringValue("content");
      if (call.ref === "pi.write" && content !== undefined) {
        const path = stringValue("path") ?? "";
        const extension = path.includes(".") ? path.split(".").at(-1) : "";
        markdownField("Content", "```" + (extension || "text") + "\n" + content + "\n```", "content");
      }
      const renderedKeys = new Set(["command", "edits", "content"]);
      const remaining = Object.fromEntries(
        Object.entries(args).filter(([key]) => !renderedKeys.has(key)),
      );
      if (Object.keys(remaining).length > 0) structuredField("Input", remaining);
    };
    field("Status", entity.status);

    if (entity.kind === "main") {
      const main = entity.value;
      field("ID", main.id);
      field("Scope", "user-facing Pi session");
      field("Model", main.model);
      field("Thinking", main.thinking);
      field("Transport", main.transport);
      field("Session", main.sessionId);
      field("Working directory", main.cwd);
      field("Pending messages", main.pendingMessages ? "yes" : "no");
      field("Local owner", main.local ? "yes" : "no");
      field(
        "Elapsed",
        main.startedAt ? formatDuration(Math.max(0, now - main.startedAt)) : undefined,
      );
    } else if (entity.kind === "peer") {
      const peer = entity.value;
      field("ID", peer.id);
      field("Scope", "concurrent root Pi session");
      field("Model", peer.model);
      field("Thinking", peer.thinking);
      field("Transport", peer.transport);
      field("Session", peer.sessionId);
      field("Working directory", peer.cwd);
      field("Pending messages", peer.pendingMessages ? "yes" : "no");
      field("Last heartbeat", new Date(peer.updatedAt).toLocaleString());
      field("Elapsed", formatDuration(Math.max(0, now - peer.startedAt)));
    } else if (entity.kind === "agent") {
      const agent = entity.value;
      field("ID", agent.id);
      field("Model", agent.model);
      structuredField("Route", agent.route);
      field("Capability profile", agent.profile);
      structuredField("Admission", agent.admission);
      field("Thinking", agent.thinking);
      field("Transport", agent.transport);
      field("Activity", agent.currentTool);
      field("Elapsed", agent.startedAt ? formatDuration((agent.finishedAt ?? now) - agent.startedAt) : undefined);
      field("Usage", agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tokens · ${agent.toolCalls ?? 0} tools · ${agent.turns ?? 0} turns · $${agent.usage.cost.toFixed(4)}` : undefined);
      markdownField("Task", agent.task, "task");
      field("Branch", agent.branch);
      field("Worktree", agent.worktree);
      field("Attach", agent.attachCommand);
      field("Error", agent.error);
      markdownField("Result", agent.text, "result");
      structuredField("Value", agent.value);
    } else if (entity.kind === "persistentAgent") {
      const persistentAgent = entity.value;
      field("ID", persistentAgent.id);
      field("Model override", persistentAgent.model ?? "inherit");
      field("Active worker model", persistentAgent.worker?.model);
      field("Thinking override", persistentAgent.thinking ?? "inherit");
      field("Active worker thinking", persistentAgent.worker?.thinking);
      field("Delivery", `${persistentAgent.delivery} · ${persistentAgent.responseMode}`);
      field("Trigger turn", persistentAgent.triggerTurn ? "yes" : "no");
      field("Activity", persistentAgent.worker?.currentTool);
      field("Transport", persistentAgent.worker?.transport);
      field(
        "Usage",
        persistentAgent.worker?.usage
          ? `${formatTokens(persistentAgent.worker.usage.input + persistentAgent.worker.usage.output)} tokens · ${persistentAgent.worker.toolCalls ?? 0} tools`
          : undefined,
      );
      field("Host events", persistentAgent.events.join(", "));
      field("Tools", persistentAgent.tools?.join(", ") ?? `inherited (${this.persistentAgentDefaultTools.join(", ")})`);
      field("Topics", persistentAgent.topics.join(", "));
      field("Queue", persistentAgent.queued);
      structuredField("Budget", persistentAgent.budget);
      field("Last error", persistentAgent.lastError);
      field("Instructions", persistentAgent.instructions);
      if (persistentAgent.recentMessages.length > 0) {
        lines.push("");
        lines.push(this.theme.fg("accent", "Recent mailbox"));
        for (const message of persistentAgent.recentMessages) {
          const text = message.text ?? message.error ?? message.action ?? "data";
          field(
            `${message.direction === "in" ? "→" : "←"} ${formatClock(message.createdAt)} ${message.source}`,
            text,
          );
        }
      }
    } else if (entity.kind === "call") {
      const call = entity.value;
      field("Reference", call.ref);
      field("ID", call.id);
      field("Kind", call.entityKind ?? call.kind);
      field("Progress", call.progress);
      field("Elapsed", formatDuration((call.finishedAt ?? now) - call.startedAt));
      field("Tokens", call.metrics?.tokens);
      field("Tool calls", call.metrics?.toolCalls);
      field("Cost", call.metrics?.cost);
      field("Entity", call.entityId);
      const renderedCorePreview = coreCallPreview(call);
      if (!renderedCorePreview) argumentField(call);
      field("Error", call.error);
      if (!renderedCorePreview) outputField("Output", call.result);
    } else if (entity.kind === "item") {
      const item = entity.value;
      field("ID", item.id);
      field("Kind", item.kind);
      field("Progress", item.total !== undefined ? `${item.completed ?? 0}/${item.total}` : undefined);
      field("Current", item.current);
      field("Detail", item.detail);
      structuredField("Data", item.data);
    } else if (entity.kind === "agentTemplate") {
      const def = entity.value;
      field("Scope", "global template");
      field("ID", def.id);
      field("Delivery", `${def.delivery} · ${def.responseMode}`);
      field("Model", def.model ?? "inherit");
      field("Thinking", def.thinking ?? "inherit");
      field("Host events", def.events.join(", "));
      field("Topics", def.topics.join(", "));
      field("Trigger turn", def.triggerTurn ? "yes" : "no");
      field("Coalesce", def.coalesce ? "yes" : "no");
      field("Created", new Date(def.createdAt).toLocaleString());
      field("Updated", new Date(def.updatedAt).toLocaleString());
      field("Instructions", def.instructions);
    } else if (entity.kind === "meshParticipant") {
      const participant = entity.value;
      const canonical = participant.participant;
      field("Scope", canonical ? `project ${canonical.kind}` : "observed mesh agent");
      field("Identity", participant.id);
      field("Root", canonical?.rootId);
      field("Parent", canonical?.parentId);
      field("Owner host", canonical?.ownerHostId);
      field("Owner identity", canonical?.ownerIdentityId);
      field("Transport", canonical?.transport);
      field("Capabilities", canonical?.capabilities.join(", "));
      field("Local", canonical ? (canonical.local ? "yes" : "no") : undefined);
      field("Observed routes", participant.routes);
      field("Last activity", new Date(participant.lastSeenAt).toLocaleString());
      field("Current work", canonical?.currentTool);
    } else if (entity.kind === "meshTopic") {
      const topic = entity.value;
      field("Scope", "project mesh topic");
      field("ID", topic.id);
      field("System topic", topic.system ? "yes" : "no");
      field("Subscribers", topic.subscribers.map((subscriber) => subscriber.name).join(", "));
      field("Recent events", topic.recentEvents);
      field(
        "Last activity",
        topic.lastEventAt ? new Date(topic.lastEventAt).toLocaleString() : undefined,
      );
    } else if (entity.kind === "meshRoute") {
      const route = entity.value;
      field("Scope", "recent project mesh route");
      field("From", `${route.fromName} (${route.fromKind}:${route.fromId})`);
      field("To", `${route.targetName} (${route.targetKind}:${route.targetId})`);
      field("Topic", route.topic);
      field("Event kind", route.kind);
      field("Deliveries", route.count);
      field("Last activity", new Date(route.lastAt).toLocaleString());
      markdownField("Payload text", route.text, "route-text");
    } else {
      const entry = entity.value;
      field("Key", entry.key);
      field("Owner", entry.owner);
      field("Version", entry.version);
      field("Updated", new Date(entry.updatedAt).toLocaleString());
      field("Detail", entry.detail);
      const filePreview = loadStateFilePreview(entry, cwd);
      if (filePreview) {
        field("File", filePreview.path);
        lines.push(this.theme.fg("dim", "Preview:"));
        lines.push(...renderStateFilePreview(
          filePreview,
          this.theme,
          width,
          120,
          this.highlightInvalidate,
        ));
      }
      structuredField("Value", entry.value);
    }
    return lines.length > 0 ? lines : [this.theme.fg("dim", "No details")];
  }

  private syncEntitySelection(entities: Entity[], preferAttention = false): void {
    if (entities.length === 0) {
      this.entityIndex = 0;
      this.selectedEntityId = undefined;
      return;
    }
    const retainedIndex = this.selectedEntityId
      ? entities.findIndex((entity) => entity.id === this.selectedEntityId)
      : -1;
    const failedIndex = preferAttention
      ? entities.findIndex(
          (entity) =>
            entity.kind !== "main" &&
            ["failed", "timed_out", "error"].includes(entity.status),
        )
      : -1;
    const blockedIndex = preferAttention
      ? entities.findIndex(
          (entity) => entity.kind !== "main" && entity.status === "blocked",
        )
      : -1;
    const activeIndex = preferAttention
      ? entities.findIndex(
          (entity) => entity.kind !== "main" && isActiveStatus(entity.status),
        )
      : -1;
    const attentionIndex =
      failedIndex >= 0 ? failedIndex : blockedIndex >= 0 ? blockedIndex : activeIndex;
    const firstWorkIndex = entities.findIndex((entity) => entity.kind !== "main");
    this.entityIndex =
      retainedIndex >= 0
        ? retainedIndex
        : attentionIndex >= 0
          ? attentionIndex
          : firstWorkIndex >= 0
            ? firstWorkIndex
            : Math.max(0, Math.min(this.entityIndex, entities.length - 1));
    this.selectedEntityId = entities[this.entityIndex]?.id;
  }

  private selectRun(snapshot: FabricDashboardSnapshot): FabricActivityRun | undefined {
    if (snapshot.runs.length === 0) {
      this.runIndex = 0;
      this.selectedRunId = undefined;
      return undefined;
    }
    if (!this.runSelectionTouched) {
      this.runIndex = 0;
      this.selectedRunId = snapshot.runs[0]?.id;
      return snapshot.runs[0];
    }
    const retainedIndex = this.selectedRunId
      ? snapshot.runs.findIndex((run) => run.id === this.selectedRunId)
      : -1;
    this.runIndex =
      retainedIndex >= 0
        ? retainedIndex
        : Math.max(0, Math.min(this.runIndex, snapshot.runs.length - 1));
    this.selectedRunId = snapshot.runs[this.runIndex]?.id;
    return snapshot.runs[this.runIndex];
  }

  private syncPhase(run: FabricActivityRun | undefined, panels: PhasePanel[]): void {
    if (panels.length === 0) {
      this.phaseIndex = 0;
      this.selectedPhaseId = undefined;
      return;
    }
    if (!this.phaseSelectionTouched) {
      const current = run?.currentPhaseId
        ? panels.findIndex((panel) => panel.id === run.currentPhaseId)
        : -1;
      const activeRunActivity = panels.findIndex(
        (panel) => panel.kind === "unphased" && isActiveStatus(panel.status),
      );
      if (current >= 0 && isActiveStatus(panels[current]!.status)) {
        this.phaseIndex = current;
      } else if (activeRunActivity >= 0) {
        this.phaseIndex = activeRunActivity;
      } else if (current >= 0) {
        this.phaseIndex = current;
      } else {
        this.phaseIndex = 0;
      }
    } else {
      const retainedIndex = this.selectedPhaseId
        ? panels.findIndex((panel) => panel.id === this.selectedPhaseId)
        : -1;
      this.phaseIndex =
        retainedIndex >= 0
          ? retainedIndex
          : Math.max(0, Math.min(this.phaseIndex, panels.length - 1));
    }
    this.phaseIndex = Math.max(0, Math.min(this.phaseIndex, panels.length - 1));
    this.selectedPhaseId = panels[this.phaseIndex]?.id;
  }

  private resetSelection(): void {
    this.phaseIndex = 0;
    this.entityIndex = 0;
    this.selectedEntityId = undefined;
    this.phaseSelectionTouched = false;
    this.selectedPhaseId = undefined;
    this.detailId = undefined;
    this.detailScroll = 0;
    this.detailMaxScroll = 0;
    this.transcriptPageAnchor = undefined;
    this.detailSelectionRestore = undefined;
    this.detailView = "summary";
    this.transcriptFollowing = true;
    this.pane = this.overviewView === "activity" ? "phases" : "entities";
  }

  private pinDetailSelection(
    run: FabricActivityRun | undefined,
    panel: PhasePanel | undefined,
    pinPhase: boolean,
  ): void {
    this.detailSelectionRestore ??= {
      runSelectionTouched: this.runSelectionTouched,
      phaseSelectionTouched: this.phaseSelectionTouched,
    };
    this.runSelectionTouched = true;
    this.selectedRunId = run?.id;
    if (pinPhase) {
      this.phaseSelectionTouched = true;
      this.selectedPhaseId = panel?.id;
    }
  }

  private closeDetail(): void {
    const restore = this.detailSelectionRestore;
    if (restore) {
      this.runSelectionTouched = restore.runSelectionTouched;
      this.phaseSelectionTouched = restore.phaseSelectionTouched;
    }
    this.detailSelectionRestore = undefined;
    this.detailId = undefined;
    this.detailScroll = 0;
    this.detailMaxScroll = 0;
    this.transcriptPageAnchor = undefined;
    this.detailView = "summary";
    this.transcriptFollowing = true;
  }

  private renderNarrowDetail(
    width: number,
    snapshot: FabricDashboardSnapshot,
    entity: Entity,
  ): string[] {
    const transcriptView =
      (entity.kind === "agent" || entity.kind === "persistentAgent") && this.detailView === "transcript";
    const content = transcriptView
      ? this.transcriptLines(entity, width)
      : this.detailLines(entity, width, snapshot.now, snapshot.main.cwd ?? process.cwd());
    const terminalRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 28;
    const maxBody = Math.max(1, terminalRows - 2);
    this.detailMaxScroll = Math.max(0, content.length - maxBody);
    if (transcriptView && this.transcriptFollowing) {
      this.detailScroll = this.detailMaxScroll;
    } else if (transcriptView && this.transcriptPageAnchor) {
      this.detailScroll = this.transcriptPageAnchor === "end" ? this.detailMaxScroll : 0;
      this.transcriptPageAnchor = undefined;
    } else {
      this.detailScroll = Math.max(0, Math.min(this.detailScroll, this.detailMaxScroll));
    }
    const title = `${entity.label}${transcriptView ? " · transcript" : ""}`;
    const hint = transcriptView
      ? `${this.transcriptToolToggleHint()} · g page top · G follow:${this.transcriptFollowing ? "on" : "off"}/tail · t summary · esc`
      : `${this.hasTranscript(entity) ? "t transcript · " : ""}esc`;
    return [title, ...content.slice(this.detailScroll, this.detailScroll + maxBody), hint]
      .map((line) => truncateToWidth(line, width, ""))
      .filter((line) => visibleWidth(line) > 0);
  }

  private renderNarrowFallback(width: number, label: string, hint: string): string[] {
    return [safeText(label), hint]
      .map((line) => truncateToWidth(line, width, ""))
      .filter((line) => visibleWidth(line) > 0);
  }

  private topBorder(width: number, title: string): string {
    const border = (value: string) => this.theme.fg("borderMuted", value);
    const safeTitle = truncateToWidth(safeText(title), Math.max(0, width - 6));
    const styledTitle = ` ${this.theme.fg("accent", safeTitle)} `;
    const remaining = Math.max(0, width - 2 - visibleWidth(styledTitle));
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return `${border(`╭${"─".repeat(left)}`)}${styledTitle}${border(`${"─".repeat(right)}╮`)}`;
  }

  private middleBorder(width: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }

  private row(width: number, content: string): string {
    const innerWidth = Math.max(0, width - 2);
    return `${this.theme.fg("borderMuted", "│")}${padToWidth(content, innerWidth)}${this.theme.fg(
      "borderMuted",
      "│",
    )}`;
  }
}
