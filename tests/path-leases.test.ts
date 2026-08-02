import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathLeaseStore } from "../src/leases/path-leases.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const roots: string[] = [];
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-path-leases-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
  const identity: MeshIdentity = { id: "main:test", name: "Main", kind: "main" };
  let now = 100;
  let sequence = 0;
  const leases = new PathLeaseStore(mesh, identity, {
    now: () => now,
    nextId: () => `lease-${++sequence}`,
  });
  return { root, mesh, leases, setNow: (value: number) => { now = value; } };
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("PathLeaseStore", () => {
  it("rejects an overlapping writer before mutation and permits owner writes", async () => {
    const { root, leases } = setup();
    const acquired = await leases.acquire(root, {
      ownerRunId: "run-a",
      paths: [{ path: "src", scope: "tree" }],
      ttlMs: 1_000,
    });
    expect(acquired).toMatchObject({ leases: [{ id: "lease-1", ownerRunId: "run-a" }] });
    expect(() => leases.assertCanWrite(root, "run-a", "src/a.ts")).not.toThrow();
    expect(() => leases.assertCanWrite(root, "run-b", "other.ts")).not.toThrow();
    expect(() => leases.assertCanWrite(root, "run-b", "src/a.ts")).toThrow(
      "Path write conflicts with lease lease-1 owned by run-a",
    );
  });

  it("blocks pi.write at the host chokepoint before creating the file", async () => {
    const { root, leases } = setup();
    await leases.acquire(root, {
      ownerRunId: "run-a",
      paths: [{ path: "src", scope: "tree" }],
      ttlMs: 1_000,
    });
    const provider = new PiToolsProvider(root, undefined, undefined, leases);
    const context = {
      cwd: root,
      parentToolCallId: "run-b",
      nestedToolCallId: "nested",
      extensionContext: {},
      update() {},
      activity() {},
      run: {
        version: 1,
        runId: "run-b",
        traceId: "trace-b",
        spanId: "span-b",
        objectiveDigest: "digest-b",
        startedAt: 100,
        deadline: 1_100,
        cancellationOwner: "run-b",
      },
    } as unknown as FabricInvocationContext;

    await expect(provider.invoke(
      "write",
      { path: "src/blocked.ts", content: "export {};" },
      context,
    )).rejects.toThrow("Path write conflicts with lease lease-1 owned by run-a");
    expect(fs.existsSync(path.join(root, "src", "blocked.ts"))).toBe(false);
  });

  it("expires leases and releases only for their owner", async () => {
    const { root, leases, setNow } = setup();
    const acquired = await leases.acquire(root, {
      ownerRunId: "run-a",
      paths: [{ path: "src/a.ts", scope: "file" }],
      ttlMs: 1_000,
    });
    const id = acquired.leases[0]!.id;
    await expect(leases.release("run-b", [id])).rejects.toThrow("does not own path lease");
    setNow(1_101);
    expect(() => leases.assertCanWrite(root, "run-b", "src/a.ts")).not.toThrow();
    await expect(leases.list()).resolves.toEqual([]);
  });

  it("lets an operator force-release foreign and unreadable lease state", async () => {
    const { root, mesh, leases } = setup();
    await leases.acquire(root, {
      ownerRunId: "run-a",
      paths: [{ path: "src", scope: "tree" }],
      ttlMs: 60_000,
    });
    expect(() => leases.assertCanWrite(root, "run-b", "src/a.ts")).toThrow();

    await expect(leases.forceRelease(["lease-1"])).resolves.toEqual({ released: ["lease-1"] });
    expect(() => leases.assertCanWrite(root, "run-b", "src/a.ts")).not.toThrow();

    await mesh.put({
      key: "path-leases/v1",
      value: { format: 1, leases: [{ id: "broken" }] },
      identity: { id: "other", name: "Other", kind: "main" },
      ifVersion: mesh.get("path-leases/v1")!.version,
    });
    await expect(leases.list()).rejects.toThrow("/fabric leases --release-all");

    await expect(leases.forceRelease()).resolves.toEqual({ released: [] });
    await expect(leases.list()).resolves.toEqual([]);
  });

  it("rejects malformed shared lease state instead of overwriting it", async () => {
    const { mesh, leases } = setup();
    await mesh.put({
      key: "path-leases/v1",
      value: { format: 1, leases: [{ id: "broken" }] },
      identity: { id: "other", name: "Other", kind: "main" },
    });

    await expect(leases.list()).rejects.toThrow("Invalid path lease state");
  });

  it("admits only one of two concurrent conflicting acquisitions", async () => {
    const { root, leases } = setup();
    const settled = await Promise.allSettled([
      leases.acquire(root, {
        ownerRunId: "run-a",
        paths: [{ path: "src", scope: "tree" }],
        ttlMs: 1_000,
      }),
      leases.acquire(root, {
        ownerRunId: "run-b",
        paths: [{ path: "src/a.ts", scope: "file" }],
        ttlMs: 1_000,
      }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});

describe("PathLeaseStore host wiring", () => {
  const runContext = (root: string, runId: string) =>
    ({
      cwd: root,
      parentToolCallId: runId,
      nestedToolCallId: "nested",
      extensionContext: {},
      update() {},
      activity() {},
      run: {
        version: 1,
        runId,
        traceId: `trace-${runId}`,
        spanId: `span-${runId}`,
        objectiveDigest: "digest",
        startedAt: 100,
        deadline: 1_100,
        cancellationOwner: runId,
      },
    }) as unknown as FabricInvocationContext;

  it("enforces only after setPathLeases installs the store, and stops when cleared", async () => {
    const { root, leases } = setup();
    await leases.acquire(root, {
      ownerRunId: "run-a",
      paths: [{ path: "src", scope: "tree" }],
      ttlMs: 60_000,
    });
    // Production installs the store through the setter, not the constructor.
    const provider = new PiToolsProvider(root, undefined, undefined);
    const write = () =>
      provider.invoke(
        "write",
        { path: "src/wired.ts", content: "export {};" },
        runContext(root, "run-b"),
      );

    await expect(write()).resolves.toBeDefined();
    fs.rmSync(path.join(root, "src", "wired.ts"));

    provider.setPathLeases(leases);
    await expect(write()).rejects.toThrow("conflicts with lease");
    expect(fs.existsSync(path.join(root, "src", "wired.ts"))).toBe(false);

    provider.setPathLeases(undefined);
    await expect(write()).resolves.toBeDefined();
  });
});
