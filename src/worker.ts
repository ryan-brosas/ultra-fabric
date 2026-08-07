#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import crossSpawn from "cross-spawn";
import { StringDecoder } from "node:string_decoder";
import { Value } from "typebox/value";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  AgentRunRecord,
  AgentRunStatus,
  AgentUsage,
  AgentWorkerOptions,
} from "./agents/types.js";

const NODE_SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);

const spawnCli = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess => NODE_SCRIPT_EXTENSIONS.has(path.extname(command).toLowerCase())
  ? crossSpawn(process.execPath, [command, ...args], options)
  : crossSpawn(command, [...args], options);

type CompactControlModule = typeof import("./agents/compact-control.js");
type WorkerOptionsModule = typeof import("./worker/options.js");
type WorkerRunRecordModule = typeof import("./worker/run-record.js");
type AgentTurnBudgetModule = typeof import("./agents/turn-budget.js");

const loadWorkerOptions = async (): Promise<WorkerOptionsModule> => {
  if (!import.meta.url.endsWith(".ts")) return import("./worker/options.js");
  const sourceModulePath = "./worker/options.ts";
  return import(sourceModulePath) as Promise<WorkerOptionsModule>;
};

const loadWorkerRunRecord = async (): Promise<WorkerRunRecordModule> => {
  if (!import.meta.url.endsWith(".ts")) return import("./worker/run-record.js");
  const sourceModulePath = "./worker/run-record.ts";
  return import(sourceModulePath) as Promise<WorkerRunRecordModule>;
};

const loadAgentTurnBudget = async (): Promise<AgentTurnBudgetModule> => {
  if (!import.meta.url.endsWith(".ts")) return import("./agents/turn-budget.js");
  const sourceModulePath = "./agents/turn-budget.ts";
  return import(sourceModulePath) as Promise<AgentTurnBudgetModule>;
};

const loadCompactControl = async (): Promise<CompactControlModule> => {
  if (!import.meta.url.endsWith(".ts")) return import("./agents/compact-control.js");
  const sourceModulePath = "./agents/compact-control.ts";
  return import(sourceModulePath) as Promise<CompactControlModule>;
};

const MAX_STDERR_CHARS = 20_000;
const MAX_EVENT_LINE_CHARS = 4 * 1024 * 1024;
const STEER_READ_CHUNK_BYTES = 256 * 1024;
const MAX_STEER_LINE_BYTES = 64 * 1024;
const MAX_STEER_COMMANDS_PER_POLL = 256;
const KILL_GRACE_MS = 5_000;

const extractText = (message: Record<string, unknown>): string => {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => part.text)
    .join("");
};

const readImages = (filePath: string | undefined): ImageContent[] => {
  if (!filePath) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Agent images file must contain an array");
  const images: ImageContent[] = [];
  for (const value of parsed) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (value as { type?: unknown }).type !== "image" ||
      typeof (value as { data?: unknown }).data !== "string" ||
      typeof (value as { mimeType?: unknown }).mimeType !== "string"
    ) {
      throw new Error("Agent images file contains an invalid image block");
    }
    images.push({
      type: "image",
      data: (value as { data: string }).data,
      mimeType: (value as { mimeType: string }).mimeType,
    });
  }
  return images;
};


const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const assistantError = (message: Record<string, unknown>): string => {
  const details: string[] = [];
  const direct = stringField(message.errorMessage) ?? stringField(message.error);
  if (direct) details.push(direct);
  if (Array.isArray(message.diagnostics)) {
    for (const diagnostic of message.diagnostics) {
      if (typeof diagnostic !== "object" || diagnostic === null || Array.isArray(diagnostic)) continue;
      const record = diagnostic as Record<string, unknown>;
      const nested =
        typeof record.error === "object" && record.error !== null && !Array.isArray(record.error)
          ? (record.error as Record<string, unknown>)
          : undefined;
      const detail = stringField(nested?.message) ?? stringField(record.message);
      if (detail) details.push(detail);
    }
  }
  const unique = [...new Set(details)];
  const provider = stringField(message.provider);
  const model = stringField(message.model);
  const source = [provider, model].filter((value): value is string => Boolean(value)).join("/");
  const summary = unique.join(" · ") || "Pi agent reported an error";
  return `${source ? `${source}: ` : ""}${summary}`.slice(0, MAX_STDERR_CHARS);
};

