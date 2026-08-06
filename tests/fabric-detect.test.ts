import { describe, expect, it } from "vitest";
import { interpretDetection } from "../src/init/detect.js";

// Pure detection: injected probe facts in, structured context out. No I/O.

describe("interpretDetection", () => {
  it("lockfile wins for the package manager, packageJson.packageManager as fallback", () => {
    const fromLock = interpretDetection({ lockfiles: ["pnpm-lock.yaml"], packageJson: null });
    expect(fromLock.packageManager).toBe("pnpm");
    const fromField = interpretDetection({ lockfiles: [], packageJson: { packageManager: "yarn@4.0.0", scripts: {} } });
    expect(fromField.packageManager).toBe("yarn");
  });

  it("maps known scripts to commands with the detected runner", () => {
    const d = interpretDetection({
      lockfiles: ["bun.lock"],
      packageJson: { scripts: { build: "bun run build", test: "vitest run", lint: "eslint", typecheck: "tsc --noEmit", check: "pnpm run check" } },
    });
    expect(d.commands.build).toBe("bun run build");
    expect(d.commands.test).toBe("bun run test");
    expect(d.commands.lint).toBe("bun run lint");
    expect(d.commands.typecheck).toBe("bun run typecheck");
    expect(d.commands.check).toBe("bun run check");
  });

  it("detects languages from manifest presence", () => {
    const d = interpretDetection({ lockfiles: [], packageJson: null, manifests: ["tsconfig.json", "Cargo.toml", "go.mod", "pyproject.toml"] });
    expect(d.languages).toContain("TypeScript");
    expect(d.languages).toContain("Rust");
    expect(d.languages).toContain("Go");
    expect(d.languages).toContain("Python");
  });

  it("captures MCP servers with tool counts and extension names", () => {
    const d = interpretDetection({
      lockfiles: [],
      packageJson: null,
      mcpServers: [{ name: "exa", toolCount: 4 }, { name: "deepwiki", toolCount: 2 }],
      extensions: ["pi-hindsight", "pi-better-openai"],
    });
    expect(d.mcpServers).toEqual([{ name: "exa", toolCount: 4 }, { name: "deepwiki", toolCount: 2 }]);
    expect(d.extensions).toContain("pi-hindsight");
  });

  it("identity precedence: gh before git config, and none when both absent", () => {
    const d = interpretDetection({ lockfiles: [], packageJson: null, identity: { gh: "octocat", git: "gituser" } });
    expect(d.identity?.name).toBe("octocat");
    const g = interpretDetection({ lockfiles: [], packageJson: null, identity: { gh: null, git: "gituser" } });
    expect(g.identity?.name).toBe("gituser");
    const n = interpretDetection({ lockfiles: [], packageJson: null, identity: { gh: null, git: null } });
    expect(n.identity).toBeNull();
  });

  it("empty probes produce safe fallbacks", () => {
    const d = interpretDetection({ lockfiles: [], packageJson: null });
    expect(d.packageManager).toBe("npm");
    expect(d.commands).toEqual({});
    expect(d.languages).toEqual([]);
    expect(d.mcpServers).toEqual([]);
    expect(d.extensions).toEqual([]);
    expect(d.identity).toBeNull();
  });
});
