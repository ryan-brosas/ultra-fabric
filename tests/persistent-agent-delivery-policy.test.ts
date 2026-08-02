import { describe, expect, it } from "vitest";
import {
  persistentAgentDeliveryNotice,
  resolvePersistentAgentDeliveryPolicy,
} from "../src/agents/persistent/delivery-policy.js";

describe("persistent Agent delivery policy", () => {
  it("makes active turn intent explicit", () => {
    expect(() => resolvePersistentAgentDeliveryPolicy("steer", undefined)).toThrow(
      /requires explicit triggerTurn/,
    );
    expect(resolvePersistentAgentDeliveryPolicy("steer", false)).toEqual({
      delivery: "steer",
      triggerTurn: false,
    });
    expect(resolvePersistentAgentDeliveryPolicy("followUp", true)).toEqual({
      delivery: "followUp",
      triggerTurn: true,
    });
  });

  it("rejects trigger intent for delivery modes that never start Main", () => {
    expect(resolvePersistentAgentDeliveryPolicy(undefined, undefined)).toEqual({
      delivery: "mailbox",
      triggerTurn: false,
    });
    expect(() => resolvePersistentAgentDeliveryPolicy("mailbox", true)).toThrow(/never starts Main/);
    expect(() => resolvePersistentAgentDeliveryPolicy("nextTurn", true)).toThrow(/never starts Main/);
  });

  it("labels passive and deferred deliveries without labeling active continuations", () => {
    expect(persistentAgentDeliveryNotice("steer", false)).toContain("does not start Main when idle");
    expect(persistentAgentDeliveryNotice("followUp", false)).toContain("triggerTurn=false");
    expect(persistentAgentDeliveryNotice("nextTurn", false)).toContain("next user turn");
    expect(persistentAgentDeliveryNotice("steer", true)).toBeUndefined();
  });
});
