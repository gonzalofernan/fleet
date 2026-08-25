import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Agent, FleetSnapshot, Project, Task } from "./domain.js";

export class FleetStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  addProject(name: string, rootPath: string): Project {
    const project: Project = { id: randomUUID(), name, rootPath, createdAt: now() };
    this.database.prepare(
      "INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run(project.id, project.name, project.rootPath, project.createdAt);
    this.addEvent("project", project.id, "created", { name, rootPath });
    return project;
  }

  createTask(projectId: string, title: string): Task {
    this.requireProject(projectId);
    const task: Task = { id: randomUUID(), projectId, title, status: "pending", createdAt: now() };
    this.database.prepare(
      "INSERT INTO tasks (id, project_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(task.id, task.projectId, task.title, task.status, task.createdAt);
    this.addEvent("task", task.id, "created", { projectId, title });
    return task;
  }

  requestAgent(taskId: string, role: string, provider = "codex"): Agent {
    this.requireTask(taskId);
    const agent: Agent = {
      id: randomUUID(),
      taskId,
      role,
      provider,
      status: "requested",
      createdAt: now(),
    };
    this.database.prepare(
      "INSERT INTO agents (id, task_id, role, provider, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(agent.id, agent.taskId, agent.role, agent.provider, agent.status, agent.createdAt);
    this.addEvent("agent", agent.id, "requested", { taskId, role, provider });
    return agent;
  }

  snapshot(): FleetSnapshot {
    return {
      projects: this.database.prepare("SELECT id, name, root_path AS rootPath, created_at AS createdAt FROM projects ORDER BY created_at").all() as unknown as Project[],
      tasks: this.database.prepare("SELECT id, project_id AS projectId, title, status, created_at AS createdAt FROM tasks ORDER BY created_at").all() as unknown as Task[],
      agents: this.database.prepare("SELECT id, task_id AS taskId, role, provider, status, created_at AS createdAt FROM agents ORDER BY created_at").all() as unknown as Agent[],
    };
  }

  close(): void {
    this.database.close();
  }

  private requireProject(id: string): void {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) {
      throw new Error(`Unknown project: ${id}`);
    }
  }

  private requireTask(id: string): void {
    if (!this.database.prepare("SELECT 1 FROM tasks WHERE id = ?").get(id)) {
      throw new Error(`Unknown task: ${id}`);
    }
  }

  private addEvent(entityType: string, entityId: string, eventType: string, payload: object): void {
    this.database.prepare(
      "INSERT INTO events (id, entity_type, entity_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), entityType, entityId, eventType, JSON.stringify(payload), now());
  }
}

export function defaultDatabasePath(cwd: string): string {
  return join(cwd, ".fleet", "fleet.db");
}

function now(): string {
  return new Date().toISOString();
}
