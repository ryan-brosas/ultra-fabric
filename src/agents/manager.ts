import type { PersistentAgentRuntime } from "./persistent/manager.js";
import type { FabricPersistentAgentRequest } from "./persistent/types.js";
import { AgentRoleRegistry } from "./role-profiles.js";
import type { AgentRunRequest, AgentHandleInfo } from "./types.js";
import type { AgentTemplateRegistry } from "./persistent/template-registry.js";
import {
  effectiveAgentTimeoutMs,
  OneShotAgentManager,
} from "./one-shot-manager.js";

export { effectiveAgentTimeoutMs };

export class AgentManager extends OneShotAgentManager {
  readonly roles: AgentRoleRegistry;
  #persistent: PersistentAgentRuntime | undefined;
  #templates: AgentTemplateRegistry | undefined;

  constructor(...args: ConstructorParameters<typeof OneShotAgentManager>) {
    super(...args);
    const [cwd, , options] = args;
    this.roles = AgentRoleRegistry.createDefault(
      options?.projectRoot ?? process.env.PI_FABRIC_PROJECT_ROOT ?? cwd,
      options?.projectTrusted !== false,
    );
  }

  override spawn(request: AgentRunRequest, signal?: AbortSignal): Promise<AgentHandleInfo> {
    return super.spawn(
      request.persistentAgentId
        ? this.roles.applyPersistentActivation(request)
        : this.roles.applyOneShot(request),
      signal,
    );
  }

  preparePersistentRequest(request: FabricPersistentAgentRequest): FabricPersistentAgentRequest {
    return this.roles.applyPersistent(request);
  }

  async setPersistentTools(id: string, tools: string[]): Promise<ReturnType<PersistentAgentRuntime["status"]>> {
    const persistentAgent = this.persistent.status(id);
    const validated = this.roles.validateTools(persistentAgent.role, "persistent", tools);
    return this.persistent.setTools(persistentAgent.id, validated);
  }

  setTemplateTools(id: string, tools: string[]): ReturnType<AgentTemplateRegistry["update"]> {
    const template = this.templates.resolve(id);
    if (!template) throw new Error(`Unknown Agent template: ${id}`);
    const validated = this.roles.validateTools(template.role, "persistent", tools);
    return this.templates.update(template.id, { tools: validated });
  }

  async importTemplate(idOrName: string, as?: string): Promise<ReturnType<PersistentAgentRuntime["status"]>> {
    const template = this.templates.resolve(idOrName);
    if (!template) throw new Error(`Unknown Agent template: ${idOrName}`);
    const request = this.preparePersistentRequest(this.templates.toRequest(template, as));
    return this.persistent.create(request);
  }

  attachPersistentLifecycle(
    persistent: PersistentAgentRuntime,
    templates: AgentTemplateRegistry,
  ): void {
    if (this.#persistent || this.#templates) {
      throw new Error("Fabric persistent Agent lifecycle is already attached");
    }
    this.#persistent = persistent;
    this.#templates = templates;
  }

  get persistent(): PersistentAgentRuntime {
    if (!this.#persistent) throw new Error("Fabric persistent Agent lifecycle is unavailable");
    return this.#persistent;
  }

  get templates(): AgentTemplateRegistry {
    if (!this.#templates) throw new Error("Fabric Agent templates are unavailable");
    return this.#templates;
  }

  override async close(): Promise<void> {
    await this.#persistent?.close();
    await super.close();
  }
}
