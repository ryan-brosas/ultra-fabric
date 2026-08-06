import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { codemapOperation } from "../src/codemap/tool.js";

const REPOS = [
  { root: process.cwd(), query: "buildCodeGraph", label: "ultra-fabric" },
  { root: "sources/pi-fovea", query: "buildCsr", label: "pi-fovea" },
  { root: "/tmp/codemap-bench/json-server", query: "default", label: "json-server" },
  { root: "/tmp/codemap-bench/pdf.js", query: "PDFDocument", label: "pdf.js" },
  { root: "/tmp/codemap-bench/superagent", query: "request", label: "superagent" },
];

describe("codemap focus/dwell across codebases", () => {
  for (const { root, query, label } of REPOS) {
    // Cross-repo bench fixtures (sources/, /tmp/codemap-bench) are cloned
    // on demand and absent from CI; skip rather than fail when missing.
    const available = root === process.cwd() || fs.existsSync(root);
    it.skipIf(!available)(`${label}: focus → dwell cycle`, { timeout: 120_000 }, () => {
      const focus = codemapOperation("focus", { query, maxTokens: 2000 }, root);
      expect(focus.operation).toBe("focus");

      if (focus.tokens === 0) {
        expect(focus.text).toContain("no symbols matched");
        return;
      }

      expect(focus.text.length).toBeGreaterThan(10);
      expect(focus.entities.length).toBeGreaterThan(0);

      const dwell = codemapOperation("dwell", { maxTokens: 2000, disclosed: focus.entities }, root);
      expect(dwell.operation).toBe("dwell");
      if (dwell.tokens > 0) {
        for (const id of dwell.entities) {
          expect(focus.entities).not.toContain(id);
        }
        expect(focus.tokens + dwell.tokens).toBeLessThanOrEqual(4000);
      }
    });
  }
});
