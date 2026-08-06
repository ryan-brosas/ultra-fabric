import { existsSync, readFileSync, realpathSync, readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";

export const MINIMUM_PI_HOST_VERSION = "0.80.6";

const PI_HOST_PACKAGE_NAMES = new Set([
  "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-coding-agent",
]);

interface ParsedVersion {
  numbers: [number, number, number];
  prerelease?: string;
}

const parseVersion = (value: string): ParsedVersion | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
};

export const compareVersions = (left: string, right: string): number | undefined => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < a.numbers.length; index++) {
    const delta = a.numbers[index]! - b.numbers[index]!;
    if (delta !== 0) return Math.sign(delta);
  }
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease === b.prerelease) return 0;
  return (a.prerelease ?? "").localeCompare(b.prerelease ?? "");
};

export const detectPiHostVersion = (
  cliPath: string | undefined = process.argv[1],
): string | undefined => {
  if (!cliPath) return undefined;
  let directory: string;
  try {
    directory = path.dirname(realpathSync(cliPath));
  } catch {
    return undefined;
  }
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (
          typeof manifest.name === "string" &&
          PI_HOST_PACKAGE_NAMES.has(manifest.name) &&
          typeof manifest.version === "string"
        ) {
          return manifest.version;
        }
      } catch {
        // Keep walking when a parent package manifest is unreadable.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

export const piHostCompatibilityWarning = (
  version: string | undefined = detectPiHostVersion(),
): string | undefined => {
  if (!version) return undefined;
  const comparison = compareVersions(version, MINIMUM_PI_HOST_VERSION);
  if (comparison === undefined || comparison >= 0) return undefined;
  return "Pi Fabric requires Pi >= " + MINIMUM_PI_HOST_VERSION + "; detected " + version + ". Persistent Agent triggerTurn and other host continuations may be ignored. Upgrade Pi before relying on persistent Agent delivery.";
};

// The Pi host loads dist at startup and keeps the loaded modules in memory, so a
// rebuild mid-session is not picked up until restart. This caused real confusion
// (e.g. codemap.explore reachable in a fresh node import but absent from the
// running host). staleBuildWarning compares the mtime of the passed entry (the
// loaded extension module) against the newest src file; when the loaded entry is
// the dist build and dist is older than src, the session is running stale code.
const walkSources = (dir: string, acc: string[] = []): string[] => {
  let entries: Dirent[] | undefined;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return acc;
  }
  for (const entry of entries ?? []) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".git") walkSources(full, acc);
    } else if (entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
};

export const staleBuildWarning = (loadedEntryPath: string): string | undefined => {
  const root = path.dirname(path.dirname(loadedEntryPath));
  const loadedIsDist = path.basename(path.dirname(loadedEntryPath)) === "dist";
  if (!loadedIsDist) return undefined;
  const distEntry = path.join(root, "dist", "index.js");
  const srcDir = path.join(root, "src");
  if (!existsSync(distEntry) || !existsSync(srcDir)) return undefined;
  const sourceFiles = walkSources(srcDir);
  if (sourceFiles.length === 0) return undefined;
  let newestSrc = 0;
  for (const file of sourceFiles) {
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime > newestSrc) newestSrc = mtime;
    } catch {
      // Unreadable source file: skip; the indicator is best-effort.
    }
  }
  let distMtime = 0;
  try {
    distMtime = statSync(distEntry).mtimeMs;
  } catch {
    return undefined;
  }
  if (newestSrc > distMtime) {
    return "The loaded Ultra Fabric build is stale: src/ is newer than dist/index.js, so this session is running pre-rebuild behavior. Run pnpm build, then restart Pi to pick up new functionality.";
  }
  return undefined;
};
