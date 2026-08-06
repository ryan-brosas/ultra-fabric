import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  detectPiHostVersion,
  MINIMUM_PI_HOST_VERSION,
  piHostCompatibilityWarning,
  staleBuildWarning,
} from "../src/host-compatibility.js";

const roots: string[] = [];

const fakeHost = (version: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-version-"));
  roots.push(root);
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }),
  );
  const cli = path.join(dist, "cli.js");
  fs.writeFileSync(cli, "");
  return cli;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Pi host compatibility", () => {
  it("compares release and prerelease versions", () => {
    expect(compareVersions("0.80.5", MINIMUM_PI_HOST_VERSION)).toBeLessThan(0);
    expect(compareVersions("0.80.6", MINIMUM_PI_HOST_VERSION)).toBe(0);
    expect(compareVersions("0.80.10", MINIMUM_PI_HOST_VERSION)).toBeGreaterThan(0);
    expect(compareVersions("0.80.6-beta.1", MINIMUM_PI_HOST_VERSION)).toBeLessThan(0);
    expect(compareVersions("invalid", MINIMUM_PI_HOST_VERSION)).toBeUndefined();
  });

  it("detects the host package from the CLI path", () => {
    expect(detectPiHostVersion(fakeHost("0.80.10"))).toBe("0.80.10");
    expect(detectPiHostVersion("/does/not/exist")).toBeUndefined();
  });

  it("warns only for a detected unsupported host", () => {
    expect(piHostCompatibilityWarning("0.80.5")).toContain("requires Pi >= 0.80.6");
    expect(piHostCompatibilityWarning("0.80.6")).toBeUndefined();
    expect(piHostCompatibilityWarning(undefined)).toBeUndefined();
  });

  it("warns when the loaded dist build is older than the source (stale build)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stale-build-"));
    roots.push(root);
    const distDir = path.join(root, "dist");
    const srcDir = path.join(root, "src");
    fs.mkdirSync(distDir);
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(distDir, "index.js"), "// built");
    fs.writeFileSync(path.join(srcDir, "config.ts"), "export const x = 1;");
    const now = new Date();
    fs.utimesSync(path.join(srcDir, "config.ts"), now, now);
    fs.utimesSync(
      path.join(distDir, "index.js"),
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() - 60_000),
    );
    const warning = staleBuildWarning(path.join(root, "dist", "index.js"));
    expect(warning).toBeDefined();
    expect(warning).toContain("stale");
    expect(warning).toContain("restart");
  });

  it("returns undefined when dist is newer than src (fresh build)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fresh-build-"));
    roots.push(root);
    const distDir = path.join(root, "dist");
    const srcDir = path.join(root, "src");
    fs.mkdirSync(distDir);
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(distDir, "index.js"), "// built");
    fs.writeFileSync(path.join(srcDir, "config.ts"), "export const x = 1;");
    const now = new Date();
    fs.utimesSync(path.join(srcDir, "config.ts"), now, now);
    fs.utimesSync(
      path.join(distDir, "index.js"),
      new Date(now.getTime() + 60_000),
      new Date(now.getTime() + 60_000),
    );
    expect(staleBuildWarning(path.join(root, "dist", "index.js"))).toBeUndefined();
  });

  it("returns undefined when the loaded entry is not a dist build (dev source mode)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dev-mode-"));
    roots.push(root);
    const srcDir = path.join(root, "src");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "index.ts"), "export const x = 1;");
    expect(staleBuildWarning(path.join(root, "src", "index.ts"))).toBeUndefined();
  });
});
