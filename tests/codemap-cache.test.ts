import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { runOutlineCached, clearOutlineCache } from "../src/codemap/cache.js";

const dir = join("/tmp", "codemap-cache-fixture");

describe("runOutlineCached", () => {
  it("reuses cached entries on an unchanged tree and invalidates only touched files", () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "export function alpha() {}\n");
    writeFileSync(join(dir, "b.ts"), "export function beta() {}\n");
    writeFileSync(join(dir, "c.ts"), "export function gamma() {}\n");
    clearOutlineCache();

    const files = ["a.ts", "b.ts", "c.ts"];

    // Cold build: every file is a cache miss.
    const cold = runOutlineCached(files, { cwd: dir });
    expect(cold.misses.sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(cold.files.length).toBe(3);

    // Warm build: no misses, same content.
    const warm = runOutlineCached(files, { cwd: dir });
    expect(warm.misses.length).toBe(0);
    expect(warm.files.length).toBe(3);

    // Touch only b.ts (advance mtime) -> only b.ts is a miss on the next build.
    const newMtime = new Date(Date.now() / 1000 * 1000 + 5_000);
    utimesSync(join(dir, "b.ts"), newMtime, newMtime);
    const partial = runOutlineCached(files, { cwd: dir });
    expect(partial.misses).toEqual(["b.ts"]);
    expect(partial.files.length).toBe(3);

    rmSync(dir, { recursive: true, force: true });
  });
});