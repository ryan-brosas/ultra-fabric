import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FABRIC_CONFIG,
  type FabricQualityCheckConfig,
  type FabricQualityMode,
} from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-fabric-quality-execution-"));
  temporaryDirectories.push(directory);
  return directory;
};

const nodeCheck = (
  id: string,
  languages: string[],
  source: string,
): FabricQualityCheckConfig => ({
  id,
  languages,
  command: process.execPath,
  args: ["-e", source],
  fileMode: "append",
  timeoutMs: 2_000,
});

const execute = async (
  cwd: string,
  mode: FabricQualityMode,
  checks: FabricQualityCheckConfig[],
  code: string,
  id: string,
) => {
  const registry = new ActionRegistry();
  registry.register(new PiToolsProvider(cwd, undefined, undefined));
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.quality.mode = mode;
  config.quality.checks = checks;
  config.approvals.write = "allow";
  return new FabricExecutionService(registry, config).execute({
    code,
    signal: undefined,
    parentToolCallId: id,
    context: { cwd, hasUI: false } as ExtensionContext,
    onPartial() {},
  });
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("quality execution enforcement", () => {
  it("records a passing host-owned gate after a successful attributed mutation", async () => {
    const cwd = temporaryDirectory();
    fs.mkdirSync(path.join(cwd, "src"));
    const result = await execute(
      cwd,
      "audit",
      [nodeCheck("types", ["typescript"], "process.stdout.write('clean')")],
      `await pi.write({ path: "src/app.ts", content: "export const value = 1;\\n" });\nreturn "done";`,
      "quality-pass",
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe("done");
    expect(result.gates).toMatchObject([
      {
        gate: "quality",
        passed: true,
        disposition: "advise",
        decision: "continue",
        evidence: [{ kind: "command", ref: "quality:types:passed" }],
      },
    ]);
  });

  it("keeps audit failures advisory and reports the controlled failure", async () => {
    const cwd = temporaryDirectory();
    const result = await execute(
      cwd,
      "audit",
      [nodeCheck("styles", ["css"], "process.stderr.write('style failed'); process.exit(2)")],
      `await pi.write({ path: "site.css", content: "body { color: red; }\\n" });\nreturn "kept";`,
      "quality-audit-failure",
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe("kept");
    expect(result.logs.join("\n")).toContain("Quality warning");
    expect(result.logs.join("\n")).toContain("style failed");
    expect(result.gates).toMatchObject([
      {
        gate: "quality",
        passed: false,
        disposition: "advise",
        decision: "continue",
      },
    ]);
  });

  it("blocks enforce mode when a changed language has no configured check", async () => {
    const cwd = temporaryDirectory();
    const result = await execute(
      cwd,
      "enforce",
      [nodeCheck("types", ["typescript"], "process.exit(0)")],
      `await pi.write({ path: "index.html", content: "<main>hello</main>\\n" });\nreturn "must not escape";`,
      "quality-uncovered",
    );

    expect(result.success).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.error).toContain("quality");
    expect(result.error).toContain("html");
    expect(result.gates).toMatchObject([
      {
        gate: "quality",
        passed: false,
        disposition: "abort",
        decision: "abort",
        failure: "gate_failed",
      },
    ]);
  });

  it("blocks enforce mode and preserves a failed check output", async () => {
    const cwd = temporaryDirectory();
    const result = await execute(
      cwd,
      "enforce",
      [nodeCheck("styles", ["css"], "process.stderr.write('bad selector'); process.exit(4)")],
      `await pi.write({ path: "site.css", content: "body { nope: true; }\\n" });\nreturn "must not escape";`,
      "quality-check-failure",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("styles: failed");
    expect(result.error).toContain("bad selector");
  });

  it("does not run quality commands when no file mutation is attributed", async () => {
    const cwd = temporaryDirectory();
    const marker = path.join(cwd, "quality-ran");
    const result = await execute(
      cwd,
      "enforce",
      [nodeCheck("marker", ["*"], `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)],
      `return "read-only";`,
      "quality-no-mutation",
    );

    expect(result.success).toBe(true);
    expect(result.gates).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not run quality commands after typecheck or runtime failure", async () => {
    const cwd = temporaryDirectory();
    const marker = path.join(cwd, "quality-ran");
    const checks = [
      nodeCheck("marker", ["*"], `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`),
    ];

    const typecheck = await execute(
      cwd,
      "enforce",
      checks,
      "return missingIdentifier;",
      "quality-typecheck-failure",
    );
    expect(typecheck.success).toBe(false);
    expect(typecheck.typeErrors).toBeDefined();
    expect(fs.existsSync(marker)).toBe(false);

    const runtime = await execute(
      cwd,
      "enforce",
      checks,
      `throw new Error("guest failed");`,
      "quality-runtime-failure",
    );
    expect(runtime.success).toBe(false);
    expect(runtime.gates).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
