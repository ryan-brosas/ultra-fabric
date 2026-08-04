import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("prewalk prompt isolation", () => {
  it("does not add prewalk state or guidance to before_agent_start", () => {
    const extensionSource = fs.readFileSync(
      path.join(process.cwd(), "src", "index.ts"),
      "utf8",
    );
    const toolSource = fs.readFileSync(
      path.join(process.cwd(), "src", "fabric-exec-tool.ts"),
      "utf8",
    );
    const start = extensionSource.indexOf('pi.on("before_agent_start"');
    const end = extensionSource.indexOf("registerFabricCommand", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const handler = extensionSource.slice(start, end);
    expect(handler.toLowerCase()).not.toContain("prewalk");

    const guidelinesStart = toolSource.indexOf("promptGuidelines: [");
    const guidelinesEnd = toolSource.indexOf("parameters:", guidelinesStart);
    expect(guidelinesStart).toBeGreaterThanOrEqual(0);
    expect(guidelinesEnd).toBeGreaterThan(guidelinesStart);
    const guidelines = toolSource.slice(guidelinesStart, guidelinesEnd).toLowerCase();
    expect(guidelines).not.toContain("prewalk");
    expect(guidelines).not.toContain("handoff");
  });

  it("filters hidden continuations by lifecycle ownership in the context hook", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "index.ts"), "utf8");
    const start = source.indexOf('pi.on("context"');
    const end = source.indexOf('pi.on("before_agent_start"', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).toContain("filterPrewalkContinuationMessages");
    expect(handler).toContain("filterPrewalkPlanningMessages");
    expect(handler).toContain("state.prewalk.acceptContinuation");
    expect(handler).toContain("state.prewalk.isArmed");
    expect(handler).not.toContain("state.prewalk.isResearchPlanning");
    expect(handler).toContain("context.sessionManager.getSessionId()");
    expect(handler).toContain("applyContextQos");
    expect(handler).toContain("state.noteContextQos");
  });

  it("keeps coding guidance outcome-oriented and context-bounded", () => {
    const toolSource = fs.readFileSync(
      path.join(process.cwd(), "src", "fabric-exec-tool.ts"),
      "utf8",
    );
    const start = toolSource.indexOf("promptGuidelines: [");
    const end = toolSource.indexOf("parameters:", start);
    const guidelines = toolSource.slice(start, end);
    const visibleGuidelines = guidelines
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"') && line.endsWith('",'));
    const visibleGuidelineChars = visibleGuidelines.reduce(
      (total, line) => total + line.length - 3,
      0,
    );

    expect(visibleGuidelines).toHaveLength(3);
    expect(visibleGuidelineChars).toBeLessThanOrEqual(1_200);
    expect(guidelines).toContain("acceptance ledger");
    expect(guidelines).toContain("direct behavioral probes");
    expect(guidelines).toContain("requested public symbols, registrations, and configuration entries");
    expect(guidelines).toContain("A build alone is not completion");
    expect(guidelines).toContain("one `pi.edit({path, edits:[...]})`");
    expect(guidelines).toContain("`literal:true`");
    expect(guidelines).toContain("`settle:true`");
    expect(guidelines).toContain("batch only independent, bounded work");
    expect(guidelines).toContain("not raw logs");
    expect(guidelines).toContain("top-level `strings`");
    expect(visibleGuidelines.every((line) => line.includes("fabric_exec"))).toBe(true);
  });

  it("keeps full-code session guidance under its recurring budget", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "index.ts"), "utf8");
    const start = source.indexOf('? "Pi Fabric full code mode:');
    const end = source.indexOf(': "Pi Fabric orchestration-only mode', start);
    const guidance = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(guidance.length).toBeLessThanOrEqual(800);
    expect(guidance).toContain("fabric_exec");
    expect(guidance).toContain("pi.*");
    expect(guidance).toContain("tools.call");
    expect(guidance).toContain("settle:true");
  });

  it("runs handoff from finalized outer message_end without aborting nested calls", () => {
    const extensionSource = fs.readFileSync(
      path.join(process.cwd(), "src", "index.ts"),
      "utf8",
    );
    const toolSource = fs.readFileSync(
      path.join(process.cwd(), "src", "fabric-exec-tool.ts"),
      "utf8",
    );
    const start = extensionSource.indexOf('pi.on("tool_result"');
    const end = extensionSource.indexOf('pi.on("tool_execution_end"', start);
    const boundaryHandlers = extensionSource.slice(start, end);

    expect(boundaryHandlers).toContain('pi.on("message_end"');
    expect(boundaryHandlers).toContain("state.runHandoffAtBoundary");
    expect(toolSource).toContain("state.claimHandoff");
    expect(toolSource).toContain("state.prewalk.executionBoundary(sessionId)");
    expect(toolSource).toContain("...(prewalk ? { prewalk } : {})");
  });

  it("selects a prunable planning message type for research arms", () => {
    // Arming moved to the shared helper so the command and configured
    // auto-arming produce the same message type and dedupe.
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "prewalk", "arm.ts"),
      "utf8",
    );
    expect(source).toContain("prewalkArmedMessageType()");
    expect(source).toContain("customType: armedMessageType");
    expect(source).toContain("hasPrewalkArmedPrompt(");
  });

  it("disarms the captured task from the agent_settled lifecycle", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "index.ts"), "utf8");
    const start = source.indexOf('pi.on("agent_settled"');
    const end = source.indexOf('pi.on("tool_call"', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).toContain("state.prewalk.settleContinuation");
    expect(handler).toContain("settledContinuation.returnModel");
    expect(handler).toContain("restorePrewalkModel");
    expect(handler).toContain("state.prewalk.settleTask");
  });
});
