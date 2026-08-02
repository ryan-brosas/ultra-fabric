import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFabricRunContext } from "../src/run/context.js";

describe("Fabric run context", () => {
  it("creates one inherited trace identity without retaining the raw objective", () => {
    const controller = new AbortController();
    const run = createFabricRunContext({
      runId: "run-1",
      traceId: "trace-root",
      spanId: "span-1",
      parentRunId: "parent-run",
      parentSpanId: "parent-span",
      objective: "secret objective",
      timeoutMs: 500,
      signal: controller.signal,
      now: () => 1_000,
      maxAgents: 2,
      maxTokens: 100,
    });

    expect(run.envelope).toEqual({
      version: 1,
      runId: "run-1",
      traceId: "trace-root",
      spanId: "span-1",
      parentRunId: "parent-run",
      parentSpanId: "parent-span",
      objectiveDigest: createHash("sha256").update("secret objective").digest("hex"),
      startedAt: 1_000,
      deadline: 1_500,
      cancellationOwner: "run-1",
    });
    expect(JSON.stringify(run.envelope)).not.toContain("secret objective");
    expect(Object.isFrozen(run.envelope)).toBe(true);
    const initialEnvelope = run.envelope;
    expect(run.extendDeadline(1_400)).toBe(false);
    expect(run.extendDeadline(2_000)).toBe(true);
    expect(run.envelope).not.toBe(initialEnvelope);
    expect(run.envelope).toMatchObject({
      runId: initialEnvelope.runId,
      traceId: initialEnvelope.traceId,
      spanId: initialEnvelope.spanId,
      deadline: 2_000,
    });
    expect(Object.isFrozen(run.envelope)).toBe(true);
    expect(run.signal).toBe(controller.signal);
  });

  it("bounds evidence and transitions and settles exactly once", () => {
    const run = createFabricRunContext({
      runId: "run-1",
      traceId: "trace-1",
      spanId: "span-1",
      objective: "work",
      timeoutMs: 500,
      now: () => 10,
      maxAgents: 1,
      maxTokens: 50,
      maxEvidence: 2,
      maxTransitions: 2,
    });

    expect(run.evidence.record({ kind: "command", ref: "test:a" }, 11)).toMatchObject({
      ok: true,
      evidence: { sequence: 1, kind: "command", ref: "test:a", recordedAt: 11 },
    });
    expect(run.evidence.record({ kind: "artifact", ref: "file:a" }, 12).ok).toBe(true);
    expect(run.evidence.record({ kind: "artifact", ref: "file:b" }, 13)).toEqual({
      ok: false,
      reason: "evidence_limit",
      limit: 2,
    });

    expect(run.transitions.record("accepted", 11)).toMatchObject({ ok: true, transition: { sequence: 1 } });
    expect(run.transitions.record("executing", 12)).toMatchObject({ ok: true, transition: { sequence: 2 } });
    expect(run.transitions.record("verifying", 13)).toEqual({
      ok: false,
      reason: "transition_limit",
      limit: 2,
    });
    expect(run.transitions.recordTerminal("failed", 14)).toMatchObject({
      ok: true,
      replaced: true,
      transition: { sequence: 2, state: "failed" },
    });
    expect(run.transitions.list().map(({ sequence, state }) => ({ sequence, state }))).toEqual([
      { sequence: 1, state: "accepted" },
      { sequence: 2, state: "failed" },
    ]);

    expect(run.settle("failed", 20)).toEqual({
      ok: true,
      settlement: { outcome: "failed", settledAt: 20 },
    });
    expect(run.settle("succeeded", 21)).toEqual({
      ok: false,
      reason: "already_settled",
      settlement: { outcome: "failed", settledAt: 20 },
    });
  });

  it("applies advise, revise, abort, crash, and revision-cap gate semantics", () => {
    const run = createFabricRunContext({
      runId: "run-1",
      traceId: "trace-1",
      spanId: "span-1",
      objective: "work",
      timeoutMs: 500,
      now: () => 10,
      maxAgents: 1,
      maxTokens: 50,
      maxGateRevisions: 1,
      maxTransitions: 5,
    });

    expect(run.gates.record({
      gate: "lint",
      passed: false,
      disposition: "advise",
      evidence: [{ kind: "command", ref: "cmd:lint" }],
    }, 11)).toMatchObject({ decision: "continue", sequence: 1 });
    expect(run.gates.record({
      gate: "tests",
      passed: false,
      disposition: "revise",
      evidence: [{ kind: "command", ref: "cmd:test" }],
      reason: "one failure",
    }, 12)).toMatchObject({ decision: "revise", revision: 1, sequence: 2 });
    expect(run.gates.record({
      gate: "tests-again",
      passed: false,
      disposition: "revise",
      evidence: [],
    }, 13)).toMatchObject({
      decision: "abort",
      failure: "revision_limit",
      revision: 1,
      sequence: 3,
    });
    expect(run.gates.record({
      gate: "security",
      passed: false,
      disposition: "abort",
      evidence: [],
    }, 14)).toMatchObject({ decision: "abort", failure: "gate_failed", sequence: 4 });
    expect(run.gates.record({
      gate: "infrastructure",
      passed: false,
      disposition: "advise",
      evidence: [],
      error: "runner crashed",
    }, 15)).toMatchObject({ decision: "abort", failure: "gate_crashed", sequence: 5 });
    expect(run.gates.terminal()).toMatchObject({
      gate: "infrastructure",
      decision: "abort",
      failure: "gate_crashed",
    });
    expect(() => run.gates.record({
      gate: "overflow",
      passed: false,
      disposition: "advise",
      evidence: [],
    }, 16)).toThrow("Fabric gate result limit exhausted (5)");
  });

  it("atomically reserves agent calls and tokens, then releases unused tokens", () => {
    let next = 0;
    const run = createFabricRunContext({
      runId: "run-1",
      traceId: "trace-1",
      spanId: "span-1",
      objective: "work",
      timeoutMs: 500,
      now: () => 10,
      maxAgents: 2,
      maxTokens: 100,
      nextId: () => `reservation-${++next}`,
    });

    const first = run.budget.reserveAgent({ tokens: 60 });
    const second = run.budget.reserveAgent({ tokens: 40 });
    expect(first).toMatchObject({ ok: true, reservation: { id: "reservation-1", tokens: 60 } });
    expect(second).toMatchObject({ ok: true, reservation: { id: "reservation-2", tokens: 40 } });
    expect(run.budget.reserveAgent({ tokens: 1 })).toEqual({
      ok: false,
      reason: "agent_limit",
      limit: 2,
    });

    if (!first.ok || !second.ok) throw new Error("expected reservations");
    expect(run.budget.settle(first.reservation.id, { actualTokens: 25 })).toMatchObject({
      ok: true,
      actualTokens: 25,
      releasedTokens: 35,
    });
    expect(run.budget.snapshot()).toEqual({
      agents: { limit: 2, spent: 1, reserved: 1, remaining: 0 },
      tokens: { limit: 100, spent: 25, reserved: 40, remaining: 35 },
    });
    expect(run.budget.release(second.reservation.id)).toMatchObject({ ok: true, releasedTokens: 40 });
    expect(run.budget.snapshot()).toEqual({
      agents: { limit: 2, spent: 1, reserved: 0, remaining: 1 },
      tokens: { limit: 100, spent: 25, reserved: 0, remaining: 75 },
    });
    expect(run.budget.settle("missing", { actualTokens: 1 })).toEqual({
      ok: false,
      reason: "unknown_reservation",
      reservationId: "missing",
    });
  });
});
