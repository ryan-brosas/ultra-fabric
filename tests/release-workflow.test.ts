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
    expect(workflow.permissions).toEqual({ contents: "read", "id-token": "write" });
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
    expect(source).not.toMatch(/NODE_AUTH_TOKEN|secrets\./);
  });
});
