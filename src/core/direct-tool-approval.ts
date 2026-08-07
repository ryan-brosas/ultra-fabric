import type { Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { FabricConfig } from "../config.js";
import type { ResolvedFabricAction } from "./action-registry.js";
import { isRecord } from "../util.js";
import {
  ApprovalController,
  FabricSessionApprovals,
  type FabricAutoApprovalAudit,
} from "./approval-controller.js";
import {
  FabricAutoApprovalClassifier,
  type FabricAutoApprovalDecision,
} from "./auto-approval-classifier.js";


const addUsage = (left: Usage, right: Usage): Usage => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  ...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
    ? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }
    : {}),
  ...(left.reasoning !== undefined || right.reasoning !== undefined
    ? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }
    : {}),
  totalTokens: left.totalTokens + right.totalTokens,
  cost: {
    input: left.cost.input + right.cost.input,
    output: left.cost.output + right.cost.output,
    cacheRead: left.cost.cacheRead + right.cost.cacheRead,
    cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
    total: left.cost.total + right.cost.total,
  },
});

export const mergeFabricApprovalUsage = (
  existing: Usage | undefined,
  approval: Usage,
): Usage => existing ? addUsage(existing, approval) : approval;

export class FabricDirectToolApproval {
  readonly #pendingUsage = new Map<string, Usage>();

  constructor(
    readonly pi: Pick<ExtensionAPI, "getAllTools">,
    readonly getConfig: () => FabricConfig,
    readonly sessionApprovals: FabricSessionApprovals,
    readonly classifier = new FabricAutoApprovalClassifier(),
    readonly onAutoDecision?: (
      audit: FabricAutoApprovalAudit,
      decision?: FabricAutoApprovalDecision,
    ) => void,
  ) {}

  async approve(event: ToolCallEvent, context: ExtensionContext): Promise<void> {
    const config = this.getConfig();
    const action = this.#resolve(event.toolName, config);
    const controller = new ApprovalController(
      config.approvals,
      context,
      this.sessionApprovals,
      this.classifier,
      (audit, decision) => {
        this.onAutoDecision?.(audit, decision);
        if (decision) this.#pendingUsage.set(event.toolCallId, decision.usage);
      },
    );
    await controller.approve(action, isRecord(event.input) ? event.input : {});
  }

  takeUsage(toolCallId: string): Usage | undefined {
    const usage = this.#pendingUsage.get(toolCallId);
    this.#pendingUsage.delete(toolCallId);
    return usage;
  }

  clear(): void {
    this.#pendingUsage.clear();
  }

  #resolve(toolName: string, config: FabricConfig): ResolvedFabricAction {
    const metadata = this.pi.getAllTools().find((tool) => tool.name === toolName);
    const builtin = metadata?.sourceInfo.source === "builtin";
    const provider = builtin ? "pi" : "extensions";
    return {
      ref: provider + "." + toolName,
      provider,
      name: toolName,
      description: metadata?.description ?? "Direct Pi tool: " + toolName,
      inputSchema: isRecord(metadata?.parameters) ? metadata.parameters : {},
      risk: config.capture.risks[toolName] ?? config.capture.defaultRisk,
    };
  }
}
