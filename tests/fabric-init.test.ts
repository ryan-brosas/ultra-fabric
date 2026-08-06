import { describe, expect, it } from "vitest";
import { planInit } from "../src/init/scaffold.js";

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
  });

  it("generated context trio is detailed", () => {
    const plan = planInit(new Set(), V);
    const byPath = new Map(plan.files.map((f) => [f.path, f.content]));
    const project = byPath.get("project.md")!;
    for (const s of ["Non-goals", "Users", "Current milestone", "Decisions", "Risks", "Links"]) {
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
