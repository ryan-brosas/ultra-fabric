import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { CodePreviewSettings } from "./code-preview.js";
import type { FabricActivityRun } from "../activity/types.js";
import type { FabricPersistentAgentDelivery, FabricPersistentAgentHostEvent } from "../agents/persistent/types.js";
import type { FabricState } from "../fabric-state.js";
import type { FabricThinking } from "../thinking.js";
import type { MeshEvent } from "../mesh/store.js";
import type { FabricDashboardMessageTarget } from "./dashboard.js";
import { createDashboardSnapshot } from "./snapshot.js";
import { isActiveStatus, type FabricDashboardSnapshot, type FabricUiPersistentAgent, type FabricUiAgent } from "./types.js";
import { FabricWidget, shouldShowFabricWidget } from "./widget.js";
import { AgentTranscriptReader, type FabricTranscriptSource } from "./transcript.js";

const WIDGET_ID = "pi-fabric";
const ACTIVITY_REFRESH_MS = 100;

const emptySnapshot = (): FabricDashboardSnapshot => {
  const now = Date.now();
  return {
    now,
    runs: [],
    main: {
      id: "main",
      name: "Main",
      kind: "main",
      status: "idle",
      transport: "host",
      cwd: process.cwd(),
      startedAt: now,
      updatedAt: now,
      pendingMessages: false,
      local: true,
    },
    peers: [],
    agents: [],
    persistentAgents: [],
    agentTemplates: [],
    state: [],
    events: [],
  };
};

export class FabricUiController {
  #context: ExtensionContext | undefined;
  #snapshot: FabricDashboardSnapshot = emptySnapshot();
  #events: MeshEvent[] = [];
  #meshOffset = 0;
  #timer: NodeJS.Timeout | undefined;
  #activityUnsubscribe: (() => void) | undefined;
  #persistentAgentUnsubscribe: (() => void) | undefined;
  #agentUnsubscribe: (() => void) | undefined;
  #scheduledRefresh: NodeJS.Timeout | undefined;
  #widgetTui: TUI | undefined;
  #dashboardTui: TUI | undefined;
  #widgetMounted = false;
  #widget: FabricWidget | undefined;
  #lastRefreshErrorAt = 0;
  #lastRefreshAt = 0;
  #dashboardOpen = false;
  #activityRevision: number | undefined;
  #activityRuns: FabricActivityRun[] = [];
  readonly #transcripts = new AgentTranscriptReader();

  constructor(
    readonly state: FabricState,
    readonly codePreviewSettings?: CodePreviewSettings,
  ) {}

  start(context: ExtensionContext): void {
    this.stop();
    this.#context = context;
    if (!this.state.config.ui.enabled || context.mode !== "tui") return;
    if (this.state.config.mesh.enabled) {
      this.#events = this.state.mesh.read({ limit: this.state.config.ui.eventHistory });
      this.#meshOffset = this.state.mesh.latestOffset();
    }
    this.#activityUnsubscribe = this.state.activity.subscribe(() => this.#scheduleRefresh());
    this.#persistentAgentUnsubscribe = this.state.persistentAgents.subscribe(() => this.#scheduleRefresh());
    this.#agentUnsubscribe = this.state.agents.subscribeUi(() => this.#scheduleRefresh());
    this.#refresh();
    this.#schedulePoll();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#scheduledRefresh) clearTimeout(this.#scheduledRefresh);
    this.#timer = undefined;
    this.#scheduledRefresh = undefined;
    this.#widget = undefined;
    this.#activityUnsubscribe?.();
    this.#activityUnsubscribe = undefined;
    this.#persistentAgentUnsubscribe?.();
    this.#persistentAgentUnsubscribe = undefined;
    this.#agentUnsubscribe?.();
    this.#agentUnsubscribe = undefined;
    if (this.#context?.mode === "tui") {
      this.#context.ui.setWidget(WIDGET_ID, undefined);
    }
    this.#context = undefined;
    this.#widgetTui = undefined;
    this.#dashboardTui = undefined;
    this.#widgetMounted = false;
    this.#events = [];
    this.#meshOffset = 0;
    this.#snapshot = emptySnapshot();
    this.#lastRefreshErrorAt = 0;
    this.#lastRefreshAt = 0;
    this.#dashboardOpen = false;
    this.#activityRevision = undefined;
    this.#activityRuns = [];
    this.#transcripts.clear();
  }

