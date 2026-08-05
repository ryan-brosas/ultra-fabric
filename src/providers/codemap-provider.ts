import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import { codemapOperation } from "../codemap/tool.js";

const descriptors: FabricActionDescriptor[] = [
  {
    name: "skeleton",
    description: "Render a minimal AST-compressed skeleton of the repository, limited by maxTokens",
    inputSchema: {
      type: "object",
      properties: {
        maxTokens: { type: "number", minimum: 100, maximum: 20000 },
      },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "search",
    description: "Route a query to the symbol or literal index and return matching definitions",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        maxTokens: { type: "number", minimum: 100, maximum: 20000 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "cascade",
    description: "Predict co-change cascade from a seed file or name:file symbol key, blending git history and AST dependency channels",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "string", minLength: 1 },
        maxTokens: { type: "number", minimum: 100, maximum: 20000 },
      },
      required: ["seed"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "expand",
    description: "Progressive disclosure: expand the dependency neighborhood around one or more entity keys",
    inputSchema: {
      type: "object",
      properties: {
        entities: { type: "array", minItems: 1, items: { type: "string" } },
        direction: { type: "string", enum: ["upstream", "downstream", "both"] },
        depth: { type: "number", minimum: 1, maximum: 2 },
        maxTokens: { type: "number", minimum: 100, maximum: 20000 },
      },
      required: ["entities"],
      additionalProperties: false,
    },
    risk: "read",
  },
];

export class CodemapProvider implements FabricProvider {
  readonly name = "codemap";
  readonly description = "AST-compressed code map for incremental navigation — symbol search, call/import graph, and progressive disclosure of entity neighborhoods";

  async list(request: FabricProviderListRequest): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? descriptors.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query))
      : descriptors;
  }

  async describe(name: string): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((item) => item.name === name);
  }

  async invoke(name: string, args: Record<string, unknown>, context: FabricInvocationContext) {
    switch (name) {
      case "skeleton":
        return codemapOperation("skeleton", { maxTokens: Number(args.maxTokens ?? 4000) }, context.cwd);
      case "search":
        return codemapOperation("search", { query: String(args.query ?? ""), maxTokens: Number(args.maxTokens ?? 4000) }, context.cwd);
      case "cascade":
        return codemapOperation("cascade", { seed: String(args.seed ?? ""), maxTokens: Number(args.maxTokens ?? 4000) }, context.cwd);
      case "expand":
        return codemapOperation("expand", { entities: Array.isArray(args.entities) ? args.entities.map(String) : [String(args.entities)], direction: args.direction as any, depth: args.depth as any, maxTokens: Number(args.maxTokens ?? 4000) }, context.cwd);
      default:
        throw new Error(`Unknown codemap action: ${name}`);
    }
  }
}