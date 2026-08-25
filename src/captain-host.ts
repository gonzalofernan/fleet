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
  let ready = false;
  let outputBuffer = "";
  renderStartup("Starting Codex", [false, false, false, false]);
  const startupTimer = setInterval(() => {
    if (!ready) renderStartup("Loading Fleet context", [true, true, false, false]);
  }, 700);
  const startupFallback = setTimeout(() => finishStartup(), 45_000);
  session.onData((data) => {
    if (ready) {
      process.stdout.write(data);
      return;
    }
    outputBuffer += data;
    if (outputBuffer.length > 100_000) outputBuffer = outputBuffer.slice(-50_000);
    if (outputBuffer.includes("Starting MCP servers")) renderStartup("Loading MCP servers", [true, false, false, false]);
    if (outputBuffer.includes("You are the Fleet captain")) renderStartup("Injecting Fleet context", [true, true, true, false]);
    if (outputBuffer.includes("FLEET_READY")) {
      finishStartup();
    }
  });

  function finishStartup(): void {
    if (ready) return;
    ready = true;
    clearInterval(startupTimer);
    clearTimeout(startupFallback);
    renderStartup("Fleet ready", [true, true, true, true]);
    setTimeout(() => {
      clearScreen();
      process.stdout.write("Fleet\r\n\r\nHola, soy Fleet. ¿En qué puedo ayudarte?\r\n\r\n");
    }, 350);
  }
  const onInput = (data: Buffer) => session.write(data.toString("utf8"));
  process.stdin.on("data", onInput);
  process.stdin.resume();
  if (process.stdin.isTTY) process.stdin.setRawMode?.(true);

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
    clearInterval(startupTimer);
    clearTimeout(startupFallback);
    process.stdin.off("data", onInput);
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
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

function renderStartup(current: string, checks: boolean[]): void {
  clearScreen();
  process.stdout.write([
    "FLEET | Captain\r\n",
    "\r\n",
    `${checks[0] ? "[ok]" : "[ ]"} Cargando Codex\r\n`,
    `${checks[1] ? "[ok]" : "[ ]"} Cargando MCP servers\r\n`,
    `${checks[2] ? "[ok]" : "[ ]"} Introduciendo contexto Fleet\r\n`,
    `${checks[3] ? "[ok]" : "[ ]"} Preparando últimos detalles\r\n`,
    `\r\n${current}...\r\n`,
  ].join(""));
}

function clearScreen(): void {
  process.stdout.write("\u001b[2J\u001b[H");
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
  return `& '${escapePowerShell(options.codexPath)}' -m '${escapePowerShell(options.model)}' -s danger-full-access -a never -C '${escapePowerShell(options.workingDirectory)}' '${escapePowerShell(options.prompt)}'`;
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}
