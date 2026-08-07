// scripts/release-notes.mjs
// Builds a detailed GitHub Release body from the matching CHANGELOG.md section.
// Pure, dependency-free: no network, no model calls. The workflow enriches the
// body with a commit list via the GitHub API before creating the release.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPOSITORY = "ryan-brosas/ultra-fabric";

export const extractChangelogSection = (changelog, version) => {
  const heading = `## ${version} - `;
  const start = changelog.indexOf(heading);
  if (start === -1) return undefined;
  const lineEnd = changelog.indexOf("\n", start);
  const bodyStart = lineEnd === -1 ? changelog.length : lineEnd + 1;
  const nextHeading = changelog.indexOf("\n## ", bodyStart);
  const end = nextHeading === -1 ? changelog.length : nextHeading;
  const section = changelog.slice(bodyStart, end).trim();
  return section.length > 0 ? section : undefined;
};

// Changelogs list newest-first, so the previous release is the first section
// heading that appears AFTER the requested version.
export const previousVersion = (changelog, version) => {
  const heading = `## ${version} - `;
  const start = changelog.indexOf(heading);
  if (start === -1) return undefined;
  const after = changelog.slice(start);
  const match = after.match(/\n## ([^\n]+?) - \d{4}-\d{2}-\d{2}/);
  return match ? match[1] : undefined;
};

export const buildReleaseTitle = (version) => `ultra-fabric ${version}`;

export const buildReleaseBody = ({ version, section, previousVersion: prev, repository }) => {
  const lines = [section, ""];
  lines.push("## Install", "", "```sh", `pi install npm:ultra-fabric@${version}`, "```", "");
  lines.push("## Links", "");
  if (repository) {
    if (prev) lines.push(`Compare: ${repository}/compare/v${prev}...v${version}`);
    lines.push(`Release: ${repository}/releases/tag/v${version}`);
  }
  lines.push(`npm: https://www.npmjs.com/package/ultra-fabric/v/${version}`);
  return lines.join("\n");
};

const main = async () => {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf("--version");
  const outIndex = args.indexOf("--out");
  const version = versionIndex !== -1 ? args[versionIndex + 1] : undefined;
  const outDir = outIndex !== -1 ? args[outIndex + 1] : undefined;
  if (!version) {
    console.error("usage: node scripts/release-notes.mjs --version <version> [--out <dir>]");
    process.exit(2);
  }
  const changelog = await readFile(join(projectRoot, "CHANGELOG.md"), "utf8");
  const section = extractChangelogSection(changelog, version);
  if (!section) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  const prev = previousVersion(changelog, version);
  const repository =
    process.env.GITHUB_REPOSITORY !== undefined
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}`
      : `https://github.com/${DEFAULT_REPOSITORY}`;
  const title = buildReleaseTitle(version);
  const body = buildReleaseBody({ version, section, previousVersion: prev, repository });
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "release-title.txt"), title + "\n", "utf8");
    await writeFile(join(outDir, "release-body.md"), body + "\n", "utf8");
    await writeFile(join(outDir, "release-prev.txt"), prev ? `v${prev}` : "", "utf8");
  }
  process.stdout.write(body + "\n");
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
