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

// ANSI SGR sequences used by the widget renderer. Kept as constants so tests
// pin the exact escape bytes and the TUI strips them when styling is disabled.
const SGR_STRIKE_DIM = "\u001b[9;2m";
const SGR_RESET = "\u001b[0m";

// Widget lines for the prewalk progress widget: completed items show the [x]
// marker with the task struck through and dimmed, pending items stay plain
// "[ ] task". Pure and ASCII-escape based, matching the theme.fg style other
// fabric widgets use; callers render the array as widget lines.
export const checklistWidgetLines = (checklist: FabricPrewalkChecklist): string[] => {
  const done = new Set(checklist.doneIndexes ?? []);
  return checklist.items.map((item, index) =>
    done.has(index) ? "[x] " + SGR_STRIKE_DIM + item.task + SGR_RESET : "[ ] " + item.task,
  );
};
