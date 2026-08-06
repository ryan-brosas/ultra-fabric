#!/usr/bin/env node
// bench/deepswe-heartbeat.mjs — publish one bounded DeepSWE watchdog heartbeat
// to the supervisor mailbox over the supported MeshStore path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MeshStore } from "../dist/mesh/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3) {
  console.error("usage: deepswe-heartbeat.mjs <status.json|-|json> <supervisorId> [meshRoot]");
  process.exit(2);
}
const [statusArg, supervisorId, meshRootArg] = args;
const meshRoot = path.resolve(meshRootArg ?? path.join(here, "..", ".pi", "fabric", "mesh"));
let status;
if (statusArg === "-") {
  status = JSON.parse(fs.readFileSync(0, "utf8"));
} else {
  status = JSON.parse(fs.readFileSync(path.resolve(statusArg), "utf8"));
}
const ALLOWED = new Set([
  "updatedAt",
  "runnerPid",
  "runnerAlive",
  "expected",
  "cellsStarted",
  "results",
  "exceptions",
  "pending",
]);
const data = {};
for (const key of ALLOWED) if (key in status) data[key] = status[key];

const store = new MeshStore(meshRoot, 256 * 1024, 500);
const event = await store.publish({
  topic: "bench.deepswe.heartbeat",
  kind: "status",
  from: { id: "deepswe-watchdog", name: "deepswe-watchdog", kind: "agent" },
  to: supervisorId,
  text: `deepswe v2 heartbeat: ${data.results}/${data.expected} results, ${data.exceptions} exceptions, runner ${data.runnerAlive ? "alive" : "stopped"}`,
  data,
});
console.log(JSON.stringify({ sequence: event.sequence, topic: event.topic, id: event.id }));
