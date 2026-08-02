import type { Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeConsultPath, type ConsultPerspective } from "./policy.js";
import type {
  ConsultEvidenceCandidate,
  ConsultEvidenceResolution,
  ConsultEvidenceResolver,
} from "./reducer.js";


const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const scoped = (target: string, perspective: ConsultPerspective): boolean =>
  perspective.scope.length === 0 || perspective.scope.some((scope) =>
    target === scope || target.startsWith(`${scope}/`)
  );

const rejected = (reason: string): ConsultEvidenceResolution => ({ kind: "rejected", reason });

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error &&
  typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;

const lineCount = (source: string): number => {
  if (!source) return 0;
  const lines = source.split(/\r\n|\n|\r/);
  if (/\r\n$|[\n\r]$/.test(source)) lines.pop();
  return lines.length;
};

type FileMetadata = Stats;
type LineCountResult =
  | { kind: "counted"; count: number }
  | { kind: "rejected"; reason: string };

const createLineCountLoader = (maxFileBytes: number, maxTotalBytes: number) => {
  const cached = new Map<string, Promise<LineCountResult>>();
  let reservedBytes = 0;
  return (target: string, metadata: FileMetadata): Promise<LineCountResult> => {
    const existing = cached.get(target);
    if (existing) return existing;
    const loaded = (async (): Promise<LineCountResult> => {
      if (metadata.size > maxFileBytes) return { kind: "rejected", reason: "file_too_large" };
      if (reservedBytes + metadata.size > maxTotalBytes) {
        return { kind: "rejected", reason: "evidence_budget_exhausted" };
      }
      reservedBytes += metadata.size;
      let handle;
      try {
        handle = await open(target, "r");
        const growthBudget = Math.max(0, maxTotalBytes - reservedBytes);
        const capacity = Math.min(maxFileBytes + 1, metadata.size + growthBudget + 1);
        const buffer = Buffer.alloc(Math.max(1, capacity));
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (read.bytesRead === 0) break;
          bytesRead += read.bytesRead;
        }
        const growth = bytesRead - metadata.size;
        const growthExceedsBudget = growth > 0 && reservedBytes + growth > maxTotalBytes;
        if (growth > 0 && !growthExceedsBudget) reservedBytes += growth;
        if (growth < 0) reservedBytes += growth;
        if (bytesRead > maxFileBytes) return { kind: "rejected", reason: "file_too_large" };
        if (growthExceedsBudget) {
          return { kind: "rejected", reason: "evidence_budget_exhausted" };
        }
        return { kind: "counted", count: lineCount(buffer.subarray(0, bytesRead).toString("utf8")) };
      } catch {
        return { kind: "rejected", reason: "unreadable" };
      } finally {
        await handle?.close().catch(() => undefined);
      }
    })();
    cached.set(target, loaded);
    return loaded;
  };
};

const resolveCandidate = async (
  rootPromise: Promise<string>,
  candidate: ConsultEvidenceCandidate,
  perspective: ConsultPerspective,
  metadataFor: (target: string) => Promise<FileMetadata>,
  countLines: (target: string, metadata: FileMetadata) => Promise<LineCountResult>,
): Promise<ConsultEvidenceResolution> => {
  const requestedPath = normalizeConsultPath(candidate.path);
  if (!requestedPath) return rejected("invalid_path");
  let root: string;
  try {
    root = await rootPromise;
    if (!root) return rejected("project_unavailable");
  } catch {
    return rejected("project_unavailable");
  }
  const lexicalTarget = path.resolve(root, requestedPath);
  if (!inside(root, lexicalTarget)) return rejected("outside_project");
  let target: string;
  try {
    target = await realpath(lexicalTarget);
  } catch (error) {
    return rejected(errorCode(error) === "ENOENT" ? "not_found" : "unreadable");
  }
  if (!inside(root, target)) return rejected("outside_project");
  const canonicalPath = path.relative(root, target).split(path.sep).join("/");
  if (!scoped(canonicalPath, perspective)) return rejected("outside_scope");

  let metadata;
  try {
    metadata = await metadataFor(target);
  } catch (error) {
    return rejected(errorCode(error) === "ENOENT" ? "not_found" : "unreadable");
  }
  if (!metadata.isFile()) return rejected("not_file");

  let line = candidate.line;
  let endLine = candidate.endLine;
  if (line !== undefined) {
    const counted = await countLines(target, metadata);
    if (counted.kind === "rejected") return rejected(counted.reason);
    endLine ??= line;
    if (line < 1 || endLine < line || endLine > counted.count) return rejected("line_out_of_range");
  } else {
    endLine = undefined;
  }
  const ref = line === undefined
    ? canonicalPath
    : endLine === line
      ? `${canonicalPath}#L${line}`
      : `${canonicalPath}#L${line}-L${endLine}`;
  return {
    kind: "resolved",
    evidence: {
      path: canonicalPath,
      ...(line === undefined ? {} : { line }),
      ...(endLine === undefined || endLine === line ? {} : { endLine }),
      claim: candidate.claim,
      ref,
    },
  };
};

export const createFileEvidenceResolver = (
  cwd: string,
  options: { maxFileBytes?: number; maxTotalBytes?: number } = {},
): ConsultEvidenceResolver => {
  const rootPromise = realpath(path.resolve(cwd)).catch(() => "");
  const maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes ?? 2 * 1024 * 1024));
  const maxTotalBytes = Math.max(1, Math.floor(options.maxTotalBytes ?? 8 * 1024 * 1024));
  const metadata = new Map<string, Promise<FileMetadata>>();
  const metadataFor = (target: string): Promise<FileMetadata> => {
    const existing = metadata.get(target);
    if (existing) return existing;
    const loaded = stat(target);
    metadata.set(target, loaded);
    return loaded;
  };
  const countLines = createLineCountLoader(maxFileBytes, maxTotalBytes);
  return (candidate, perspective) =>
    resolveCandidate(rootPromise, candidate, perspective, metadataFor, countLines);
};
