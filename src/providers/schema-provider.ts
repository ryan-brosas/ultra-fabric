import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import { SchemaController } from "../schema/controller.js";
import type { SchemaEvidence, SchemaFileOperation } from "../schema/types.js";

const pathProperty = { type: "string", minLength: 1 };
const evidenceSchema = {
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "file_exists" }, path: pathProperty },
      required: ["kind", "path"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "file_absent" }, path: pathProperty },
      required: ["kind", "path"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "file_contains" },
        path: pathProperty,
        literal: { type: "string", minLength: 1 },
      },
      required: ["kind", "path", "literal"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "file_sha256" },
        path: pathProperty,
        sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      },
      required: ["kind", "path", "sha256"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "trusted_command" },
        name: { type: "string", minLength: 1 },
      },
      required: ["kind", "name"],
      additionalProperties: false,
    },
  ],
};

const expectedSchema = {
  oneOf: [
    {
      type: "object",
      properties: { absent: { const: true } },
      required: ["absent"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } },
      required: ["sha256"],
      additionalProperties: false,
    },
  ],
};

const operationSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "write" },
        path: pathProperty,
        content: { type: "string" },
        expected: expectedSchema,
      },
      required: ["kind", "path", "content", "expected"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "edit" },
        path: pathProperty,
        oldText: { type: "string", minLength: 1 },
        newText: { type: "string" },
        expectedSha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      },
      required: ["kind", "path", "oldText", "newText", "expectedSha256"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "delete" },
        path: pathProperty,
        expectedSha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      },
      required: ["kind", "path", "expectedSha256"],
      additionalProperties: false,
    },
  ],
};

const descriptors: FabricActionDescriptor[] = [
  {
    name: "status",
    description: "Read the fixed session Schema mode, transaction bounds, generation, and invocation hypotheses",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    namespace: "schema",
  },
  {
    name: "hypothesize",
    description: "Durably bind a falsifiable hypothesis and nonempty typed evidence to the current state and workspace",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", minLength: 1 },
        summary: { type: "string", minLength: 1 },
        evidence: { type: "array", minItems: 1, items: evidenceSchema },
        complexityReduction: { type: "boolean" },
      },
      required: ["label", "summary", "evidence"],
      additionalProperties: false,
    },
    risk: "write",
    namespace: "schema",
  },
  {
    name: "verify",
    description: "Fail-closed verification that may issue one fresh invocation-bound single-use certificate",
    inputSchema: {
      type: "object",
      properties: { hypothesisId: { type: "string", minLength: 1 } },
      required: ["hypothesisId"],
      additionalProperties: false,
    },
    risk: "execute",
    namespace: "schema",
  },
  {
    name: "commit",
    description: "Consume one same-invocation certificate and atomically attempt bounded declared-file operations with rollback and postconditions",
    inputSchema: {
      type: "object",
      properties: {
        hypothesisId: { type: "string", minLength: 1 },
        certificate: { type: "string", minLength: 1 },
        operations: { type: "array", minItems: 1, items: operationSchema },
        postconditions: { type: "array", minItems: 1, items: evidenceSchema },
      },
      required: ["hypothesisId", "certificate", "operations", "postconditions"],
      additionalProperties: false,
    },
    risk: "execute",
    effect: "workspace",
    namespace: "schema",
  },
  {
    name: "abort",
    description: "Abort an uncommitted same-invocation hypothesis and optionally its active certificate",
    inputSchema: {
      type: "object",
      properties: {
        hypothesisId: { type: "string", minLength: 1 },
        certificate: { type: "string", minLength: 1 },
      },
      required: ["hypothesisId"],
      additionalProperties: false,
    },
    risk: "write",
    namespace: "schema",
  },
];

export class SchemaProvider implements FabricProvider {
  readonly name = "schema";
  readonly description = "Host-owned, opt-in Schema verification and bounded local-file transaction control plane";

  constructor(readonly controller: SchemaController) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "status":
        return this.controller.status(context.parentToolCallId);
      case "hypothesize":
        return this.controller.hypothesize(
          {
            label: String(args.label),
            summary: String(args.summary),
            evidence: args.evidence as SchemaEvidence[],
            ...(args.complexityReduction === true ? { complexityReduction: true } : {}),
          },
          context,
        );
      case "verify":
        return this.controller.verify(String(args.hypothesisId), context);
      case "commit":
        return this.controller.commit(
          {
            hypothesisId: String(args.hypothesisId),
            certificate: String(args.certificate),
            operations: args.operations as SchemaFileOperation[],
            postconditions: args.postconditions as SchemaEvidence[],
          },
          context,
        );
      case "abort":
        return this.controller.abort(
          {
            hypothesisId: String(args.hypothesisId),
            ...(typeof args.certificate === "string" ? { certificate: args.certificate } : {}),
          },
          context,
        );
      default:
        throw new Error(`Unknown schema action: ${actionName}`);
    }
  }

  async invocationEnded(parentToolCallId: string): Promise<void> {
    await this.controller.endInvocation(parentToolCallId);
  }
}
