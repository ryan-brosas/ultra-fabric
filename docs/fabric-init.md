# Fabric Init: Repository Context Workflow

Research-backed placement and content for Fabric project context. `/fabric init`
is a visible repository workflow, not a silent scaffold: it queues a displayed
follow-up message for Main that inspects the repository, proposes only grounded
context changes, and reports created, updated, skipped, and validated artifacts.
The command itself never writes files. The pure scaffold planner in
`src/init/scaffold.ts` remains the tested reference for the templates and
placement decisions below.

## 1. External research (ranked sources, fetched via mcp.exa.omniroute_web_search / omniroute_web_fetch)

### AGENTS.md open standard
- agents.md (primary, fetched): AGENTS.md complements README — agent-focused instructions (build steps, tests, conventions) kept out of README. Adopted by Copilot, Windsurf, Cursor, Codex, Gemini CLI, Devin, Warp, and others.
- Discovery (agents.md): "Agents automatically read the nearest file in the directory tree, so the closest one takes precedence and every subproject can ship tailored instructions." Files may be nested per hierarchy (github.com/agentsmd/agents.md/issues/135, v1.1 proposal).

### Harness conventions
- opencode (opencode.ai/docs/rules/, fetched): AGENTS.md = custom instructions in LLM context, "similar to Cursor's rules". \`/init\` scans important files, may ask targeted questions, then creates or **updates** AGENTS.md in place — "improve it in place instead of blindly replacing it". Focus: build/lint/test commands, command order + verification, architecture not obvious from filenames, conventions/setup gotchas, references to existing instruction sources.
- Claude Code (code.claude.com/docs/en/memory, fetched): CLAUDE.md loaded at the start of every conversation; treated as context, not enforced config; "the more specific and concise your instructions, the more consistently Claude follows them". \`/init\` generates a starting CLAUDE.md automatically (build commands, test instructions). Filetype-scoped rules via .claude/rules/; auto memory separate.
- Cursor: legacy root .cursorrules (deprecated) -> .cursor/rules/ directory (deployhq.com guide).
- GitHub Copilot: .github/copilot-instructions.md (deployhq.com guide).
- Gemini CLI: GEMINI.md at project root (agents.md ecosystem list; gemini-cli docs).

### Init precedents (overwrite behavior)
- opencode \`/init\`: improves in place, never blindly replaces.
- Claude \`/init\`: generates when absent; interactive otherwise. Both are non-destructive by default.

## 2. Local discovery (this stack, file:line evidence)

- pi loads context files at startup: "Context files (AGENTS.md walking up from cwd)" (pi sdk.md:350); "Global context file (AGENTS.md)" (sdk.md:359); "Pi loads context files at startup. Add an AGENTS.md file to tell it how to work in a project" (quickstart.md:88); "AGENTS.md and CLAUDE.md context files are loaded regardless of project trust" (security.md:27); ".contextFiles - AGENTS.md files and other loaded context files" (extensions.md:538).
- .pi/project.md, .pi/roadmap.md, .pi/tech-stack.md: ZERO mechanical references in ultra-fabric src (grep across src/, no hits) and absent from pi docs — convention-only, referenced by this repo's AGENTS.md/CLAUDE.md.
- \`/fabric settings\` -> openFabricSettings (src/commands/fabric.ts:884) -> settings UI (src/ui/settings.ts) persisting to the project fabric config .pi/fabric.json (tracked in git).
- Config version constant: CURRENT_FABRIC_CONFIG_VERSION (src/config.ts:7).

## 3. Decision

- **AGENTS.md at root** — the single mechanically-loaded rules entrypoint (pi walks up from cwd; root tops the walk). Follows the agents.md standard and opencode convention.
- **project.md, roadmap.md, tech-stack.md at ROOT** (not .pi/) — ecosystem convention is root-level context files; .pi is the config/state dir (fabric.json, runs, mesh). None of the three are mechanically loaded anywhere, so placement is conventional: root siblings of AGENTS.md, linked from it.
- **.pi/fabric.json stays under .pi** — settings, mechanically read by the host; scaffolded with configVersion: CURRENT_FABRIC_CONFIG_VERSION and minimal keys (fullCodeMode: false).
- **Strictly non-destructive**: per-file create/skip; existing files reported as skipped; when legacy .pi/project.md-style files are detected, emit a migration notice (report only — never move or delete).
- Rejected: (a) keep everything in .pi — contradicts the ecosystem standard and the explicit ask; (b) single mega AGENTS.md — the trio keeps durable context split by concern (rules / what-why / sequencing / stack facts); (c) CLAUDE.md-only — not cross-agent portable; AGENTS.md is the standard pi loads.

## 4. Template sections

AGENTS.md: overview (2-3 lines) / commands (build, test, check, gate) / architecture & layout / conventions (naming, imports, commits) / Ultra surfaces (prewalk, codemap, roles scout+explorer, mcp.$search) / verification gate.
project.md: purpose & scope / current milestone / decisions.
roadmap.md: ordered milestones with status markers.
tech-stack.md: languages / frameworks / tooling / versions.
