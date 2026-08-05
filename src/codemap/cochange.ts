import { execFileSync } from "node:child_process";

export interface CoChangeEntry {
  file: string;
  count: number;
  rate: number;
}

export interface CoChangeOptions {
  cwd?: string;
  maxCommits?: number;
}

const git = (args: string[], cwd: string): string => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 }).trim();
  } catch {
    return "";
  }
};

export const mineCoChange = (
  anchorFile: string,
  options: CoChangeOptions = {},
): CoChangeEntry[] => {
  const cwd = options.cwd ?? process.cwd();
  const maxCommits = Math.min(options.maxCommits ?? 200, 500);
  const hashes = git(
    ["log", `--format=%H`, `-${maxCommits}`, "--", anchorFile],
    cwd,
  ).split("\n").filter(Boolean);
  if (hashes.length === 0) return [];
  const total = hashes.length;
  const counts = new Map<string, number>();
  for (const hash of hashes) {
    const files = git(["show", "--name-only", "--format=", hash], cwd)
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f && f !== anchorFile);
    for (const file of new Set(files)) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([file, count]) => ({ file, count, rate: count / total }))
    .sort((a, b) => b.count - a.count);
};