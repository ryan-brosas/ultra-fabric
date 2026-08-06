// Failure taxonomy with recovery guidance, adapted from PALADIN
// (arXiv 2509.25238; sources/PALADIN/data/toolscan_taxonomy_map.json for the
// category structure, sources/PALADIN/data/recovery_dictionary.json for the
// per-error recovery paths). Pure text rules; no I/O.

export type FailureCategory =
  | "tool-not-found"
  | "bad-arguments"
  | "auth"
  | "http-invocation"
  | "timeout"
  | "rate-limit"
  | "network"
  | "unknown";

export interface ClassifiedFailure {
  category: FailureCategory;
  recovery: string;
}

const RECOVERY: Record<FailureCategory, string> = {
  "tool-not-found":
    "The tool or resource does not exist under this name. Re-list the available tools or paths, correct the name, and do not retry the same identifier.",
  "bad-arguments":
    "The call shape is wrong. Read the tool's input schema, fix the missing or invalid fields, and resend with corrected arguments.",
  auth:
    "Credentials or scopes are insufficient. Check the credential source and permissions before anything else; do not retry blindly with the same token.",
  "http-invocation":
    "The endpoint rejected or failed the request. Check required params and content-type for 4xx, then resend once; treat repeated 5xx as a provider outage and fall back to the next candidate.",
  timeout:
    "The operation ran out of time. Narrow the request (smaller scope, fewer results) or raise the budget once; if it times out again, fall back instead of looping.",
  "rate-limit":
    "The provider is throttling. Back off and retry after the window, or fall back to an alternative provider for now.",
  network:
    "The connection failed before the request completed. Check reachability once, then fall back to the next candidate; network errors are rarely fixed by immediate retry.",
  unknown:
    "Unrecognized failure. Read the full error text before acting; if the cause is not clear from one read, fall back to the next candidate and report the error verbatim.",
};

interface Rule {
  category: FailureCategory;
  pattern: RegExp;
}

// Order matters: more specific categories match before generic HTTP handling.
const RULES: Rule[] = [
  { category: "rate-limit", pattern: /\b429\b|rate limit/i },
  { category: "timeout", pattern: /\b408\b|timed? ?out/i },
  { category: "auth", pattern: /\b401\b|\b403\b|unauthorized|forbidden/i },
  { category: "bad-arguments", pattern: /\b422\b|InvalidToolArguments|ValueError|KeyError|AttributeError|is required|invalid literal/i },
  { category: "tool-not-found", pattern: /NoSuchTool|ENOENT|ModuleNotFound|ImportError|DNS resolution|not found\b.*tool|tool .*not found|no such file/i },
  { category: "network", pattern: /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|network/i },
  { category: "http-invocation", pattern: /\b(400|404|500|502|503|505|510)\b|Bad Request|Bad Gateway|Internal Server Error|Not Found/i },
];

export const classifyFailure = (errorText: string): ClassifiedFailure => {
  for (const rule of RULES) {
    if (rule.pattern.test(errorText)) {
      return { category: rule.category, recovery: RECOVERY[rule.category] };
    }
  }
  return { category: "unknown", recovery: RECOVERY.unknown };
};
