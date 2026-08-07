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

export const runOutline = (
  filePaths: readonly string[],
  options: OutlineOptions = {},
): OutlineFile[] => {
  const binary = options.binary ?? "ast-grep";
  const cwd = options.cwd ?? process.cwd();
  try {
    const res = crossSpawn.sync(binary, ["outline", "--json=compact", ...filePaths], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (res.error || res.status !== 0) return [];
    const stdout = res.stdout;
    if (!stdout.trim()) return [];
    const raw = JSON.parse(stdout) as RawFile[];
    if (!Array.isArray(raw)) return [];
    return raw.map(toFile);
  } catch {
    return [];
  }
};
