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
// before the JSON array of scalar projections. Extract the array.
export const extractCgcJson = (stdout: string): unknown => {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(repairWrappedStrings(clean.slice(start, end + 1))) as unknown;
  } catch {
    return null;
  }
};

// The cgc CLI prints query results with Rich's print_json, which wraps long
// string values at the console width (default 80 when piped) by embedding a
// real newline inside the JSON string literal. JSON.stringify escapes real
// newlines in values as \n, so any raw newline inside a string literal is a
// wrap artifact: drop it and the value rejoins exactly as emitted.
const repairWrappedStrings = (json: string): string => {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === "\n" || ch === "\r") {
        // wrap artifact inside a string value
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
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
    // The cgc CLI writes diagnostics ("Error: Context 'x' is not registered")
    // to stdout while stderr carries only bootstrap lines; prefer the stream
    // that actually contains a diagnostic so the failure message is actionable.
    const stdoutRaw = (err as { stdout?: unknown }).stdout;
    const stderr =
      typeof err.stderr === "string" && err.stderr.trim() ? err.stderr.trim() : null;
    const stdout =
      typeof stdoutRaw === "string" && stdoutRaw.trim() ? stdoutRaw.trim() : null;
    const hasDiag = (s: string): boolean => /error|not registered|query error/i.test(s);
    let detail =
      stderr && stdout
        ? hasDiag(stdout)
          ? stdout
          : stderr
        : (stderr ?? stdout ?? String(err.message ?? err));
    detail = detail.split("\n").slice(-3).join(" | ");
    return { ok: false, kind: "error", message: detail.slice(0, 300) };
  }
};

export const cgcQuery = (cypher: string, opts: CgcOptions = {}): CgcResult => {
  const runner = opts.runner ?? defaultCgcRunner;
  const args = ["query", cypher];
  // Path-prefix contexts scope name in the cypher (STARTS WITH), never as
  // --context: CGC only accepts a registered context name there, and passing a
  // path throws with the bootstrap lines on stderr. Only a registered name
  // (no leading slash) becomes the --context flag.
  if (opts.context && !opts.context.startsWith("/")) {
    args.push("--context", opts.context);
  }
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

// Vendored and generated paths poison scoped results: a checkout that indexes
// its reference clones and benchmark artifacts fills hotspot and search output
// with minified bundle functions. Applied only when a path scope narrows the
// query to one checkout; the unscoped global view stays unfiltered.
const VENDOR_EXCLUSIONS = ["/sources/", "/bench/", "node_modules", ".min.js"] as const;
const exclusionClause = (alias: string, context?: string): string =>
  context && context.startsWith("/")
    ? VENDOR_EXCLUSIONS.map((p) => ` AND NOT ${alias}.path CONTAINS ${JSON.stringify(p)}`).join("")
    : "";

// Multi-word queries are agent phrasing ("PrewalkController claimChecklistReminder"),
// not literal names: no symbol contains the joined string, so each token must
// match independently and any token hit qualifies.
const tokenMatchClause = (alias: string, query: string): string => {
  const tokens = query.split(/\s+/).filter(Boolean).slice(0, 6);
  if (tokens.length <= 1) {
    return `${alias}.name CONTAINS ${JSON.stringify(tokens[0] ?? query)}`;
  }
  return "(" + tokens.map((t) => `${alias}.name CONTAINS ${JSON.stringify(t)}`).join(" OR ") + ")";
};

export const cypher = {
  symbolSearch: (query: string, context?: string): string =>
    `MATCH (f:Function) WHERE ${tokenMatchClause("f", query)}${scopeClause("f", context)}${exclusionClause("f", context)} RETURN f.name, f.path, f.line_number, f.lang LIMIT 20`,
  classSearch: (query: string, context?: string): string =>
    `MATCH (c:Class) WHERE ${tokenMatchClause("c", query)}${scopeClause("c", context)}${exclusionClause("c", context)} RETURN c.name, c.path, c.line_number, c.lang LIMIT 10`,
  fileSearch: (query: string, context?: string): string =>
    `MATCH (f:File) WHERE f.path CONTAINS ${JSON.stringify(query)}${scopeClause("f", context)} RETURN f.path LIMIT 10`,
  functionCount: (context?: string): string =>
    `MATCH (f:Function) WHERE 1 = 1${scopeClause("f", context)} RETURN count(*) AS c`,
  fileCount: (context?: string): string =>
    `MATCH (f:File) WHERE 1 = 1${scopeClause("f", context)} RETURN count(*) AS c`,
  hotspots: (minComplexity: number, context?: string): string =>
    `MATCH (f:Function) WHERE f.cyclomatic_complexity > ${minComplexity}${scopeClause("f", context)}${exclusionClause("f", context)} RETURN f.name, f.path, f.line_number, f.cyclomatic_complexity ORDER BY f.cyclomatic_complexity DESC LIMIT 10`,
  importsOf: (filePath: string): string =>
    `MATCH (f:File)-[:IMPORTS]->(m:Module) WHERE f.path = ${JSON.stringify(filePath)} RETURN m.name LIMIT 20`,
  inheritsOf: (name: string, context?: string): string =>
    `MATCH (c:Class)-[:INHERITS]->(x) WHERE c.name = ${JSON.stringify(name)}${scopeClause("c", context)} RETURN x.name, x.path LIMIT 10`,
  sourceOf: (name: string, context?: string, file?: string): string =>
    `MATCH (f:Function) WHERE f.name = ${JSON.stringify(name)}${file ? ` AND f.path CONTAINS ${JSON.stringify(file)}` : ""}${scopeClause("f", context)} RETURN f.source, f.path, f.line_number LIMIT 1`,
  testsIn: (context?: string): string =>
    `MATCH (f:File) WHERE (f.path CONTAINS "test" OR f.path CONTAINS "spec")${scopeClause("f", context)} RETURN f.path LIMIT 20`,
};
