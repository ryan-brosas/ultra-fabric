export const countNewlines = (value: string): number => {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 10) count++;
  }
  return count;
};

export const truncateMiddle = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  const marker = `\n\n... ${value.length - maxChars} characters omitted by Pi Fabric ...\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
};

// The single record guard used across the codebase. The 10 per-module copies
// of this body were consolidated here so a record-shaped value narrows the
// same way everywhere (JsonRecord is structurally Record<string, unknown>).
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
