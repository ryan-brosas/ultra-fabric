import { statSync } from "node:fs";
import { resolve } from "node:path";
import { runOutline, type OutlineFile, type OutlineOptions } from "./outline.js";

// mtime-keyed outline cache so the graph rebuilds incrementally instead of
// re-running ast-grep over the whole tree on every call. A file is re-parsed
// only when its mtime changes; unchanged files are served from cache. This is
// the "incremental mapping" half of the design (vs tree-sitter's incremental
// parsing).

interface CacheEntry {
  mtime: number;
  file: OutlineFile;
}

const cache = new Map<string, CacheEntry>();

export interface OutlineCacheResult {
  files: OutlineFile[];
  misses: string[]; // files that were re-parsed (cache misses) this call
}

export const runOutlineCached = (
  files: readonly string[],
  options: OutlineOptions = {},
): OutlineCacheResult => {
  const cwd = options.cwd ?? process.cwd();
  const kept = new Map<string, OutlineFile>();
  const changed: string[] = [];
  for (const f of files) {
    const abs = resolve(cwd, f);
    let mtime: number;
    try {
      mtime = statSync(abs).mtimeMs;
    } catch {
      changed.push(f);
      continue;
    }
    const entry = cache.get(abs);
    if (entry && entry.mtime === mtime) {
      kept.set(f, entry.file);
    } else {
      changed.push(f);
    }
  }
  if (changed.length > 0) {
    const fresh = runOutline(changed, options);
    for (const file of fresh) {
      const abs = resolve(cwd, file.path);
      let mtime = 0;
      try {
        mtime = statSync(abs).mtimeMs;
      } catch {
        // best effort
      }
      cache.set(abs, { mtime, file });
      kept.set(file.path, file);
    }
  }
  // Preserve the requested order, dropping files that produced no outline.
  const ordered = files.map((f) => kept.get(f)).filter((x): x is OutlineFile => x !== undefined);
  return { files: ordered, misses: changed };
};