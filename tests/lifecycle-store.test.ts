import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import {
  FabricWorkStore,
  sanitizeWorkSlug,
  deriveWorkSlug,
  type FabricWorkInput,
  type FabricWorkPhase,
  type FabricWorkStatus,
  type FabricWorkEvidence,
  type FabricWorkGate,
} from "../src/lifecycle/store.js";

const roots: string[] = [];
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-work-"));
  roots.push(root);
  const mesh = new MeshStore(root, 64 * 1024, 100);
  const identity: MeshIdentity = { id: "main:test", name: "Main", kind: "main" };
  let now = 1_000;
  const store = new FabricWorkStore(mesh, identity, { maxRecords: 20, now: () => now });
  return { store, mesh, setNow: (v: number) => { now = v; } };
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const baseInput = (overrides: Partial<FabricWorkInput> = {}): FabricWorkInput => ({
  slug: "add-auth-refresh",
  title: "Add auth refresh",
  phase: "research" as FabricWorkPhase,
  status: "active" as FabricWorkStatus,
  ...overrides,
});

const sampleEvidence = (): FabricWorkEvidence => ({ phase: "research", ref: "src/test.ts:1", claim: "test claim" });
const sampleGate = (): FabricWorkGate => ({ gate: "test", passed: true, sequence: 1, recordedAt: Date.now() });