  async openDashboard(context: ExtensionContext): Promise<void> {
    if (context.mode !== "tui") {
      context.ui.notify("The Fabric dashboard is available in TUI mode", "warning");
      return;
    }
    if (!this.state.config.ui.enabled) {
      context.ui.notify("The Fabric UI is disabled by ui.enabled", "warning");
      return;
    }
    if (!this.#context) this.start(context);
    else this.#refresh();
    const [{ FabricDashboard }, { buildModelSource }] =
      await Promise.all([import("./dashboard.js"), import("./model-picker.js")]);
    const modelSource = buildModelSource(context.modelRegistry);
    const reportUpdate = (message: string, update: Promise<unknown>): void => {
      void update
        .then(() => {
          context.ui.notify(message, "info");
          this.#refresh();
        })
        .catch((error) =>
          context.ui.notify(error instanceof Error ? error.message : String(error), "error"),
        );
    };
    const onTargetMessage = (
      target: FabricDashboardMessageTarget,
      message: string,
      delivery: "steer" | "followUp",
    ): void => {
      const action =
        target.kind === "persistentAgent"
          ? delivery === "steer"
            ? `Message queued for ${target.name}`
            : `Follow-up queued for ${target.name}`
          : delivery === "steer"
            ? `Steer queued for ${target.name}`
            : `Follow-up queued for ${target.name}`;
      reportUpdate(
        action,
        this.state.queueUserMessage(target.id, message, delivery),
      );
    };
    const onAgentStop = (agentId: string): void => {
      reportUpdate("Agent stopped", this.state.stopParticipant(agentId));
    };
    const onPersistentAgentModel = (persistentAgentId: string, model: string | undefined): void => {
      reportUpdate("Persistent Agent model updated", this.state.persistentAgents.setModel(persistentAgentId, model));
    };
    const onPersistentAgentThinking = (persistentAgentId: string, thinking: FabricThinking | undefined): void => {
      reportUpdate("Persistent Agent thinking level updated", this.state.persistentAgents.setThinking(persistentAgentId, thinking));
    };
    const onPersistentAgentEvents = (persistentAgentId: string, events: FabricPersistentAgentHostEvent[]): void => {
      reportUpdate("Persistent Agent event subscriptions updated", this.state.persistentAgents.setEvents(persistentAgentId, events));
    };
    const onPersistentAgentDeliveryPolicy = (
      persistentAgentId: string,
      delivery: FabricPersistentAgentDelivery,
      triggerTurn: boolean,
    ): void => {
      reportUpdate(
        "Persistent Agent delivery policy updated",
        this.state.persistentAgents.setDeliveryPolicy(persistentAgentId, delivery, triggerTurn),
      );
    };
    const onGlobalDeliveryPolicy = (
      persistentAgentId: string,
      delivery: FabricPersistentAgentDelivery,
      triggerTurn: boolean,
    ): void => {
      try {
        this.state.templates.update(persistentAgentId, { delivery, triggerTurn });
        context.ui.notify("Global agent template delivery policy updated", "info");
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    const onPersistentAgentTools = (persistentAgentId: string, tools: string[]): void => {
      reportUpdate("Persistent Agent tools updated", this.state.agents.setPersistentTools(persistentAgentId, tools));
    };
    const onClearMessages = (persistentAgentId: string): void => {
      reportUpdate("Persistent Agent mailbox cleared", this.state.persistentAgents.clearMessages(persistentAgentId));
    };
    const onPersistentAgentInstructions = (persistentAgentId: string, instructions: string): void => {
      reportUpdate("Persistent Agent instructions updated", this.state.persistentAgents.setInstructions(persistentAgentId, instructions));
    };
    const onGlobalInstructions = (agentTemplateId: string, instructions: string): void => {
      try {
        this.state.templates.update(agentTemplateId, { instructions });
        context.ui.notify("Global agent template instructions updated", "info");
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    const onImportPersistentAgent = (agentTemplateId: string): void => {
      const def = this.state.templates.resolve(agentTemplateId);
      if (!def) return;
      this.state.agents
        .importTemplate(def.id)
        .then((persistentAgent) => {
          context.ui.notify(`Imported Agent template "${def.name}" as ${persistentAgent.name}`, "info");
          this.#refresh();
        })
        .catch((error) =>
          context.ui.notify(error instanceof Error ? error.message : String(error), "error"),
        );
    };
    const onExportPersistentAgent = (persistentAgentId: string): void => {
      try {
        const def = this.state.persistentAgents.definition(persistentAgentId);
        const template = this.state.templates.create(def);
        context.ui.notify(`Exported "${template.name}" to global agent templates`, "info");
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    const onRemoveAgentTemplate = (agentTemplateId: string): void => {
      try {
        const result = this.state.templates.remove(agentTemplateId);
        context.ui.notify(
          result.removed ? "Removed Agent template template" : "Agent template not found",
          result.removed ? "info" : "warning",
        );
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    this.#dashboardOpen = true;
    this.#schedulePoll(true);
    try {
      await context.ui.custom<void>(
        (tui, theme, keybindings, done) => {
          this.#dashboardTui = tui;
          return new FabricDashboard(tui, theme, () => this.#snapshot, () => done(undefined), {
            modelSource,
            keybindings,
            ...(this.codePreviewSettings
              ? { codePreviewSettings: this.codePreviewSettings }
              : {}),
            onTargetMessage,
            onAgentStop,
            agentTranscript: (agent, followLatest) =>
              this.#transcripts.read(this.#agentTranscriptSource(agent), followLatest),
            persistentAgentTranscript: (persistentAgent, followLatest) =>
              this.#transcripts.read(this.#persistentAgentTranscriptSource(persistentAgent), followLatest),
            loadOlderTranscript: (target) =>
              this.#transcripts.loadOlder(this.#transcriptSource(target)),
            loadNewerTranscript: (target) =>
              this.#transcripts.loadNewer(this.#transcriptSource(target)),
            loadLatestTranscript: (target) =>
              this.#transcripts.loadLatest(this.#transcriptSource(target)),
            onPersistentAgentModel,
            onPersistentAgentThinking,
            onPersistentAgentEvents,
            onPersistentAgentDeliveryPolicy,
            onGlobalDeliveryPolicy,
            onPersistentAgentTools,
            persistentAgentDefaultTools: this.state.config.agents?.defaultTools ?? [],
            onClearMessages,
            onPersistentAgentInstructions,
            onGlobalInstructions,
            onImportPersistentAgent,
            onExportPersistentAgent,
            onRemoveAgentTemplate,
          });
        },
        {
          overlay: true,
          overlayOptions: {
            width: "94%",
            minWidth: 40,
            maxHeight: "90%",
            anchor: "center",
            margin: 1,
          },
        },
      );
    } finally {
      this.#dashboardOpen = false;
      this.#dashboardTui = undefined;
      this.#schedulePoll(true);
    }
  }

  snapshot(): FabricDashboardSnapshot {
    return structuredClone(this.#snapshot);
  }

  #schedulePoll(reset = false): void {
    if (reset && this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#timer || !this.#context) return;
    const active =
      this.#snapshot.runs.some((run) => run.status === "running") ||
      this.#snapshot.peers.length > 0 ||
      this.#snapshot.agents.some((agent) => isActiveStatus(agent.status)) ||
      this.#snapshot.persistentAgents.some(
        (persistentAgent) =>
          isActiveStatus(persistentAgent.status) ||
          Boolean(persistentAgent.worker && isActiveStatus(persistentAgent.worker.status)),
      );
    if (!this.#dashboardOpen && !active) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#refresh();
      this.#schedulePoll();
    }, this.state.config.ui.refreshMs);
    this.#timer.unref();
  }

  #scheduleRefresh(): void {
    if (this.#scheduledRefresh || !this.#context) return;
    const elapsed = performance.now() - this.#lastRefreshAt;
    const delay = Math.max(
      0,
      Math.min(ACTIVITY_REFRESH_MS, this.state.config.ui.refreshMs) - elapsed,
    );
    this.#scheduledRefresh = setTimeout(() => {
      this.#scheduledRefresh = undefined;
      this.#refresh();
      this.#schedulePoll(true);
    }, delay);
    this.#scheduledRefresh.unref();
  }

  #agentTranscriptSource(agent: FabricUiAgent): FabricTranscriptSource {
    return { id: agent.id, status: agent.status, ...(agent.logFile ? { logFile: agent.logFile } : {}) };
  }

  #persistentAgentTranscriptSource(persistentAgent: FabricUiPersistentAgent): FabricTranscriptSource {
    if (persistentAgent.worker?.logFile && isActiveStatus(persistentAgent.worker.status)) {
      return {
        id: `${persistentAgent.id}:${persistentAgent.worker.id}`,
        status: persistentAgent.worker.status,
        logFile: persistentAgent.worker.logFile,
      };
    }
    const retained = persistentAgent.lastRunId && persistentAgent.logDir
      ? path.join(persistentAgent.logDir, persistentAgent.lastRunId, "events.jsonl")
      : undefined;
    if (retained) return { id: persistentAgent.id, status: persistentAgent.status, logFile: retained };
    if (persistentAgent.sessionFile) {
      return { id: persistentAgent.id, status: persistentAgent.status, logFile: persistentAgent.sessionFile };
    }
    return { id: persistentAgent.id, status: persistentAgent.status };
  }

  #transcriptSource(target: FabricUiAgent | FabricUiPersistentAgent): FabricTranscriptSource {
    return "recentMessages" in target
      ? this.#persistentAgentTranscriptSource(target)
      : this.#agentTranscriptSource(target);
  }

  #refresh(): void {
    this.#lastRefreshAt = performance.now();
    const context = this.#context;
    if (!context || !this.state.initialized) return;
    try {
      this.#pollMesh();
      const revision =
        typeof this.state.activity.revision === "function"
          ? this.state.activity.revision()
          : undefined;
      if (revision === undefined || revision !== this.#activityRevision) {
        this.#activityRuns = this.state.activity.runs();
        this.#activityRevision = revision;
      }
      this.#snapshot = createDashboardSnapshot(
        this.state,
        this.#events,
        context,
        this.#activityRuns,
      );
      this.#renderWidget(context);
      if (this.#dashboardTui) this.#dashboardTui.requestRender();
      else if (this.#widgetTui && this.#widget?.hasChanged()) this.#widgetTui.requestRender();
    } catch (error) {
      const now = Date.now();
      if (now - this.#lastRefreshErrorAt >= 10_000) {
        this.#lastRefreshErrorAt = now;
        const message = error instanceof Error ? error.message : String(error);
        context.ui.notify(`Fabric dashboard refresh failed: ${message}`, "warning");
      }
    }
  }

  #pollMesh(): void {
    if (!this.state.config.mesh.enabled) return;
    const result = this.state.mesh.tail(this.#meshOffset, this.state.config.ui.eventHistory);
    this.#meshOffset = result.nextOffset;
    if (result.events.length === 0) return;
    this.#events.push(...result.events);
    const limit = this.state.config.ui.eventHistory;
    if (this.#events.length > limit) this.#events.splice(0, this.#events.length - limit);
  }

  #renderWidget(context: ExtensionContext): void {
    const config = this.state.config.ui;
    const shouldShow =
      context.mode === "tui" &&
      shouldShowFabricWidget(this.#snapshot, config.widget);
    if (shouldShow) {
      if (this.#widgetMounted) return;
      this.#widgetMounted = true;
      context.ui.setWidget(
        WIDGET_ID,
        (tui, theme) => {
          this.#widgetTui = tui;
          this.#widget = new FabricWidget(theme, () => this.#snapshot, config.maxRows);
          return this.#widget;
        },
        { placement: "aboveEditor" },
      );
      return;
    }
    if (!this.#widgetMounted) return;
    context.ui.setWidget(WIDGET_ID, undefined);
    this.#widgetMounted = false;
    this.#widgetTui = undefined;
    this.#widget = undefined;
  }
}
