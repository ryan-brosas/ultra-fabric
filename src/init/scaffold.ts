// /fabric init: pure, non-destructive project scaffold planner.
// Context files (AGENTS.md + the durable trio + user.md) live at the ROOT per
// the agents.md standard and ecosystem convention (see docs/fabric-init.md);
// settings and role profiles stay under .pi because the host mechanically
// reads them there (role-profiles.ts:301-303, config loading). No I/O here.

import type { DetectedContext } from "./detect.js";

export interface InitFile {
  path: string;
  content: string;
  action: "create" | "skip";
}

export interface InitPlan {
  files: InitFile[];
  migrations: string[];
}

const LEGACY_CONTEXT = [".pi/project.md", ".pi/roadmap.md", ".pi/tech-stack.md"];

const fabricJson = (configVersion: number): string =>
  JSON.stringify({ configVersion, fullCodeMode: false }, null, 2) + "\n";

const commandLine = (value: string | undefined, label: string, placeholder: string): string =>
  value ? "- " + label + ": " + value : "- " + label + ": " + placeholder;

const commandsBlock = (detected: DetectedContext | null): string => {
  const c = detected?.commands ?? {};
  const gate = c.check
    ? c.check
    : [c.typecheck, c.lint, c.test].filter(Boolean).join(" && ");
  return [
    commandLine(c.build, "Build", "<build command>"),
    commandLine(c.test, "Test", "<test command>"),
    commandLine(gate || undefined, "Gate", "<typecheck + lint + test command>"),
  ].join("\n");
};

const lockfileNameFor = (pm: string): string => {
  switch (pm) {
    case "pnpm":
      return "pnpm-lock.yaml";
    case "bun":
      return "bun.lock";
    case "yarn":
      return "yarn.lock";
    default:
      return "package-lock.json";
  }
};

const renderAgentsMd = (detected: DetectedContext | null): string =>
  "# AGENTS.md\n\nOperating rules for AI agents working in this repository.\n\n## Rule 0: User authority\n\nThe user's latest explicit instruction controls intent and scope. When it conflicts with anything here, the user wins.\n\n## Project overview\n\n<One or two sentences: what this project is and what it does.>\n\n## Commands\n\n" +
  commandsBlock(detected) +
  "\n\n## Architecture & layout\n\n<Where the important code lives and how the pieces relate.>\n\n## Conventions\n\n- <naming, imports, commit style>\n\n## Destructive actions\n\n- Never delete a file or folder without explicit written permission, including files you created yourself.\n- Never run irreversible commands (git reset --hard, git clean -fd, rm -rf) unless the user states the exact command and accepts the consequences.\n- Prefer safer alternatives first (git status, git diff, backups).\n- Never stash, reset, restore, or overwrite other agents' concurrent working-tree changes; treat them as your own and build around them.\n\n## Code editing discipline\n\n- Revise existing files in place. New files are only for genuinely new functionality; no _v2 / _improved / _enhanced variants.\n- No script-based bulk rewrites of code. Make changes directly, or delegate many simple instances to parallel role agents.\n- Find all references before renaming or changing a signature.\n\n## Testing policy\n\nTests cover the happy path, edge cases (empty input, boundaries), and error conditions. Run the focused test module after a change, then the repository gate.\n\n## Research discipline\n\n- Check sources/ early for reference implementations and upstream code; clone to sources/ and read locally instead of fetching isolated files.\n- Verify claims against source or label them unconfirmed. Separate what you verified locally from what still needs confirmation on live servers.\n\n## Secrets\n\nNever put secrets (tokens, keys, passwords) in prompts, agent instructions, messages, logs, or committed files. Read them at runtime from environment variables or config. Never echo them.\n\n## Writing\n\n- One name per thing; active voice; short common words.\n- No marketing filler (seamless, robust, comprehensive) or stacked hedges (\"it is important to note that\").\n- Keep replies proportional: do not narrate tool calls or echo file contents.\n\n## Agent surfaces\n\nThis project runs on Ultra Fabric. Agents have first-party tooling:\n\n- /fabric prewalk plans before mutations; the checklist gates each slice.\n- codemap (skeleton / search / expand / cascade / source) is the AST code map — use it before grep for symbols, structure, and call graphs.\n- mcp.$search balances evidence queries across the configured MCP search tools (web, docs, repo-wiki).\n- Role agents: scout (external research), explorer (codebase cartography) — delegate breadth to them on their own context budget.\n\nDurable project context:\n\n- project.md — purpose, scope, current milestone\n- roadmap.md — ordered milestones with status\n- tech-stack.md — languages, frameworks, tooling, versions\n- user.md — identity and preferences\n\n## Fabric behavior\n\nThis repository runs under Ultra Fabric, which closes the loop between the user's intent and implementation:\n\n- /fabric prewalk arms before the first mutation. Once armed, the first mutation is gated behind an accepted checklist. Research-mode checklists carry 5-9 validated items; easy escape takes 2-4 items for bounded tasks; a trivial escape takes 1-2 small edits in the same turn without a model swap.\n- After the checklist is accepted, the executor owns implementation through completion and re-arms per user message. A blocked handoff is retried with /fabric prewalk --retry.\n- Role agents (scout, explorer, worker, reviewer) resolve their model by precedence: the per-call request wins, then /fabric settings roleModels, then the profile pin. Delegate breadth to children — they spend their own context, but a child carries a fixed harness context per turn, so delegate whole questions, not micro-queries.\n- The checklist gates every mutation. Tests, the repository gate, and a receipt are part of completion.\n\n## Verification\n\nRun the repository gate before finishing a slice and report the result.\n";

