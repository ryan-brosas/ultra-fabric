import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import { PathLeaseStore } from "../leases/path-leases.js";

const descriptors: FabricActionDescriptor[] = [
  {
    name: "acquire",
    description: "Atomically acquire file/tree write leases for the current Fabric run",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1, maxLength: 4_096 },
              scope: { type: "string", enum: ["file", "tree"] },
            },
            required: ["path", "scope"],
            additionalProperties: false,
          },
        },
        ttlMs: { type: "number", minimum: 1_000, maximum: 86_400_000 },
      },
      required: ["paths", "ttlMs"],
      additionalProperties: false,
    },
    risk: "write",
    effect: "state",
  },
  {
    name: "release",
    description: "Release path leases owned by the current Fabric run",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    risk: "write",
    effect: "state",
  },
  {
    name: "list",
    description: "List active project path leases",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
];

export class LeasesProvider implements FabricProvider {
  readonly name = "leases";
  readonly description = "Cooperative host-enforced file and tree write leases";

  constructor(readonly store: PathLeaseStore) {}

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
    const ownerRunId = context.run?.runId ?? context.parentToolCallId;
    switch (name) {
      case "acquire":
        return this.store.acquire(context.cwd, {
          ownerRunId,
          paths: args.paths as Array<{ path: string; scope: "file" | "tree" }>,
          ttlMs: Number(args.ttlMs),
        });
      case "release":
        return this.store.release(
          ownerRunId,
          Array.isArray(args.ids) ? args.ids.map(String) : [],
        );
      case "list":
        return this.store.list();
      default:
        throw new Error(`Unknown leases action: ${name}`);
    }
  }
}
