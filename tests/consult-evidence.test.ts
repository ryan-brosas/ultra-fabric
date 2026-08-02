import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileEvidenceResolver } from "../src/consult/evidence.js";

const roots: string[] = [];
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-consult-evidence-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src", "auth"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "auth", "tokens.ts"), "one\ntwo\nthree\nfour\n", "utf8");
  fs.writeFileSync(path.join(root, "outside.ts"), "outside\n", "utf8");
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Ultra Consult file evidence", () => {
  it("resolves an existing in-scope line range to one canonical address", async () => {
    const root = setup();
    const resolve = createFileEvidenceResolver(root);
    await expect(resolve({
      path: "./src/auth/tokens.ts",
      line: 2,
      endLine: 3,
      claim: "rotation updates two states",
    }, {
      id: "tokens",
      question: "inspect tokens",
      scope: ["src/auth"],
    })).resolves.toEqual({
      kind: "resolved",
      evidence: {
        path: "src/auth/tokens.ts",
        line: 2,
        endLine: 3,
        claim: "rotation updates two states",
        ref: "src/auth/tokens.ts#L2-L3",
      },
    });
  });

  it("rejects real files outside the perspective scope", async () => {
    const root = setup();
    const resolve = createFileEvidenceResolver(root);
    await expect(resolve({ path: "outside.ts", claim: "outside" }, {
      id: "tokens",
      question: "inspect tokens",
      scope: ["src/auth"],
    })).resolves.toEqual({ kind: "rejected", reason: "outside_scope" });
  });

  it("rejects missing files and invalid line ranges", async () => {
    const root = setup();
    const resolve = createFileEvidenceResolver(root);
    const perspective = { id: "tokens", question: "inspect", scope: ["src"] };
    await expect(resolve({ path: "src/missing.ts", claim: "missing" }, perspective))
      .resolves.toEqual({ kind: "rejected", reason: "not_found" });
    await expect(resolve({ path: "src/auth/tokens.ts", line: 9, claim: "bad line" }, perspective))
      .resolves.toEqual({ kind: "rejected", reason: "line_out_of_range" });
  });

  it("rejects absolute and parent-traversal paths before filesystem access", async () => {
    const root = setup();
    const resolve = createFileEvidenceResolver(root);
    const perspective = { id: "tokens", question: "inspect", scope: [] };
    await expect(resolve({ path: "/etc/passwd", claim: "absolute" }, perspective))
      .resolves.toEqual({ kind: "rejected", reason: "invalid_path" });
    await expect(resolve({ path: "../outside.ts", claim: "escape" }, perspective))
      .resolves.toEqual({ kind: "rejected", reason: "invalid_path" });
  });

  it("rejects a symlink that resolves outside the project root", async () => {
    const root = setup();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-consult-external-"));
    roots.push(external);
    fs.writeFileSync(path.join(external, "secret.ts"), "secret\n", "utf8");
    fs.symlinkSync(path.join(external, "secret.ts"), path.join(root, "src", "escape.ts"));
    const resolve = createFileEvidenceResolver(root);
    await expect(resolve({ path: "src/escape.ts", claim: "escaped" }, {
      id: "all",
      question: "inspect",
      scope: ["src"],
    })).resolves.toEqual({ kind: "rejected", reason: "outside_project" });
  });

  it("caps cumulative evidence reads while caching repeated files", async () => {
    const root = setup();
    fs.writeFileSync(path.join(root, "src", "one.ts"), "one\ntwo\nthree\nfour\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "two.ts"), "five\nsix\nseven\neight\n", "utf8");
    const resolve = createFileEvidenceResolver(root, {
      maxFileBytes: 64,
      maxTotalBytes: 32,
    });
    const perspective = { id: "all", question: "inspect", scope: ["src"] };

    await expect(resolve({ path: "src/one.ts", line: 1, claim: "one" }, perspective))
      .resolves.toMatchObject({ kind: "resolved" });
    await expect(resolve({ path: "src/one.ts", line: 2, claim: "two" }, perspective))
      .resolves.toMatchObject({ kind: "resolved" });
    await expect(resolve({ path: "src/two.ts", line: 1, claim: "five" }, perspective))
      .resolves.toEqual({ kind: "rejected", reason: "evidence_budget_exhausted" });
  });

  it("bounds file reads used for line validation", async () => {
    const root = setup();
    fs.writeFileSync(path.join(root, "src", "large.ts"), "x".repeat(100), "utf8");
    const resolve = createFileEvidenceResolver(root, { maxFileBytes: 32 });
    await expect(resolve({ path: "src/large.ts", line: 1, claim: "large" }, {
      id: "all",
      question: "inspect",
      scope: ["src"],
    })).resolves.toEqual({ kind: "rejected", reason: "file_too_large" });
  });
});