const PROJECT_MD = "# Project\n\n## Purpose & scope\n\n<What this project is for, who it serves, and what is in scope.>\n\n## Non-goals\n\n<What this project deliberately does not do.>\n\n## Users\n\n<Who uses it and how.>\n\n## Current milestone\n\n<What is being worked on now, with the acceptance criteria that define done.>\n\n- Goal: <outcome>\n- Acceptance: <observable definition of done>\n\n## Decisions\n\n<Architecture and direction decisions, one entry per line:>\n\n- <date> <decision> — <reason> — <alternatives considered>\n\n## Risks & constraints\n\n- <risk or constraint> — <mitigation or owner>\n\n## Links\n\n- Docs: <link>\n- Issue tracker: <link>\n- CI: <link>\n";

const ROADMAP_MD = "# Roadmap\n\n## Usage\n\nUpdate this file as work lands. Move a milestone to Done with its evidence, and mark anything deliberately shelved as Parked with the reason.\n\n## Milestones\n\n### 1. <milestone name>\n\n- Goal: <outcome>\n- Acceptance: <observable definition of done>\n- Status: <todo | in-progress | done>\n- Evidence: <test run, benchmark, or artifact proving it>\n\n### 2. <milestone name>\n\n- Goal: <outcome>\n- Acceptance: <observable definition of done>\n- Status: <todo | in-progress | done>\n- Evidence: <test run, benchmark, or artifact proving it>\n\n## Done\n\n- <milestone name> — <date> — <evidence>\n\n## Parked\n\n- <milestone name> — <reason>\n";

const renderTechStackMd = (detected: DetectedContext | null): string => {
  const languages = detected?.languages?.length
    ? detected.languages.map((l) => "| " + l + " | <ver> | <where it is used> |").join("\n")
    : "| <lang> | <ver> | <where it is used> |";
  const pm = detected?.packageManager;
  const pmLine = pm
    ? "- " + pm + " only; commit the lockfile (" + lockfileNameFor(pm) + "). Do not introduce other lockfiles."
    : "- <manager> only; commit the lockfile. Do not introduce other lockfiles.";
  const mcpRows = detected?.mcpServers?.length
    ? detected.mcpServers.map((s) => "| " + s.name + " | " + s.toolCount + " tools | <env var or config path> |").join("\n")
    : "| <name> | <what it provides> | <env var or config path> |";
  return (
    "# Tech Stack\n\n## Languages\n\n| Language | Version | Purpose |\n|----------|---------|---------|\n" +
    languages +
    "\n\n## Frameworks & libraries\n\n| Component | Version | Purpose |\n|-----------|---------|---------|\n| <name> | <ver> | <what it does here> |\n\n## Tooling\n\n- Build: <command>\n- Test: <command>\n- Lint: <command>\n- Typecheck: <command>\n\n## Runtime targets\n\n<Node or runtime version, OS targets, deployment targets.>\n\n## Package manager & lockfile policy\n\n" +
    pmLine +
    "\n\n## Upgrade policy\n\n<When and how dependencies are upgraded, and who reviews the change.>\n\n## External services & MCP servers\n\n| Service / server | Purpose | Credentials location |\n|------------------|---------|----------------------|\n" +
    mcpRows +
    "\n"
  );
};

