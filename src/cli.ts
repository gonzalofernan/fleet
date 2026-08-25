#!/usr/bin/env node
import { resolve } from "node:path";
import { renderDashboard } from "./dashboard.js";
import { FleetService } from "./service.js";
import { defaultDatabasePath, FleetStore } from "./storage.js";
import { ensureSettings, initializeLoopDirectory, initializeProjectDirectory } from "./settings.js";

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
        "fleet project add <name> --path <repository-path>",
        "fleet project create <name>",
        "fleet task create --project <project-id> --title <title>",
        "fleet agent request --task <task-id> --role <role> [--provider codex]",
        "fleet agent launch <agent-id>",
        "fleet loop create --title <title> --schedule <schedule> [--project <project-id>]",
        "fleet settings",
        "fleet reconcile",
        "fleet captain",
        "fleet dashboard",
        "fleet status",
      ],
    };
  }

  if (command[0] === "project" && command[1] === "add") {
    const name = required(command[2], "project name");
    return store.addProject(name, resolve(required(option(command, "--path"), "--path")));
  }
  if (command[0] === "project" && command[1] === "create") {
    const name = required(command[2], "project name");
    return store.addProject(name, initializeProjectDirectory(settings, name));
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
  if (command[0] === "captain") {
    new FleetService(store).launchCaptain(process.cwd());
    return { status: "launched", title: "FLEET | Captain" };
  }
  if (command[0] === "reconcile") {
    return new FleetService(store).reconcileProject(process.cwd());
  }
  if (command[0] === "status") {
    if (command[1] === "--view") return renderDashboard(store.snapshot());
    return store.snapshot();
  }
  if (command[0] === "dashboard") return renderDashboard(store.snapshot());
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
