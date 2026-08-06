import { execFileSync } from "node:child_process";

// Read-only bridge to CGC (CodeGraphContext, pipx-installed "cgc" CLI).
// CGC keeps its own FalkorDB-backed graph over the operator's configured root
// (the "work" repo tree, which includes the inspo reference clones). This module is a
// separate query surface: CGC results are never merged into the project's own
// ast-grep graph, so reference symbol names cannot collide with project ones.
// Only read commands are used (query / stats); nothing here mutates CGC state.

type CgcErrorKind = "unavailable" | "timeout" | "error";
export type CgcResult =
  | { ok: true; text: string }
  | { ok: false; kind: CgcErrorKind; message: string };

// Injected seam so tests never shell out. Throws on failure (ENOENT, timeout,
// nonzero exit with stderr), mirroring execFileSync behavior.
export type CgcRunner = (args: string[]) => string;

export interface CgcOptions {
  // "" = global CGC database. A path prefix (e.g. /home/ryanj/work/inspo/<repo>)
  // scopes the cypher templates via STARTS WITH on node paths. CGC named
  // contexts are passed through when a context is registered.
  context?: string;
  timeoutMs?: number;
  runner?: CgcRunner;
}

const DEFAULT_CGC_TIMEOUT_MS = 30_000;

export const defaultCgcRunner: CgcRunner = (args) =>
  execFileSync("cgc", args, {
    encoding: "utf8",
    timeout: DEFAULT_CGC_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });

// cgc query prints bootstrap lines ("Resolving context...", rich console setup)
// before the JSON array of scalar projections (json.dumps). Extract the array.
export const extractCgcJson = (stdout: string): unknown => {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
};

export const runCgc = (runner: CgcRunner, args: string[], timeoutMs: number): CgcResult => {
  void timeoutMs;
  try {
    return { ok: true, text: runner(args) };
  } catch (e) {
    const err = e as { code?: string | number; stderr?: unknown; message?: string };
    if (err.code === "ENOENT") {
      return { ok: false, kind: "unavailable", message: "cgc binary not found on PATH" };
    }
    if (err.code === "ETIMEDOUT" || err.code === "SIGTERM") {
      return { ok: false, kind: "timeout", message: "cgc query timed out" };
    }
    const detail =
      typeof err.stderr === "string" && err.stderr.trim()
        ? err.stderr.trim().split("\n").slice(-3).join(" | ")
        : String(err.message ?? err);
    return { ok: false, kind: "error", message: detail.slice(0, 300) };
  }
};

export const cgcQuery = (cypher: string, opts: CgcOptions = {}): CgcResult => {
  const runner = opts.runner ?? defaultCgcRunner;
  const args = ["query", cypher];
  if (opts.context) args.push("--context", opts.context);
  return runCgc(runner, args, opts.timeoutMs ?? DEFAULT_CGC_TIMEOUT_MS);
};

// Cypher templates, proven against the live falkordb-remote "work" graph
// (CGC 0.5.2). Scalar projections only: raw Node objects are not JSON
// serializable in cgc query output. Scope clause uses STARTS WITH on the node
// path when a repo path prefix is configured.

const scopeClause = (alias: string, context?: string): string =>
  context && context.startsWith("/")
    ? ` AND ${alias}.path STARTS WITH ${JSON.stringify(context)}`
    : "";

export const cypher = {
  symbolSearch: (query: string, context?: string): string =>
    `MATCH (f:Function) WHERE f.name CONTAINS ${JSON.stringify(query)}${scopeClause("f", context)} RETURN f.name, f.path, f.line_number, f.lang LIMIT 20`,
  fileSearch: (query: string, context?: string): string =>
    `MATCH (f:File) WHERE f.path CONTAINS ${JSON.stringify(query)}${scopeClause("f", context)} RETURN f.path LIMIT 10`,
  functionCount: (context?: string): string =>
    `MATCH (f:Function) WHERE 1 = 1${scopeClause("f", context)} RETURN count(*) AS c`,
  fileCount: (context?: string): string =>
    `MATCH (f:File) WHERE 1 = 1${scopeClause("f", context)} RETURN count(*) AS c`,
  hotspots: (minComplexity: number, context?: string): string =>
    `MATCH (f:Function) WHERE f.cyclomatic_complexity > ${minComplexity}${scopeClause("f", context)} RETURN f.name, f.path, f.line_number, f.cyclomatic_complexity ORDER BY f.cyclomatic_complexity DESC LIMIT 10`,
  importsOf: (filePath: string): string =>
    `MATCH (f:File)-[:IMPORTS]->(m:Module) WHERE f.path = ${JSON.stringify(filePath)} RETURN m.name LIMIT 20`,
  inheritsOf: (name: string, context?: string): string =>
    `MATCH (c:Class)-[:INHERITS]->(x) WHERE c.name = ${JSON.stringify(name)}${scopeClause("c", context)} RETURN x.name, x.path LIMIT 10`,
  sourceOf: (name: string, context?: string): string =>
    `MATCH (f:Function) WHERE f.name = ${JSON.stringify(name)}${scopeClause("f", context)} RETURN f.source, f.path, f.line_number LIMIT 1`,
  testsIn: (context?: string): string =>
    `MATCH (f:File) WHERE (f.path CONTAINS "test" OR f.path CONTAINS "spec")${scopeClause("f", context)} RETURN f.path LIMIT 20`,
};
