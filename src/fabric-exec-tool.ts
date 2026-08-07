import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { renderFabricExecCall, renderFabricExecResult } from "./fabric-exec-render.js";
import type { CodePreviewSettings } from "./ui/code-preview.js";
import {
  type FabricToolShellDecorator,
  withCodePreviewShell,
} from "./ui/code-preview-shell.js";
import { Type } from "typebox";
import { createFabricPersistedExecutionDetails } from "./audit/index.js";
import type { FabricState } from "./fabric-state.js";
import { formatFailureProgress } from "./failure-progress.js";
import { typeErrorRecoveryHint } from "./type-error-guidance.js";
import { normalizeRunDisplay } from "./run-display.js";
import type { PendingFabricHandoff } from "./prewalk/handoff.js";
import type { FabricMediaBlock } from "./protocol.js";
import { boundModelOutput, modelOutputBudget } from "./output-budget.js";
import { formatFabricValue } from "./ui/structured.js";
import { countNewlines } from "./util.js";

const RESULT_FORMATS = ["auto", "yaml", "json", "text"] as const;

export const createFabricExecTool = (
  state: FabricState,
  codePreviewSettings: CodePreviewSettings,
  pendingHandoffs: Map<string, PendingFabricHandoff>,
  decorateShell: FabricToolShellDecorator = withCodePreviewShell,
): ToolDefinition<any, any, any> => decorateShell(
  defineTool({
    name: "fabric_exec",
    label: "Fabric",
    description:
      "Execute type-checked TypeScript through Fabric for discovery, providers, agents, MCP, extensions, and, in full-code or Schema enforce mode, Pi core tools. QuickJS is isolated; Node mode is trusted and unsafe.",
    promptSnippet:
      "Pi core tools, MCP, Fabric providers, discovery, and extensions",
    promptGuidelines: [
      "In `fabric_exec`, batch only independent, bounded work; use `Promise.all` for independent calls and sequence search→read and edit→verify. Search with bounded `pi.grep`/`pi.find`, use `pi.read` ranges and `literal:true` for punctuated text, and coalesce same-file replacements into one `pi.edit({path, edits:[...]})` call.",
      "In `fabric_exec` coding work, keep an acceptance ledger; trace the execution path, use direct behavioral probes, confirm requested public symbols, registrations, and configuration entries, and run the smallest relevant checks. Inspect failures instead of rerunning unchanged checks. A build alone is not completion.",
      "In `fabric_exec`, use `settle:true` for expected nonzero probes, set one realistic timeout, pass multiline payloads through top-level `strings` and π, prefer `pi.edit`/`pi.write`, and return compact decisions and evidence—not raw logs or unused intermediate results.",
    ],
    // The model-facing schema is intentionally flat: one large `code` string
    // plus scalar/optional params. Do not add nested arrays-of-objects with
    // escaped content here. SOTA models are post-trained on one dominant
    // harness's flat tool shapes and can invent trailing keys at the
    // highest-entropy point of a nested escaped-JSON field, which a strict
    // schema hard-rejects. Keep this surface string/scalar-heavy; the only
    // nested field (display) ignores unknown keys. See
    // lucumr.pocoo.org/2026/7/4/better-models-worse-tools/ and pi-tool-repair.
    // display also accepts a bare (or JSON-object) string, silently repaired
    // to { name } via normalizeRunDisplay: flash-tier models cold-start with
    // that near-miss, and repairing beats a zero-work rejection round trip.
    parameters: Type.Object({
      code: Type.String({
        description:
          "TypeScript body with top-level await/return. Globals: tools, mcp, memory, state, schema, compact, agents, mesh, print, and π; full-code mode adds pi and extensions. Load the fabric-exec skill for exact signatures.",
      }),
      strings: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Named strings exposed as π.key, useful for content that is awkward to quote",
        }),
      ),
      resultFormat: Type.Optional(Type.Union(RESULT_FORMATS.map((value) => Type.Literal(value)))),
      tokenBudget: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Optional token budget observed by workflow.agent() calls",
        }),
      ),
      agentBudget: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Optional agent-call cap, bounded by Fabric configuration",
        }),
      ),
      display: Type.Optional(
        Type.Union([
          Type.Object(
            {
              name: Type.Optional(
                Type.String({ description: "Human-readable name for the Fabric activity panel" }),
              ),
              description: Type.Optional(
                Type.String({ description: "Compact objective shown in the Fabric dashboard" }),
              ),
            },
          ),
          Type.String({
            description:
              "Objective shorthand normalized to { name } (a JSON-object string is parsed). Prefer the object form when available.",
          }),
        ]),
      ),
    }),
    renderCall(params, theme, context) {
      return renderFabricExecCall(params, theme, context, {
        state,
        codePreviewSettings,
      });
    },
    renderResult(result, view, theme, context) {
      return renderFabricExecResult(result, view, theme, context, {
        state,
        codePreviewSettings,
      });
    },
    async execute(toolCallId, params, signal, onUpdate, context) {
      await state.ensure(context);
      // Defensive: a non-strict provider may deliver code as an array of lines;
      // join before type-checking so the program runs instead of failing on a
      // non-string code param. Strict providers reject an array upstream
      // against the Type.String schema, so this branch is a no-op there.
      const code = Array.isArray(params.code) ? params.code.join("\n") : params.code;
      const sessionId = context.sessionManager.getSessionId();
      const prewalk = state.prewalk.executionBoundary(sessionId);
      const runDisplay = normalizeRunDisplay(params.display);
      const result = await state.execution.execute({
        code,
        ...(params.strings ? { strings: params.strings } : {}),
        signal,
        parentToolCallId: toolCallId,
        context,
        ...(prewalk ? { prewalk } : {}),
        ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
        ...(params.agentBudget !== undefined ? { maxAgentCalls: params.agentBudget } : {}),
        ...(runDisplay
          ? {
              display: {
                ...(runDisplay.name !== undefined && { name: runDisplay.name }),
                ...(runDisplay.description !== undefined && { description: runDisplay.description }),
              },
            }
          : {}),
        onPartial(snapshot) {
          onUpdate?.({
            content: [{ type: "text", text: snapshot.progress ?? "" }],
            details: {
              progress: snapshot.progress,
              audits: snapshot.audits,
              phases: snapshot.phases,
            },
          });
        },
      });

      const selectedResultFormat =
        params.resultFormat ?? state.config.executor.resultFormat;
      const pendingHandoff = state.claimHandoff(
        result,
        sessionId,
        selectedResultFormat,
        toolCallId,
      );
      if (pendingHandoff) {
        pendingHandoffs.set(toolCallId, pendingHandoff);
        context.ui.setStatus(
          "fabric-prewalk",
          `waiting for fabric_exec boundary → ${String(pendingHandoff.args.model ?? "executor")}`,
        );
      }
      const fullFormattedValue = formatFabricValue(result.value, selectedResultFormat);
      const failureProgress = formatFailureProgress(result.trace);
      const fullSections = [...result.logs];
      if (fullFormattedValue.text) fullSections.push(fullFormattedValue.text);
      if (result.error) fullSections.push(`Runtime error: ${result.error}`);
      if (failureProgress) fullSections.push(failureProgress);
      const fullRawOutput = fullSections.join("\n\n");
      const outputBudget = modelOutputBudget(
        state.config.executor.maxOutputChars,
        result.success,
      );
      const outputWillTruncate = fullRawOutput.length > outputBudget;
      const formattedValue = outputWillTruncate
        ? formatFabricValue(
            result.value,
            selectedResultFormat,
            outputBudget,
          )
        : fullFormattedValue;
      const sections = [...result.logs];
      const logPrefix = result.logs.join("\n\n");
      if (formattedValue.text) sections.push(formattedValue.text);
      if (result.error) sections.push(`Runtime error: ${result.error}`);
      if (failureProgress) sections.push(failureProgress);
      const rawOutput = sections.join("\n\n");
      const outputFormat =
        formattedValue.language &&
        formattedValue.text &&
        (result.logs.length === 0 || !outputWillTruncate)
          ? formattedValue.language
          : undefined;
      const outputFormatStartLine = result.logs.length > 0
        ? countNewlines(logPrefix) + 2
        : 0;
      const persistedDetails = createFabricPersistedExecutionDetails({
        ...result,
        ...(outputFormat ? { outputFormat, outputFormatStartLine } : {}),
        ...(outputFormat
          ? {
              outputFormatLines:
                formattedValue.highlightedLineCount
                ?? countNewlines(formattedValue.text) + 1,
            }
          : {}),
      });

      if (result.typeErrors) {
        const text = result.typeErrors
          .map((error) =>
            error.line > 0
              ? `Line ${error.line}:${error.column} — ${error.message}`
              : error.message,
          )
          .join("\n");
        const recoveryHint = typeErrorRecoveryHint(code, result.typeErrors);
        const bounded = await boundModelOutput(
          `Type errors; code was not executed:\n${text}${
            recoveryHint ? `\n\n${recoveryHint}` : ""
          }`,
          outputBudget,
        );
        return {
          content: [{ type: "text", text: bounded.text }],
          details: persistedDetails,
          isError: true,
        };
      }

      const output = (await boundModelOutput(
        rawOutput || "(no output)",
        outputBudget,
        fullRawOutput || "(no output)",
      )).text;
      const terminate =
        pendingHandoff !== undefined ||
        (result.success &&
          typeof result.value === "object" &&
          result.value !== null &&
          "terminate" in result.value &&
          result.value.terminate === true);
      // A nested `pi.read` of an image returns image content blocks that
      // normalizeResult stripped (the sandbox holds text only). The provider
      // handed them out-of-band to each call audit; re-attach them here so
      // pi core's ToolExecutionComponent renders a kitty image preview — the
      // same path a native `read` takes — for single-call AND multitool
      // reads. pi-vision-handoff keeps the image in the nested tool_result
      // (its `context` hook swaps image→description on the LLM-bound
      // fabric_exec clone), so every read audit carries its image here.
      const mediaBlocks: FabricMediaBlock[] = [];
      for (const audit of result.audits) {
        if (audit.media) mediaBlocks.push(...audit.media);
      }
      const singleAudit = result.audits.length === 1 ? result.audits[0] : undefined;
      // The read tool's own text note (e.g. "Read image file [image/png]"),
      // captured after the handoff stripped pi's non-vision note. Used as
      // the single-call body + content text so the preview shows the kitty
      // image + the clean note (like pi core) instead of the handoff's
      // verbose description. Multitool renders each read's note as its own
      // call body, so the joined program return suffices as the content text
      // there.
      const mediaNote = singleAudit?.mediaNote;
      // The base64 payload now lives in the result content; discard the
      // duplicate in-memory audit copies before returning.
      for (const audit of result.audits) {
        delete audit.media;
        delete audit.mediaNote;
      }
      const content: Array<{ type: "text"; text: string } | FabricMediaBlock> = [];
      if (mediaBlocks.length > 0) {
        // Mirror a native `read`: keep the image block(s) for pi core's kitty
        // render alongside the short note. The handoff's `context` hook
        // swaps each image for its description on the LLM-bound clone, so the
        // text-only model still receives the description while the terminal
        // shows the kitty image.
        const textOutput =
          singleAudit && mediaNote
            ? mediaNote
            : (output === "(no output)" ? "" : output);
        if (textOutput) content.push({ type: "text", text: textOutput });
        for (const block of mediaBlocks) content.push(block);
        if (singleAudit && mediaNote) {
          singleAudit.result = mediaNote;
        }
      } else {
        content.push({ type: "text", text: output });
      }
      return {
        content,
        details: persistedDetails,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(terminate ? { terminate: true } : {}),
        ...(result.success ? {} : { isError: true }),
      };
    },
  }),
  {
    mode: codePreviewSettings.toolCallBackground,
    toolCallTiming: codePreviewSettings.toolCallTiming,
  },
);
