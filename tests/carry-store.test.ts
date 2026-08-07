import { describe, expect, it } from "vitest";
import { CarryStore } from "../src/runtime/carry-store.js";

describe("CarryStore", () => {
  it("isolates snapshots per session and round-trips values", () => {
    const store = new CarryStore();
    store.persist("session-a", { token: "alpha" });
    store.persist("session-b", { token: "beta" });

    expect(store.snapshot("session-a")).toEqual({ token: "alpha" });
    expect(store.snapshot("session-b")).toEqual({ token: "beta" });
    expect(store.snapshot("session-c")).toEqual({});
  });

  it("returns copies so callers cannot mutate stored state", () => {
    const store = new CarryStore();
    store.persist("s", { list: [1] });
    const first = store.snapshot("s") as { list: number[] };
    first.list.push(2);
    expect(store.snapshot("s")).toEqual({ list: [1] });
  });

  it("rejects oversized payloads and keeps the previous snapshot", () => {
    const store = new CarryStore();
    store.persist("s", { keep: "small" });
    store.persist("s", { big: "y".repeat(300_000) });
    expect(store.snapshot("s")).toEqual({ keep: "small" });
  });

  it("evicts the oldest sessions beyond the bound", () => {
    const store = new CarryStore(2);
    store.persist("s1", { n: 1 });
    store.persist("s2", { n: 2 });
    store.persist("s3", { n: 3 });
    expect(store.snapshot("s1")).toEqual({});
    expect(store.snapshot("s2")).toEqual({ n: 2 });
    expect(store.snapshot("s3")).toEqual({ n: 3 });
  });

  it("refreshes recency on persist so active sessions survive eviction", () => {
    const store = new CarryStore(2);
    store.persist("s1", { n: 1 });
    store.persist("s2", { n: 2 });
    store.persist("s1", { n: 10 });
    store.persist("s3", { n: 3 });
    expect(store.snapshot("s1")).toEqual({ n: 10 });
    expect(store.snapshot("s2")).toEqual({});
  });

  it("clears everything", () => {
    const store = new CarryStore();
    store.persist("s", { n: 1 });
    store.clear();
    expect(store.snapshot("s")).toEqual({});
  });
});
