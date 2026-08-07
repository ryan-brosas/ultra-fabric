// Capability classification for MCP search tools. Pure and deterministic:
// given a tool's name, description, and inputSchema (never its server name),
// return the evidence capability it can serve. No server-name allowlists, so
// the router works on any user's MCP set.

export type EvidenceCapability = "web-search" | "web-fetch" | "repo-wiki" | "docs-search" | "computer-use" | "health" | "none";

export interface EvidenceToolShape {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const schemaProps = (schema: Record<string, unknown>): string[] => {
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  return props && typeof props === "object" ? Object.keys(props) : [];
};

export const classifyToolCapability = (tool: EvidenceToolShape): EvidenceCapability => {
  const text = (tool.name + " " + tool.description).toLowerCase();
  const props = schemaProps(tool.inputSchema);

  // Computer / browser use: action parameter (navigate, click, type, screenshot) or
  // computer/computer-use naming in the tool name or description.
  if (props.includes("action") && /(navigate|click|type|screenshot|extract|computer)/.test(text)) return "computer-use";
  if (/(computer.?use|computer.?call|browser.*render|render.*browser)/.test(text) && props.includes("url")) return "computer-use";

  // URL fetch: a url parameter plus fetch/extract/scrape/crawl naming.
  if (props.includes("url") && /(fetch|extract|scrape|crawl)/.test(text)) return "web-fetch";
  // Health probes: pool/health/circuit-breaker naming.
  if (/(health|circuit breaker|pool status|heartbeat)/.test(text)) return "health";
  // Repo wiki: a repository target plus question/wiki phrasing (deepwiki shape).
  if (/(\brepos?\b|\brepository\b|github\.com)/.test(text) && /(question|wiki|documentation topics)/.test(text)) return "repo-wiki";
  // Library/documentation search: docs naming plus query phrasing.
  if (/(documentation|\bdocs\b|library|reference|guide)/.test(text) && /(search|query|lookup|ask)/.test(text)) return "docs-search";
  // Generic web search: a query parameter plus an explicit web signal.
  // The web signal is required so local/registry searches (codegraph registry
  // bundles, notion/obsidian/memory/skill indexes) are not misrouted to the
  // open web.
  if (props.includes("query") && /(web|internet|browser|search engine)/.test(text)) return "web-search";
  return "none";
};