const terminateChild = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (!child.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch { /* child process group already exited */ }
};

const extractBalancedJson = (text: string, start: number): string | null => {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
};

const parseStructuredValue = (text: string): unknown => {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Whole text is not JSON; try extraction below.
  }
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Fenced block is not JSON; try balanced extraction below.
    }
  }
  const start = trimmed.search(/[{\[]/);
  if (start >= 0) {
    const balanced = extractBalancedJson(trimmed, start);
    if (balanced) return JSON.parse(balanced);
  }
  return JSON.parse(trimmed);
};

let crashContext: { statusFile: string; record: AgentRunRecord } | undefined;
let runRecordHelpers: WorkerRunRecordModule | undefined;
let terminalWritten = false;
const writeCrashStatus = (error: unknown): void => {
  if (!crashContext || !runRecordHelpers || terminalWritten) return;
  try {
    runRecordHelpers.writeCrashRunRecord(crashContext.statusFile, crashContext.record, error);
  } catch {
    // Best effort: if the crash-status write itself fails, #monitor falls back
    // to "Agent transport exited without a result".
  }
};
process.on("uncaughtException", (error) => {
  writeCrashStatus(error);
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : error}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  writeCrashStatus(error);
  process.stderr.write(`Unhandled rejection: ${error instanceof Error ? error.stack ?? error.message : error}\n`);
  process.exit(1);
});

interface WorkerRunState {
  stderr: string;
  outputBuffer: string;
  terminalStatus: AgentRunStatus | undefined;
  terminalError: string | undefined;
  sawAgentError: boolean;
  retryPending: boolean;
  turnBudgetStopTimer: NodeJS.Timeout | undefined;
  steerOffset: number;
  steerRemainder: Buffer;
  skippingOversizedSteerLine: boolean;
}

interface WorkerRunDeps {
  options: AgentWorkerOptions;
  child: ChildProcess;
  record: AgentRunRecord;
  compactControl: InstanceType<CompactControlModule["ChildCompactControl"]>;
  logStream: ReturnType<typeof fs.createWriteStream>;
  lastEmittedUsage: AgentUsage;
  latestRunText: (text: string) => string;
  extractUsageDelta: (message: Record<string, unknown>) => { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | undefined;
  applyUsage: (record: AgentRunRecord, message: Record<string, unknown>) => void;
  update: () => void;
  enforceTurnBudget: () => void;
}

function emitTokenUsage(state: WorkerRunState, deps: WorkerRunDeps, delta?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; }): void {
  const snapshot = deps.record.usage;
  if (
    snapshot.input === deps.lastEmittedUsage.input &&
    snapshot.output === deps.lastEmittedUsage.output &&
    snapshot.cacheRead === deps.lastEmittedUsage.cacheRead &&
    snapshot.cacheWrite === deps.lastEmittedUsage.cacheWrite &&
    snapshot.cost === deps.lastEmittedUsage.cost
  ) {
    return;
  }
  emitLifecycle(state, deps, "tokens.usage", {
    runId: deps.options.id,
    name: deps.options.name,
    depth: deps.options.depth,
    ...(deps.options.persistentAgentId ? { persistentAgentId: deps.options.persistentAgentId } : {}),
    ...(deps.options.persistentAgentName ? { persistentAgentName: deps.options.persistentAgentName } : {}),
    cumulativeTokens:
      snapshot.input + snapshot.output + snapshot.cacheRead + snapshot.cacheWrite,
    input: delta?.input ?? 0,
    output: delta?.output ?? 0,
    cacheRead: delta?.cacheRead ?? 0,
    cacheWrite: delta?.cacheWrite ?? 0,
    cost: delta?.cost ?? snapshot.cost,
  });
  deps.lastEmittedUsage.input = snapshot.input;
  deps.lastEmittedUsage.output = snapshot.output;
  deps.lastEmittedUsage.cacheRead = snapshot.cacheRead;
  deps.lastEmittedUsage.cacheWrite = snapshot.cacheWrite;
  deps.lastEmittedUsage.cost = snapshot.cost;
}

