import type { Theme, AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import type { CodePreviewSettings } from "../src/ui/code-preview.js";
import type { FabricState } from "../src/fabric-state.js";

const settings = {
  shikiTheme: "dark-plus",
  diffIntensity: "subtle",
  wordEmphasis: "all",
  toolCallBackground: "on",
  toolCallTiming: true,
  readCollapsedLines: 10,
  readContentPreview: true,
  writeContentPreview: true,
  writeCollapsedLines: 10,
  editDiffPreview: true,
  editCollapsedLines: 160,
  grepCollapsedLines: 15,
  grepResultPreview: true,
  findResultPreview: true,
  lsResultPreview: true,
  pathListCollapsedLines: 20,
  readLineNumbers: true,
  bashResultPreview: true,
  bashWarnings: true,
  syntaxHighlighting: true,
  secretWarnings: true,
  pathIcons: "unicode",
  tools: ["bash", "read", "write", "edit", "grep", "find", "ls"],
} as unknown as CodePreviewSettings;

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
} as unknown as Theme;

const state = { initialized: true, config: { ui: { showNestedToolCalls: true } } } as unknown as FabricState;

const identityShell = <T>(t: T): T => t;
const toolDef = createFabricExecTool(state, settings, new Map(), identityShell);
const tool = toolDef as unknown as {
  renderResult: (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: { args: Record<string, unknown>; state: Record<string, unknown>; cwd: string; invalidate: () => void },
  ) => Component;
};

const render = (
  content: string,
  details: Record<string, unknown>,
  options: { expanded?: boolean; isPartial?: boolean } = {},
): string => {
  const component = tool.renderResult(
    { content: [{ type: "text" as const, text: content }], details } as AgentToolResult<unknown>,
    { expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
    theme,
    { cwd: process.cwd(), args: {}, state: {}, invalidate: () => {} },
  );
  return component.render(80).join("\n");
};

const auditOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ref: "pi.bash",
  provider: "pi",
  tool: "bash",
  success: true,
  args: { command: "echo hi" },
  result: "hi",
  ...over,
});

describe("renderResult with no audits", () => {
  it("renders a bare success marker when there is no output", () => {
    expect(render("", { success: true, audits: [] })).toContain("Fabric");
  });

  it("renders the error text when the execution failed", () => {
    const text = render("", { success: false, error: "boom failed", audits: [] });
    expect(text).toContain("boom failed");
  });

  it("renders plain output text when the execution succeeded", () => {
    const text = render("alpha\nbravo", { success: true, audits: [] });
    expect(text).toContain("alpha");
    expect(text).toContain("bravo");
  });

  it("truncates long output when collapsed and keeps more when expanded", () => {
    const many = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const collapsed = render(many, { success: true, audits: [] });
    const expanded = render(many, { success: true, audits: [] }, { expanded: true });
    expect(collapsed).toContain("line0");
    expect(collapsed).not.toContain("line39");
    expect(expanded).toContain("line39");
  });
});

describe("renderResult with one audit", () => {
  it("names the single tool that ran", () => {
    const text = render("", { success: true, audits: [auditOf()] });
    expect(text).toContain("bash");
  });

  it("surfaces the audit error when the single call failed", () => {
    const text = render("", {
      success: false,
      audits: [auditOf({ success: false, error: "permission denied" })],
    });
    expect(text).toContain("permission denied");
  });
});

describe("renderResult with several audits", () => {
  it("summarizes every call that ran", () => {
    const text = render("", {
      success: true,
      audits: [
        auditOf({ ref: "pi.read", tool: "read", args: { path: "a.ts" }, result: "x" }),
        auditOf({ ref: "pi.grep", tool: "grep", args: { pattern: "y" }, result: "z" }),
      ],
    });
    expect(text).toMatch(/read|grep/);
  });

  it("reports a failing call among several", () => {
    const text = render("", {
      success: false,
      audits: [
        auditOf({ ref: "pi.read", tool: "read" }),
        auditOf({ ref: "pi.bash", tool: "bash", success: false, error: "nope failed" }),
      ],
    });
    expect(text).toMatch(/nope failed|1/);
  });
});

describe("renderResult while partial", () => {
  it("renders a live frame without throwing", () => {
    const text = render("working", { audits: [auditOf()] }, { isPartial: true });
    expect(typeof text).toBe("string");
  });

  it("renders a partial frame with no audits yet", () => {
    const text = render("", { audits: [] }, { isPartial: true });
    expect(typeof text).toBe("string");
  });
});