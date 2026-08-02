import fs from "node:fs";
import nodePath from "node:path";
import { detectQualityLanguage } from "./languages.js";
import type { QualityChangedFile } from "./policy.js";

export interface QualityMutationAudit {
  ref: string;
  success?: boolean;
  args?: Record<string, unknown>;
  result?: unknown;
}

interface CollectQualityChangedFilesOptions {
  cwd: string;
  audits: readonly QualityMutationAudit[];
  languageOverrides?: Readonly<Record<string, string>>;
  maxProbeBytes?: number;
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const stringPaths = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

const schemaPaths = (audit: QualityMutationAudit): string[] => {
  const result = recordValue(audit.result);
  if (result?.outcome !== "committed") return [];
  const committedPaths = stringPaths(result.paths);
  if (committedPaths.length > 0) return committedPaths;
  const operations = audit.args?.operations;
  if (!Array.isArray(operations)) return [];
  return operations.flatMap((operation) => {
    const path = recordValue(operation)?.path;
    return typeof path === "string" && path.trim() ? [path] : [];
  });
};

export const mutationPathsFromAudits = (
  audits: readonly QualityMutationAudit[],
): string[] => {
  const paths: string[] = [];
  for (const audit of audits) {
    if (audit.success !== true) continue;
    if (audit.ref === "pi.write" || audit.ref === "pi.edit") {
      const path = audit.args?.path;
      if (typeof path === "string" && path.trim()) paths.push(path);
    } else if (audit.ref === "schema.commit") {
      paths.push(...schemaPaths(audit));
    }
  }
  return [...new Set(paths)];
};

const isInside = (cwd: string, target: string): boolean => {
  const relative = nodePath.relative(cwd, target);
  return relative !== ""
    && !relative.startsWith(`..${nodePath.sep}`)
    && relative !== ".."
    && !nodePath.isAbsolute(relative);
};

const readProbe = (filePath: string, maxBytes: number): string => {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(descriptor, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
};

export const collectQualityChangedFiles = (
  options: CollectQualityChangedFilesOptions,
): QualityChangedFile[] => {
  const cwd = fs.realpathSync(options.cwd);
  const maxProbeBytes = Math.min(
    1024 * 1024,
    Math.max(1, Math.floor(options.maxProbeBytes ?? 8 * 1024)),
  );
  const seen = new Set<string>();
  const files: QualityChangedFile[] = [];

  for (const requestedPath of mutationPathsFromAudits(options.audits)) {
    const resolved = nodePath.resolve(cwd, requestedPath);
    if (!isInside(cwd, resolved)) continue;

    let canonical: string;
    try {
      canonical = fs.realpathSync(resolved);
      if (!isInside(cwd, canonical) || !fs.statSync(canonical).isFile()) continue;
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const relative = nodePath.relative(cwd, canonical).split(nodePath.sep).join("/");
    const content = readProbe(canonical, maxProbeBytes);
    files.push({
      path: relative,
      language: detectQualityLanguage(relative, content, options.languageOverrides),
    });
  }

  return files;
};
