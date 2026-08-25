import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Agent, AgentContext, AgentStatus, FleetSnapshot, Loop, Project, Task } from "./domain.js";
import { recommendModel } from "./models.js";

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
        model TEXT NOT NULL DEFAULT 'gpt-5.6-luna',
        status TEXT NOT NULL,
        branch TEXT,
        worktree_path TEXT,
        terminal_title TEXT,
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
      CREATE TABLE IF NOT EXISTS loops (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        title TEXT NOT NULL,
        schedule TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        directory_path TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    this.addColumnIfMissing("agents", "branch", "TEXT");
    this.addColumnIfMissing("agents", "worktree_path", "TEXT");
    this.addColumnIfMissing("agents", "terminal_title", "TEXT");
    this.addColumnIfMissing("agents", "model", "TEXT NOT NULL DEFAULT 'gpt-5.6-luna'");
    this.addColumnIfMissing("loops", "directory_path", "TEXT");
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

  requestAgent(taskId: string, role: string, provider = "codex", model = recommendModel(role)): Agent {
    this.requireTask(taskId);
    const agent: Agent = {
      id: randomUUID(),
      taskId,
      role,
      provider,
      model,
      status: "requested",
      branch: null,
      worktreePath: null,
      terminalTitle: null,
      createdAt: now(),
    };
    this.database.prepare(
      "INSERT INTO agents (id, task_id, role, provider, model, status, branch, worktree_path, terminal_title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(agent.id, agent.taskId, agent.role, agent.provider, agent.model, agent.status, agent.branch, agent.worktreePath, agent.terminalTitle, agent.createdAt);
    this.addEvent("agent", agent.id, "requested", { taskId, role, provider, model });
    return agent;
  }

  createLoop(title: string, schedule: string, projectId: string | null, directoryPath: string | null = null): Loop {
    if (projectId) this.requireProject(projectId);
    const loop: Loop = { id: randomUUID(), projectId, title, schedule, enabled: true, directoryPath, createdAt: now() };
    this.database.prepare(
      "INSERT INTO loops (id, project_id, title, schedule, enabled, directory_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(loop.id, loop.projectId, loop.title, loop.schedule, Number(loop.enabled), loop.directoryPath, loop.createdAt);
    this.addEvent("loop", loop.id, "created", { title, schedule, projectId, directoryPath });
    return loop;
  }

  findProjectByRoot(rootPath: string): Project | null {
    const row = this.database.prepare(
      "SELECT id, name, root_path AS rootPath, created_at AS createdAt FROM projects WHERE root_path = ?",
    ).get(rootPath) as unknown as Project | undefined;
    return row ?? null;
  }

  findAgentByWorktree(worktreePath: string): Agent | null {
    const row = this.database.prepare(
      "SELECT id, task_id AS taskId, role, provider, model, status, branch, worktree_path AS worktreePath, terminal_title AS terminalTitle, created_at AS createdAt FROM agents WHERE worktree_path = ?",
    ).get(worktreePath) as unknown as Agent | undefined;
    return row ?? null;
  }

  recoverAgent(taskId: string, details: { branch: string; worktreePath: string; terminalTitle: string }): Agent {
    this.requireTask(taskId);
    const agent: Agent = {
      id: randomUUID(), taskId, role: "recovered", provider: "unknown", model: "unknown", status: "unknown",
      branch: details.branch, worktreePath: details.worktreePath, terminalTitle: details.terminalTitle, createdAt: now(),
    };
    this.database.prepare(
      "INSERT INTO agents (id, task_id, role, provider, model, status, branch, worktree_path, terminal_title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(agent.id, agent.taskId, agent.role, agent.provider, agent.model, agent.status, agent.branch, agent.worktreePath, agent.terminalTitle, agent.createdAt);
    this.addEvent("agent", agent.id, "recovered", details);
    return agent;
  }

  snapshot(): FleetSnapshot {
    return {
      projects: this.database.prepare("SELECT id, name, root_path AS rootPath, created_at AS createdAt FROM projects ORDER BY created_at").all() as unknown as Project[],
      tasks: this.database.prepare("SELECT id, project_id AS projectId, title, status, created_at AS createdAt FROM tasks ORDER BY created_at").all() as unknown as Task[],
      agents: this.database.prepare("SELECT id, task_id AS taskId, role, provider, model, status, branch, worktree_path AS worktreePath, terminal_title AS terminalTitle, created_at AS createdAt FROM agents ORDER BY created_at").all() as unknown as Agent[],
      loops: (this.database.prepare("SELECT id, project_id AS projectId, title, schedule, enabled, directory_path AS directoryPath, created_at AS createdAt FROM loops ORDER BY created_at").all() as Array<Omit<Loop, "enabled"> & { enabled: number }>).map((loop) => ({ ...loop, enabled: Boolean(loop.enabled) })),
    };
  }

  getAgentContext(agentId: string): AgentContext {
    const row = this.database.prepare(`
      SELECT
        a.id AS agentId, a.task_id AS agentTaskId, a.role AS agentRole, a.provider AS agentProvider, a.model AS agentModel,
        a.status AS agentStatus, a.branch AS agentBranch, a.worktree_path AS agentWorktreePath,
        a.terminal_title AS agentTerminalTitle, a.created_at AS agentCreatedAt,
        t.id AS taskId, t.project_id AS taskProjectId, t.title AS taskTitle, t.status AS taskStatus,
        t.created_at AS taskCreatedAt,
        p.id AS projectId, p.name AS projectName, p.root_path AS projectRootPath, p.created_at AS projectCreatedAt
      FROM agents a
      JOIN tasks t ON t.id = a.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE a.id = ?
    `).get(agentId) as Record<string, string | null> | undefined;
    if (!row) throw new Error(`Unknown agent: ${agentId}`);
    return {
      agent: {
        id: requiredRow(row, "agentId"), taskId: requiredRow(row, "agentTaskId"), role: requiredRow(row, "agentRole"),
        provider: requiredRow(row, "agentProvider"), model: requiredRow(row, "agentModel"), status: requiredRow(row, "agentStatus") as AgentStatus,
        branch: row.agentBranch, worktreePath: row.agentWorktreePath, terminalTitle: row.agentTerminalTitle,
        createdAt: requiredRow(row, "agentCreatedAt"),
      },
      task: {
        id: requiredRow(row, "taskId"), projectId: requiredRow(row, "taskProjectId"), title: requiredRow(row, "taskTitle"),
        status: requiredRow(row, "taskStatus") as Task["status"], createdAt: requiredRow(row, "taskCreatedAt"),
      },
      project: {
        id: requiredRow(row, "projectId"), name: requiredRow(row, "projectName"), rootPath: requiredRow(row, "projectRootPath"),
        createdAt: requiredRow(row, "projectCreatedAt"),
      },
    };
  }

  provisionAgent(agentId: string, details: { branch: string; worktreePath: string; terminalTitle: string }): Agent {
    const context = this.getAgentContext(agentId);
    if (context.agent.status !== "requested") {
      throw new Error(`Agent ${agentId} cannot be launched from ${context.agent.status}`);
    }
    this.database.prepare(`
      UPDATE agents
      SET status = 'waiting', branch = ?, worktree_path = ?, terminal_title = ?
      WHERE id = ?
    `).run(details.branch, details.worktreePath, details.terminalTitle, agentId);
    this.addEvent("agent", agentId, "provisioned", details);
    return { ...context.agent, status: "waiting", ...details };
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

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function defaultDatabasePath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "Fleet", "fleet.db");
}

function now(): string {
  return new Date().toISOString();
}

function requiredRow(row: Record<string, string | null>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) throw new Error(`Database row is missing ${key}`);
  return value;
}
