import { describe, expect, it } from "vitest";

const CODEMAP = "src/providers/codemap-provider";

describe("CodemapProvider", () => {
  it("name is codemap", async () => {
    const { CodemapProvider } = await import("../" + CODEMAP + ".js");
    const prov = new CodemapProvider();
    expect(prov.name).toBe("codemap");
  });

  it("list() returns every descriptor", async () => {
    const { CodemapProvider } = await import("../" + CODEMAP + ".js");
    const items = await new CodemapProvider().list({});
    expect(items).toHaveLength(7);
    const names = items.map((i: { name: string }) => i.name).sort();
    expect(names).toEqual(["cascade", "dwell", "expand", "focus", "search", "skeleton", "source"]);
    for (const item of items) {
      expect((item as { inputSchema?: unknown }).inputSchema).toBeDefined();
    }
  });

  it("list() filters by query", async () => {
    const { CodemapProvider } = await import("../" + CODEMAP + ".js");
    const items = await new CodemapProvider().list({ query: "search" });
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((i: { name: string; description: string }) => i.name.toLowerCase().includes("search") || i.description.toLowerCase().includes("search"))).toBe(true);
  });

  it("describe('search') returns the search descriptor", async () => {
    const { CodemapProvider } = await import("../" + CODEMAP + ".js");
    const desc = await new CodemapProvider().describe("search");
    expect(desc).toBeDefined();
    expect(desc.name).toBe("search");
  });

  it("expand descriptor depth bound is capped at 2", async () => {
    const { CodemapProvider } = await import("../" + CODEMAP + ".js");
    const expand = await new CodemapProvider().describe("expand");
    expect(expand).toBeDefined();
    const depth = (expand!.inputSchema as Record<string, unknown>).properties as Record<string, unknown>;
    expect((depth.depth as Record<string, unknown>).maximum).toBe(2);
  });

  it("list() includes a cascade descriptor", async () => {
    const { CodemapProvider } = await import("../" + CODEMAP + ".js");
    const items = await new CodemapProvider().list({});
    expect(items.some((i: { name: string }) => i.name === "cascade")).toBe(true);
  });

  it("invoke('cascade') finds a real co-change partner", { timeout: 60000 }, async () => {
    const { CodemapProvider } = await import("../" + CODEMAP + ".js");
    const result = await new CodemapProvider().invoke("cascade", { seed: "src/config.ts", maxTokens: 2000 }, { cwd: process.cwd() });
    const text = JSON.stringify(result);
    expect(text).toContain("tests/config.test.ts");
  });

  it("describe of unknown name is undefined", async () => {
    const { CodemapProvider } = await import("../" + CODEMAP + ".js");
    const desc = await new CodemapProvider().describe("nonexistent");
    expect(desc).toBeUndefined();
  });

  it("invoke('search') finds real symbols in the repo", async () => {
    const { CodemapProvider } = await import("../" + CODEMAP + ".js");
    const result = await new CodemapProvider().invoke("search", { query: "buildCodeGraph" }, { cwd: process.cwd() });
    expect(typeof result).toBe("object");
    const text = JSON.stringify(result);
    expect(text).toContain("src/codemap/build.ts");
  });

  it("invoke of an unknown action rejects", async () => {
    const { CodemapProvider } = await import("../" + CODEMAP + ".js");
    await expect(new CodemapProvider().invoke("bogus", {}, { cwd: process.cwd() })).rejects.toThrow();
  });
});