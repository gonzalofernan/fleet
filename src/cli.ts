#!/usr/bin/env node
import { resolve } from "node:path";
import { renderDashboard } from "./dashboard.js";
import { FleetService } from "./service.js";
import { defaultDatabasePath, FleetStore } from "./storage.js";
import { cloneManagedProject, createManagedProject, ensureSettings, initializeLoopDirectory, initializeProjectDirectory } from "./settings.js";
import { initializeProjectContext } from "./project-context.js";
import { startCaptainHost } from "./captain-host.js";
import { MESSAGE_PRIORITIES, MESSAGE_TYPES, type MessagePriority, type MessageStatus, type MessageType } from "./domain.js";
import { cleanupCodexSessions } from "./codex-sessions.js";
import { startCaptainBridge, startWorkerBridge } from "./agent-bridge.js";

const [, , ...args] = process.argv;
const settings = ensureSettings();
const store = new FleetStore(process.env.FLEET_DB || defaultDatabasePath());

try {
  const result = execute(args);
  process.stdout.write(typeof result === "string" ? result : `${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`fleet: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}

function execute(command: string[]): object | string {
  if (command.length === 0 || command[0] === "help" || command[0] === "--help") {
    return {
      usage: [
        "fleet project create <name>",
        "fleet project clone <name> --url <repository-url>",
        "fleet project add <name> --path <repository-path>",
        "fleet project context --id <project-id>",
        "fleet task create --project <project-id> --title <title>",
        "fleet agent request --task <task-id> --role <role> [--provider codex]",
        "fleet agent launch <agent-id>",
        "fleet agent status --id <agent-id> --status <status> [--message <text>]",
        "fleet agent reply --id <agent-id> --text <text>",
        "fleet agent complete --id <agent-id> --message <summary>",
        "fleet worker-cleanup --agent-id <agent-id> --working-directory <path> --started-at <iso> --codex-path <path>",
        "fleet loop create --title <title> --schedule <schedule> [--project <project-id>]",
        "fleet message send --text <text> [--agent <agent-id>] [--task <task-id>] [--type info|question|approval|blocked|completed] [--priority low|normal|high|urgent]",
        "fleet message list [--status unread|delivered|acknowledged|resolved]",
        "fleet message acknowledge --id <message-id>",
        "fleet message resolve --id <message-id>",
        "fleet message snooze --id <message-id> --minutes <minutes>",
        "fleet settings",
        "fleet reconcile",
        "fleet github sync [--project <repository-path>]",
        "fleet captain",
        "fleet dashboard [--recent-projects <n>] [--recent-activity <n>]",
        "fleet status",
      ],
    };
  }

  if (command[0] === "project" && command[1] === "add") {
    const name = required(command[2], "project name");
    const rootPath = resolve(required(option(command, "--path"), "--path"));
    const project = store.addProject(name, rootPath);
    return { ...project, context: initializeProjectContext(settings, name, rootPath) };
  }
  if (command[0] === "project" && command[1] === "create") {
    const name = required(command[2], "project name");
    return store.addProject(name, createManagedProject(settings, name));
  }
  if (command[0] === "project" && command[1] === "clone") {
    const name = required(command[2], "project name");
    return store.addProject(name, cloneManagedProject(settings, name, required(option(command, "--url"), "--url")));
  }
  if (command[0] === "project" && command[1] === "context") {
    const project = store.getProject(required(option(command, "--id"), "project id"));
    return initializeProjectContext(settings, project.name, project.rootPath);
  }
  if (command[0] === "task" && command[1] === "create") {
    return store.createTask(required(option(command, "--project"), "--project"), required(option(command, "--title"), "--title"));
  }
  if (command[0] === "agent" && command[1] === "request") {
    return store.requestAgent(
      required(option(command, "--task"), "--task"),
      required(option(command, "--role"), "--role"),
      option(command, "--provider") ?? "codex",
      option(command, "--model"),
    );
  }
  if (command[0] === "agent" && command[1] === "launch") {
    return new FleetService(store).launchAgent(required(command[2], "agent id"));
  }
  if (command[0] === "agent" && command[1] === "status") {
    return store.updateAgentStatus(
      required(option(command, "--id"), "agent id"),
      required(option(command, "--status"), "agent status") as Parameters<FleetStore["updateAgentStatus"]>[1],
      option(command, "--message"),
    );
  }
  if (command[0] === "agent" && command[1] === "reply") {
    return store.queueAgentReply(
      required(option(command, "--id"), "agent id"),
      required(option(command, "--text"), "reply text"),
    );
  }
  if (command[0] === "agent" && command[1] === "complete") {
    new FleetService(store).completeAgent(
      required(option(command, "--id"), "agent id"),
      required(option(command, "--message"), "completion summary"),
    );
    return "";
  }
  if (command[0] === "loop" && command[1] === "create") {
    const title = required(option(command, "--title"), "--title");
    return store.createLoop(
      title,
      required(option(command, "--schedule"), "--schedule"),
      option(command, "--project") ?? null,
      initializeLoopDirectory(settings, title),
    );
  }
  if (command[0] === "settings") return settings;
  if (command[0] === "message" && command[1] === "send") {
    const type = parseMessageType(option(command, "--type") ?? "info");
    const priority = parseMessagePriority(option(command, "--priority") ?? "normal");
    return store.sendMessage({
      text: required(option(command, "--text"), "--text"),
      agentId: option(command, "--agent") ?? null,
      taskId: option(command, "--task") ?? null,
      type,
      priority,
    });
  }
  if (command[0] === "message" && command[1] === "list") {
    const status = option(command, "--status");
    return store.listMessages(status ? parseMessageStatus(status) : null);
  }
  if (command[0] === "message" && command[1] === "acknowledge") {
    return store.acknowledgeMessage(required(option(command, "--id"), "--id"));
  }
  if (command[0] === "message" && command[1] === "resolve") {
    return store.resolveMessage(required(option(command, "--id"), "--id"));
  }
  if (command[0] === "message" && command[1] === "snooze") {
    const minutes = Number(required(option(command, "--minutes"), "--minutes"));
    return store.snoozeMessage(required(option(command, "--id"), "--id"), minutes);
  }
  if (command[0] === "captain-host") {
    startCaptainHost({
      codexPath: required(option(command, "--codex-path"), "--codex-path"),
      model: required(option(command, "--model"), "--model"),
      workingDirectory: required(option(command, "--working-directory"), "--working-directory"),
      databasePath: required(option(command, "--database-path"), "--database-path"),
      prompt: Buffer.from(required(option(command, "--prompt-base64"), "--prompt-base64"), "base64").toString("utf8"),
    });
    return "";
  }
  if (command[0] === "captain-bridge") {
    startCaptainBridge({
      codexPath: required(option(command, "--codex-path"), "--codex-path"),
      databasePath: required(option(command, "--database-path"), "--database-path"),
      workingDirectory: required(option(command, "--working-directory"), "--working-directory"),
      startedAt: required(option(command, "--started-at"), "--started-at"),
    });
    return "";
  }
  if (command[0] === "worker-bridge") {
    startWorkerBridge({
      agentId: required(option(command, "--agent-id"), "agent id"),
      codexPath: required(option(command, "--codex-path"), "--codex-path"),
      databasePath: required(option(command, "--database-path"), "--database-path"),
      workingDirectory: required(option(command, "--working-directory"), "--working-directory"),
      startedAt: required(option(command, "--started-at"), "--started-at"),
    });
    return "";
  }
  if (command[0] === "captain-cleanup") {
    cleanupCodexSessions({
      workingDirectory: required(option(command, "--working-directory"), "--working-directory"),
      startedAt: required(option(command, "--started-at"), "--started-at"),
      codexPath: required(option(command, "--codex-path"), "--codex-path"),
    });
    return "";
  }
  if (command[0] === "worker-cleanup") {
    cleanupCodexSessions({
      workingDirectory: required(option(command, "--working-directory"), "--working-directory"),
      startedAt: required(option(command, "--started-at"), "--started-at"),
      codexPath: required(option(command, "--codex-path"), "--codex-path"),
    });
    store.clearAgentSession(required(option(command, "--agent-id"), "agent id"));
    return "";
  }
  if (command[0] === "captain") {
    new FleetService(store).launchCaptain(process.cwd());
    return { status: "launched", title: "FLEET | Captain" };
  }
  if (command[0] === "reconcile") {
    return new FleetService(store).reconcileProject(process.cwd());
  }
  if (command[0] === "github" && command[1] === "sync") {
    const projectPath = option(command, "--project");
    return new FleetService(store).reconcileMergedPullRequests(projectPath ? resolve(projectPath) : undefined);
  }
  if (command[0] === "status") {
    if (command[1] === "--view") return renderDashboard(store.snapshot());
    return store.snapshot();
  }
  if (command[0] === "dashboard") {
    return renderDashboard(store.snapshot(), {
      recentProjectsLimit: optionalLimit(command, "--recent-projects"),
      recentActivityLimit: optionalLimit(command, "--recent-activity"),
    });
  }
  throw new Error(`Unknown command: ${command.join(" ")}`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function required(value: string | undefined, label: string): string {
  if (!value || value.startsWith("--")) throw new Error(`Missing ${label}`);
  return value;
}

function optionalLimit(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error(`${name} must be an integer between 1 and 50`);
  return limit;
}

function parseMessageType(value: string): MessageType {
  if (!MESSAGE_TYPES.includes(value as MessageType)) throw new Error(`Unknown message type: ${value}`);
  return value as MessageType;
}

function parseMessagePriority(value: string): MessagePriority {
  if (!MESSAGE_PRIORITIES.includes(value as MessagePriority)) throw new Error(`Unknown message priority: ${value}`);
  return value as MessagePriority;
}

function parseMessageStatus(value: string): MessageStatus {
  if (!["unread", "delivered", "acknowledged", "resolved"].includes(value)) throw new Error(`Unknown message status: ${value}`);
  return value as MessageStatus;
}
