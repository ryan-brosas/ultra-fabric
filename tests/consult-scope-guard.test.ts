import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import registerConsultScopeGuard from "../src/consult/scope-guard-extension.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env.PI_FABRIC_CONSULT_SCOPE_V1;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type GuardResult = { block: true; reason?: string } | undefined;
type ToolCall = { toolName: string; input: Record<string, unknown> };
type Guard = (event: ToolCall, context: { cwd: string }) => GuardResult | Promise<GuardResult>;

const setup = (root: string, scopes: string[]): Guard => {
  process.env.PI_FABRIC_CONSULT_SCOPE_V1 = JSON.stringify({ version: 1, root, scopes });
  let guard: Guard | undefined;
  registerConsultScopeGuard({
    on(event: string, handler: Guard) {
      if (event === "tool_call") guard = handler;
    },
  } as never);
  if (!guard) throw new Error("scope guard did not register tool_call");
  return guard;
};

describe("Ultra Consult worker scope guard", () => {
  it("allows reads inside a perspective scope and blocks sibling/default reads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-consult-scope-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "src/auth"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/billing"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/auth/token.ts"), "export const token = true;\n");
    fs.writeFileSync(path.join(root, "src/billing/invoice.ts"), "export const invoice = true;\n");
    const guard = setup(root, ["src/auth"]);

    await expect(guard({ toolName: "read", input: { path: "src/auth/token.ts" } }, { cwd: root }))
      .resolves.toBeUndefined();
    await expect(guard({ toolName: "grep", input: { pattern: "token", path: "src/auth" } }, { cwd: root }))
      .resolves.toBeUndefined();
    await expect(guard({ toolName: "read", input: { path: "src/billing/invoice.ts" } }, { cwd: root }))
      .resolves.toMatchObject({ block: true });
    await expect(guard({ toolName: "grep", input: { pattern: "token" } }, { cwd: root }))
      .resolves.toMatchObject({ block: true });
  });

  it("blocks traversal, out-of-project symlinks, and non-read tools", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-consult-scope-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-consult-outside-"));
    roots.push(root, outside);
    fs.mkdirSync(path.join(root, "src/auth"), { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    fs.symlinkSync(outside, path.join(root, "src/auth/escape"));
    const guard = setup(root, ["src/auth"]);

    await expect(guard({ toolName: "read", input: { path: "../secret.txt" } }, { cwd: root }))
      .resolves.toMatchObject({ block: true });
    await expect(guard({ toolName: "read", input: { path: "src/auth/escape/secret.txt" } }, { cwd: root }))
      .resolves.toMatchObject({ block: true });
    await expect(guard({ toolName: "bash", input: { command: "pwd" } }, { cwd: root }))
      .resolves.toMatchObject({ block: true });
  });

  it("allows project-wide reads only for an explicitly empty scope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-consult-scope-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "README.md"), "read me\n");
    const guard = setup(root, []);

    await expect(guard({ toolName: "read", input: { path: "README.md" } }, { cwd: root }))
      .resolves.toBeUndefined();
    await expect(guard({ toolName: "ls", input: {} }, { cwd: root }))
      .resolves.toBeUndefined();
  });
});
