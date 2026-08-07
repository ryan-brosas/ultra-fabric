import type { FabricPrewalkChecklist } from "./checklist.js";

export const PREWALK_CONTINUE_MESSAGE_TYPE = "pi-fabric-prewalk-continue";
export const PREWALK_ARMED_MESSAGE_TYPE = "pi-fabric-prewalk-armed";
export const PREWALK_PLAN_MESSAGE_TYPE = "pi-fabric-prewalk-research-plan";

interface MessageWithRole {
  role: string;
}

const continuationIdFrom = <Message extends MessageWithRole>(
  message: Message,
): string | undefined => {
  if (message.role !== "custom") return undefined;
  const custom = message as Message & {
    customType?: unknown;
    details?: unknown;
  };
  if (custom.customType !== PREWALK_CONTINUE_MESSAGE_TYPE) return undefined;
  if (
    typeof custom.details !== "object" ||
    custom.details === null ||
    Array.isArray(custom.details)
  ) {
    return "";
  }
  const continuationId = (custom.details as { continuationId?: unknown }).continuationId;
  return typeof continuationId === "string" && continuationId ? continuationId : "";
};

export const filterPrewalkPlanningMessages = <Message extends MessageWithRole>(
  messages: Message[],
  keepPlanningInstruction: boolean,
): { messages: Message[]; changed: boolean } => {
  if (keepPlanningInstruction) return { messages, changed: false };
  const filtered = messages.filter((message) => {
    if (message.role !== "custom") return true;
    const customType = (message as Message & { customType?: unknown }).customType;
    return (
      customType !== PREWALK_PLAN_MESSAGE_TYPE &&
      customType !== PREWALK_ARMED_MESSAGE_TYPE
    );
  });
  return filtered.length === messages.length
    ? { messages, changed: false }
    : { messages: filtered, changed: true };
};

export const filterPrewalkContinuationMessages = <Message extends MessageWithRole>(
  messages: Message[],
  accept: (handoffId: string) => boolean,
): { messages: Message[]; changed: boolean } => {
  let changed = false;
  const filtered = messages.filter((message) => {
    const continuationId = continuationIdFrom(message);
    if (continuationId === undefined) return true;
    const keep = continuationId.length > 0 && accept(continuationId);
    if (!keep) changed = true;
    return keep;
  });
  return { messages: changed ? filtered : messages, changed };
};

// A per-turn reminder rendered from the live checklist so a long continuation
// cannot drift away from its own plan. Injected by the context hook, not
// persisted, so it steers inference without accumulating in the session. The
// controller bounds how many turns it fires per continuation, so this steers a
// drifting executor without holding Main after the checklist is satisfied.
export const prewalkChecklistReminder = (
  checklist: FabricPrewalkChecklist,
): string => {
  const done = new Set(checklist.doneIndexes ?? []);
  const open = checklist.items.map((item, index) => ({ item, index })).filter(({ index }) => !done.has(index));
  return [
    `Prewalk checklist still active (${done.size} of ${checklist.items.length} done). Keep working the remaining items; do not end the turn until every open item and validation is complete.`,
    // Number by the original 1-based checklist position: [DONE:n] indexes refer
    // to the original order, so a renumbered list would make the executor mark
    // the wrong item complete and the progress widget would never strike through.
    ...open.map(
      ({ item, index }) => `- ${index + 1}. ${item.task}\n  Validation: ${item.validation}`,
    ),
    // Explicit emission contract: the host parses [DONE:n] from the executor's
    // turn text to advance the checklist and strike through done items.
    "As you complete each open item above, emit its [DONE:n] marker in the same turn, where n is the item's number above (the original checklist position); for example [DONE:2] for item 2.",
    "Before claiming completion: sweep every other call site for any pattern, signature, or check you changed; keep the diff minimal and confirm no out-of-scope behavior changed; run the full test module the change lives in, not just the test you expect to flip.",
  ].join("\n");
};
