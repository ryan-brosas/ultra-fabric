import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("context certification host contract", () => {
  it("loads against the installed Pi host version", async () => {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const packagePath = path.join(path.dirname(path.dirname(entry)), "package.json");
    const installed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version: string };

    // @ts-expect-error Certification adapters are dependency-free JavaScript loaded directly by Node.
    const adapter = await import("../../scripts/certification/pi-compaction.mjs");

    expect(adapter.PI_COMPACTION_API.version).toBe(installed.version);
  });
});
