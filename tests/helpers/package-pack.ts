import { execFileSync } from "node:child_process";

interface PackRecord {
  files: Array<{ path: string }>;
}

export function readPackedFilePaths(cwd = process.cwd()): Set<string> {
  const payload = JSON.parse(execFileSync(
    process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm",
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm", "pack", "--ignore-scripts", "--dry-run", "--json"]
      : ["pack", "--ignore-scripts", "--dry-run", "--json"],
    { cwd, encoding: "utf8" },
  )) as PackRecord[] | Record<string, PackRecord>;
  const packed = Array.isArray(payload) ? payload : Object.values(payload);

  return new Set(packed[0]!.files.map((entry) => entry.path));
}
