import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  FABRIC_PERSISTENT_AGENT_PI_HOST_EVENTS,
  type FabricPersistentAgentPiHostEvent,
} from "./types.js";

export type FabricPersistentAgentHostEventObserver = (
  eventName: FabricPersistentAgentPiHostEvent,
  event: ExtensionEvent,
  context: ExtensionContext,
) => void;

interface ObservableExtensionApi {
  on(
    event: FabricPersistentAgentPiHostEvent,
    handler: (event: ExtensionEvent, context: ExtensionContext) => void,
  ): void;
}

export const registerFabricPersistentAgentHostEventObservers = (
  pi: ExtensionAPI,
  observer: FabricPersistentAgentHostEventObserver,
): void => {
  const observable = pi as unknown as ObservableExtensionApi;
  for (const eventName of FABRIC_PERSISTENT_AGENT_PI_HOST_EVENTS) {
    observable.on(eventName, (event, context) => observer(eventName, event, context));
  }
};
