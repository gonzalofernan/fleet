import { spawn as spawnPty, type IPty } from "node-pty";
import { FleetStore } from "./storage.js";
import type { FleetMessage } from "./domain.js";

export interface CaptainHostOptions {
  codexPath: string;
  workingDirectory: string;
  model: string;
  prompt: string;
  databasePath: string;
}

export interface CaptainPty {
  write(data: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: () => void): { dispose(): void };
  kill(): void;
}

export function startCaptainHost(options: CaptainHostOptions, createPty = createCaptainPty): void {
  const store = new FleetStore(options.databasePath);
  const session = createPty(options);
  session.onData((data) => process.stdout.write(data));

  const poll = setInterval(() => {
    for (const message of store.listMessages("unread")) {
      session.write(formatCaptainEvent(message));
      store.markMessageDelivered(message.id);
    }
    for (const message of store.listMessagesDueForReminder()) {
      session.write(formatCaptainEvent(message, true));
      store.markMessageReminded(message.id);
    }
  }, 250);

  const close = () => {
    clearInterval(poll);
    store.close();
  };
  session.onExit(close);
  process.once("SIGINT", () => { session.kill(); close(); });
}

export function formatCaptainEvent(message: FleetMessage, reminder = false): string {
  const context = [
    message.projectName ? `Proyecto: ${message.projectName}` : null,
    message.agentRole ? `Agente: ${message.agentRole}${message.agentId ? ` (${message.agentId.slice(0, 8)})` : ""}` : message.agentId ? `Agente: ${message.agentId.slice(0, 8)}` : null,
    message.taskTitle ? `Tarea: ${message.taskTitle}` : null,
  ].filter(Boolean).join("\r\n");
  const header = `[FLEET EVENT${reminder ? " | REMINDER" : ""} | ${message.priority.toUpperCase()} | ${message.type}]`;
  return `\r\n${header}\r\n${context}${context ? "\r\n" : ""}\r\n${message.text}\r\n\r\n`;
}

function createCaptainPty(options: CaptainHostOptions): CaptainPty {
  const command = buildCodexCommand(options);
  const pty: IPty = spawnPty("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
    name: "xterm-256color", cols: 160, rows: 48, cwd: options.workingDirectory,
    env: process.env as Record<string, string>,
  });
  return pty;
}

export function buildCodexCommand(options: CaptainHostOptions): string {
  return `& '${escapePowerShell(options.codexPath)}' -m '${escapePowerShell(options.model)}' -s danger-full-access -a never --no-alt-screen -C '${escapePowerShell(options.workingDirectory)}' '${escapePowerShell(options.prompt)}'`;
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}
