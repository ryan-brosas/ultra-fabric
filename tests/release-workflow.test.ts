import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface ReleaseWorkflow {
  on?: { push?: { tags?: string[] } };
  permissions?: Record<string, string>;
  jobs?: {
    publish?: {
      "timeout-minutes"?: number;
      steps?: WorkflowStep[];
    };
  };
}

describe("npm release workflow", () => {
  it("publishes only matching version tags through tokenless OIDC", () => {
    const source = fs.readFileSync(".github/workflows/release.yml", "utf8");
    const workflow = parse(source) as ReleaseWorkflow;
    const publish = workflow.jobs?.publish;
    const steps = publish?.steps ?? [];
    const commands = steps.flatMap((step) => step.run ?? []);

    expect(workflow.on?.push?.tags).toEqual(["v*"]);
    // contents: write is required for creating the detailed GitHub Release
    // from the changelog section; npm publishing stays tokenless via OIDC.
    expect(workflow.permissions).toEqual({ contents: "write", "id-token": "write" });
    expect(publish?.["timeout-minutes"]).toBe(20);
    expect(steps.map((step) => step.uses).filter(Boolean)).toEqual([
      "actions/checkout@v6",
      "pnpm/action-setup@v4",
      "actions/setup-node@v6",
    ]);
    expect(steps.find((step) => step.uses === "actions/setup-node@v6")?.with)
      .toMatchObject({ "node-version": "24", "registry-url": "https://registry.npmjs.org" });
    expect(commands).toContain("pnpm install --frozen-lockfile");
    expect(commands.some((command) => command.includes("GITHUB_REF_NAME") && command.includes("package.json")))
      .toBe(true);
    expect(commands).toContain("npm publish --access public --tag next");
    const notes = steps.find((step) => step.name === "Build release notes");
    expect(notes?.run).toContain("scripts/release-notes.mjs");
    const release = steps.find((step) => step.name === "Create GitHub Release");
    expect(release?.run).toContain("gh release create");
    // Reruns edit the existing release in place instead of failing.
    expect(release?.run).toContain("gh release edit");
    expect(source).not.toMatch(/NODE_AUTH_TOKEN|secrets\./);
  });
});
