import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentRoleRegistry,
  parseAgentRoleProfile,
  renderAgentRolePrompt,
} from "../src/agents/role-profiles.js";

const roots: string[] = [];
const temporary = (name: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ultra-fabric-role-${name}-`));
  roots.push(root);
  return root;
};
const profile = (overrides: Record<string, string | number> = {}): string => {
  const values = {
    name: "scout",
    description: "Map relevant code",
    lifecycle: "one-shot",
    goal: "Return the smallest useful code map.",
    completion: "Report exact paths and stop when the map is sufficient.",
    maxTurns: 6,
    graceTurns: 1,
    ...overrides,
  };
  return [
    "---",
    ...Object.entries(values).map(([key, value]) => `${key}: ${value}`),
    "tools: read, grep, find, ls",
    ...(values.lifecycle === "persistent"
      ? ["events: turn_end, tool_error", "responseMode: directive", "delivery: steer", "triggerTurn: false", "coalesce: true"]
      : []),
    "---",
    "Inspect selectively. Do not guess or continue after the completion contract is met.",
  ].join("\n");
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Agent role profiles", () => {
  it("requires behavior, goal, completion, lifecycle, and a bounded turn budget", () => {
    expect(() => parseAgentRoleProfile(profile(), "/roles/scout.md", "project")).not.toThrow();
    expect(() => parseAgentRoleProfile(profile({ goal: "" }), "/roles/scout.md", "project"))
      .toThrow("goal is required");
    expect(() => parseAgentRoleProfile(profile({ completion: "" }), "/roles/scout.md", "project"))
      .toThrow("completion is required");
    expect(() => parseAgentRoleProfile(profile({ maxTurns: 0 }), "/roles/scout.md", "project"))
      .toThrow("maxTurns must be an integer");
    expect(() => parseAgentRoleProfile(profile({ lifecycle: "forever" }), "/roles/scout.md", "project"))
      .toThrow("lifecycle must be one-shot or persistent");
  });

  it("rejects lifecycle-incoherent and malformed custom profile fields", () => {
    const oneShotEvents = profile().replace("tools: read, grep, find, ls", "events: turn_end");
    expect(() => parseAgentRoleProfile(oneShotEvents, "/roles/scout.md", "project"))
      .toThrow("events is available only to persistent roles");

    const passiveMailbox = profile({ lifecycle: "persistent" }).replace("delivery: steer", "delivery: mailbox");
    expect(() => parseAgentRoleProfile(passiveMailbox, "/roles/ambient.md", "project"))
      .toThrow("triggerTurn is valid only with steer or followUp delivery");

    const invalidTopic = profile({ lifecycle: "persistent" }).replace("tools: read, grep, find, ls", "topics: ../escape");
    expect(() => parseAgentRoleProfile(invalidTopic, "/roles/ambient.md", "project"))
      .toThrow("invalid topic ../escape");

    expect(() => parseAgentRoleProfile(profile({ model: " " }), "/roles/scout.md", "project"))
      .toThrow("model must be a non-empty string");
    expect(() => parseAgentRoleProfile(
      profile({ lifecycle: "persistent", freshness: "eventually" }),
      "/roles/ambient.md",
      "project",
    )).toThrow("invalid freshness policy");
  });

  it("loads builtin then user then project profiles with project precedence", () => {
    const root = temporary("precedence");
    const builtin = path.join(root, "builtin");
    const user = path.join(root, "user");
    const project = path.join(root, "project", ".pi", "agents");
    for (const dir of [builtin, user, project]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(builtin, "scout.md"), profile({ description: "builtin" }));
    fs.writeFileSync(path.join(user, "scout.md"), profile({ description: "user" }));
    fs.writeFileSync(path.join(project, "scout.md"), profile({ description: "project" }));

    const roles = new AgentRoleRegistry({
      projectRoot: path.join(root, "project"),
      userDir: user,
      builtinDir: builtin,
    });
    expect(roles.require("scout", "one-shot").description).toBe("project");
  });

  it("fails closed for unknown roles and lifecycle mismatches", () => {
    const root = temporary("mismatch");
    const builtin = path.join(root, "builtin");
    fs.mkdirSync(builtin, { recursive: true });
    fs.writeFileSync(path.join(builtin, "advisor.md"), profile({
      name: "advisor",
      lifecycle: "persistent",
    }));
    const roles = new AgentRoleRegistry({ projectRoot: root, builtinDir: builtin, userDir: null });

    expect(() => roles.require("missing", "one-shot")).toThrow("Unknown Agent role");
    expect(() => roles.require("advisor", "one-shot")).toThrow("requires the persistent lifecycle");
  });

  it("does not load project role profiles outside the trust boundary", () => {
    const root = temporary("trust");
    const builtin = path.join(root, "builtin");
    const project = path.join(root, ".pi", "agents");
    fs.mkdirSync(builtin, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(builtin, "worker.md"), profile({ name: "worker" }));
    fs.writeFileSync(path.join(project, "worker.md"), profile({ name: "worker" }));

    const trusted = new AgentRoleRegistry({ projectRoot: root, builtinDir: builtin, userDir: null });
    const untrusted = new AgentRoleRegistry({
      projectRoot: root,
      builtinDir: builtin,
      userDir: null,
      projectDir: null,
    });

    expect(trusted.require("worker", "one-shot").source).toBe("project");
    expect(untrusted.require("worker", "one-shot").source).toBe("builtin");
  });

  it("applies persistent role type defaults without creating another runtime class", () => {
    const root = temporary("persistent-defaults");
    const builtin = path.join(root, "builtin");
    fs.mkdirSync(builtin, { recursive: true });
    fs.writeFileSync(path.join(builtin, "supervisor.md"), profile({
      name: "supervisor",
      lifecycle: "persistent",
      freshness: "latest-main-revision",
    }));
    const roles = new AgentRoleRegistry({ projectRoot: root, builtinDir: builtin, userDir: null });
    const request = roles.applyPersistent({
      name: "release supervisor",
      role: "supervisor",
      goal: "   ",
      completion: "",
      instructions: "Watch release work.",
    });

    expect(request).toMatchObject({
      role: "supervisor",
      goal: "Return the smallest useful code map.",
      completion: "Report exact paths and stop when the map is sufficient.",
      events: ["turn_end", "tool_error"],
      responseMode: "directive",
      delivery: "steer",
      triggerTurn: false,
      coalesce: true,
      validWhile: {
        version: 1,
        source: expect.stringContaining("activation.mainRevision === current.mainRevision"),
      },
      turnBudget: { maxTurns: 6, graceTurns: 1 },
    });
  });

  it("renders the role behavior, concrete task, goal, completion, and stop condition", () => {
    const parsed = parseAgentRoleProfile(profile(), "/roles/scout.md", "project");
    const prompt = renderAgentRolePrompt(parsed, "Trace the authentication entry point.");
    expect(prompt).toContain("## Role behavior");
    expect(prompt).toContain("Trace the authentication entry point.");
    expect(prompt).toContain("Return the smallest useful code map.");
    expect(prompt).toContain("Report exact paths and stop");
    expect(prompt).toContain("Do not start new work after completion");
  });

  it("ships only bounded builtin profiles with practical lifecycle defaults", () => {
    const roles = AgentRoleRegistry.createDefault(process.cwd());
    for (const name of ["scout", "explorer", "reviewer", "worker"]) {
      const role = roles.require(name, "one-shot");
      expect(role.turnBudget.maxTurns).toBeGreaterThan(0);
    }
    for (const name of ["advisor", "supervisor", "ambient", "coordinator"]) {
      const role = roles.require(name, "persistent");
      expect(role.turnBudget.maxTurns).toBeGreaterThan(0);
    }
    expect(roles.require("supervisor", "persistent").freshness).toBe("latest-main-revision");
  });
});
