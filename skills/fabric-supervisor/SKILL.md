---
name: fabric-supervisor
description: Creates or reuses Ultra Fabric's native persistent supervisor role for one concrete, measurable goal. Use for long-running Main-session drift, blocker, and completion supervision. Do not use for one-shot review or ordinary advice; use an Agent reviewer or fabric-advisor instead.
disable-model-invocation: true
---

# Fabric Supervisor

This skill is setup UX. The native `supervisor` role profile owns event subscriptions, directive validation, delivery, coalescing, tools, model defaults, completion behavior, and turn bounds. Do not duplicate that policy in a second prompt or install a supervisor extension.

## Setup

Derive one concrete goal from the skill arguments or active request. Pass it as `strings.goal` to this program:

```ts
const goal = π.goal.trim();
if (!goal) throw new Error("fabric-supervisor requires a concrete goal");

const catalog = await agents.roles({ lifecycle: "persistent" });
const profile = catalog.roles.find((candidate) => candidate.name === "supervisor");
if (!profile) {
  throw new Error(
    `The native supervisor role is unavailable: ${catalog.diagnostics.join("; ") || "restore agents/supervisor.md"}`,
  );
}

const existing = (await agents.list({ lifecycle: "persistent" })).find(
  (agent) => agent.name === "supervisor" && agent.status !== "stopped",
);
const instructions = `Supervise Main only for this concrete goal:

${goal}`;

if (existing) {
  const warnings = [
    ...(existing.role !== "supervisor" ? [`existing Agent has role ${existing.role}; stop and remove it before recreation`] : []),
    ...(existing.goal !== goal ? ["existing supervisor owns a different goal; stop and remove it before recreation"] : []),
    ...(existing.status !== "idle" ? [`existing supervisor is ${existing.status}; wait until idle before updating it`] : []),
  ];
  if (warnings.length) return { reused: false, agent: existing, profile, warnings };
  await agents.setInstructions({ id: existing.id, instructions });
  return { reused: true, agent: await agents.status({ id: existing.id }), profile, warnings: [] };
}

const agent = await agents.create({
  name: "supervisor",
  role: "supervisor",
  goal,
  instructions,
});
return { started: true, agent, profile, warnings: [] };
```

Do not override the profile's events, delivery, directive mode, tools, or budget in this skill. Customize those defaults in `.pi/agents/supervisor.md`; choose a model afterward with `agents.setModel(...)` when an instance-specific override is needed.

## Completion criterion

Complete when setup returns a persistent Agent with `role: "supervisor"`, the requested goal, and no warnings. Report its ID and the `agents.messages({ id })` and `agents.stop({ id })` calls. Do not wait for the supervised goal in the setup invocation.

## When NOT to use

- For one fresh correctness pass, run a one-shot `reviewer` Agent.
- For advice only at explicit decision points, use `fabric-advisor`.
- For task execution, use a `worker` Agent. A supervisor observes and steers; it does not become a second implementer.
