import type { Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadCodePreviewSettings } from "./ui/code-preview.js";
import {
  type FabricToolShellDecorator,
  withCodePreviewShell,
} from "./ui/code-preview-shell.js";
import { registerFabricPersistentAgentHostEventObservers } from "./agents/persistent/host-event-observer.js";
import { CapturedToolCatalog } from "./capture/catalog.js";
import { installRegisteredToolCapture } from "./capture/interceptor.js";
import { registerFabricCommand } from "./commands/fabric.js";
import {
  filterPrewalkContinuationMessages,
  filterPrewalkPlanningMessages,
} from "./prewalk/continuation.js";
import { restorePrewalkModel } from "./prewalk/model.js";
import { prewalkChecklistReminder } from "./prewalk/continuation.js";
import { checklistProgress, checklistWidgetLines, extractDoneMarkers } from "./prewalk/checklist-progress.js";

// Concatenated text of the most recent assistant message in the branch, so
// [DONE:n] progress markers in the executor's last turn reach the controller.
const lastAssistantTurnText = (messages: readonly unknown[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message?.role !== "assistant") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    let text = "";
    for (const part of parts as Array<{ type?: unknown; text?: unknown }>) {
      if (part?.type === "text" && typeof part.text === "string") text += part.text;
    }
    return text;
  }
  return "";
};
import { autoArmPrewalk } from "./prewalk/arm.js";
import { scoutBridge } from "./prewalk/scout-brief.js";
import { prewalkRearmDefaults } from "./prewalk/rearm.js";
import { withTrajectoryRearmDirective } from "./prewalk/handoff.js";
import type { PendingFabricHandoff } from "./prewalk/handoff.js";
import {
  DEFAULT_FABRIC_CONFIG,
  effectiveToolCaptureConfig,
} from "./config.js";
import { registerCompactionHook } from "./compaction/hook.js";
import { applyHandoffRetirement } from "./context/handoff-retirement.js";
import { prewalkMemoryDir, recordChecklist } from "./prewalk/checklist-memory.js";
import { prewalkFailureDir, recordFailure } from "./prewalk/failure-memory.js";
import { applyContextQos } from "./context/qos.js";
import { compactAtConfiguredThreshold } from "./compaction/threshold.js";
import {
  FabricToolLifecycle,
  FabricToolOwnership,
  ownsFabricToolSource,
} from "./core/tool-ownership.js";
import {
  expandSkillDirMarkersForRead,
  expandSkillDirMarkersInSkillBlock,
} from "./core/skill-dir.js";
import { restoreSkillsForFullCodePrompt } from "./core/skill-prompt.js";
import {
  FabricDirectToolApproval,
  mergeFabricApprovalUsage,
} from "./core/direct-tool-approval.js";
import { buildSkillReferenceGuidance } from "./core/skill-references.js";
import { createFabricExecTool } from "./fabric-exec-tool.js";
import { createCodemapTool } from "./codemap/tool.js";
import { FabricState } from "./fabric-state.js";
import { piHostCompatibilityWarning, staleBuildWarning } from "./host-compatibility.js";
import {
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricProviderRegistration,
} from "./protocol.js";
import type { AgentToolResultMessage } from "./agents/types.js";
import { FabricUiController } from "./ui/controller.js";
import { configureHighlighting } from "./ui/highlight.js";
import { formatFabricValue } from "./ui/structured.js";
import { truncateMiddle } from "./util.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Absolute path to the Fabric skills bundled with this extension. Resolved
// relative to the extension entry so it works both in development (src/) and
// in an installed package (dist/). Contributed via resources_discover so child
// Pi processes that load Fabric with -e (agents across both lifecycles) discover the
// same fabric-exec / fabric-advisor / fabric-council skill references as the
// main agent, which gets them through the package manifest.
const FABRIC_EXTENSION_ENTRY_PATH = path.resolve(fileURLToPath(import.meta.url));
const FABRIC_SKILLS_DIR = path.resolve(
  path.dirname(FABRIC_EXTENSION_ENTRY_PATH),
  "..",
  "skills",
);

