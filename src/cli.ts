#!/usr/bin/env node
import { resolve } from "node:path";
import { defaultDatabasePath, FleetStore } from "./storage.js";

const [, , ...args] = process.argv;
const store = new FleetStore(process.env.FLEET_DB ?? defaultDatabasePath(process.cwd()));

try {
  const result = execute(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`fleet: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}

function execute(command: string[]): object {
  if (command.length === 0 || command[0] === "help" || command[0] === "--help") {
    return {
      usage: [
        "fleet project add <name> --path <repository-path>",
        "fleet task create --project <project-id> --title <title>",
        "fleet agent request --task <task-id> --role <role> [--provider codex]",
        "fleet status",
      ],
    };
  }

  if (command[0] === "project" && command[1] === "add") {
    const name = required(command[2], "project name");
    return store.addProject(name, resolve(required(option(command, "--path"), "--path")));
  }
  if (command[0] === "task" && command[1] === "create") {
    return store.createTask(required(option(command, "--project"), "--project"), required(option(command, "--title"), "--title"));
  }
  if (command[0] === "agent" && command[1] === "request") {
    return store.requestAgent(
      required(option(command, "--task"), "--task"),
      required(option(command, "--role"), "--role"),
      option(command, "--provider") ?? "codex",
    );
  }
  if (command[0] === "status") {
    return store.snapshot();
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