function pollSteer(state: WorkerRunState, deps: WorkerRunDeps): void {
  if (!deps.options.steerFile || state.terminalStatus) return;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(deps.options.steerFile, "r");
  } catch {
    return;
  }
  try {
    const size = fs.fstatSync(descriptor).size;
    if (size < state.steerOffset) {
      state.steerOffset = 0;
      state.steerRemainder = Buffer.alloc(0);
      state.skippingOversizedSteerLine = false;
    }
    if (size <= state.steerOffset) return;
    const length = Math.min(size - state.steerOffset, STEER_READ_CHUNK_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, state.steerOffset);
    state.steerOffset += bytesRead;
    let combined = Buffer.concat([state.steerRemainder, buffer.subarray(0, bytesRead)]);
    if (state.skippingOversizedSteerLine) {
      const skippedLineEnd = combined.indexOf(0x0a);
      if (skippedLineEnd < 0) return;
      combined = combined.subarray(skippedLineEnd + 1);
      state.skippingOversizedSteerLine = false;
    }
    const newline = combined.lastIndexOf(0x0a);
    if (newline < 0) {
      if (combined.length > MAX_STEER_LINE_BYTES) {
        state.steerRemainder = Buffer.alloc(0);
        state.skippingOversizedSteerLine = true;
      } else {
        state.steerRemainder = Buffer.from(combined);
      }
      return;
    }
    const remainder = combined.subarray(newline + 1);
    if (remainder.length > MAX_STEER_LINE_BYTES) {
      state.steerRemainder = Buffer.alloc(0);
      state.skippingOversizedSteerLine = true;
    } else {
      state.steerRemainder = Buffer.from(remainder);
    }
    let processedCommands = 0;
    for (const raw of combined.subarray(0, newline + 1).toString("utf8").split("\n")) {
      if (processedCommands >= MAX_STEER_COMMANDS_PER_POLL) break;
      if (Buffer.byteLength(raw, "utf8") > MAX_STEER_LINE_BYTES) continue;
      const line = raw.trim();
      if (!line) continue;
      processedCommands += 1;
      let command: { type?: string; message?: string; mode?: string; instructions?: string };
      try {
        command = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        if (command.type === "steer" && typeof command.message === "string") {
          deps.child.stdin?.write(JSON.stringify({ type: "steer", message: command.message }) + "\n");
        } else if (command.type === "follow_up" && typeof command.message === "string") {
          deps.child.stdin?.write(JSON.stringify({ type: "follow_up", message: command.message }) + "\n");
        } else if (command.type === "set_steering_mode" && typeof command.mode === "string") {
          deps.child.stdin?.write(JSON.stringify({ type: "set_steering_mode", mode: command.mode }) + "\n");
        } else if (command.type === "set_follow_up_mode" && typeof command.mode === "string") {
          deps.child.stdin?.write(JSON.stringify({ type: "set_follow_up_mode", mode: command.mode }) + "\n");
        } else if (command.type === "compact") {
          deps.compactControl.queue(command.instructions);
        }
      } catch {
        /* stdin closed (settled/stopped deps.child); a late steer is dropped */
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function processEvent(state: WorkerRunState, deps: WorkerRunDeps, line: string): void {
  if (process.env.PI_FABRIC_INJECT_CRASH === "stream") throw new Error("simulated stream crash");
  if (!line.trim()) return;
  deps.logStream.write(`${line}\n`);
  let event: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    event = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  deps.compactControl.observe(event);
  if (event.type === "agent_start") {
    emitLifecycle(state, deps, "pi.agent_start");
    state.retryPending = false;
    state.sawAgentError = false;
    state.terminalError = undefined;
    return;
  }
  if (event.type === "response" && event.command === "prompt" && event.success === false) {
    state.sawAgentError = true;
    state.terminalError = typeof event.error === "string" ? event.error : "Pi rejected the prompt";
    deps.child.stdin?.end();
    return;
  }
  if (event.type === "extension_ui_request") {
    const method = event.method;
    if (
      typeof event.id === "string" &&
      (method === "select" || method === "confirm" || method === "input" || method === "editor")
    ) {
      deps.child.stdin?.write(
        `${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`,
      );
    }
    return;
  }
  if (event.type === "tool_execution_start") {
    deps.record.toolCalls++;
    if (typeof event.toolName === "string") {
      deps.record.currentTool = event.toolName;
      process.stdout.write(`→ ${event.toolName}\n`);
    }
    deps.update();
    return;
  }
  if (event.type === "tool_execution_end") {
    if (event.isError === true) {
      emitLifecycle(state, deps, "pi.tool_error", {
        ...(typeof event.toolCallId === "string" ? { toolCallId: event.toolCallId } : {}),
        ...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
      });
    }
    delete deps.record.currentTool;
    deps.update();
    return;
  }
  if (event.type === "turn_end") {
    emitLifecycle(state, deps, "pi.turn_end", {
      ...(typeof event.turnIndex === "number" ? { turnIndex: event.turnIndex } : {}),
    });
    deps.record.turns++;
    deps.enforceTurnBudget();
    deps.update();
    return;
  }
  if (event.type === "queue_update") {
    const steering = Array.isArray(event.steering)
      ? event.steering.filter((value): value is string => typeof value === "string")
      : [];
    const followUp = Array.isArray(event.followUp)
      ? event.followUp.filter((value): value is string => typeof value === "string")
      : [];
    deps.record.pendingMessages = { steering, followUp };
    deps.update();
    return;
  }
  if (event.type === "message_end") {
    const message = event.message;
    if (typeof message !== "object" || message === null || Array.isArray(message)) return;
    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role !== "assistant") return;
    const text = extractText(messageRecord);
    if (text) {
      deps.record.text = deps.latestRunText(text);
      process.stdout.write(`\n${text}\n`);
    }
    const usageDelta = deps.extractUsageDelta(messageRecord);
    deps.applyUsage(deps.record, messageRecord);
    emitTokenUsage(state, deps, usageDelta);
    enforceTokenLimit(state, deps);
    if (messageRecord.stopReason === "error") {
      state.sawAgentError = true;
      state.terminalError = assistantError(messageRecord);
    } else {
      state.sawAgentError = false;
      // Once a terminal cause is set (e.g. the per-deps.child token guard), keep it;
      // a later non-error message_end must not clobber the reason we are
      // terminating for.
      if (!state.terminalStatus) state.terminalError = undefined;
    }
    deps.update();
    return;
  }
  if (event.type === "agent_end") {
    if (event.willRetry !== true && state.turnBudgetStopTimer) {
      clearTimeout(state.turnBudgetStopTimer);
      state.turnBudgetStopTimer = undefined;
    }
    emitLifecycle(state, deps, "pi.agent_end", { willRetry: event.willRetry === true });
    state.retryPending = event.willRetry === true;
    return;
  }
  if (event.type === "agent_settled") {
    emitLifecycle(state, deps, "pi.agent_settled");
    if (!state.retryPending) {
      // Pull controls that landed with the final stream events before deciding
      // whether this one-shot deps.child can close. A queued compact keeps stdin
      // open until its correlated response and compaction_end are observed.
      pollSteer(state, deps, );
      deps.compactControl.childSettled();
    }
    return;
  }
  if (event.type === "compaction_end") {
    emitLifecycle(state, deps, "pi.session_compact", {
      ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
      ...(typeof event.willRetry === "boolean" ? { willRetry: event.willRetry } : {}),
    });
    return;
  }
  if (event.type === "extension_error") {
    const error = typeof event.error === "string" ? event.error : "Extension error";
    state.stderr = `${state.stderr}\n${error}`.trim().slice(-MAX_STDERR_CHARS);
    deps.update();
  }
}


function emitLifecycle(state: WorkerRunState, deps: WorkerRunDeps, event: string, data?: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(deps.options.lifecycleFile), { recursive: true });
    fs.appendFileSync(
      deps.options.lifecycleFile,
      JSON.stringify({ version: 1, event, occurredAt: Date.now(), ...(data ? { data } : {}) }) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Lifecycle telemetry is best-effort and must not fail the deps.child run.
  }
}

function enforceTokenLimit(state: WorkerRunState, deps: WorkerRunDeps): void {
  if (state.terminalStatus || !deps.options.maxTokens || deps.options.maxTokens <= 0) return;
  const total =
    deps.record.usage.input +
    deps.record.usage.output +
    deps.record.usage.cacheRead +
    deps.record.usage.cacheWrite;
  if (total <= deps.options.maxTokens) return;
  state.terminalStatus = "budget_exhausted";
  state.terminalError = `Fabric token limit reached: ${total} tokens (limit ${deps.options.maxTokens}); terminating deps.child`;
  terminateChild(deps.child, "SIGTERM");
  setTimeout(() => terminateChild(deps.child, "SIGKILL"), KILL_GRACE_MS).unref();
  deps.child.stdin?.end();
}


const main = async (): Promise<void> => {
  const [optionHelpers, loadedRunRecordHelpers, turnBudgetHelpers] = await Promise.all([
    loadWorkerOptions(),
    loadWorkerRunRecord(),
    loadAgentTurnBudget(),
  ]);
  runRecordHelpers = loadedRunRecordHelpers;
  const {
    applyUsage,
    createRunningRecord,
    emptyUsage,
    extractUsageDelta,
    latestRunText,
    updateRunRecord,
    writeRunRecord,
  } = loadedRunRecordHelpers;
  const { agentTurnBudgetDecision } = turnBudgetHelpers;
  const options = optionHelpers.parseWorkerOptions();
  const thinking =
    options.thinking === "off" ||
    options.thinking === "minimal" ||
    options.thinking === "low" ||
    options.thinking === "medium" ||
    options.thinking === "high" ||
    options.thinking === "xhigh" ||
    options.thinking === "max"
      ? options.thinking
      : undefined;
  const task = fs.readFileSync(options.taskFile, "utf8");
  const images = readImages(options.imagesFile);
  const record = createRunningRecord(options, task, thinking, Date.now());
  writeRunRecord(options.statusFile, record);
  crashContext = { statusFile: options.statusFile, record };
  process.stdout.write(`[pi-fabric] ${options.name}\n${task}\n\n`);
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const logStream = fs.createWriteStream(options.logFile, { flags: "a", mode: 0o600 });
  logStream.on("error", () => {});

  const schema = options.schemaFile
    ? fs.readFileSync(options.schemaFile, "utf8")
    : undefined;
  const piArguments = ["--mode", "rpc"];
  if (options.sessionFile) piArguments.push("--session", options.sessionFile);
  else piArguments.push("--no-session");
  if (!options.extensions) piArguments.push("--no-extensions");
  if (options.fabricExtensionPath) piArguments.push("-e", options.fabricExtensionPath);
  if (options.consultReadScope !== undefined) {
    if (!options.consultScopeExtensionPath) {
      throw new Error("Ultra Consult read scope requires a Pi guard extension");
    }
    // Consult must receive only its task, explicit tools, schema, and scope guard.
    // Ambient project resources defeat fresh-context isolation and can exceed the
    // worker token ceiling before it produces a finding.
    piArguments.push(
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "-e",
      options.consultScopeExtensionPath,
    );
  }
  if (options.tools.length > 0) piArguments.push("--tools", options.tools.join(","));
  else piArguments.push("--no-tools"); // explicit empty allowlist => no tools, not Pi defaults
  if (options.model) piArguments.push("--model", options.model);
  if (thinking) piArguments.push("--thinking", thinking);
  if (options.systemPrompt) piArguments.push("--append-system-prompt", options.systemPrompt);
  if (schema) {
    piArguments.push(
      "--append-system-prompt",
      `Your final response must contain only JSON matching this schema, without Markdown fences:\n${schema}`,
    );
  }
  const childArguments = piArguments;
  const childBinary = options.piBinary;

  const child = spawnCli(childBinary, childArguments, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      PI_FABRIC_DEPTH: String(options.depth),
      PI_FABRIC_PARENT_RUN: options.id,
      PI_FABRIC_AGENT_NAME: options.name,
      ...(options.traceId ? { PI_FABRIC_TRACE_ID: options.traceId } : {}),
      ...(options.traceId ? { PI_FABRIC_PARENT_SPAN_ID: options.id } : {}),
      ...(options.mainAgentId ? { PI_FABRIC_MAIN_AGENT_ID: options.mainAgentId } : {}),
      PI_FABRIC_GRANTED_RISKS: options.grantedRisks.join(","),
      PI_FABRIC_FULL_CODE_MODE: String(options.fullCodeMode),
      ...(options.persistentAgentId ? { PI_FABRIC_PERSISTENT_AGENT_ID: options.persistentAgentId } : {}),
      ...(options.persistentAgentName ? { PI_FABRIC_PERSISTENT_AGENT_NAME: options.persistentAgentName } : {}),
      ...(options.meshRoot ? { PI_FABRIC_MESH_ROOT: options.meshRoot } : {}),
      ...(options.projectRoot ? { PI_FABRIC_PROJECT_ROOT: options.projectRoot } : {}),
      ...(options.consultReadScope !== undefined
        ? {
            PI_FABRIC_CONSULT_SCOPE_V1: JSON.stringify({
              version: 1,
              root: options.projectRoot ?? options.cwd,
              scopes: options.consultReadScope,
            }),
          }
        : {}),
      ...(options.ownerHostId ? { PI_FABRIC_OWNER_HOST_ID: options.ownerHostId } : {}),
      ...(options.ownerIdentityId
        ? { PI_FABRIC_OWNER_IDENTITY_ID: options.ownerIdentityId }
        : {}),
      ...(options.runRoot ? { PI_FABRIC_RUN_ROOT: options.runRoot } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Mutable run state shared by the stream, steer, and lifecycle handlers.
  // Held in one object so those handlers can live at module scope instead of
  // closing over main's locals.
  const state: WorkerRunState = {
    stderr: "",
    outputBuffer: "",
    terminalStatus: undefined,
    terminalError: undefined,
    sawAgentError: false,
    retryPending: false,
    turnBudgetStopTimer: undefined,
    steerOffset: 0,
    steerRemainder: Buffer.alloc(0),
    skippingOversizedSteerLine: false,
  };
  const outputDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  const update = (): void => updateRunRecord(options.statusFile, record);

  // Attributed token telemetry. Every usage-bearing child event emits one
  // tokens.usage lifecycle entry identified by this run/persistentAgent/runner/depth.
  // The manager drains these alongside the pi.* lifecycle stream and appends
  // them to the budget ledger, replacing the old per-settle flat attribution.
  const lastEmittedUsage = emptyUsage();

  const { ChildCompactControl } = await loadCompactControl();
  const compactControl = new ChildCompactControl(options.id, {
    send(frame) {
      if (!child.stdin || child.stdin.writableEnded || child.stdin.destroyed) {
        throw new Error("Child Pi stdin closed before compaction could start");
      }
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    close() {
      child.stdin?.end();
    },
    update(status) {
      record.compaction = status;
      update();
    },
  });

  // Preemptive per-child token guard. timeoutMs bounds wall time and budgetUsd
  // bounds cost, but a single runaway child can still blow its own context
  // before Pi core compacts. When maxTokens is set and the child's cumulative
  // token usage crosses it, terminate the child like a timeout so the run
  // settles with a terminal status instead of burning to the hour deadline.
  const enforceTurnBudget = (): void => {
    if (state.terminalStatus || !options.turnBudget) return;
    const decision = agentTurnBudgetDecision(options.turnBudget, record.turns);
    if (decision === "continue") return;
    record.turnBudget = {
      ...options.turnBudget,
      outcome: decision === "wrap-up" ? "wrap-up-requested" : "exceeded",
    };
    if (decision !== "stop" || state.turnBudgetStopTimer) return;
    state.turnBudgetStopTimer = setTimeout(() => {
      state.turnBudgetStopTimer = undefined;
      if (state.terminalStatus || child.exitCode !== null) return;
      state.terminalStatus = "timed_out";
      state.terminalError = `Agent turn budget reached: ${record.turns} turns (limit ${options.turnBudget!.maxTurns} + grace ${options.turnBudget!.graceTurns})`;
      terminateChild(child, "SIGTERM");
      setTimeout(() => terminateChild(child, "SIGKILL"), KILL_GRACE_MS).unref();
      child.stdin?.end();
    }, 500);
    state.turnBudgetStopTimer.unref();
  };



  const deps: WorkerRunDeps = {
    options,
    child,
    record,
    compactControl,
    logStream,
    lastEmittedUsage,
    latestRunText,
    extractUsageDelta,
    applyUsage,
    update,
    enforceTurnBudget,
  };



  child.stdin?.on("error", () => {});
  {
    child.stdin?.write(
      `${JSON.stringify({
        type: "prompt",
        message: task,
        ...(images.length > 0 ? { images } : {}),
      })}\n`,
    );
  }

  // Tail a control file (steer.jsonl) the parent appends to and forward each
  // queued command to the child pi over its RPC stdin. This is the fabric
  // steering channel: the orchestrator (or any peer via the mesh relay) can
  // interject a steer / follow_up / queue-mode command between the child's
  // turns without stopping and respawning it, preserving its context. The
  // poller is best-effort: a closed or ended stdin (settled/stopped child) is
  // swallowed so a late steer never crashes the worker.
  const steerTimer = options.steerFile ? setInterval(() => pollSteer(state, deps), 200) : undefined;
  steerTimer?.unref?.();

  child.stdout?.on("data", (chunk: Buffer) => {
    state.outputBuffer += outputDecoder.write(chunk);
    while (true) {
      const newline = state.outputBuffer.indexOf("\n");
      if (newline < 0) {
        if (state.outputBuffer.length > MAX_EVENT_LINE_CHARS) {
          state.terminalStatus = "failed";
          state.terminalError = "Agent emitted an oversized event line";
          state.outputBuffer = "";
          terminateChild(child, "SIGTERM");
        }
        break;
      }
      if (newline > MAX_EVENT_LINE_CHARS) {
        state.terminalStatus = "failed";
        state.terminalError = "Agent emitted an oversized event line";
        state.outputBuffer = "";
        terminateChild(child, "SIGTERM");
        return;
      }
      const line = state.outputBuffer.slice(0, newline).replace(/\r$/, "");
      state.outputBuffer = state.outputBuffer.slice(newline + 1);
      processEvent(state, deps, line);
    }
  });
  const recordStderr = (text: string): void => {
    if (!text) return;
    logStream.write(`${JSON.stringify({ type: "worker_stderr", text })}\n`);
    process.stderr.write(text);
    state.stderr = `${state.stderr}${text}`.slice(-MAX_STDERR_CHARS);
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    recordStderr(stderrDecoder.write(chunk));
  });
  child.stderr?.on("error", () => {});

  const timeout = setTimeout(() => {
    state.terminalStatus = "timed_out";
    state.terminalError = `Agent timed out after ${options.timeoutMs}ms`;
    terminateChild(child, "SIGTERM");
    setTimeout(() => terminateChild(child, "SIGKILL"), KILL_GRACE_MS).unref();
  }, options.timeoutMs);
  timeout.unref();

  const stop = (): void => {
    if (state.terminalStatus) return;
    state.terminalStatus = "stopped";
    state.terminalError = "Agent stopped";
    terminateChild(child, "SIGTERM");
    setTimeout(() => terminateChild(child, "SIGKILL"), KILL_GRACE_MS).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      state.terminalStatus = "failed";
      state.terminalError = error.message;
      resolve(null);
    });
    child.once("close", (code) => resolve(code));
  });

  if (steerTimer) clearInterval(steerTimer);
  if (state.turnBudgetStopTimer) clearTimeout(state.turnBudgetStopTimer);
  clearTimeout(timeout);
  if (process.env.PI_FABRIC_INJECT_CRASH === "close") throw new Error("simulated close crash");
  state.outputBuffer += outputDecoder.end();
  recordStderr(stderrDecoder.end());
  if (state.outputBuffer.trim()) processEvent(state, deps, state.outputBuffer);
  record.exitCode = exitCode;
  record.stderr = state.stderr.slice(-MAX_STDERR_CHARS);
  if (
    record.compaction?.status === "queued" ||
    record.compaction?.status === "in_flight"
  ) {
    const error = state.terminalError ?? "Child Pi exited before the queued compaction completed";
    record.compaction = {
      ...record.compaction,
      status: "failed",
      updatedAt: Date.now(),
      finishedAt: Date.now(),
      error,
    };
    if (!state.terminalStatus) {
      state.terminalStatus = "failed";
      state.terminalError = error;
    }
  }
  record.finishedAt = Date.now();
  record.updatedAt = record.finishedAt;
  const childCompleted = exitCode === 0 && !state.sawAgentError;
  record.status = state.terminalStatus ?? (childCompleted ? "completed" : "failed");
  if (options.turnBudget) {
    const exceeded = state.terminalError?.startsWith("Agent turn budget reached:") === true;
    record.turnBudget = {
      ...options.turnBudget,
      outcome: exceeded ? "exceeded" : "within-budget",
    };
  }
  if (state.terminalError) record.error = state.terminalError;
  if (record.status === "failed" && !record.error) {
    record.error =
      state.stderr.trim() ||
      (exitCode === 0
        ? "Pi agent reported an error before exiting"
        : `Pi exited with code ${exitCode ?? "unknown"}`);
  }
  if (record.status === "completed" && options.schemaFile) {
    try {
      const schema = JSON.parse(fs.readFileSync(options.schemaFile, "utf8")) as Record<
        string,
        unknown
      >;
      const value = record.value ?? parseStructuredValue(record.text);
      if (!Value.Check(schema, value)) {
        const errors = [...Value.Errors(schema, value)]
          .slice(0, 5)
          .map((error) => error.message)
          .join("; ");
        throw new Error(errors || "value does not match schema");
      }
      record.value = value;
    } catch (error) {
      record.status = "failed";
      const reason = error instanceof Error ? error.message : String(error);
      const output = record.text.trim();
      const snippet = output.slice(0, 200);
      record.error = `Structured agent output was invalid: ${reason}${snippet ? ` (output: ${snippet}${output.length > 200 ? "…" : ""})` : ""}`;
    }
  }
  delete record.currentTool;
  writeRunRecord(options.statusFile, record);
  terminalWritten = true;
  process.stdout.write(`\n[pi-fabric] ${record.status}\n`);
  await Promise.all([
    new Promise<void>((resolve) => logStream.end(resolve)),
    Promise.resolve(),
  ]);
  process.exitCode = record.status === "completed" ? 0 : 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  writeCrashStatus(error);
  process.exit(1);
});
