import type { FabricRunDisplay } from "./activity/types.js";

// Silent repair for fabric_exec `display` near-misses. The declared shape is
// the object { name?, description? }, but models reliably cold-start with a
// bare objective string (or a JSON-stringified object) instead, which strict
// schema validation used to reject at the cost of a zero-work round trip.
// Both spellings carry identical intent, so coerce them. See the
// flat-tool-schema note in fabric-exec-tool.ts.

const recordDisplay = (record: Record<string, unknown>): FabricRunDisplay | undefined => {
  const display: FabricRunDisplay = {};
  if (typeof record.name === "string") display.name = record.name;
  if (typeof record.description === "string") display.description = record.description;
  return display.name !== undefined || display.description !== undefined ? display : undefined;
};

const parseObjectString = (text: string): Record<string, unknown> | undefined => {
  if (!text.startsWith("{") || !text.endsWith("}")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export const normalizeRunDisplay = (input: unknown): FabricRunDisplay | undefined => {
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return undefined;
    const parsed = text.startsWith("{") ? parseObjectString(text) : undefined;
    // Fall back to the raw string as the name: intent preservation beats shape
    // pedantry for a cosmetic label.
    return (parsed && recordDisplay(parsed)) ?? { name: input };
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return recordDisplay(input as Record<string, unknown>);
  }
  return undefined;
};
