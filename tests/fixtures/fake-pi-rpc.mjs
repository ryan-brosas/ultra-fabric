#!/usr/bin/env node

import readline from "node:readline";

const send = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const usage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 };

const successMessage = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "fake",
  model: "fake-model",
  usage,
  stopReason: "stop",
});

const providerFailure = () => ({
  role: "assistant",
  content: [],
  provider: "openai-codex",
  model: "gpt-test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  stopReason: "error",
  errorMessage: "fetch failed",
  diagnostics: [
    {
      type: "provider_transport_failure",
      error: { name: "Error", message: "WebSocket error" },
      details: { configuredTransport: "auto", fallbackTransport: "sse" },
    },
  ],
});

const finishAttempt = (message, willRetry) => {
  send({ type: "message_end", message });
  send({ type: "turn_end", message, toolResults: [] });
  send({ type: "agent_end", messages: [message], willRetry });
  send({ type: "agent_settled" });
};

let started = false;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (started || !line.trim()) return;
  started = true;
  const command = JSON.parse(line);
  const task = typeof command.message === "string" ? command.message : "";

  send({ type: "response", command: "prompt", success: true });
  send({ type: "agent_start" });

  if (task.includes("RETRY_THEN_SUCCEED")) {
    finishAttempt(providerFailure(), true);
    setTimeout(() => {
      send({ type: "agent_start" });
      finishAttempt(successMessage("retry recovered"), false);
    }, 25);
    return;
  }

  if (task.includes("FAIL_PROVIDER")) {
    finishAttempt(providerFailure(), false);
    return;
  }

  if (task.includes("EXCEED_TURN_BUDGET")) {
    const message = successMessage("still working");
    send({ type: "message_end", message });
    send({ type: "turn_end", message, toolResults: [] });
    setTimeout(() => {
      send({ type: "message_end", message });
      send({ type: "turn_end", message, toolResults: [] });
    }, 25);
    return;
  }

  if (task.includes("REPORT_CONSULT_SCOPE")) {
    finishAttempt(
      successMessage(JSON.stringify({
        scope: JSON.parse(process.env.PI_FABRIC_CONSULT_SCOPE_V1 ?? "null"),
        args: process.argv.slice(2),
      })),
      false,
    );
    return;
  }

  if (task.includes("REPORT_FABRIC_IDENTITY")) {
    finishAttempt(
      successMessage(
        JSON.stringify({
          mainAgentId: process.env.PI_FABRIC_MAIN_AGENT_ID,
          parentRun: process.env.PI_FABRIC_PARENT_RUN,
          traceId: process.env.PI_FABRIC_TRACE_ID,
          parentSpanId: process.env.PI_FABRIC_PARENT_SPAN_ID,
          agentName: process.env.PI_FABRIC_AGENT_NAME,
        }),
      ),
      false,
    );
    return;
  }

  const value = {
    action: "message",
    message: `validated persistentAgent response:${process.env.PI_FABRIC_FULL_CODE_MODE ?? "missing"}`,
  };
  finishAttempt(successMessage(JSON.stringify(value)), false);
});

process.stdin.on("end", () => {
  setTimeout(() => process.exit(0), 5);
});
process.stdin.resume();
