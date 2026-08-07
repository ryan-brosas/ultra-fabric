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
    expect(agents.content).toContain("delegate exploration breadth to them by default");
    expect(agents.content).toContain("prewalk.delegateContext defaults on and prewalk.autoScout is explicit opt-in");
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

  it("fabric.json is valid JSON pinned to the current configVersion", () => {
    const plan = planInit(new Set(), V);
    const cfg = JSON.parse(plan.files.find((f) => f.path === ".pi/fabric.json")!.content) as { configVersion: number };
    expect(cfg.configVersion).toBe(V);
  });

  it("defers root creation when only the legacy .pi sibling exists", () => {
    const plan = planInit(new Set([".pi/project.md"]), V);
    const byPath = new Map(plan.files.map((f) => [f.path, f.action]));
    expect(byPath.get("project.md")).toBe("defer");
    const migration = plan.migrations.find(
      (m) => m.includes(".pi/project.md") && m.includes("root-level project.md"),
    );
    expect(migration).toBeDefined();
  });

  it("applyInitPlan writes nothing for deferred files and reports them apart", () => {
    const plan = planInit(new Set([".pi/roadmap.md"]), V);
    const writes: string[] = [];
    const applied = applyInitPlan(plan, {
      exists: () => false,
      write: (p) => {
        writes.push(p);
      },
    });
    expect(applied.deferred).toContain("roadmap.md");
    expect(applied.created).not.toContain("roadmap.md");
    expect(applied.skipped).not.toContain("roadmap.md");
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
});
