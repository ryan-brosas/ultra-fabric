import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS, guestTypeDeclarations } from "../src/runtime/guest-types.js";
import {
  normalizeTypeScriptPath,
  typeCheckFabricCode,
} from "../src/runtime/type-checker.js";

describe("Fabric guest type checker", () => {
  it("normalizes Windows paths for TypeScript compiler host comparisons", () => {
    expect(normalizeTypeScriptPath("C:\\work\\__pi_fabric_guest_1.ts")).toBe(
      "C:/work/__pi_fabric_guest_1.ts",
    );
  });

  it("accepts typed Fabric code with top-level return", () => {
    const result = typeCheckFabricCode(
      'const text = await pi.read({ path: "README.md" });\nreturn text.length;',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
    expect(result.javascript).toContain("async function __piFabricMain()");
    expect(result.javascript).not.toContain("path: string");
  });

  it("accepts dynamic MCP namespaces and orchestration helpers", () => {
    const result = typeCheckFabricCode(
      `
const mcpResult = await mcp.context7.resolve_library_id({ libraryName: "react" });
const review = await agents.run({ task: "Review it", transport: "localterm" });
console.log(review.status);
return { mcpResult, review };
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts immediate and predicate-gated trajectory handoff", () => {
    const result = typeCheckFabricCode(
      `
await pi.edit({ path: "src/a.ts", old: "a", new: "b" });
const migrated = await agents.setModel({ id: "reviewer", model: "anthropic/executor" });
return agents.handoff({
  model: "anthropic/executor",
  task: migrated.name,
  when: ({ count, calls }) =>
    count(["pi.edit", "mcp.docs.lookup"]) >= 1 && calls[0]?.ref === "pi.edit",
});
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts typed first-class Fabric provider calls", () => {
    const result = typeCheckFabricCode(
      `
const recalled = await memory.recall({ query: "proxy", branches: "active" });
const current = await state.get();
const status = await schema.status();
const hypothesis = await schema.hypothesize({
  label: "proxy-surface",
  summary: "The direct provider surface is available",
  evidence: [{ kind: "file_exists", path: "package.json" }],
});
const pending = await compact.status();
return { recalled, current, mode: status.mode, hypothesis: hypothesis.hypothesisId, pending };
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts prewalk checklist escapes documented in the guest surface", () => {
    const trivial = typeCheckFabricCode(
      'return prewalk.checklist({ trivial: true });',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(trivial.errors).toEqual([]);
    const easy = typeCheckFabricCode(
      `
return prewalk.checklist({
  easy: true,
  items: [
    { task: "Flip the flag", validation: "The flag is flipped" },
    { task: "Run the gate", validation: "The gate passes" },
  ],
  schema: {
    intent: "Flip the flag",
    references: [],
    localScope: { files: ["src/contract.mjs"], symbols: [], cascadeRefs: [] },
    invariants: ["Protected diagnostics remain available"],
    postconditions: ["The gate passes"],
  },
});
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(easy.errors).toEqual([]);
  });

  it("accepts research-mode prewalk.checklist({ items, schema })", () => {
    const result = typeCheckFabricCode(
      `
return prewalk.checklist({
  items: [
    { task: "Probe the surface", validation: "The probe returns" },
    { task: "Implement the fix", validation: "The fix is green" },
    { task: "Gate the slice", validation: "The gate passes" },
    { task: "Sweep call sites", validation: "No stray consumers" },
    { task: "Run the module tests", validation: "The module is green" },
  ],
  schema: {
    intent: "Probe and fix the surface",
    references: [],
    localScope: { files: ["src/contract.mjs"], symbols: [], cascadeRefs: [] },
    invariants: ["Protected diagnostics remain available"],
    postconditions: ["The module tests pass"],
  },
});
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("still rejects trivial-with-items like the runtime does", () => {
    const result = typeCheckFabricCode(
      `
return prewalk.checklist({
  trivial: true,
  items: [{ task: "T", validation: "V" }],
});
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects misspelled first-class provider argument keys", () => {
    const result = typeCheckFabricCode(
      'await compact.request({ reasno: "context pressure" }); return "never";',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toMatch(/reasno|known properties/i);
  });

  it("keeps first-class Fabric providers typed in orchestration-only mode", () => {
    const declarations = guestTypeDeclarations(false);
    expect(declarations).not.toContain("declare const pi: PiToolsApi");
    expect(declarations).not.toContain("declare const extensions: FabricExtensionsApi");
    expect(declarations).toContain("declare const schema: FabricSchemaApi");

    const result = typeCheckFabricCode(
      'const mode = (await schema.status()).mode; const matches = await memory.recall({ query: "x" }); return { mode, matches };',
      declarations,
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts workflow, persistentAgent, and mesh primitives", () => {
    const result = typeCheckFabricCode(
      `
const captured = await extensions.project_status({ verbose: true });
console.log(captured.text);
const main = await agents.main();
await agents.followUp({ id: main.id, message: "review the result" });
const watcher = await agents.create({
  name: "advisor",
  instructions: "Review each turn",
  events: ["turn_end"],
  responseMode: "directive",
});
await agents.setTools({ id: watcher.id, tools: ["read", "grep", "find", "ls"] });
const persistent: FabricPersistentAgentInfo[] = await agents.list({ lifecycle: "persistent" });
const templates = await agents.templates();
const telemetry = await agents.telemetry();
const selectedLifecycle: FabricAgentLifecycle = telemetry.persistent > 0 ? "all" : "one-shot";
const selected = await agents.list({ lifecycle: selectedLifecycle });
console.log(persistent[0]?.messages, templates[0]?.instructions, telemetry.persistent, selected.length);
await mesh.publish({ topic: "team.review", to: watcher.id, text: "start" });
await phase("Review");
const findings = await parallel([
  () => agent<{ issues: string[] }>("Find issues", {
    label: "issue scan",
    schema: {
      type: "object",
      properties: { issues: { type: "array", items: { type: "string" } } },
      required: ["issues"],
    },
  }),
]);
return findings;
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts parallel(items, mapper, concurrency) and infers item types", () => {
    const result = typeCheckFabricCode(
      `
const items = [{ q: "a", n: 3 }, { q: "b", n: 2 }];
const out = await parallel(items, ({ q, n }) => agent(q + ":" + n, { label: q }), 2);
return out;
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("reports user-facing line numbers for functional errors", () => {
    // Wrong arg type (path: 42) is now deferred to runtime (functional-errors-only);
    // an undefined name is a genuine breakage still caught at type-check.
    const result = typeCheckFabricCode(
      'await pi.read({ path: missingFile });\nreturn "never";',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.line).toBe(1);
    expect(result.errors[0]?.message).toContain("Cannot find name");
  });
});
