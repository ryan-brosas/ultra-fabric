import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectQualityChangedFiles,
  mutationPathsFromAudits,
  type QualityMutationAudit,
} from "../src/quality/tracker.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-fabric-quality-"));
  temporaryDirectories.push(directory);
  return directory;
};

const audit = (
  ref: string,
  args: Record<string, unknown>,
  result: unknown = {},
  success = true,
): QualityMutationAudit => ({ ref, args, result, success });

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("quality mutation tracking", () => {
  it("attributes successful Pi writes and edits without duplicate paths", () => {
    const cwd = temporaryDirectory();
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src", "app.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(cwd, "site.css"), "body { color: black; }\n");

    const audits = [
      audit("pi.write", { path: "src/app.ts" }),
      audit("pi.edit", { path: path.join(cwd, "site.css") }),
      audit("pi.edit", { path: "src/app.ts" }),
    ];

    expect(mutationPathsFromAudits(audits)).toEqual([
      "src/app.ts",
      path.join(cwd, "site.css"),
    ]);
    expect(collectQualityChangedFiles({ cwd, audits })).toEqual([
      { path: "src/app.ts", language: "typescript" },
      { path: "site.css", language: "css" },
    ]);
  });

  it("ignores failed calls and opaque shell execution", () => {
    const cwd = temporaryDirectory();
    fs.writeFileSync(path.join(cwd, "changed.py"), "print('ok')\n");

    expect(collectQualityChangedFiles({
      cwd,
      audits: [
        audit("pi.write", { path: "changed.py" }, {}, false),
        audit("pi.bash", { command: "printf changed > changed.py" }),
      ],
    })).toEqual([]);
  });

  it("uses committed Schema paths and skips files deleted by the transaction", () => {
    const cwd = temporaryDirectory();
    fs.mkdirSync(path.join(cwd, "public"));
    fs.writeFileSync(path.join(cwd, "public", "index.html"), "<main>ok</main>\n");

    const audits = [audit(
      "schema.commit",
      {
        operations: [
          { kind: "write", path: "fallback.ts" },
          { kind: "delete", path: "removed.css" },
        ],
      },
      { outcome: "committed", paths: ["public/index.html", "removed.css"] },
    )];

    expect(collectQualityChangedFiles({ cwd, audits })).toEqual([
      { path: "public/index.html", language: "html" },
    ]);
  });

  it("falls back to declared Schema operations when committed result paths are unavailable", () => {
    const cwd = temporaryDirectory();
    fs.writeFileSync(path.join(cwd, "app.go"), "package app\n");

    const audits = [audit(
      "schema.commit",
      { operations: [{ kind: "edit", path: "app.go" }] },
      { outcome: "committed" },
    )];

    expect(collectQualityChangedFiles({ cwd, audits })).toEqual([
      { path: "app.go", language: "go" },
    ]);
  });

  it("rejects workspace escapes and symlinks that resolve outside the cwd", () => {
    const cwd = temporaryDirectory();
    const outside = temporaryDirectory();
    const outsideFile = path.join(outside, "outside.ts");
    fs.writeFileSync(outsideFile, "export {};\n");
    fs.symlinkSync(outsideFile, path.join(cwd, "linked.ts"));

    expect(collectQualityChangedFiles({
      cwd,
      audits: [
        audit("pi.write", { path: "../outside.ts" }),
        audit("pi.write", { path: outsideFile }),
        audit("pi.edit", { path: "linked.ts" }),
      ],
    })).toEqual([]);
  });

  it("uses bounded content probes for shebangs, binaries, and custom overrides", () => {
    const cwd = temporaryDirectory();
    fs.mkdirSync(path.join(cwd, "bin"));
    fs.writeFileSync(path.join(cwd, "bin", "check"), "#!/usr/bin/env bash\necho ok\n");
    fs.writeFileSync(path.join(cwd, "blob.custom"), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(cwd, "view.templ"), "package view\n");

    const files = collectQualityChangedFiles({
      cwd,
      audits: [
        audit("pi.write", { path: "bin/check" }),
        audit("pi.write", { path: "blob.custom" }),
        audit("pi.write", { path: "view.templ" }),
      ],
      languageOverrides: { ".templ": "go-template" },
      maxProbeBytes: 64,
    });

    expect(files).toEqual([
      { path: "bin/check", language: "shell" },
      { path: "blob.custom", language: "binary" },
      { path: "view.templ", language: "go-template" },
    ]);
  });
});
