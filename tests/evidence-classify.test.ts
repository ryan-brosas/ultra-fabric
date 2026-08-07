import { describe, expect, it } from "vitest";
import { classifyToolCapability } from "../src/evidence/classify.js";

// Fixtures captured from the live MCP registry (tools.describe) — name,
// description, and inputSchema only. No server-name allowlists: the classifier
// must work on any user's MCP set.
const webSearch = {
  name: "exa.omniroute_web_search",
  description: "Performs web search using OmniRoute's search gateway. Supports multiple providers (Serper, Brave, Perplexity, Exa, Tavily) with automatic failover.",
  inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "integer" }, search_type: { type: "string" } } },
};
const webFetch = {
  name: "exa.omniroute_web_fetch",
  description: "Fetches and extracts content from a URL using OmniRoute's web fetch gateway. Supports multiple providers (Firecrawl, Jina Reader, Tavily) with automatic failover.",
  inputSchema: { type: "object", properties: { url: { type: "string" }, format: { type: "string" } } },
};
const poolHealth = {
  name: "exa.omniroute_pool_health",
  description: "Returns aggregated web-session pool health: pool stats + circuit breaker state + per-session details + health status (healthy/degraded/down) + issues list.",
  inputSchema: { type: "object", properties: { provider: { type: "string" } } },
};
const deepwikiAsk = {
  name: "deepwiki.ask_question",
  description: "Ask any question about a GitHub repository and get an AI-powered, context-grounded response.",
  inputSchema: { type: "object", properties: { repoName: { type: "string" }, question: { type: "string" } }, required: ["repoName", "question"] },
};
const deepwikiRead = {
  name: "deepwiki.read_wiki_structure",
  description: "Get a list of documentation topics for a GitHub repository.",
  inputSchema: { type: "object", properties: { repoName: { type: "string" } }, required: ["repoName"] },
};
const cloudflareDocs = {
  name: "cloudflare-docs.search_cloudflare_documentation",
  description: "Search the Cloudflare documentation. Use this tool to answer any question about Cloudflare products or features, including Workers, Pages, R2.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const codegraphCrud = {
  name: "codegraphcontext.add_code_to_graph",
  description: "Add code to the code graph index for a repository.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};
const pyxel = {
  name: "pyxel.run",
  description: "Run a Pyxel sketch.",
  inputSchema: { type: "object", properties: {} },
};
const browserNavigate = {
  name: "exa.omniroute_browser_navigate",
  description: "Navigate a browser to a URL and return the rendered page content. Supports interactive browsing with click, type, and screenshot actions.",
  inputSchema: { type: "object", properties: { url: { type: "string" }, action: { type: "string" } } },
};
const computerUse = {
  name: "exa.omniroute_computer_use",
  description: "Control a computer-use session: take screenshots, click elements, type text, and extract visible content. Computer-use browser rendering for ChatGPT.",
  inputSchema: { type: "object", properties: { url: { type: "string" }, action: { type: "string" } } },
};

describe("classifyToolCapability", () => {
  it("maps a query+search tool to web-search", () => {
    expect(classifyToolCapability(webSearch)).toBe("web-search");
  });
  it("maps a url tool to web-fetch", () => {
    expect(classifyToolCapability(webFetch)).toBe("web-fetch");
  });
  it("maps a health/status tool to health", () => {
    expect(classifyToolCapability(poolHealth)).toBe("health");
  });
  it("maps a repo question tool to repo-wiki", () => {
    expect(classifyToolCapability(deepwikiAsk)).toBe("repo-wiki");
    expect(classifyToolCapability(deepwikiRead)).toBe("repo-wiki");
  });
  it("maps a documentation query tool to docs-search", () => {
    expect(classifyToolCapability(cloudflareDocs)).toBe("docs-search");
  });
  it("returns none for unrelated tools", () => {
    expect(classifyToolCapability(codegraphCrud)).toBe("none");
    expect(classifyToolCapability(pyxel)).toBe("none");
  });

  it("maps a browser navigation tool to computer-use", () => {
    expect(classifyToolCapability(browserNavigate)).toBe("computer-use");
  });
  it("maps a computer-use tool to computer-use", () => {
    expect(classifyToolCapability(computerUse)).toBe("computer-use");
  });
  it("does not misroute fetch-only tools with url+action to computer-use", () => {
    const fetchLike = {
      name: "exa.omniroute_web_fetch",
      description: "Fetches content from a URL.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, format: { type: "string" } } },
    };
    expect(classifyToolCapability(fetchLike)).toBe("web-fetch");
  });
  it("does not misroute local registry or index searches to web-search", () => {
    const registryBundles = {
      name: "codegraphcontext.search_registry_bundles",
      description: "Search registry bundles of indexed repositories.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    };
    const notion = {
      name: "exa.notion_search",
      description: "Search Notion pages and databases.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    };
    expect(classifyToolCapability(registryBundles)).toBe("none");
    expect(classifyToolCapability(notion)).toBe("none");
  });
});
