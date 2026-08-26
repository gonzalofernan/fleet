#!/usr/bin/env node
import { resolve } from "node:path";
import { renderDashboard } from "./dashboard.js";
import {
  AGENT_STATUSES,
  DELIVERY_MODES,
  MESSAGE_PRIORITIES,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  RISK_LEVELS,
  TASK_KINDS,
  type AgentStatus,
  type DeliveryMode,
  type MessagePriority,
  type MessageStatus,
  type MessageType,
  type RiskLevel,
  type TaskKind,
  type TaskSpec,
} from "./domain.js";
import { EXECUTION_PROFILES } from "./execution-profiles.js";
import { initializeProjectContext } from "./project-context.js";
import { FleetService } from "./service.js";
import {
  cloneManagedProject,
  createManagedProject,
  ensureSettings,
  initializeLoopDirectory,
  type FleetSettings,
} from "./settings.js";
import { defaultDatabasePath, FleetStore } from "./storage.js";
import { runSupervisedRuntime } from "./supervisor.js";

const [, , ...args] = process.argv;
void main(args);

async function main(command: string[]): Promise<void> {
  try {
    if (command[0] === "runtime" && command[1] === "run") {
      const exitCode = await runSupervisedRuntime({
        runtimeId: required(option(command, "--id"), "--id"),
        databasePath: option(command, "--database-path") ?? process.env.FLEET_DB ?? defaultDatabasePath(),
      });
      process.exitCode = exitCode;
      return;
    }

    const settings = ensureSettings();
    const store = new FleetStore(process.env.FLEET_DB || defaultDatabasePath());
    try {
      const result = execute(command, store, settings);
      if (result !== "") process.stdout.write(typeof result === "string" ? `${result}\n` : `${JSON.stringify(result, null, 2)}\n`);
    } finally {
      store.close();
    }
  } catch (error) {
    process.stderr.write(`fleet: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function execute(command: string[], store: FleetStore, settings: FleetSettings): object | string {
  const service = new FleetService(store, undefined, undefined, settings);
  if (command.length === 0 || command[0] === "help" || command[0] === "--help") return help();

  if (command[0] === "project" && command[1] === "add") {
    const name = required(command[2], "project name");
    const rootPath = resolve(required(option(command, "--path"), "--path"));
    const project = store.addProject(name, rootPath);
    return { ...project, context: initializeProjectContext(settings, name, rootPath) };
  }
  if (command[0] === "project" && command[1] === "create") {
    const name = required(command[2], "project name");
    const rootPath = createManagedProject(settings, name);
    const project = store.addProject(name, rootPath);
    return { ...project, context: initializeProjectContext(settings, name, rootPath) };
  }
  if (command[0] === "project" && command[1] === "clone") {
    const name = required(command[2], "project name");
    const rootPath = cloneManagedProject(settings, name, required(option(command, "--url"), "--url"));
    const project = store.addProject(name, rootPath);
    return { ...project, context: initializeProjectContext(settings, name, rootPath) };
  }
  if (command[0] === "project" && command[1] === "context") {
    const project = store.getProject(required(option(command, "--id"), "project id"));
    service.refreshProject(project.id, "Contexto del proyecto actualizado manualmente.");
    return initializeProjectContext(settings, project.name, project.rootPath);
  }

  if (command[0] === "task" && command[1] === "create") {
    const title = required(option(command, "--title"), "--title");
    const task = store.createTask(required(option(command, "--project"), "--project"), title, taskSpecOptions(command, title));
    service.refreshProject(task.projectId, `Tarea creada: ${task.title}`);
    return task;
  }
  if (command[0] === "task" && command[1] === "status") {
    const task = store.updateTaskStatus(
      required(option(command, "--id"), "--id"),
      required(option(command, "--status"), "--status") as Parameters<FleetStore["updateTaskStatus"]>[1],
      option(command, "--reason"),
    );
    service.refreshProject(task.projectId, `Tarea ${task.title} -> ${task.status}`);
    return task;
  }

  if (command[0] === "agent" && command[1] === "request") {
    const agent = store.requestAgent(
      required(option(command, "--task"), "--task"),
      required(option(command, "--role"), "--role"),
      option(command, "--provider") ?? settings.defaultProvider,
      option(command, "--model"),
      option(command, "--profile"),
    );
    const task = store.getTask(agent.taskId);
    service.refreshProject(task.projectId, `Agente solicitado: ${agent.role} (${agent.id.slice(0, 8)}).`);
    return agent;
  }
  if (command[0] === "agent" && command[1] === "launch") return service.launchAgent(required(command[2], "agent id"));
  if (command[0] === "agent" && command[1] === "status") {
    return store.updateAgentStatus(
      required(option(command, "--id"), "agent id"),
      parseFrom(AGENT_STATUSES, required(option(command, "--status"), "agent status"), "agent status") as AgentStatus,
      option(command, "--message"),
    );
  }
  if (command[0] === "agent" && command[1] === "reply") {
    return store.queueAgentReply(
      required(option(command, "--id"), "agent id"),
      required(option(command, "--text"), "reply text"),
      option(command, "--message") ?? null,
    );
  }
  if (command[0] === "agent" && command[1] === "complete") {
    return service.completeAgent(
      required(option(command, "--id"), "agent id"),
      required(option(command, "--message"), "completion summary"),
    );
  }
  if (command[0] === "agent" && command[1] === "cancel") {
    return service.cancelAgent(
      required(option(command, "--id"), "agent id"),
      option(command, "--reason") ?? "Cancelled by the Fleet captain",
    );
  }

  if (command[0] === "runtime" && command[1] === "list") return store.snapshot().runtimes;
  if (command[0] === "runtime" && command[1] === "cancel") {
    return store.requestRuntimeCancellation(
      required(option(command, "--id"), "--id"),
      option(command, "--reason") ?? "Cancelled by the Fleet captain",
    );
  }

  if (command[0] === "loop" && command[1] === "create") {
    const title = required(option(command, "--title"), "--title");
    const taskSpec = taskSpecOptions(command, title);
    return store.createLoop(
      title,
      option(command, "--schedule") ?? "manual",
      option(command, "--project") ?? null,
      initializeLoopDirectory(settings, title),
      {
        taskSpec,
        role: option(command, "--role"),
        provider: option(command, "--provider") ?? settings.defaultProvider,
        model: option(command, "--model"),
      },
    );
  }
  if (command[0] === "loop" && command[1] === "run") return service.runLoop(required(command[2], "loop id"));

  if (command[0] === "message" && command[1] === "send") {
    const text = required(option(command, "--text"), "--text");
    return store.sendMessage({
      text,
      agentId: option(command, "--agent") ?? null,
      taskId: option(command, "--task") ?? null,
      attemptId: option(command, "--attempt") ?? null,
      type: parseMessageType(option(command, "--type") ?? "info"),
      priority: parseMessagePriority(option(command, "--priority") ?? "normal"),
      dedupeKey: option(command, "--dedupe-key") ?? null,
      correlationId: option(command, "--correlation") ?? null,
      requiresHuman: hasFlag(command, "--requires-human") ? true : undefined,
    });
  }
  if (command[0] === "message" && command[1] === "list") {
    const status = option(command, "--status");
    return store.listMessages(status ? parseMessageStatus(status) : null);
  }
  if (command[0] === "message" && command[1] === "acknowledge") return store.acknowledgeMessage(required(option(command, "--id"), "--id"));
  if (command[0] === "message" && command[1] === "resolve") {
    return store.resolveMessage(required(option(command, "--id"), "--id"), option(command, "--resolution"));
  }
  if (command[0] === "message" && command[1] === "snooze") {
    return store.snoozeMessage(required(option(command, "--id"), "--id"), numericOption(command, "--minutes", 1, 43_200));
  }
  if (command[0] === "decision" && command[1] === "list") {
    const status = option(command, "--status");
    if (status && !["pending", "resolved", "cancelled"].includes(status)) throw new Error(`Unknown decision status: ${status}`);
    return store.listDecisions((status as "pending" | "resolved" | "cancelled" | undefined) ?? null);
  }

  if (command[0] === "profile" && command[1] === "list") return EXECUTION_PROFILES;
  if (command[0] === "provider" && command[1] === "list") return [{ id: "codex", supervised: true, authentication: "ChatGPT/Codex CLI" }];
  if (command[0] === "settings") return settings;
  if (command[0] === "captain") {
    const runtime = service.launchCaptain(process.cwd());
    return { status: "launched", title: "FLEET | Captain", runtimeId: runtime.id };
  }
  if (command[0] === "reconcile") return service.reconcileProject(process.cwd());
  if (command[0] === "github" && command[1] === "sync") {
    const projectPath = option(command, "--project");
    return service.reconcileMergedPullRequests(projectPath ? resolve(projectPath) : undefined);
  }
  if (command[0] === "status") return command[1] === "--view" ? renderDashboard(store.snapshot()) : store.snapshot();
  if (command[0] === "dashboard") {
    return renderDashboard(store.snapshot(), {
      recentProjectsLimit: optionalLimit(command, "--recent-projects"),
      recentActivityLimit: optionalLimit(command, "--recent-activity"),
    });
  }
  if (["captain-host", "captain-bridge", "worker-bridge", "captain-cleanup", "worker-cleanup"].includes(command[0] ?? "")) {
    throw new Error(`${command[0]} was removed; Fleet runtimes are now owned by the unified local supervisor`);
  }
  throw new Error(`Unknown command: ${command.join(" ")}`);
}

function help(): object {
  return {
    usage: [
      "fleet captain",
      "fleet dashboard",
      "fleet project create <name>",
      "fleet project clone <name> --url <repository-url>",
      "fleet project add <name> --path <repository-path>",
      "fleet task create --project <id> --title <title> [--kind coding|review|research|browser|writing|operations] [--delivery git-pr|report-only|conversation-only] [--accept <criterion>]",
      "fleet agent request --task <id> --role <role> [--provider codex] [--model <model>] [--profile <profile>]",
      "fleet agent launch <id>",
      "fleet agent reply --id <agent-id> --message <message-id> --text <response>",
      "fleet agent complete --id <agent-id> --message <summary>",
      "fleet agent cancel --id <agent-id> [--reason <reason>]",
      "fleet loop create --title <title> --project <id> [--schedule manual|@every 1h|<cron>]",
      "fleet loop run <id>",
      "fleet decision list [--status pending|resolved|cancelled]",
      "fleet runtime list",
      "fleet runtime cancel --id <id>",
      "fleet github sync [--project <path>]",
      "fleet profile list",
      "fleet provider list",
    ],
  };
}

function taskSpecOptions(args: string[], title: string): Partial<TaskSpec> {
  const result: Partial<TaskSpec> = { objective: option(args, "--objective") ?? title };
  const kind = option(args, "--kind");
  const delivery = option(args, "--delivery");
  const risk = option(args, "--risk");
  if (kind) result.kind = parseFrom(TASK_KINDS, kind, "task kind") as TaskKind;
  if (delivery) result.deliveryMode = parseFrom(DELIVERY_MODES, delivery, "delivery mode") as DeliveryMode;
  if (risk) result.riskLevel = parseFrom(RISK_LEVELS, risk, "risk level") as RiskLevel;
  const criteria = options(args, "--accept");
  const contextPaths = options(args, "--context");
  if (criteria.length) result.acceptanceCriteria = criteria;
  if (contextPaths.length) result.contextPaths = contextPaths;
  if (option(args, "--profile")) result.executionProfile = option(args, "--profile")!;
  return result;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function options(args: string[], name: string): string[] {
  return args.flatMap((value, index) => value === name && args[index + 1] && !args[index + 1]!.startsWith("--") ? [args[index + 1]!] : []);
}

function hasFlag(args: string[], name: string): boolean { return args.includes(name); }

function required(value: string | undefined, label: string): string {
  if (!value || value.startsWith("--")) throw new Error(`Missing ${label}`);
  return value;
}

function numericOption(args: string[], name: string, min: number, max: number): number {
  const value = Number(required(option(args, name), name));
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function optionalLimit(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error(`${name} must be an integer between 1 and 50`);
  return limit;
}

function parseFrom<const T extends readonly string[]>(values: T, value: string, label: string): T[number] {
  if (!values.includes(value as T[number])) throw new Error(`Unknown ${label}: ${value}`);
  return value as T[number];
}

function parseMessageType(value: string): MessageType { return parseFrom(MESSAGE_TYPES, value, "message type"); }
function parseMessagePriority(value: string): MessagePriority { return parseFrom(MESSAGE_PRIORITIES, value, "message priority"); }
function parseMessageStatus(value: string): MessageStatus { return parseFrom(MESSAGE_STATUSES, value, "message status"); }
