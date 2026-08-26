import type { ProcessRuntime } from "../domain.js";
import type { ExecutionProfile } from "../execution-profiles.js";

export interface ProviderCommand {
  executable: string;
  args: string[];
}

export interface ProviderSessionLookup {
  workingDirectory: string;
  startedAt: string;
}

export interface AgentProviderAdapter {
  readonly id: string;
  buildCommand(runtime: ProcessRuntime, profile: ExecutionProfile): ProviderCommand;
  findSession(options: ProviderSessionLookup): string | null;
  sendMessage(sessionId: string, message: string): boolean;
  cleanupSessions(options: ProviderSessionLookup): string[];
}

export class ProviderRegistry {
  private readonly providers = new Map<string, AgentProviderAdapter>();

  constructor(providers: AgentProviderAdapter[]) {
    for (const provider of providers) this.providers.set(provider.id, provider);
  }

  get(id: string): AgentProviderAdapter {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Provider ${id} is not registered in this Fleet runtime`);
    return provider;
  }

  list(): string[] { return [...this.providers.keys()].sort(); }
}
