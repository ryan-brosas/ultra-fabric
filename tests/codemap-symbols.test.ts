import { describe, expect, it } from "vitest";
import {
  buildSymbolIndex,
  enclosingSymbol,
  buildContainmentEdges,
  buildReferenceEdges,
  buildAllEdges,
} from "../src/codemap/symbols.js";
import { extractImportEdges } from "../src/codemap/imports.js";
import { runOutline } from "../src/codemap/outline.js";
import { computeEdgeWeight } from "../src/codemap/rank.js";
import { findSourceFiles } from "../src/codemap/lang.js";

const files = runOutline(["src/workflows/durable.ts"]);
const index = buildSymbolIndex(files);
const root = process.cwd();

describe("buildSymbolIndex", () => {
  it("contains at least 6000 symbols across the full src tree", () => {
    const find = findSourceFiles(process.cwd(), [".ts"]);
    const fullFiles = runOutline(find);
    const fullIndex = buildSymbolIndex(fullFiles);
    expect(fullIndex.nodes.length).toBeGreaterThanOrEqual(6000);
  });

  it("resolves DurableWorkflowStore with symbolType class and non-empty members", () => {
    const store = index.byName.get("DurableWorkflowStore");
    expect(store).toBeDefined();
    expect(store![0]!.file).toBe("src/workflows/durable.ts");
    expect(store![0]!.symbolType).toBe("class");
    const members = index.nodes.filter((n) => n.parent === "DurableWorkflowStore");
    expect(members.length).toBeGreaterThan(0);
  });
});

describe("enclosingSymbol", () => {
  it("resolves a line inside cancel to cancel, not DurableWorkflowStore", () => {
    const resolved = enclosingSymbol(index, "src/workflows/durable.ts", 440);
    expect(resolved?.name).toBe("cancel");
  });
});

describe("buildContainmentEdges", () => {
  it("has an edge from DurableWorkflowStore to cancel", () => {
    const edges = buildContainmentEdges(index);
    expect(edges.some((e) => e.from.includes("DurableWorkflowStore") && e.to.includes("cancel"))).toBe(true);
  });

  it("has no self-edges", () => {
    const edges = buildContainmentEdges(index);
    expect(edges.every((e) => e.from !== e.to)).toBe(true);
  });
});

describe("buildReferenceEdges", () => {
  it("has a reference edge into refreshReady from a distinct enclosing symbol", () => {
    const edges = buildReferenceEdges(index, root);
    const intoSlug = edges.filter((e) => e.to.includes("refreshReady"));
    expect(intoSlug.length).toBeGreaterThan(0);
    expect(intoSlug.every((e) => e.from !== e.to)).toBe(true);
  });

  it("has no self-edges", () => {
    const edges = buildReferenceEdges(index, root);
    expect(edges.every((e) => e.from !== e.to)).toBe(true);
  });
});

describe("maxDefiners threshold", () => {
  it("suppresses edges for identifiers with more than 5 definitions", () => {
    const edges = buildReferenceEdges(index, root, { maxDefiners: 5 });
    // 'kind' has 71 definitions — should produce zero reference edges
    const kindEdges = edges.filter((e) => e.to.startsWith("kind:"));
    expect(kindEdges.length).toBe(0);
  });

  it("still emits edges for identifiers under the threshold", () => {
    const edges = buildReferenceEdges(index, root, { maxDefiners: 5 });
    // refreshReady has 1 definition — should still produce edges
    const slugEdges = edges.filter((e) => e.to.startsWith("refreshReady:"));
    expect(slugEdges.length).toBeGreaterThan(0);
  });
});

describe("buildAllEdges edge kinds", () => {
  it("produces all four LocAgent edge kinds over the full src tree", () => {
    const find = findSourceFiles(process.cwd(), [".ts"]);
    const fullIndex = buildSymbolIndex(runOutline(find));
    // The codemap has two graph layers: a symbol-level graph (buildAllEdges:
    // contains/invokes/inherits) and a file-level import graph (extractImportEdges:
    // imports). Both are built over src/; together they cover all four kinds.
    const symbolEdges = buildAllEdges(fullIndex, root);
    const importEdges = extractImportEdges(root).edges;
    const edges = [...symbolEdges, ...importEdges];
    const kinds = new Set(edges.map((e) => e.kind));
    for (const k of ["contains", "imports", "invokes", "inherits"] as const) {
      expect(edges.some((e) => e.kind === k)).toBe(true);
    }
    expect(kinds.size).toBe(4);
  });
});

describe("edge weighting for common names", () => {
  it("down-weights symbols defined in more than 5 files", () => {
    const rare = computeEdgeWeight("refreshReady", 1, false, false, 1);
    const common = computeEdgeWeight("create", 1, false, false, 10);
    expect(common).toBeLessThan(rare);
  });
});