const renderUserMd = (identity: DetectedContext["identity"]): string => {
  const identityLine = identity
    ? "- GitHub: @" + identity.name + " (detected via " + (identity.source === "gh" ? "gh CLI" : "git config") + ")"
    : "<GitHub username — run \`gh auth status\` or tell me your handle, then fill this in>";
  return (
    "# User\n\n## Identity\n\n" +
    identityLine +
    "\n\n## Preferences\n\n<how you like to work, review cadence, tooling choices>\n\n## Current focus\n\n<what you are working toward>\n"
  );
};const SCOUT_MD = "---\nname: scout\ndescription: Fast read-only external research — dependency source, docs, ecosystem facts — returning cited findings with evidence locators\nlifecycle: one-shot\ngoal: Answer the research question with the smallest set of authoritative sources and return concise findings plus evidence locators\ncompletion: Stop when the recommendation is supported, every non-trivial claim is cited, and no further search is likely to change it\nmaxTurns: 6\ngraceTurns: 1\ntools: read, grep, find, ls, codemap\nmodel: omniroute/auto/fast\n---\n\n# Scout\n\nYou are a read-only external research specialist. You never modify the workspace. You return concise, cited findings — never file dumps.\n\n## Output contract\n\n- Lead with the direct answer, then the evidence.\n- Findings: 1-3 sentence verdicts. Locators: exact repo paths with file:line, or verified URLs.\n- Never return whole files. Separate verified facts from assumptions; state source conflicts explicitly.\n- Stop when more searching is unlikely to change the recommendation.\n\n## Evidence tools\n\n- Discovery first: call mcp.$search with your query — it classifies intent, ranks every search-capable MCP tool by health and recency, and falls back across them. Use pin/deny/weights to steer; read the provenance to report which server and tool answered.\n- Named fallbacks only when $search is unavailable: mcp.exa.omniroute_web_search for web search, mcp.exa.omniroute_web_fetch for page extraction, deepwiki for repository questions. Source hierarchy: official docs > library source > maintainer articles > community posts.\n- Dependency or upstream source: read clones under sources/ first; clone to /tmp only when absent. Repo-local facts come from source, not the internet.\n- Local context: codemap search/source for symbol definitions; pi.grep only for string literals, comments, and configuration text.\n\n## Retrieval budget\n\nStart with one broad search or one official-doc lookup. Search again only when the core question is unanswered, a required fact is missing, or a claim would otherwise be unsupported. Absence of evidence is not evidence of absence — report what you checked.\n\n## Citations\n\nCite every non-trivial claim with a file:line or URL. Never invent URLs. If a source is inaccessible, say so explicitly and continue with whatever evidence remains.\n";const EXPLORER_MD = "---\nname: explorer\ndescription: Fast read-only codebase cartographer — locate files, symbols, call paths — returning file:line evidence locators\nlifecycle: one-shot\ngoal: Map the terrain the caller asked for — exact files, symbols, and call paths — with file:line evidence\ncompletion: Stop as soon as the answer is supported; do not map unrelated transitive code\nmaxTurns: 6\ngraceTurns: 1\ntools: read, grep, find, ls, codemap\nmodel: omniroute/auto/best-coding-fast\n---\n\n# Explorer\n\nYou are a read-only codebase explorer. You output concise, evidence-backed findings with exact paths — never file dumps.\n\n## Output contract\n\n- Findings: 1-3 sentence verdicts. Locators: absolute paths with file:line for every non-obvious claim.\n- Never return whole files. Mark uncertainty explicitly when multiple candidates remain.\n- Stop when the answer is supported; do not trace transitive code beyond what is needed.\n\n## Navigation tools — codemap first\n\n- codemap search: resolve symbol, declaration, call, and phrase queries from the AST index (name, symbolType, file:line).\n- codemap source: read the exact AST range of a name:file symbol key.\n- codemap expand: disclose the dependency neighborhood (upstream/downstream) around entity keys.\n- codemap cascade: predict co-change partners for a seed file or symbol.\n- pi.read with offset/limit: read only the window around a hit.\n- pi.grep ONLY for literal text that is not a code symbol: string literals, comments, configuration.\n\n## Retrieval budget\n\nStart with one codemap search batch. Search again only if the first batch misses a required file, returns ambiguous candidates, or a claim would be unsupported. Prefer targeted sections over whole-file reads. Never re-read a file you already read.\n";

export const planInit = (
  existingPaths: ReadonlySet<string>,
  configVersion: number,
  detected: DetectedContext | null = null,
): InitPlan => {
  const files: InitFile[] = [];
  const add = (path: string, content: string): void => {
    files.push({ path, content, action: existingPaths.has(path) ? "skip" : "create" });
  };
  add("AGENTS.md", renderAgentsMd(detected));
  add("project.md", PROJECT_MD);
  add("roadmap.md", ROADMAP_MD);
  add("tech-stack.md", renderTechStackMd(detected));
  add("user.md", renderUserMd(detected?.identity ?? null));
  add(".pi/fabric.json", fabricJson(configVersion));
  add(".pi/agents/scout.md", SCOUT_MD);
  add(".pi/agents/explorer.md", EXPLORER_MD);
  const migrations = LEGACY_CONTEXT
    .filter((p) => existingPaths.has(p))
    .map((p) => "legacy context " + p + " exists; consider moving its content to the root-level sibling (report only — nothing was changed)");
  return { files, migrations };
};

export interface InitIo {
  exists: (path: string) => boolean;
  write: (path: string, content: string) => void;
}

// Adapter: apply a plan through injected exists/write so the command wiring
// stays thin and tests stay hermetic.
export const applyInitPlan = (plan: InitPlan, io: InitIo): { created: string[]; skipped: string[] } => {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const f of plan.files) {
    if (f.action === "skip" || io.exists(f.path)) {
      skipped.push(f.path);
      continue;
    }
    io.write(f.path, f.content);
    created.push(f.path);
  }
  return { created, skipped };
};