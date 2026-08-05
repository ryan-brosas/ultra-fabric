const STOPWORDS = new Set([
  "feat", "fix", "chore", "docs", "refactor", "test", "style", "perf", "ci",
  "build", "revert", "the", "a", "an", "and", "or", "in", "of", "to", "for",
  "is", "on", "with", "by", "from", "as", "at", "be", "this", "that",
  "add", "remove", "update", "delete", "set", "get", "new", "use", "make",
]);

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const CONVENTIONAL_RE = /^[a-z]+\(([^)]+)\):/;

export const extractQueryIdentifiers = (
  message: string,
): string[] => {
  // Strip conventional-commit prefix like 'fix(prewalk):'
  const convMatch = message.match(CONVENTIONAL_RE);
  let body = message;
  if (convMatch) {
    // Drop the prefix entirely, including the scope
    body = message.slice(convMatch[0]!.length);
  }
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  IDENT_RE.lastIndex = 0;
  while ((match = IDENT_RE.exec(body)) !== null) {
    const tok = match[0]!;
    if (STOPWORDS.has(tok.toLowerCase())) continue;
    if (tok.length < 4) continue;
    tokens.push(tok);
  }
  // Also extract the conventional-commit scope if present, as it often names a subsystem
  if (convMatch && convMatch[1]) {
    const scope = convMatch[1]!.trim();
    if (scope && scope.length >= 4 && !STOPWORDS.has(scope.toLowerCase())) {
      tokens.push(scope);
    }
  }
  return [...new Set(tokens)];
};