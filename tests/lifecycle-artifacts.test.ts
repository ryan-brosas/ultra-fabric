import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactAdapter, type ArtifactAdapter } from "../src/lifecycle/artifacts.js";

const roots: string[] = [];
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-artifacts-"));
  roots.push(root);
  return new FileArtifactAdapter(path.join(root, ".artifact"));
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("FileArtifactAdapter", () => {
  it("satisfies the ArtifactAdapter interface", () => {
    const adapter: ArtifactAdapter = new FileArtifactAdapter("/tmp/test-artifacts");
    expect(typeof adapter.write).toBe("function");
    expect(typeof adapter.read).toBe("function");
    expect(typeof adapter.resolve).toBe("function");
  });
  it("writes and reads back artifact content", () => {
    const adapter = setup();
    const written = adapter.write("add-auth-refresh", "spec", "# Spec\n\nTest content");
    expect(written.replace(/\\/g, "/")).toContain(".artifact/add-auth-refresh/spec.md");
    expect(adapter.read("add-auth-refresh", "spec")).toBe("# Spec\n\nTest content");
  });

  it("returns undefined for missing artifacts", () => {
    const adapter = setup();
    expect(adapter.read("add-auth-refresh", "plan")).toBeUndefined();
  });

  it("rejects traversal attempts and unlisted names", () => {
    const adapter = setup();
    expect(() => adapter.write("../escape", "spec", "evil")).toThrow();
    expect(() => adapter.write("add-auth-refresh", "notes" as never, "evil")).toThrow();
  });

  it("writes and reads back an impact artifact", () => {
    const adapter = setup();
    adapter.write("add-auth", "impact", "# Impact\n\nCallers: src/a.ts:12");
    expect(adapter.read("add-auth", "impact")).toBe("# Impact\n\nCallers: src/a.ts:12");
  });

  it("creates the directory structure on first write", () => {
    const adapter = setup();
    adapter.write("fix-prewalk", "research", "findings");
    expect(fs.existsSync(adapter.resolve("fix-prewalk", "research"))).toBe(true);
  });
});