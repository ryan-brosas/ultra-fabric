import fs from "node:fs";
import path from "node:path";

const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? value
  : 0;

const operationSummary = (result) => {
  const operations = Array.isArray(result?.details?.trace?.operations)
    ? result.details.trace.operations
    : [];
  const checklist = operations.find(
    (operation) => operation?.ref === "fabric.prewalk.checklist" && operation?.outcome === "succeeded",
  );
  const items = Array.isArray(checklist?.args?.items) ? checklist.args.items.length : 0;
  const workspaceMutations = operations.filter(
    (operation) => operation?.effect === "workspace" && operation?.outcome === "succeeded",
  ).length;
  return {
    type: "fabric_exec",
    checklistItems: items,
    workspaceMutations,
    terminate: result?.terminate === true,
  };
};

export default function prewalkBenchmarkProbe(pi) {
  const output = process.env.PI_FABRIC_PREWALK_PROBE_PATH;
  if (!output || !path.isAbsolute(output)) return;
  const append = (record) => fs.appendFileSync(output, `${JSON.stringify(record)}\n`, "utf8");
  let phase = "unknown";
  let requestIndex = 0;

  pi.on("context", (event) => {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const planningPresent = messages.some(
      (message) => message?.role === "custom" &&
        message?.customType === "pi-fabric-prewalk-research-plan",
    );
    const armedPresent = messages.some(
      (message) => message?.role === "custom" &&
        message?.customType === "pi-fabric-prewalk-armed",
    );
    const continuationPresent = messages.some(
      (message) => message?.role === "custom" &&
        message?.customType === "pi-fabric-prewalk-continue",
    );
    phase = continuationPresent ? "executor" : planningPresent || armedPresent ? "frontier" : "unknown";
    requestIndex += 1;
    append({
      type: "context",
      requestIndex,
      phase,
      planningPresent,
      continuationPresent,
    });
  });

  pi.on("message_end", (event) => {
    const message = event?.message;
    if (message?.role !== "assistant") return;
    const inputTokens = Math.floor(finite(message.usage?.input));
    const outputTokens = Math.floor(finite(message.usage?.output));
    const cacheReadTokens = Math.floor(finite(message.usage?.cacheRead));
    const cacheWriteTokens = Math.floor(finite(message.usage?.cacheWrite));
    append({
      type: "message",
      requestIndex,
      phase,
      provider: typeof message.provider === "string" ? message.provider.slice(0, 128) : "",
      model: typeof message.model === "string" ? message.model.slice(0, 256) : "",
      contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: Math.floor(finite(message.usage?.totalTokens)),
    });
  });

  pi.on("tool_execution_end", (event) => {
    if (event?.toolName !== "fabric_exec") return;
    append({ ...operationSummary(event.result), isError: event.isError === true });
  });
}
