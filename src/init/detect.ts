// /fabric init environment detection. Pure: probe facts are injected, and the
// module returns structured context used to fill the scaffold templates.
// No I/O imports; the adapter gathers probes with fs/exec effects.

export interface McpServerProbe {
  name: string;
  toolCount: number;
}

export interface IdentityProbe {
  gh: string | null; // gh api user login
  git: string | null; // git config user.name
}

export interface DetectionProbes {
  lockfiles: string[]; // filenames present, e.g. ["pnpm-lock.yaml"]
  packageJson: { packageManager?: string; scripts?: Record<string, string> } | null;
  manifests?: string[]; // filenames present, e.g. ["tsconfig.json"]
  mcpServers?: McpServerProbe[];
  extensions?: string[];
  identity?: IdentityProbe;
}

export interface DetectedCommand {
  build?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
  check?: string;
}

export interface DetectedContext {
  packageManager: string;
  commands: DetectedCommand;
  languages: string[];
  dependencies: string[];
  mcpServers: McpServerProbe[];
  extensions: string[];
  identity: { name: string; source: "gh" | "git" } | null;
}

const LOCKFILE_TO_PM: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
};

const MANIFEST_TO_LANG: Array<[string, string]> = [
  ["tsconfig.json", "TypeScript"],
  ["Cargo.toml", "Rust"],
  ["go.mod", "Go"],
  ["pyproject.toml", "Python"],
  ["pom.xml", "Java"],
  ["package.json", "JavaScript"],
];

const SCRIPT_KEYS = ["build", "test", "lint", "typecheck", "check"] as const;

export const interpretDetection = (probes: DetectionProbes): DetectedContext => {
  const lockPm = probes.lockfiles.map((name) => LOCKFILE_TO_PM[name]).find((pm) => pm !== undefined);
  const fieldPm = probes.packageJson?.packageManager?.split("@")[0];
  const packageManager = lockPm ?? fieldPm ?? "npm";

  const scripts = probes.packageJson?.scripts ?? {};
  const commands: DetectedCommand = {};
  for (const key of SCRIPT_KEYS) {
    if (typeof scripts[key] === "string") {
      commands[key] = packageManager + " run " + key;
    }
  }

  const manifests = probes.manifests ?? [];
  const languages = MANIFEST_TO_LANG.filter(([name]) => manifests.includes(name)).map(([, lang]) => lang);
  const deduped = languages.includes("TypeScript")
    ? languages.filter((lang) => lang !== "JavaScript")
    : languages;

  const mcpServers = probes.mcpServers ?? [];
  const extensions = probes.extensions ?? [];

  let identity: DetectedContext["identity"] = null;
  if (probes.identity?.gh) identity = { name: probes.identity.gh, source: "gh" };
  else if (probes.identity?.git) identity = { name: probes.identity.git, source: "git" };

  return {
    packageManager,
    commands,
    languages: deduped,
    dependencies: [],
    mcpServers,
    extensions,
    identity,
  };
};
