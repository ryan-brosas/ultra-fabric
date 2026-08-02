import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeConsultPath } from "./policy.js";

interface ConsultScopeEnvelope {
  version: 1;
  root: string;
  scopes: string[];
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const loadScope = (): { root: string; scopes: string[] } => {
  const raw = process.env.PI_FABRIC_CONSULT_SCOPE_V1;
  if (!raw) throw new Error("Ultra Consult scope guard requires host scope metadata");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Ultra Consult scope metadata must be an object");
  }
  const envelope = parsed as Partial<ConsultScopeEnvelope>;
  if (envelope.version !== 1 || typeof envelope.root !== "string" || !Array.isArray(envelope.scopes)) {
    throw new Error("Ultra Consult scope metadata is malformed");
  }
  const root = fs.realpathSync(envelope.root);
  const scopes = envelope.scopes.map((scope) => {
    const normalized = normalizeConsultPath(scope);
    if (!normalized) throw new Error("Ultra Consult scope contains an invalid project path");
    const resolved = fs.realpathSync(path.resolve(root, normalized));
    if (!inside(root, resolved)) throw new Error("Ultra Consult scope resolves outside the project");
    return resolved;
  });
  return { root, scopes };
};

export default function registerConsultScopeGuard(pi: ExtensionAPI): void {
  const allowed = loadScope();
  pi.on("tool_call", async (event, context) => {
    if (!READ_TOOLS.has(event.toolName)) {
      return { block: true, reason: "Ultra Consult workers are read-only" };
    }
    const input = typeof event.input === "object" && event.input !== null
      ? event.input as Record<string, unknown>
      : {};
    const requested = input.path;
    if (requested === undefined && allowed.scopes.length > 0) {
      return { block: true, reason: "Ultra Consult scoped reads require an explicit path" };
    }
    if (requested !== undefined && typeof requested !== "string") {
      return { block: true, reason: "Ultra Consult read path must be a string" };
    }
    try {
      const target = fs.realpathSync(path.resolve(context.cwd, requested ?? "."));
      if (!inside(allowed.root, target)) {
        return { block: true, reason: "Ultra Consult reads must stay inside the project" };
      }
      if (allowed.scopes.length > 0 && !allowed.scopes.some((scope) => inside(scope, target))) {
        return { block: true, reason: "Ultra Consult read is outside the declared perspective scope" };
      }
      return undefined;
    } catch {
      return { block: true, reason: "Ultra Consult read path could not be resolved safely" };
    }
  });
}
