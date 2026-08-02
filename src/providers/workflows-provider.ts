import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import {
  DurableWorkflowStore,
  type DurableWorkflowDefinition,
  type DurableWorkflowEvidenceRef,
} from "../workflows/durable.js";

const idProperty = { type: "string", minLength: 1, maxLength: 128 };
const phaseDefinitionSchema = {
  type: "object",
  properties: {
    id: idProperty,
    deps: { type: "array", items: idProperty, maxItems: 128 },
    objective: { type: "string", maxLength: 20_000 },
    maxAttempts: { type: "number", minimum: 1, maximum: 20 },
  },
  required: ["id"],
  additionalProperties: false,
};
const descriptors: FabricActionDescriptor[] = [
  {
    name: "create",
    description: "Create or reopen an idempotent mesh-backed durable phase graph",
    inputSchema: {
      type: "object",
      properties: {
        id: idProperty,
        name: { type: "string", minLength: 1, maxLength: 256 },
        phases: { type: "array", items: phaseDefinitionSchema, minItems: 1, maxItems: 128 },
        leaseMs: { type: "number", minimum: 1_000 },
      },
      required: ["id", "name", "phases"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "status",
    description: "Read one durable workflow and all bounded phase states",
    inputSchema: {
      type: "object",
      properties: { id: idProperty },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "list",
    description: "List durable workflows newest-first",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 1_000 } },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "claim",
    description: "Atomically lease one ready workflow phase to the current Fabric run",
    inputSchema: {
      type: "object",
      properties: { id: idProperty, phaseId: idProperty },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "complete",
    description: "Complete an identity-leased phase with bounded evidence and an output digest",
    inputSchema: {
      type: "object",
      properties: {
        id: idProperty,
        phaseId: idProperty,
        leaseToken: { type: "string", minLength: 1, maxLength: 256 },
        evidence: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["command", "artifact", "trace", "custom"] },
              ref: { type: "string", minLength: 1, maxLength: 2_048 },
              digest: { type: "string", maxLength: 256 },
            },
            required: ["kind", "ref"],
            additionalProperties: false,
          },
        },
        output: {},
      },
      required: ["id", "phaseId", "leaseToken"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "fail",
    description: "Fail or retry an identity-leased workflow phase",
    inputSchema: {
      type: "object",
      properties: {
        id: idProperty,
        phaseId: idProperty,
        leaseToken: { type: "string", minLength: 1, maxLength: 256 },
        error: { type: "string", minLength: 1, maxLength: 4_096 },
        retryable: { type: "boolean" },
      },
      required: ["id", "phaseId", "leaseToken", "error"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "resume",
    description: "Release expired leases and expose ready unfinished phases",
    inputSchema: {
      type: "object",
      properties: { id: idProperty },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "cancel",
    description: "Cancel every unfinished phase while retaining completed evidence",
    inputSchema: {
      type: "object",
      properties: { id: idProperty, reason: { type: "string", maxLength: 4_096 } },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "write",
  },
];

const definition = (args: Record<string, unknown>): DurableWorkflowDefinition => ({
  id: String(args.id),
  name: String(args.name),
  phases: Array.isArray(args.phases)
    ? args.phases.map((phase) => {
        const value = phase as Record<string, unknown>;
        return {
          id: String(value.id),
          ...(Array.isArray(value.deps)
            ? { deps: value.deps.filter((dep): dep is string => typeof dep === "string") }
            : {}),
          ...(typeof value.objective === "string" ? { objective: value.objective } : {}),
          ...(typeof value.maxAttempts === "number" ? { maxAttempts: value.maxAttempts } : {}),
        };
      })
    : [],
  ...(typeof args.leaseMs === "number" ? { leaseMs: args.leaseMs } : {}),
});

const evidence = (value: unknown): DurableWorkflowEvidenceRef[] | undefined =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const record = entry as Record<string, unknown>;
        const kind = record.kind;
        if (
          (kind !== "command" && kind !== "artifact" && kind !== "trace" && kind !== "custom") ||
          typeof record.ref !== "string"
        ) {
          return [];
        }
        return [{
          kind,
          ref: record.ref,
          ...(typeof record.digest === "string" ? { digest: record.digest } : {}),
        }];
      })
    : undefined;

export class WorkflowsProvider implements FabricProvider {
  readonly name = "workflows";
  readonly description = "Mesh-backed durable workflow phase graphs with leases and replay";

  constructor(readonly store: DurableWorkflowStore) {}

  async list(request: FabricProviderListRequest): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query)
        )
      : descriptors;
  }

  async describe(actionName: string): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    const id = String(args.id ?? "");
    switch (actionName) {
      case "create":
        return this.store.create(definition(args));
      case "status":
        return this.store.status(id);
      case "list":
        return this.store.list(typeof args.limit === "number" ? args.limit : 100);
      case "claim":
        return this.store.claim(id, {
          ownerRunId: context.run?.runId ?? context.parentToolCallId,
          ...(context.run?.traceId ? { ownerTraceId: context.run.traceId } : {}),
          ...(context.run?.spanId ? { ownerSpanId: context.run.spanId } : {}),
          ...(typeof args.phaseId === "string" ? { phaseId: args.phaseId } : {}),
        });
      case "complete":
        return this.store.complete(id, {
          phaseId: String(args.phaseId),
          leaseToken: String(args.leaseToken),
          ...(evidence(args.evidence) ? { evidence: evidence(args.evidence)! } : {}),
          ...(Object.prototype.hasOwnProperty.call(args, "output") ? { output: args.output } : {}),
        });
      case "fail":
        return this.store.fail(id, {
          phaseId: String(args.phaseId),
          leaseToken: String(args.leaseToken),
          error: String(args.error),
          ...(typeof args.retryable === "boolean" ? { retryable: args.retryable } : {}),
        });
      case "resume":
        return this.store.resume(id);
      case "cancel":
        return this.store.cancel(id, typeof args.reason === "string" ? args.reason : undefined);
      default:
        throw new Error(`Unknown workflows action: ${actionName}`);
    }
  }
}
