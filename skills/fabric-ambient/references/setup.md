# Persistent Agent profile setup

Pass `strings.name`, `strings.role`, `strings.instructions`, JSON `strings.events`, `strings.triggerTurn` (`"true"`/`"false"`), and `strings.model` (key/substring; empty when unset).

```ts
const events = JSON.parse(π.events) as FabricPersistentAgentHostEvent[];
const role = π.role || "worker";
const triggerTurn = π.triggerTurn === "true";
const desiredTools = ["read", "grep", "find", "ls"];
let model: string | undefined;
if (π.model) {
  const models: FabricModelInfo[] = await tools.models();
  const needle = π.model.toLowerCase();
  const exact = models.filter((entry) => entry.key.toLowerCase() === needle);
  const fuzzy = exact.length === 0
    ? models.filter((entry) =>
        entry.id.toLowerCase().includes(needle) ||
        entry.name.toLowerCase().includes(needle)
      )
    : exact;
  if (fuzzy.length !== 1) {
    throw new Error(
      fuzzy.length === 0
        ? `Model "${π.model}" not found: ${models.map((entry) => entry.key).join(", ")}`
        : `Model "${π.model}" is ambiguous: ${fuzzy.map((entry) => entry.key).join(", ")}`,
    );
  }
  model = fuzzy[0].key;
}

const existing = (await agents.list({ lifecycle: "persistent" })).find(
  (agent) => agent.name === π.name && agent.status !== "stopped",
);
if (existing) {
  const warnings = [
    ...(existing.status !== "idle" ? [`persistent agent is ${existing.status}; wait until idle or stop it before reconfiguration`] : []),
    ...(existing.role !== role ? [`recreate for role=${role}`] : []),
    ...(existing.responseMode !== "directive" ? ["recreate for responseMode=directive"] : []),
    ...(existing.coalesce !== true ? ["recreate for coalesce=true"] : []),
    ...(existing.topics.length !== 0 ? ["recreate without topic subscriptions"] : []),
    ...(model && existing.model !== model ? [`model "${model}" requires a dashboard change or recreation`] : []),
  ];
  if (warnings.length) return { reused: false, agent: existing, warnings };

  await agents.setInstructions({ id: existing.id, instructions: π.instructions });
  if (
    existing.tools?.length !== desiredTools.length ||
    desiredTools.some((tool) => !existing.tools?.includes(tool))
  ) {
    await agents.setTools({ id: existing.id, tools: desiredTools });
  }
  if (existing.events.length !== events.length || events.some((event) => !existing.events.includes(event))) {
    await agents.setEvents({ id: existing.id, events });
  }
  if (existing.delivery !== "steer" || existing.triggerTurn !== triggerTurn) {
    await agents.setDeliveryPolicy({ id: existing.id, delivery: "steer", triggerTurn });
  }
  return {
    reused: true,
    agent: await agents.status({ id: existing.id }),
    warnings: [],
  };
}

const persistentAgent = await agents.create({
  name: π.name,
  role,
  instructions: π.instructions,
  events,
  responseMode: "directive",
  delivery: "steer",
  triggerTurn,
  coalesce: true,
  tools: desiredTools,
  ...(model ? { model } : {}),
});
return { started: true, agent: persistentAgent };
```

Reuse updates instructions/events/delivery/native tools. Recreate for role, runner, model, `responseMode`, `coalesce`, or topics. Extension and provider availability follows the configured runner and persistent-agent extension policy. Report ID/warnings and messages/stop; do not wait.
