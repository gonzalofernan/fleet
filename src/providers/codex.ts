import { cleanupCodexSessions } from "../codex-sessions.js";
import { findStartedCodexSession, queueCodexMessage } from "../codex-bridge.js";
import type { ProcessRuntime } from "../domain.js";
import type { ExecutionProfile } from "../execution-profiles.js";
import type { AgentProviderAdapter, ProviderCommand, ProviderSessionLookup } from "./provider.js";

export class CodexProviderAdapter implements AgentProviderAdapter {
  readonly id = "codex";

  constructor(private readonly configuredCodexPath?: string) {}

  buildCommand(runtime: ProcessRuntime, profile: ExecutionProfile): ProviderCommand {
    const codexPath = runtime.launchConfig.codexPath;
    if (!codexPath) throw new Error(`Runtime ${runtime.id} has no Codex executable configured`);
    const promptBase64 = Buffer.from(runtime.launchConfig.prompt, "utf8").toString("base64");
    const script = [
      `$prompt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${promptBase64}'))`,
      `& '${escapePowerShell(codexPath)}' -m '${escapePowerShell(runtime.model)}' -s '${profile.sandbox}' -a '${profile.approvalPolicy}' -C '${escapePowerShell(runtime.workingDirectory)}' "$prompt"`,
      "exit $LASTEXITCODE",
    ].join("\n");
    return {
      executable: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    };
  }

  findSession(options: ProviderSessionLookup): string | null {
    return findStartedCodexSession(options);
  }

  sendMessage(sessionId: string, message: string): boolean {
    const codexPath = this.configuredCodexPath ?? process.env.FLEET_CODEX_PATH;
    if (!codexPath) throw new Error("FLEET_CODEX_PATH is not available to the supervised Codex runtime");
    return queueCodexMessage(codexPath, sessionId, message);
  }

  cleanupSessions(options: ProviderSessionLookup): string[] {
    const codexPath = this.configuredCodexPath ?? process.env.FLEET_CODEX_PATH;
    if (!codexPath) return [];
    return cleanupCodexSessions({ ...options, codexPath });
  }
}

function escapePowerShell(value: string): string { return value.replaceAll("'", "''"); }
