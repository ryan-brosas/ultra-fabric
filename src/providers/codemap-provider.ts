import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import { codemapOperation, type CgcToolOptions } from "../codemap/tool.js";

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
    name: "focus",
    description: "Heat-diffuse query seeds through the code graph (t=4) and render hot/warm/glow tiers bounded by maxTokens",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        t: { type: "number", minimum: 1, maximum: 64 },
        maxTokens: { type: "number", minimum: 100, maximum: 20000 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "dwell",
    description: "Expand an active focus field (diffusion time grows) and return the delta against already-disclosed nodes",
    inputSchema: {
      type: "object",
      properties: {
        t: { type: "number", minimum: 1, maximum: 64 },
        disclosed: { type: "array", items: { type: "string" } },
        maxTokens: { type: "number", minimum: 100, maximum: 20000 },
      },
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
  {
    name: "explore",
    description: "Bounded staged evidence pack for a task query: skeleton, routed symbols, complexity hotspots, seam-test pointers, and top source (ast graph), or the CGC reference graph when mode is cgc",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["ast", "cgc"] },
        context: { type: "string" },
        maxTokens: { type: "number", minimum: 100, maximum: 20000 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "source",
    description: "Return the AST range text of a name:file symbol key, bounded by maxTokens",
    inputSchema: {
      type: "object",
      properties: {
        entities: { type: "array", minItems: 1, maxItems: 1, items: { type: "string" } },
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
  readonly description = "AST-compressed code map for incremental navigation — symbol search, call/import graph, and progressive disclosure of entity neighborhoods; mode cgc queries the separate read-only CodeGraphContext reference graph";

  #cgc: (() => CgcToolOptions | undefined) | undefined;

  constructor(cgc?: () => CgcToolOptions | undefined) {
    this.#cgc = cgc;
  }

  #opts = (args: Record<string, unknown>): { cgc: CgcToolOptions } | undefined => {
    const cfg = this.#cgc?.();
    return cfg ? { cgc: cfg } : undefined;
  };

  #commonArgs = (args: Record<string, unknown>): Record<string, unknown> =>
    Object.assign(
      {},
      args.mode === "cgc" ? { mode: "cgc" as const } : {},
      typeof args.context === "string" && args.context ? { context: args.context } : {},
    );

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
        return codemapOperation("skeleton", Object.assign({ maxTokens: Number(args.maxTokens ?? 4000) }, this.#commonArgs(args)), context.cwd, this.#opts(args));
      case "search":
        return codemapOperation("search", Object.assign({ query: String(args.query ?? ""), maxTokens: Number(args.maxTokens ?? 4000) }, this.#commonArgs(args)), context.cwd, this.#opts(args));
      case "focus":
        return codemapOperation("focus", { query: String(args.query ?? ""), t: Number(args.t ?? 4), maxTokens: Number(args.maxTokens ?? 4000) }, context.cwd);
      case "dwell":
        return codemapOperation("dwell", Object.assign({ maxTokens: Number(args.maxTokens ?? 4000) }, args.t != null ? { t: Number(args.t) } : {}, Array.isArray(args.disclosed) ? { disclosed: args.disclosed.map(String) } : {}), context.cwd);
      case "cascade":
        return codemapOperation("cascade", { seed: String(args.seed ?? ""), maxTokens: Number(args.maxTokens ?? 4000) }, context.cwd);
      case "expand":
        return codemapOperation("expand", Object.assign({ entities: Array.isArray(args.entities) ? args.entities.map(String) : [String(args.entities)], direction: args.direction as any, depth: args.depth as any, maxTokens: Number(args.maxTokens ?? 4000) }, this.#commonArgs(args)), context.cwd, this.#opts(args));
      case "source":
        return codemapOperation("source", Object.assign({ entities: Array.isArray(args.entities) ? args.entities.map(String) : [String(args.entities)], maxTokens: Number(args.maxTokens ?? 4000) }, this.#commonArgs(args)), context.cwd, this.#opts(args));
      case "explore":
        return codemapOperation("explore", Object.assign({ query: String(args.query ?? ""), maxTokens: Number(args.maxTokens ?? 4000) }, this.#commonArgs(args)), context.cwd, this.#opts(args));
      default:
        throw new Error(`Unknown codemap action: ${name}`);
    }
  }
}