import crossSpawn from "cross-spawn";

export interface OutlineRange {
  line: number;       // 1-indexed
  column: number;
  endLine: number;     // 1-indexed
  endColumn: number;
}

export interface OutlineMember {
  symbolType: string;
  name: string;
  range: OutlineRange;
  isPublic: boolean;
}

export interface OutlineItem {
  symbolType: string;
  name: string;
  range: OutlineRange;
  signature: string;
  astKind: string;
  isImport: boolean;
  isExported: boolean;
  members: OutlineMember[];
}

export interface OutlineFile {
  path: string;
  language: string;
  items: OutlineItem[];
}

interface RawRange {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

interface RawMember {
  symbolType: string;
  name: string;
  range: RawRange;
  isPublic?: boolean;
}

interface RawItem {
  symbolType: string;
  name: string;
  range: RawRange;
  signature: string;
  astKind: string;
  isImport: boolean;
  isExported: boolean;
  members?: RawMember[];
}

interface RawFile {
  path: string;
  language: string;
  items: RawItem[];
}

const toRange = (raw: RawRange): OutlineRange => ({
  line: raw.start.line + 1,
  column: raw.start.column,
  endLine: raw.end.line + 1,
  endColumn: raw.end.column,
});

const toMember = (raw: RawMember): OutlineMember => ({
  symbolType: raw.symbolType,
  name: raw.name,
  range: toRange(raw.range),
  isPublic: raw.isPublic ?? true,
});

const toItem = (raw: RawItem): OutlineItem => ({
  symbolType: raw.symbolType,
  name: raw.name,
  range: toRange(raw.range),
  signature: raw.signature,
  astKind: raw.astKind,
  isImport: raw.isImport,
  isExported: raw.isExported,
  members: (raw.members ?? []).map(toMember),
});

const toFile = (raw: RawFile): OutlineFile => ({
  path: raw.path,
  language: raw.language,
  items: raw.items.map(toItem),
});

export interface OutlineOptions {
  binary?: string;
  cwd?: string;
}

// Windows cmd.exe shims truncate command lines at 8191 characters. A full-tree
// ast-grep argv (hundreds of file paths) exceeds that and fails silently, so
// chunk the file list into bounded batches and merge the JSON results. Chunks
// keep order so callers see the same outline on every platform.
export const CHUNK_TARGET_CHARS = 3500;

export const chunkPaths = (filePaths: readonly string[], maxChars = CHUNK_TARGET_CHARS): string[][] => {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const file of filePaths) {
    if (current.length > 0 && chars + file.length + 1 > maxChars) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(file);
    chars += file.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

export const runOutline = (
  filePaths: readonly string[],
  options: OutlineOptions = {},
): OutlineFile[] => {
  const binary = options.binary ?? "ast-grep";
  const cwd = options.cwd ?? process.cwd();
  const files: OutlineFile[] = [];
  for (const chunk of chunkPaths(filePaths)) {
    try {
      const res = crossSpawn.sync(binary, ["outline", "--json=compact", ...chunk], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (res.error || res.status !== 0) continue;
      const stdout = res.stdout;
      if (!stdout.trim()) continue;
      const raw = JSON.parse(stdout) as RawFile[];
      if (Array.isArray(raw)) files.push(...raw.map(toFile));
    } catch {
      // skip this chunk; other chunks still contribute
    }
  }
  return files;
};
