import { describe, expect, it } from "vitest";
import { planInit, applyInitPlan } from "../src/init/scaffold.js";

// /fabric init: root-level context scaffold. Pure planner — no I/O.

const V = 7;

describe("planInit", () => {
  it("plans create for every file in a fresh project, context at root and settings under .pi", () => {
    const plan = planInit(new Set(), V);
    expect(plan.files.map((f) => f.path)).toEqual([
      "AGENTS.md",
      "project.md",
      "roadmap.md",
      "tech-stack.md",
      "user.md",
      ".pi/fabric.json",
      ".pi/agents/scout.md",
      ".pi/agents/explorer.md",
    ]);
    for (const f of plan.files) expect(f.action).toBe("create");
  });

  it("AGENTS.md carries the researched and adopted sections", () => {
    const plan = planInit(new Set(), V);
    const agents = plan.files.find((f) => f.path === "AGENTS.md")!;
    for (const section of [
      "Commands",
      "Architecture",
      "Conventions",
      "Verification",
      "Rule 0",
      "Destructive",
      "Code editing",
      "Testing policy",
      "Research",
      "Secrets",
      "Writing",
      "Fabric behavior",
    ]) {
      expect(agents.content.toLowerCase()).toContain(section.toLowerCase());
    }
    // links the trio and names the Ultra surfaces
    expect(agents.content).toContain("project.md");
    expect(agents.content).toContain("roadmap.md");
    expect(agents.content).toContain("codemap");
    expect(agents.content).toContain("available on request on their own context budget");
    expect(agents.content).toContain("prewalk.autoScout is explicit opt-in");
    expect(agents.content).toContain("fan out explorer or scout children in parallel");
  });

  it("generated context trio is detailed", () => {
    const plan = planInit(new Set(), V);
    const byPath = new Map(plan.files.map((f) => [f.path, f.content]));
    const project = byPath.get("project.md")!;
    for (const s of [
      "Purpose",
      "Users and success",
      "Boundaries and invariants",
      "Architecture",
      "Agent utilization",
      "Code-graph links",
      "Source ownership",
      "Tests and integrations",
      "Verification and operations",
      "Decisions, risks, and questions",
    ]) {
      expect(project.toLowerCase()).toContain(s.toLowerCase());
    }
    const roadmap = byPath.get("roadmap.md")!;
    for (const s of ["Usage", "Acceptance", "Status", "Evidence", "Done", "Parked"]) {
      expect(roadmap.toLowerCase()).toContain(s.toLowerCase());
    }
    const stack = byPath.get("tech-stack.md")!;
    for (const s of ["Version", "Tooling", "Runtime targets", "lockfile", "Upgrade", "External services"]) {
      expect(stack.toLowerCase()).toContain(s.toLowerCase());
    }
  });

  it("fills templates from detection when present", () => {
    const detected = {
      packageManager: "pnpm",
      commands: { build: "pnpm run build", test: "pnpm run test", check: "pnpm run check" },
      languages: ["TypeScript"],
      dependencies: [],
      mcpServers: [{ name: "exa", toolCount: 4 }],
      extensions: [],
      identity: { name: "octocat", source: "gh" as const },
    };
    const plan = planInit(new Set(), V, detected);
    const byPath = new Map(plan.files.map((f) => [f.path, f.content]));
    expect(byPath.get("AGENTS.md")).toContain("pnpm run build");
    expect(byPath.get("AGENTS.md")).toContain("pnpm run check");
    const stack = byPath.get("tech-stack.md")!;
    expect(stack).toContain("| TypeScript |");
    expect(stack).toContain("| exa | 4 tools |");
    expect(stack).toContain("pnpm only; commit the lockfile (pnpm-lock.yaml)");
    const user = byPath.get("user.md")!;
    expect(user).toContain("@octocat");
    expect(user).toContain("detected via gh CLI");
    for (const s of [
      "Identity",
      "Outcomes",
      "Communication",
      "Workflow",
      "Tools and environment",
      "Privacy and secrets",
      "Durable reminders",
      "Unknowns",
    ]) {
      expect(user.toLowerCase()).toContain(s.toLowerCase());
    }
  });

  it("keeps placeholders when detection is absent and user.md asks the user", () => {
    const plan = planInit(new Set(), V);
    const byPath = new Map(plan.files.map((f) => [f.path, f.content]));
    expect(byPath.get("AGENTS.md")).toContain("<build command>");
    expect(byPath.get("user.md")).toContain("gh auth status");
  });

  it("skips user.md when it already exists", () => {
    const plan = planInit(new Set(["user.md"]), V);
    const byPath = new Map(plan.files.map((f) => [f.path, f.action]));
    expect(byPath.get("user.md")).toBe("skip");
  });

  it("AGENTS.md is adapted generic guidance, not copied from another project", () => {
    const plan = planInit(new Set(), V);
    const agents = plan.files.find((f) => f.path === "AGENTS.md")!;
    for (const foreign of ["bun", "beads", "ACFS", "Next.js", "VPS"]) {
      expect(agents.content.toLowerCase()).not.toContain(foreign.toLowerCase());
    }
  });

  it("fabric.json materializes the full default config pinned to the current configVersion", () => {
    const plan = planInit(new Set(), V);
    const raw = plan.files.find((f) => f.path === ".pi/fabric.json")!.content;
    const cfg = JSON.parse(raw) as Record<string, unknown> & { configVersion: number };
    expect(cfg.configVersion).toBe(V);
    expect(cfg.prewalk).toMatchObject({ arm: "task" });
    expect(cfg.prewalk).not.toHaveProperty("delegateContext");
    expect(cfg.agents).toMatchObject({ enabled: true });
    expect(cfg.executor).toMatchObject({ runtime: "quickjs" });
    expect(cfg.compaction).toBeDefined();
    expect(raw).not.toContain("/home/");
  });

  it("defers root creation without a migration notice when only the legacy .pi sibling exists", () => {
    const plan = planInit(new Set([".pi/project.md"]), V);
    const byPath = new Map(plan.files.map((f) => [f.path, f.action]));
    expect(byPath.get("project.md")).toBe("defer");
    expect(plan.migrations).toHaveLength(0);
  });

  it("copies a deferred root file from its legacy .pi sibling when readable", () => {
    const plan = planInit(new Set([".pi/roadmap.md"]), V);
    const writes: string[] = [];
    const contents: string[] = [];
    const applied = applyInitPlan(plan, {
      exists: () => false,
      read: (p) => (p === ".pi/roadmap.md" ? "# legacy roadmap\n" : null),
      write: (p, content) => {
        writes.push(p);
        contents.push(content);
      },
    });
    expect(applied.copied).toContain("roadmap.md");
    expect(applied.created).not.toContain("roadmap.md");
    expect(writes).toContain("roadmap.md");
    expect(contents).toContain("# legacy roadmap\n");
  });

  it("keeps a deferred file unwritten when the legacy sibling cannot be read", () => {
    const plan = planInit(new Set([".pi/roadmap.md"]), V);
    const writes: string[] = [];
    const applied = applyInitPlan(plan, {
      exists: () => false,
      read: () => null,
      write: (p) => {
        writes.push(p);
      },
    });
    expect(applied.deferred).toContain("roadmap.md");
    expect(writes).not.toContain("roadmap.md");
  });

  it("skips existing files and reports legacy .pi context", () => {
    const plan = planInit(new Set(["AGENTS.md", "project.md", ".pi/project.md"]), V);
    const byPath = new Map(plan.files.map((f) => [f.path, f.action]));
    expect(byPath.get("AGENTS.md")).toBe("skip");
    expect(byPath.get("project.md")).toBe("skip");
    expect(byPath.get("roadmap.md")).toBe("create");
    expect(plan.migrations.some((m) => m.includes(".pi/project.md"))).toBe(true);
  });

  it("emits no migration notices when no legacy .pi context exists", () => {
    const plan = planInit(new Set(), V);
    expect(plan.migrations).toHaveLength(0);
  });

  it("overwrites an existing file when the plan opts it in", () => {
    const plan = planInit(new Set(["tech-stack.md"]), V, null, null, {
      overwrite: new Set(["tech-stack.md"]),
    });
    const f = plan.files.find((x) => x.path === "tech-stack.md")!;
    expect(f.action).toBe("overwrite");
    const writes: string[] = [];
    const applied = applyInitPlan(plan, {
      exists: () => true,
      read: () => null,
      write: (p) => {
        writes.push(p);
      },
    });
    expect(applied.created).toContain("tech-stack.md");
    expect(applied.skipped).not.toContain("tech-stack.md");
    expect(writes).toContain("tech-stack.md");
  });

  it("writes detected MCP servers into AGENTS.md", () => {
    const detected = {
      packageManager: "pnpm",
      commands: {},
      languages: ["TypeScript"],
      dependencies: [],
      mcpServers: [{ name: "exa", toolCount: 4 }, { name: "custom-tools", toolCount: 2 }],
      extensions: [],
      identity: null,
    };
    const plan = planInit(new Set(), V, detected);
    const agents = plan.files.find((f) => f.path === "AGENTS.md")!.content;
    expect(agents).toContain("## MCP servers");
    expect(agents).toContain("exa (4 tools)");
    expect(agents).toContain("custom-tools (2 tools)");
    expect(agents).toContain("TypeScript");
    expect(agents).toContain("pnpm");
  });

  it("omits the MCP servers section when none are detected", () => {
    const plan = planInit(new Set(), V);
    const agents = plan.files.find((f) => f.path === "AGENTS.md")!.content;
    expect(agents).not.toContain("## MCP servers");
  });

  it("threads user answers into AGENTS.md and project.md", () => {
    const plan = planInit(new Set(), V, null, {
      name: "acme-billing",
      purpose: "Invoicing service for the Acme storefront",
      users: "End users",
      success: "Stability",
    });
    const agents = plan.files.find((f) => f.path === "AGENTS.md")!.content;
    expect(agents).toContain("acme-billing");
    expect(agents).toContain("Invoicing service for the Acme storefront");
    expect(agents).not.toContain("<One or two sentences");
    const project = plan.files.find((f) => f.path === "project.md")!.content;
    expect(project).toContain("acme-billing");
    expect(project).toContain("Invoicing service for the Acme storefront");
    expect(project).toContain("Primary users: End users");
    expect(project).toContain("Success priority: Stability");
  });
});
