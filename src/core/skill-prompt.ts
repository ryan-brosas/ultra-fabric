import {
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";

const SKILL_SECTION_HEADING =
  "The following skills provide specialized instructions for specific tasks.";
const PI_SKILL_LOAD_INSTRUCTION =
  "Use the read tool to load a skill's file when the task matches its description.";
const FABRIC_SKILL_LOAD_INSTRUCTION =
  "Use `pi.read` inside `fabric_exec` to load a skill's file when the task matches its description.";
const CWD_MARKER = "\nCurrent working directory:";
const STOP_WORDS = new Set([
  "and", "are", "for", "from", "into", "must", "that", "the", "this", "use", "when", "with",
]);

export interface SkillPromptOptions {
  prompt: string;
  maxSkills?: number;
  maxIndexChars?: number;
}

const terms = (value: string): string[] =>
  value.toLowerCase().split(/[^a-z0-9]+/).filter(
    (term) => term.length >= 3 && !STOP_WORDS.has(term),
  );

const skillScore = (skill: Skill, prompt: string, promptTerms: ReadonlySet<string>): number => {
  const normalizedName = skill.name.toLowerCase().replaceAll("-", " ");
  const nameTerms = terms(skill.name);
  const descriptionTerms = new Set(terms(skill.description));
  return (prompt.includes(normalizedName) ? 1_000 : 0) +
    nameTerms.filter((term) => promptTerms.has(term)).length * 20 +
    [...promptTerms].filter((term) => descriptionTerms.has(term)).length * 2;
};

const selectedSkills = (
  skills: readonly Skill[],
  options: SkillPromptOptions,
): { selected: Skill[]; omitted: Skill[] } => {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  const prompt = options.prompt.toLowerCase();
  const promptTerms = new Set(terms(prompt));
  const maximum = Math.max(0, Math.min(32, Math.floor(options.maxSkills ?? 12)));
  const ranked = visible
    .map((skill) => ({ skill, score: skillScore(skill, prompt, promptTerms) }))
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
  const selected = ranked.filter((entry) => entry.score > 0).slice(0, maximum).map((entry) => entry.skill);
  const selectedNames = new Set(selected.map((skill) => skill.name));
  return { selected, omitted: visible.filter((skill) => !selectedNames.has(skill.name)) };
};

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const skillIndex = (skills: readonly Skill[], maximum: number): string => {
  if (skills.length === 0) return "";
  const groups = new Map<string, string[]>();
  const direct: string[] = [];
  for (const skill of [...skills].sort((left, right) => left.name.localeCompare(right.name))) {
    const suffix = `/${skill.name}/SKILL.md`;
    if (!skill.filePath.endsWith(suffix)) {
      direct.push(`- ${escapeXml(skill.name)} -> ${escapeXml(JSON.stringify(skill.filePath))}`);
      continue;
    }
    const root = skill.filePath.slice(0, -suffix.length);
    const names = groups.get(root) ?? [];
    names.push(skill.name);
    groups.set(root, names);
  }
  const rows = [
    ...[...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).flatMap(
      ([root, names]) => {
        const chunks: string[] = [];
        for (let index = 0; index < names.length; index += 20) {
          chunks.push(`- root ${escapeXml(JSON.stringify(root))}: ${names.slice(index, index + 20).map(escapeXml).join(", ")}`);
        }
        return chunks;
      },
    ),
    ...direct,
  ];
  const cap = Math.max(256, Math.min(16_000, Math.floor(maximum)));
  const header = [
    "<skill_index>",
    "Additional model-visible skills are indexed by name. For a root entry, load ROOT/NAME/SKILL.md through pi.read only when relevant.",
  ];
  const footer = "</skill_index>";
  const output = [...header];
  for (const row of rows) {
    if ([...output, row, footer].join("\n").length > cap) break;
    output.push(row);
  }
  output.push(footer);
  return output.join("\n");
};

export const restoreSkillsForFullCodePrompt = (
  systemPrompt: string,
  skills: readonly Skill[],
  options?: SkillPromptOptions,
): string => {
  if (systemPrompt.includes(SKILL_SECTION_HEADING)) {
    return systemPrompt.replace(
      PI_SKILL_LOAD_INSTRUCTION,
      FABRIC_SKILL_LOAD_INSTRUCTION,
    );
  }

  const visible = options ? selectedSkills(skills, options) : { selected: [...skills], omitted: [] };
  const catalog = formatSkillsForPrompt(visible.selected).replace(
    PI_SKILL_LOAD_INSTRUCTION,
    FABRIC_SKILL_LOAD_INSTRUCTION,
  );
  const index = options ? skillIndex(visible.omitted, options.maxIndexChars ?? 8_000) : "";
  const section = [catalog, index].filter(Boolean).join("\n\n");
  if (!section) return systemPrompt;

  const cwdIndex = systemPrompt.lastIndexOf(CWD_MARKER);
  if (cwdIndex < 0) return `${systemPrompt}${section}`;
  return `${systemPrompt.slice(0, cwdIndex)}${section}${systemPrompt.slice(cwdIndex)}`;
};
