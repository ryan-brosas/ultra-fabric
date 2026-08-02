import type { FabricPersistentAgentDelivery } from "./types.js";

const ACTIVE_DELIVERIES = new Set<FabricPersistentAgentDelivery>(["steer", "followUp"]);
const PASSIVE_DELIVERIES = new Set<FabricPersistentAgentDelivery>(["mailbox", "nextTurn"]);

export interface FabricPersistentAgentDeliveryPolicy {
  delivery: FabricPersistentAgentDelivery;
  triggerTurn: boolean;
}

export const resolvePersistentAgentDeliveryPolicy = (
  delivery: FabricPersistentAgentDelivery | undefined,
  triggerTurn: boolean | undefined,
): FabricPersistentAgentDeliveryPolicy => {
  const resolvedDelivery = delivery ?? "mailbox";
  if (!ACTIVE_DELIVERIES.has(resolvedDelivery) && !PASSIVE_DELIVERIES.has(resolvedDelivery)) {
    throw new Error(`Invalid Fabric persistent Agent delivery: ${String(delivery)}`);
  }
  if (ACTIVE_DELIVERIES.has(resolvedDelivery)) {
    if (typeof triggerTurn !== "boolean") {
      throw new Error(
        `Persistent Agent delivery "${resolvedDelivery}" requires explicit triggerTurn: true or false`,
      );
    }
    return { delivery: resolvedDelivery, triggerTurn };
  }
  if (triggerTurn === true) {
    throw new Error(
      `Persistent Agent delivery "${resolvedDelivery}" cannot use triggerTurn: true because it never starts Main`,
    );
  }
  return { delivery: resolvedDelivery, triggerTurn: false };
};

export const persistentAgentDeliveryNotice = (
  delivery: Exclude<FabricPersistentAgentDelivery, "mailbox">,
  triggerTurn: boolean,
): string | undefined => {
  if (delivery === "nextTurn") {
    return "[Deferred persistent Agent delivery: queued for the next user turn; this message never starts Main.]";
  }
  if (!triggerTurn) {
    return "[Passive persistent Agent delivery: triggerTurn=false; this message does not start Main when idle.]";
  }
  return undefined;
};
