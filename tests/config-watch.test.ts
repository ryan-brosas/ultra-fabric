import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFabricConfig } from "../src/config.js";
import {
  configMtimesChanged,
  reloadConfigWhenChanged,
} from "../src/fabric-state.js";

describe("config watch", () => {
  const paths = (dir: string): readonly string[] => [
    join(dir, "agent", "fabric.json"),
    join(dir, "proj", ".pi", "fabric.json"),
  ];

  it("reloads the project config when its mtime changes and skips unchanged files", () => {
    const dir = mkdtempSync(join(tmpdir(), "fabric-config-watch-"));
    try {
      mkdirSync(join(dir, "proj", ".pi"), { recursive: true });
      mkdirSync(join(dir, "agent"), { recursive: true });
      const projectPath = paths(dir)[1]!;
      const opts = { cwd: join(dir, "proj"), agentDir: join(dir, "agent"), projectTrusted: true };
      writeFileSync(projectPath, JSON.stringify({ configVersion: 3, prewalk: { model: "anthropic/one" } }));
      expect(loadFabricConfig(opts).prewalk.model).toBe("anthropic/one");

      // First check seeds the baseline without reloading.
      let state = reloadConfigWhenChanged({ prev: null, paths: paths(dir), reload: vi.fn() });
      expect(state.reloaded).toBe(false);
      // Unchanged mtimes cause zero reloads.
      const quiet = vi.fn();
      state = reloadConfigWhenChanged({ prev: state.next, paths: paths(dir), reload: quiet });
      expect(state.reloaded).toBe(false);
      expect(quiet).not.toHaveBeenCalled();

      // Mutate the project file with a forced distinct mtime: the next prompt
      // reloads and the new value lands in the live config.
      writeFileSync(projectPath, JSON.stringify({ configVersion: 3, prewalk: { model: "anthropic/two" } }));
      utimesSync(projectPath, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
      let reloadedModel: string | undefined;
      state = reloadConfigWhenChanged({
        prev: state.next,
        paths: paths(dir),
        reload: () => {
          reloadedModel = loadFabricConfig(opts).prewalk.model;
        },
      });
      expect(state.reloaded).toBe(true);
      expect(reloadedModel).toBe("anthropic/two");

      // Once reloaded, the new mtime is cached: no further reloads.
      const quiet2 = vi.fn();
      state = reloadConfigWhenChanged({ prev: state.next, paths: paths(dir), reload: quiet2 });
      expect(state.reloaded).toBe(false);
      expect(quiet2).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports mtime changes across the watched paths", () => {
    const prev = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(configMtimesChanged(prev, new Map([["a", 1], ["b", 2]]))).toBe(false);
    expect(configMtimesChanged(prev, new Map([["a", 3], ["b", 2]]))).toBe(true);
    expect(configMtimesChanged(prev, new Map([["a", 1], ["b", 2], ["c", 0]]))).toBe(true);
  });
});
