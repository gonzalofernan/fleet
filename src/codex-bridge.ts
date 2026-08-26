import { spawnSync } from "node:child_process";
import { normalize, resolve } from "node:path";
import type { FleetMessage } from "./domain.js";
import { findCodexSessions } from "./codex-sessions.js";
import { flattenPromptForWindowsArgument } from "./adapters/windows-terminal.js";

export interface CodexSessionLookup {
  workingDirectory: string;
  startedAt: string;
  sessionsRoot?: string;
}

export function findStartedCodexSession(options: CodexSessionLookup): string | null {
  const startedAt = Date.parse(options.startedAt);
  if (Number.isNaN(startedAt)) return null;
  const expectedDirectory = comparablePath(options.workingDirectory);
  return findCodexSessions(options.sessionsRoot)
    .filter((session) => comparablePath(session.cwd) === expectedDirectory && Date.parse(session.timestamp) >= startedAt)
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0]?.id ?? null;
}

export function queueCodexMessage(codexPath: string, sessionId: string, message: string): boolean {
  const script = buildCodexQueueScript(codexPath, sessionId, message);
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-EncodedCommand", encodedScript], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

export function buildCodexQueueScript(codexPath: string, sessionId: string, message: string): string {
  const messageBase64 = Buffer.from(flattenPromptForWindowsArgument(message), "utf8").toString("base64");
  return [
    `$message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${messageBase64}'))`,
    `& '${escapePowerShell(codexPath)}' queue --thread '${escapePowerShell(sessionId)}' --message \"$message\"`,
    "exit $LASTEXITCODE",
  ].join("\n");
}

export function formatFleetMessageForCaptain(message: FleetMessage, reminder = false): string {
  const source = [message.projectName, message.agentRole, message.taskTitle].filter(Boolean).join(" / ") || "Agente sin contexto";
  return [
    `[FLEET MESSAGE${reminder ? " | REMINDER" : ""}]`,
    `Origen: ${source}`,
    `Tipo: ${message.type}`,
    `Prioridad: ${message.priority}`,
    `Requiere intervención humana: ${message.requiresHuman ? "sí" : "no"}`,
    "Mensaje del agente:",
    message.text,
    "Fin del mensaje Fleet.",
  ].join("\n");
}

function comparablePath(value: string): string {
  return normalize(resolve(value)).replaceAll("/", "\\").toLowerCase();
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}