describe("FabricWorkStore", () => {
  it("derives a slug from words rather than characters, capped at 6 words and 80 chars on a word boundary", () => {
    expect(deriveWorkSlug("Add Auth Refresh")).toBe("add-auth-refresh");
    expect(deriveWorkSlug("  fix  prewalk  loop  ")).toBe("fix-prewalk-loop");
    const long = "make the current workflow better look for arxiv";
    const slug = deriveWorkSlug(long);
    const words = slug.split("-");
    expect(words.length).toBeLessThanOrEqual(6);
    expect(slug.includes("templat")).toBe(false);
  });

  it("caps the slug at 80 characters even when a single word exceeds the limit, preferring word boundaries", () => {
    const long = deriveWorkSlug("a".repeat(102));
    expect(long.length).toBeLessThanOrEqual(80);
    const withWord = deriveWorkSlug("b".repeat(85) + " second");
    expect(withWord.length).toBeLessThanOrEqual(80);
  });

  it("escalates the suffix when both slug and slug-2 are already taken", async () => {
    const { store } = setup();
    await store.create(baseInput({ slug: "test", title: "First" }));
    await store.create(baseInput({ slug: "test", title: "Second" }));
    const third = await store.create(baseInput({ slug: "test", title: "Third" }));
    expect(third.slug).toBe("test-3");
    expect(third.title).toBe("Third");
  });

  it("does not let punctuation or case leak into the slug", () => {
    expect(deriveWorkSlug("Fix: the parser!")).toBe("fix-the-parser");
    expect(deriveWorkSlug("feat.2026.q3")).toBe("feat-2026-q3");
  });

  it("sanitizes slugs, collapsing whitespace and rejecting unsafe segments", () => {
    expect(sanitizeWorkSlug("Add Auth Refresh")).toBe("add-auth-refresh");
    expect(sanitizeWorkSlug("  fix  prewalk  loop  ")).toBe("fix-prewalk-loop");
    expect(sanitizeWorkSlug("feat.2026.q3")).toBe("feat.2026.q3");
    expect(() => sanitizeWorkSlug("__proto__")).toThrow("unsafe segment");
    expect(() => sanitizeWorkSlug("")).toThrow("cannot be empty");
  });

  it("accepts evidence and gates in the input", async () => {
    const { store } = setup();
    const record = await store.create(baseInput({
      evidence: [sampleEvidence()],
      gates: [sampleGate()],
    }));
    expect(record.evidence).toHaveLength(1);
    expect(record.gates).toHaveLength(1);
  });

  it("creates a work record idempotently and returns the existing record on collision", async () => {
    const { store } = setup();
    const first = await store.create(baseInput());
    const second = await store.create(baseInput());
    expect(second.slug).toBe(first.slug);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("suffixes colliding slugs when the title differs but the slug matches", async () => {
    const { store, setNow } = setup();
    const first = await store.create(baseInput({ slug: "auth-refresh", title: "Auth Refresh" }));
    setNow(2_000);
    const second = await store.create(baseInput({ slug: "auth-refresh", title: "Different Title" }));
    expect(second.slug).toBe("auth-refresh-2");
    expect(second.title).toBe("Different Title");
    expect(second.createdAt).toBeGreaterThan(first.createdAt);
  });

  it("updates a record via CAS and advances the phase", async () => {
    const { store, setNow } = setup();
    await store.create(baseInput());
    setNow(2_000);
    const updated = await store.update("add-auth-refresh", (record) => ({
      ...record,
      phase: "plan",
      artifacts: { ...record.artifacts, plan: ".artifact/add-auth-refresh/plan.md" },
    }));
    expect(updated.phase).toBe("plan");
    expect(updated.updatedAt).toBe(2_000);
    expect(updated.artifacts.plan).toBe(".artifact/add-auth-refresh/plan.md");
    expect(store.get("add-auth-refresh").phase).toBe("plan");
  });

  it("round-trips the active pointer", async () => {
    const { store } = setup();
    await store.create(baseInput({ slug: "feature-a" }));
    await store.setActive("feature-a");
    expect(store.getActive()).toBe("feature-a");
  });

  it("does not advance progress when inFlight is empty (simulating a failed settle)", async () => {
    const { store } = setup();
    await store.create(baseInput());
    // No inFlight set — completeInFlight is a no-op
    const record = await store.completeInFlight("add-auth-refresh");
    expect(record.progress).toEqual([]);
    expect(record.inFlight).toEqual([]);
  });

  it("claimPhaseContract returns the phase on first claim and undefined on repeat", async () => {
    const { store } = setup();
    await store.create(baseInput({ slug: "feature-a", phase: "research" }));
    await store.setActive("feature-a");
    expect(store.claimPhaseContract("session-1")).toBe("research");
    expect(store.claimPhaseContract("session-1")).toBeUndefined();
  });

  it("claimPhaseContract returns the new phase after a phase change", async () => {
    const { store } = setup();
    await store.create(baseInput({ slug: "feature-b", phase: "create" }));
    await store.setActive("feature-b");
    expect(store.claimPhaseContract("session-1")).toBe("create");
    await store.update("feature-b", (r) => ({ ...r, phase: "plan" }));
    expect(store.claimPhaseContract("session-1")).toBe("plan");
    expect(store.claimPhaseContract("session-1")).toBeUndefined();
  });

  it("defaults inFlight to an empty array on create", async () => {
    const { store } = setup();
    const record = await store.create(baseInput());
    expect(record.inFlight).toEqual([]);
  });

  it("completeInFlight moves inFlight ids into progress and clears inFlight", async () => {
    const { store } = setup();
    await store.create(baseInput());
    await store.update("add-auth-refresh", (r) => ({ ...r, inFlight: ["1.1", "1.2"] }));
    const updated = await store.completeInFlight("add-auth-refresh");
    expect(updated.inFlight).toEqual([]);
    expect(updated.progress).toEqual(["1.1", "1.2"]);
  });

  it("completeInFlight is idempotent when called twice", async () => {
    const { store } = setup();
    await store.create(baseInput());
    await store.update("add-auth-refresh", (r) => ({ ...r, inFlight: ["1.1"] }));
    await store.completeInFlight("add-auth-refresh");
    const second = await store.completeInFlight("add-auth-refresh");
    expect(second.progress).toEqual(["1.1"]);
    expect(second.inFlight).toEqual([]);
  });

  it("claimPhaseContract returns undefined with no active record or a dangling pointer", async () => {
    const { store } = setup();
    expect(store.claimPhaseContract("session-1")).toBeUndefined();
    await store.setActive("nonexistent");
    expect(store.claimPhaseContract("session-1")).toBeUndefined();
  });

  it("lists records and excludes the active pointer", async () => {
    const { store } = setup();
    await store.create(baseInput({ slug: "alpha", title: "Alpha" }));
    await store.create(baseInput({ slug: "beta", title: "Beta" }));
    await store.setActive("alpha");
    const records = store.list();
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.slug).sort()).toEqual(["alpha", "beta"]);
  });
});