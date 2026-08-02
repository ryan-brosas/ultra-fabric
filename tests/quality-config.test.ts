import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FABRIC_CONFIG,
  loadFabricConfig,
  normalizeFabricConfig,
} from "../src/config.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-fabric-quality-config-"));
  temporaryDirectories.push(directory);
  return directory;
};

const configuredCheck = (id: string) => ({
  id,
  languages: ["typescript"],
  command: "pnpm",
  args: ["exec", "tsc"],
  fileMode: "none",
  timeoutMs: 30_000,
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("quality configuration", () => {
  it("is opt-in and has bounded conservative defaults", () => {
    expect(DEFAULT_FABRIC_CONFIG.quality).toEqual({
      mode: "off",
      maxOutputChars: 20_000,
      maxProbeBytes: 8_192,
      ignoredLanguages: ["binary"],
      languageOverrides: {},
      checks: [],
    });
  });

  it("normalizes language routing, unique trusted argv checks, and bounds", () => {
    const quality = normalizeFabricConfig({
      quality: {
        mode: "enforce",
        maxOutputChars: 1,
        maxProbeBytes: Number.MAX_SAFE_INTEGER,
        ignoredLanguages: [" binary ", "generated", "binary", 42],
        languageOverrides: {
          ".TEMPL": " Go-Template ",
          " ": "ignored",
          ".bad": 42,
        },
        checks: [
          {
            id: " web ",
            languages: [" HTML ", "css", "html", "*"],
            command: " pnpm ",
            args: ["exec", "stylelint", 42],
            fileMode: "append",
            timeoutMs: Number.MAX_SAFE_INTEGER,
          },
          configuredCheck("web"),
          { id: "missing-language", languages: [], command: "lint" },
          { id: "missing-command", languages: ["go"], command: " " },
        ],
      },
    }).quality;

    expect(quality).toEqual({
      mode: "enforce",
      maxOutputChars: 256,
      maxProbeBytes: 1024 * 1024,
      ignoredLanguages: ["binary", "generated"],
      languageOverrides: { ".templ": "go-template" },
      checks: [
        {
          id: "web",
          languages: ["html", "css", "*"],
          command: "pnpm",
          args: ["exec", "stylelint"],
          fileMode: "append",
          timeoutMs: 10 * 60_000,
        },
      ],
    });
  });

  it("drops invalid modes and malformed checks instead of executing them", () => {
    const quality = normalizeFabricConfig({
      quality: {
        mode: "strict",
        checks: "pnpm check",
      },
    }).quality;

    expect(quality).toEqual(DEFAULT_FABRIC_CONFIG.quality);
  });

  it("loads project quality commands only for a trusted project", () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "fabric.json"),
      JSON.stringify({ quality: { mode: "audit", checks: [configuredCheck("global")] } }),
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({ quality: { mode: "enforce", checks: [configuredCheck("project")] } }),
    );

    const untrusted = loadFabricConfig({ cwd, agentDir, projectTrusted: false });
    const trusted = loadFabricConfig({ cwd, agentDir, projectTrusted: true });

    expect(untrusted.quality.mode).toBe("audit");
    expect(untrusted.quality.checks.map((check) => check.id)).toEqual(["global"]);
    expect(trusted.quality.mode).toBe("enforce");
    expect(trusted.quality.checks.map((check) => check.id)).toEqual(["project"]);
  });
});
