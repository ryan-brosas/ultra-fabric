import { describe, expect, it } from "vitest";
import { runOutline } from "../src/codemap/outline.js";

// runOutline degrades to [] when ast-grep cannot run, which keeps the Fabric
// provider from crashing its host. That same silence turns a broken toolchain
// into dozens of unrelated-looking assertion failures across the codemap suite,
// so this guard fails once, by name, instead.
describe("codemap toolchain", () => {
  it("has a working ast-grep binary, so codemap failures are real failures", () => {
    const files = runOutline(["src/codemap/outline.ts"]);
    expect(files.length, "ast-grep produced no outline: the binary is missing or not executable").toBeGreaterThan(0);
    expect(files[0]!.items.length, "ast-grep ran but parsed no symbols").toBeGreaterThan(0);
  });
});
