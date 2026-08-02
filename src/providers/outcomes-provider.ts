import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import { FabricOutcomeStore, evaluateDeterministic } from "../outcomes/store.js";

const id = { type: "string", minLength: 1, maxLength: 256 };
const descriptors: FabricActionDescriptor[] = [
  {
    name: "list",
    description: "List bounded derived Fabric run outcomes without prompts or result bodies",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 10_000 } },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "status",
    description: "Read one outcome by outcome id or run id",
    inputSchema: {
      type: "object",
      properties: { id },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "evaluate",
    description: "Score a deterministic exact, contains, or numeric fixture and append only its verdict",
    inputSchema: {
      type: "object",
      properties: {
        id,
        scorer: { type: "string", enum: ["exact", "contains", "numeric"] },
        actual: {},
        expected: {},
        tolerance: { type: "number", minimum: 0 },
      },
      required: ["id", "scorer", "actual", "expected"],
      additionalProperties: false,
    },
    risk: "write",
    effect: "state",
  },
  {
    name: "judge",
    description: "Append an optional external model-judge score without persisting judge prose",
    inputSchema: {
      type: "object",
      properties: {
        id,
        scorer: { type: "string", minLength: 1, maxLength: 256 },
        evaluator: { type: "string", minLength: 1, maxLength: 256 },
        score: { type: "number", minimum: 0, maximum: 1 },
        passed: { type: "boolean" },
      },
      required: ["id", "scorer", "evaluator", "score", "passed"],
      additionalProperties: false,
    },
    risk: "write",
    effect: "state",
  },
  {
    name: "recommend",
    description: "Rank model routes only after each candidate reaches the configured sample minimum",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
];

export class OutcomesProvider implements FabricProvider {
  readonly name = "outcomes";
  readonly description = "Bounded run outcomes, deterministic evaluation, and sample-gated recommendations";

  constructor(readonly store: FabricOutcomeStore) {}

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
    _context: FabricInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "list":
        return this.store.list(typeof args.limit === "number" ? args.limit : undefined);
      case "status":
        return this.store.status(String(args.id));
      case "evaluate": {
        const evaluation = evaluateDeterministic({
          scorer: args.scorer as "exact" | "contains" | "numeric",
          actual: args.actual,
          expected: args.expected,
          ...(typeof args.tolerance === "number" ? { tolerance: args.tolerance } : {}),
        });
        return this.store.evaluate(String(args.id), evaluation);
      }
      case "judge":
        return this.store.evaluate(String(args.id), {
          kind: "model_judge",
          scorer: String(args.scorer),
          evaluator: String(args.evaluator),
          score: Number(args.score),
          passed: args.passed === true,
        });
      case "recommend":
        return this.store.recommend();
      default:
        throw new Error(`Unknown outcomes action: ${actionName}`);
    }
  }
}
