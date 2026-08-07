import type { FabricPrewalkChecklist } from "./checklist.js";

// Progress markers the executor drops into its turn text as it finishes
// checklist steps: "[DONE:n]" with 1-based item indexes. The parser is pure
// and bounded so a long workflow can report progress without the host
// re-reading plan state.

const DONE_MARKER = /\[DONE:(\d+)\]/g;

export const extractDoneMarkers = (text: string, itemCount: number): number[] => {
  const indexes = new Set<number>();
  for (const match of text.matchAll(DONE_MARKER)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n >= 1 && n <= itemCount) indexes.add(n - 1);
  }
  return [...indexes].sort((a, b) => a - b);
};

export const checklistProgress = (checklist: FabricPrewalkChecklist): { done: number; total: number } => ({
  done: checklist.doneIndexes?.length ?? 0,
  total: checklist.items.length,
});