const registrationFrom = (value: unknown): FabricProviderRegistration | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const registration = value as Partial<FabricProviderRegistration>;
  const provider = registration.provider;
  if (
    registration.version !== 1 ||
    typeof provider !== "object" ||
    provider === null ||
    typeof provider.name !== "string" ||
    typeof provider.description !== "string" ||
    typeof provider.list !== "function" ||
    typeof provider.describe !== "function" ||
    typeof provider.invoke !== "function"
  ) {
    return undefined;
  }
  return registration as FabricProviderRegistration;
};

export default async function piFabric(pi: ExtensionAPI): Promise<void> {
  const codePreviewSettings = await loadCodePreviewSettings();
  const decorateShell: FabricToolShellDecorator = withCodePreviewShell;
  let compatibilityWarningShown = false;
  configureHighlighting(
    codePreviewSettings.shikiTheme,
    codePreviewSettings.syntaxHighlighting,
  );
  const capturedTools = new CapturedToolCatalog();
  const state = new FabricState(pi, capturedTools);
  const directToolApproval = new FabricDirectToolApproval(
    pi,
    () => state.config,
    state.sessionApprovals,
  );
  const pendingHandoffs = new Map<string, PendingFabricHandoff>();
  const toolOwnership = new FabricToolOwnership(pi);
  const fabricUi = new FabricUiController(state, codePreviewSettings);

  const unsubscribeProviderRegistration = pi.events.on(
    FABRIC_PROVIDER_REGISTER_EVENT,
    (value: unknown) => {
      const registration = registrationFrom(value);
      if (!registration) throw new Error("Invalid Pi Fabric provider registration");
      state.registerExternal(
        registration.provider,
        registration.overwrite === undefined ? {} : { overwrite: registration.overwrite },
      );
    },
  );

  pi.on("resources_discover", async () => {
    if (existsSync(FABRIC_SKILLS_DIR)) return { skillPaths: [FABRIC_SKILLS_DIR] };
    return {};
  });

  const fabricTool = createFabricExecTool(
    state,
    codePreviewSettings,
    pendingHandoffs,
    decorateShell,
  );
  const fabricToolLifecycle = new FabricToolLifecycle(
    () => ownsFabricToolSource(pi.getAllTools(), FABRIC_EXTENSION_ENTRY_PATH),
    () => state.initialized ? state.execution.authorizer : undefined,
    () => state.initialized ? directToolApproval : undefined,
  );

  const inactiveCapturePolicy = {
    ...structuredClone(DEFAULT_FABRIC_CONFIG.capture),
    enabled: false,
    hideFromModel: false,
  };
  const toolCapture = await installRegisteredToolCapture({
    anchorDefinition: fabricTool,
    catalog: capturedTools,
    initialPolicy: inactiveCapturePolicy,
  });
  pi.registerTool(fabricTool);
  pi.registerTool(createCodemapTool({
    cgc: () => ({
      enabled: state.config.codemap.enabled,
      ...(state.config.codemap.context ? { context: state.config.codemap.context } : {}),
      timeoutMs: state.config.codemap.timeoutMs,
    }),
  }));

  const applyFabricMode = (): void => {
    toolCapture.setPolicy(effectiveToolCaptureConfig(state.config));
    pi.registerTool(fabricTool);
    toolOwnership.apply(
      state.config.fullCodeMode || state.config.schema.mode === "enforce",
    );
  };
  const suspendToolCapture = (): void => {
    toolCapture.setPolicy(inactiveCapturePolicy);
  };

  // ESC stop-the-world: a lone Escape (debounced to ignore escape sequences
  // such as arrow keys) halts every persistent agent — aborting in-flight runs
  // and cancelling queued work — and arms a stop-the-world gate that freezes
  // host-event and mesh dispatch so the interrupted persistentAgents are not re-armed by
  // the interrupt's own turn_end / agent_settled events. The gate lifts when the
  // user resumes by sending a new message (the "input" host event). Escape is
  // observed but not consumed, so Pi's native cancel-streaming still fires;
  // single ESC therefore stops the current turn and the advisor/supervisor
  // persistentAgents at once. Disabled when mesh/persistentAgents are off or ui.haltOnEscape is
  // false.
  let haltOnEscapeUnsubscribe: (() => void) | undefined;
  const uninstallHaltOnEscape = (): void => {
    haltOnEscapeUnsubscribe?.();
    haltOnEscapeUnsubscribe = undefined;
  };
  const installHaltOnEscape = (context: ExtensionContext): void => {
    uninstallHaltOnEscape();
    if (context.mode !== "tui") return;
    if (!state.config.ui.haltOnEscape || !state.config.mesh.enabled) return;
    if (typeof context.ui.onTerminalInput !== "function") return;
    const ESC = "\x1b";
    const DEBOUNCE_MS = 60;
    let escTimer: NodeJS.Timeout | undefined;
    const trigger = (): void => {
      if (!state.initialized || !state.config.mesh.enabled) return;
      let halted = 0;
      try {
        // A lone Esc that lands while Fabric is already in a stop-the-world
        // halt is a no-op: the gate is armed and resumes on the next message,
        // so don't repeat the notice — a double-Esc to open /tree would
        // otherwise pop it on every press. Only the first Esc of a halt
        // session notifies.
        if (state.persistentAgents.halted) return;
        halted = state.persistentAgents.haltAll().halted;
      } catch {
        return;
      }
      // Nothing had work to abort: the gate armed silently, so skip the
      // notice — a lone Esc with no active persistent Agents should not pop a
      // "halted 0 persistent Agents" line.
      if (halted === 0) return;
      context.ui.notify(
        `Fabric: halted ${halted} persistent Agent${halted === 1 ? "" : "s"} (Esc) · resumes on next message`,
        "warning",
      );
    };
    haltOnEscapeUnsubscribe = context.ui.onTerminalInput((data: string) => {
      if (data === ESC) {
        if (escTimer) clearTimeout(escTimer);
        escTimer = setTimeout(() => {
          escTimer = undefined;
          trigger();
        }, DEBOUNCE_MS);
        escTimer.unref?.();
        return undefined;
      }
      // Any other input cancels a pending lone-Esc debounce — the Esc byte was
      // most likely the start of an escape sequence that arrived split.
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = undefined;
      }
      return undefined;
    });
  };

  pi.on("session_start", async (_event, context) => {
    pendingHandoffs.clear();
    state.carry.clear();
    directToolApproval.clear();
    fabricUi.stop();
    suspendToolCapture();
    if (!compatibilityWarningShown) {
      compatibilityWarningShown = true;
      const warning = piHostCompatibilityWarning();
      if (warning) {
        console.warn(`[pi-fabric] ${warning}`);
        if (context.hasUI) context.ui.notify(warning, "warning");
      }
      const stale = staleBuildWarning(FABRIC_EXTENSION_ENTRY_PATH);
      if (stale) {
        console.warn(`[pi-fabric] ${stale}`);
        if (context.hasUI) context.ui.notify(stale, "warning");
      }
    }
    const projectTrusted =
      typeof context.isProjectTrusted === "function" ? context.isProjectTrusted() : true;
    try {
      Object.assign(
        codePreviewSettings,
        await loadCodePreviewSettings(context.cwd, projectTrusted),
      );
      configureHighlighting(
        codePreviewSettings.shikiTheme,
        codePreviewSettings.syntaxHighlighting,
      );
      Object.assign(
        fabricTool,
        createFabricExecTool(state, codePreviewSettings, pendingHandoffs, decorateShell),
      );
    } catch (error) {
      console.warn("[pi-fabric] Failed to refresh code preview settings.", error);
    }
    await state.initialize(context);
    if (state.initialized) {
      const scoutRun = scoutBridge(state.agents);
      await autoArmPrewalk(pi, state.prewalk, state.config, context, scoutRun ? { scoutRun } : {});
    }
    applyFabricMode();
    fabricUi.start(context);
    installHaltOnEscape(context);
  });

  // Tool ownership changes only at session or mode transitions; lifecycle hooks
  // forward host events without churning an explicitly selected active set.
  pi.on("input", async (event, context) => {
    if (!state.initialized) return;
    // Hand-edited config takes effect on the next prompt: stat the two
    // fabric.json files and reload when either changed on disk.
    state.reloadConfigIfChanged(context);
    state.prewalk.observeTask(
      context.sessionManager.getSessionId(),
      event.text,
    );
    await state.publishHostLifecycle("pi.input", event);
  });

  pi.on("agent_start", async (event) => {
    if (state.initialized) await state.publishHostLifecycle("pi.agent_start", event);
  });

  pi.on("agent_end", async (event) => {
    if (state.initialized) await state.publishHostLifecycle("pi.agent_end", event);
  });

  pi.on("turn_end", async (event) => {
    if (!state.initialized) return;
    await state.publishHostLifecycle("pi.turn_end", event);
  });

  pi.on("agent_settled", async (event, context) => {
    if (!state.initialized) return;
    const sessionId = context.sessionManager.getSessionId();
    // Re-arming reads the configuration in force now, so a mode or model change
    // between tasks takes effect instead of the previous arm being carried on.
    const rearm = prewalkRearmDefaults(state.config);
    const settledContinuation = state.prewalk.settleContinuation(sessionId, rearm);
    // Two terminal paths owe a restore: a continuation that settles (including a
    // gated one that never passed verification) and a task blocked by a failed
    // gate at the fabric_exec boundary. The ?? keeps it to one restore.
    const returnModel =
      settledContinuation.returnModel ?? state.prewalk.takeReturnState(sessionId).model;
    const returnThinking =
      settledContinuation.returnThinking ?? state.prewalk.takeReturnState(sessionId).thinking;
    if (returnThinking) {
      pi.setThinkingLevel(returnThinking as any);
    }
    if (returnModel) {
      const restored = await restorePrewalkModel(
        pi,
        context,
        returnModel,
      );
      // A concurrent settle is already restoring Main; reporting it as a
      // failure would be wrong, so leave the notice to the owning call.
      if (restored.status !== "in-progress") {
        context.ui.notify(
          restored.status === "restored"
            ? `Prewalk restored Main → ${restored.model}`
            : `Prewalk could not restore ${restored.model}: ${restored.error}`,
          restored.status === "restored" ? "info" : "warning",
        );
      }
    }
    // Failure memory: a gate failure (abort gate, exhausted revisions, or a
    // continuation that settled while still verifying) leaves the task blocked
    // with its error preserved. Mine the failure mode keyed by task so the next
    // similar task seeds its planning phase with it (PreFlect-style prospective
    // distillation). Opt-in via prewalk.failureMemory.
    if (state.config.prewalk.failureMemory === true) {
      const failedStatus = state.prewalk.status();
      if (failedStatus.state === "blocked" && failedStatus.task) {
        const error = failedStatus.error ?? "Prewalk gate blocked the task";
        recordFailure(
          prewalkFailureDir(state.config.agents.runRoot),
          failedStatus.task,
          {
            kind: error.includes("revision limit")
              ? "revision-exhausted"
              : "gate-abort",
            gate: error,
            feedback: error,
          },
        );
      }
    }
    // Checklist memory: a settled continuation leaves an accepted checklist
    // behind. Record it keyed by the task text so a later similar task seeds
    // its planning phase with the prior plan instead of re-deriving it.
    if (
      settledContinuation.settled &&
      state.config.prewalk.reuseChecklists === true
    ) {
      if (settledContinuation.checklist && settledContinuation.task) {
        recordChecklist(
          prewalkMemoryDir(state.config.agents.runRoot),
          settledContinuation.task,
          settledContinuation.checklist,
        );
      }
    }
    const settledTask = state.prewalk.settleTask(sessionId, rearm);
    if (settledContinuation.settled || settledTask) {
      const status = state.prewalk.status();
      context.ui.setStatus(
        "fabric-prewalk",
        status.state === "armed"
          ? `armed → ${status.model}`
          : status.state === "blocked"
            ? `blocked → ${status.model}`
            : undefined,
      );
    }
    // Keep the completed widget mounted until a newer Fabric run replaces it.
    // Removing rows at settle would pull the editor and latest chat content upward.
    // Pi's compact API is callback-based. Await the controller's Promise here
    // so ExtensionRunner does not finish this handler (and Pi does not publish
    // its public agent_settled event) before compaction settles.
    await state.compact.maybeCommit(context);
    await compactAtConfiguredThreshold(context, state.config);
    await state.publishHostLifecycle("pi.agent_settled", event);
  });

  pi.on("tool_call", (event, context) =>
    fabricToolLifecycle.toolCall(event, context));

  // Pi 0.80.6 intentionally ignores `isError` returned by custom-tool
  // execute(). Repair the finalized outer result through official middleware.
  pi.on("tool_result", (event) => fabricToolLifecycle.toolResult(event));

  pi.on("tool_result", (event, context) => {
    if (event.toolName !== "read" || event.isError) return undefined;
    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const text = expandSkillDirMarkersForRead(
        part.text,
        event.input,
        context.cwd,
      );
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { content } : undefined;
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "toolResult") return undefined;
    const message = event.message as AgentToolResultMessage & { usage?: Usage };
    const usage = directToolApproval.takeUsage(message.toolCallId);
    if (!usage) return undefined;
    return {
      message: {
        ...message,
        usage: mergeFabricApprovalUsage(message.usage, usage),
      },
    };
  });

  // message_end runs after all tool-result middleware and tool_execution_end but
  // before Pi persists the native toolResult or starts another model turn. That
  // is the complete outer fabric_exec boundary: fork the exact message, wait for
  // the child, then replace what Main sees while terminate prevents inference.
  pi.on("message_end", async (event, context) => {
    if (event.message.role !== "toolResult") return undefined;
    const pending = pendingHandoffs.get(event.message.toolCallId);
    if (!pending || event.message.toolName !== "fabric_exec") return undefined;
    pendingHandoffs.delete(event.message.toolCallId);

    const outerToolResult = event.message as AgentToolResultMessage;
    const handoff = await state.runHandoffAtBoundary(
      pending,
      outerToolResult,
      context,
    );
    const formatted = formatFabricValue(
      handoff,
      pending.resultFormat,
      state.config.executor.maxOutputChars,
    );
    const output = truncateMiddle(
      formatted.text || "(no output)",
      state.config.executor.maxOutputChars,
    );
    // Directive lands after truncation so it survives maxOutputChars, and
    // gates on "still armed" so one-shot trajectory handoffs stay silent.
    const text = withTrajectoryRearmDirective(
      output,
      pending,
      handoff,
      state.prewalk,
      context.sessionManager.getSessionId(),
    );
    const boundarySucceeded = handoff.completed === true || handoff.continued === true;
    const details =
      typeof event.message.details === "object" &&
      event.message.details !== null &&
      !Array.isArray(event.message.details) &&
      "success" in event.message.details
        ? { ...event.message.details, success: boundarySucceeded }
        : event.message.details;
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text }],
        details,
        isError: !boundarySucceeded,
      },
    };
  });

  pi.on("tool_execution_end", async (event, context) => {
    if (!state.initialized) return;
    state.noteMainActivity(context);
    if (event.isError) {
      state.dispatchHostEvent("tool_error", event, context);
      await state.publishHostLifecycle("pi.tool_error", event);
    }
  });

  pi.on("session_compact", async (event) => {
    if (!state.initialized) return;
    await state.publishHostLifecycle("pi.session_compact", event);
  });

  // Fabric owns the default compaction route and always keeps a deterministic
  // portable summary, with compatible model-native backends layered on top.
  // The documented "pi" escape hatch leaves compaction to pi-core.
  registerCompactionHook(pi, {
    getEngine: () =>
      state.initialized
        ? state.config.compaction.engine
        : DEFAULT_FABRIC_CONFIG.compaction.engine,
    getTargetContextRatio: () =>
      state.initialized
        ? state.config.compaction.targetContextRatio
        : DEFAULT_FABRIC_CONFIG.compaction.targetContextRatio,
    getThresholdContextRatio: (modelKey) =>
      state.initialized
        ? state.config.compaction.thresholds[modelKey]
        : DEFAULT_FABRIC_CONFIG.compaction.thresholds[modelKey],
  });

  pi.on("context", (event, context) => {
    const sessionId = context.sessionManager.getSessionId();
    const continuation = filterPrewalkContinuationMessages(
      event.messages,
      (handoffId) =>
        state.initialized &&
        state.prewalk.acceptContinuation(sessionId, handoffId),
    );
    const planning = filterPrewalkPlanningMessages(
      continuation.messages,
      state.initialized && state.prewalk.isArmed(sessionId),
    );
    const contextQos = state.initialized
      ? state.config.compaction.contextQos
      : DEFAULT_FABRIC_CONFIG.compaction.contextQos;
    const qos = contextQos.enabled
      ? applyContextQos(planning.messages, contextQos)
      : {
          messages: planning.messages,
          changed: false,
          report: { retiredResults: 0, retiredChars: 0, protectedResults: 0 },
        };
    state.noteContextQos(qos.report);
    // Handoff-boundary retirement: once the executor continuation is live and
    // accepted, Main's planning-phase read/grep/find/ls results are dead weight
    // replayed as input every turn. The checklist carries the plan, so retire
    // them behind the continuation anchor when prewalk.handoffRetirement is on.
    const prewalkStatus = state.initialized ? state.prewalk.status() : undefined;
    const liveContinuation =
      prewalkStatus &&
      (prewalkStatus.state === "continuing" || prewalkStatus.state === "verifying") &&
      prewalkStatus.checklist &&
      prewalkStatus.checklist.trivial !== true
        ? prewalkStatus.handoffId
        : undefined;
    const retirement =
      liveContinuation &&
      state.config.prewalk.handoffRetirement === true
        ? applyHandoffRetirement(qos.messages, {
            continuationId: liveContinuation,
            enabled: true,
          })
        : {
            messages: qos.messages,
            changed: false,
            report: { retiredResults: 0, retiredChars: 0, protectedResults: 0 },
          };
    let changed =
      continuation.changed || planning.changed || qos.changed || retirement.changed;
    let messages = retirement.messages.map((message) => {
      if (message.role !== "user") return message;
      if (typeof message.content === "string") {
        const content = expandSkillDirMarkersInSkillBlock(message.content);
        if (content === message.content) return message;
        changed = true;
        return { ...message, content };
      }
      let messageChanged = false;
      const content = message.content.map((part) => {
        if (part.type !== "text") return part;
        const text = expandSkillDirMarkersInSkillBlock(part.text);
        if (text === part.text) return part;
        changed = true;
        messageChanged = true;
        return { ...part, text };
      });
      return messageChanged ? { ...message, content } : message;
    });
    const liveChecklist = state.initialized
      ? state.prewalk.claimChecklistReminder(sessionId)
      : undefined;
    if (liveChecklist) {
      messages = [
        ...messages,
        {
          role: "user",
          content: [{ type: "text", text: prewalkChecklistReminder(liveChecklist) }],
        } as (typeof messages)[number],
      ];
      changed = true;
    }
    // Progress: [DONE:n] markers in the latest assistant turn mark checklist
    // items complete; the widget and status keep the plan's progress visible
    // between turns (prime-agent plan-mode style, ASCII only).
    if (state.initialized) {
      const lastAssistantText = lastAssistantTurnText(messages);
      if (lastAssistantText) {
        const checklist = state.prewalk.status();
        if (checklist.state !== "idle" && checklist.checklist) {
          const indexes = extractDoneMarkers(lastAssistantText, checklist.checklist.items.length);
          if (indexes.length > 0) state.prewalk.markChecklistDone(sessionId, indexes);
          const progress = checklistProgress(checklist.checklist);
          if (progress.total > 0) {
            context.ui.setStatus(
              "fabric-prewalk-progress",
              `checklist ${progress.done}/${progress.total}`,
            );
            context.ui.setWidget(
              "fabric-prewalk-progress",
              checklistWidgetLines(checklist.checklist),
            );
          }
        }
      }
    }
    return changed ? { messages } : undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const fullCodeMode = state.initialized
      ? state.config.fullCodeMode
      : DEFAULT_FABRIC_CONFIG.fullCodeMode;
    const schemaMode = state.initialized
      ? state.config.schema.mode
      : DEFAULT_FABRIC_CONFIG.schema.mode;
    const effectiveFullCodeMode = fullCodeMode || schemaMode === "enforce";
    if (!pi.getActiveTools().includes("fabric_exec")) return;
    const skills = event.systemPromptOptions.skills ?? [];
    // Full code mode replaces Pi's direct read tool, so retain task-relevant
    // skill descriptions and a bounded path index for on-demand discovery.
    const systemPrompt = effectiveFullCodeMode
      ? restoreSkillsForFullCodePrompt(event.systemPrompt, skills, { prompt: event.prompt })
      : event.systemPrompt;
    // Pi expands the invoked skill into the user message, but wrappers may
    // delegate by name. Resolve only explicit invocation lines so full code
    // mode preserves Pi's progressive skill loading without exposing read.
    const skillReferenceGuidance = effectiveFullCodeMode
      ? buildSkillReferenceGuidance(event.prompt, skills)
      : undefined;
    const guidance = (effectiveFullCodeMode
      ? "Pi Fabric full code mode: fabric_exec is the exclusive model tool. Inside code, use pi.* for core tools, extensions.* for registered tools, mcp.<server>.<tool> for known MCP actions, stable provider globals (memory/state/schema/compact/agents/mesh), and tools.call({ref,args}) for computed refs. pi.read/grep/find/ls return strings; pi.bash/edit/write return {ok,output,details} and reject on failure (use settle:true for expected nonzero). Use top-level strings through π.key for awkward payloads; load the fabric-exec skill for exact signatures."
      : "Pi Fabric orchestration-only mode keeps pi.* and extensions.* unavailable inside fabric_exec while native host tools remain direct. Use known mcp.<server>.<tool> actions, stable provider globals, discovery through tools.catalog/search/describe/list, and tools.call({ref,args}) for computed refs.")
      + (schemaMode === "enforce"
        ? "\n\nSchema enforce mode is fixed for this session. Reads remain available, but protected-workspace changes must use schema.hypothesize → schema.verify → schema.commit in the same fabric_exec invocation. Direct pi.edit/write/bash, agents, state/mesh writes, compaction requests, MCP, extensions, and external providers are blocked by the host gate."
        : schemaMode === "audit"
          ? "\n\nSchema audit mode reports actions that enforce mode would block, but preserves their current behavior."
          : "")
      + (skillReferenceGuidance ? `\n\n${skillReferenceGuidance}` : "");
    return {
      systemPrompt: `${systemPrompt}\n\n${guidance}`,
    };
  });

  registerFabricPersistentAgentHostEventObservers(pi, (eventName, event, context) => {
    if (!state.initialized) return;
    state.dispatchHostEvent(eventName, event, context);
  });

  pi.on("session_shutdown", async () => {
    unsubscribeProviderRegistration();
    try {
      pendingHandoffs.clear();
      directToolApproval.clear();
      uninstallHaltOnEscape();
      fabricUi.stop();
      suspendToolCapture();
      toolOwnership.release();
      fabricToolLifecycle.clear();
      await state.shutdown();
    } finally {
      toolCapture.dispose();
    }
  });

  registerFabricCommand(pi, { state, fabricUi, capturedTools, applyFabricMode, suspendToolCapture });
}

export * from "./audit/index.js";
export * from "./protocol.js";
export { buildCodeGraph, anchoredPageRank } from "./codemap/build.js";
