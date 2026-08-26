import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Agent, AgentContext, AgentStatus, FleetMessage, FleetSnapshot, Loop, MessagePriority, MessageStatus, MessageType, Project, PullRequestMerge, Task } from "./domain.js";
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
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT REFERENCES agents(id),
        task_id TEXT REFERENCES tasks(id),
        type TEXT NOT NULL,
        priority TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        requires_human INTEGER NOT NULL DEFAULT 0,
        reminder_at TEXT,
        last_reminded_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS pull_request_merges (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        number INTEGER NOT NULL,
        url TEXT NOT NULL,
        head_ref_name TEXT NOT NULL,
        base_ref_name TEXT NOT NULL,
        merged_at TEXT NOT NULL,
        detected_at TEXT NOT NULL
      ) STRICT;
    `);
    this.addColumnIfMissing("agents", "branch", "TEXT");
    this.addColumnIfMissing("agents", "worktree_path", "TEXT");
    this.addColumnIfMissing("agents", "terminal_title", "TEXT");
    this.addColumnIfMissing("agents", "model", "TEXT NOT NULL DEFAULT 'gpt-5.6-luna'");
    this.addColumnIfMissing("loops", "directory_path", "TEXT");
    this.addColumnIfMissing("messages", "requires_human", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("messages", "reminder_at", "TEXT");
    this.addColumnIfMissing("messages", "last_reminded_at", "TEXT");
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

  markTaskForReview(taskId: string): Task {
    const task = this.requireTaskRecord(taskId);
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      throw new Error(`Task ${taskId} cannot enter review from ${task.status}`);
    }
    this.database.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(taskId);
    this.addEvent("task", taskId, "review_requested", {});
    return { ...task, status: "review" };
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

  sendMessage(details: { agentId?: string | null; taskId?: string | null; type: MessageType; priority?: MessagePriority; text: string; requiresHuman?: boolean }): FleetMessage {
    if (details.agentId) this.requireAgent(details.agentId);
    if (details.taskId) this.requireTask(details.taskId);
    const requiresHuman = details.requiresHuman ?? ["question", "approval", "blocked"].includes(details.type);
    const message: FleetMessage = {
      id: randomUUID(), agentId: details.agentId ?? null, taskId: details.taskId ?? null,
      type: details.type, priority: details.priority ?? "normal", text: details.text,
      status: "unread", requiresHuman, reminderAt: null, lastRemindedAt: null,
      projectName: null, agentRole: null, taskTitle: null, createdAt: now(),
    };
    this.database.prepare(
      "INSERT INTO messages (id, agent_id, task_id, type, priority, text, status, requires_human, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(message.id, message.agentId, message.taskId, message.type, message.priority, message.text, message.status, Number(message.requiresHuman), message.createdAt);
    this.addEvent("message", message.id, "created", details);
    return message;
  }

  listMessages(status: MessageStatus | null = null): FleetMessage[] {
    const baseQuery = `SELECT m.id, m.agent_id AS agentId, m.task_id AS taskId, m.type, m.priority, m.text, m.status,
      m.requires_human AS requiresHuman, m.reminder_at AS reminderAt, m.last_reminded_at AS lastRemindedAt,
      p.name AS projectName, a.role AS agentRole, t.title AS taskTitle, m.created_at AS createdAt
      FROM messages m
      LEFT JOIN agents a ON a.id = m.agent_id
      LEFT JOIN tasks t ON t.id = m.task_id
      LEFT JOIN projects p ON p.id = t.project_id`;
    const query = status
      ? `${baseQuery} WHERE m.status = ? ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.created_at`
      : `${baseQuery} ORDER BY m.created_at`;
    const rows = (status ? this.database.prepare(query).all(status) : this.database.prepare(query).all()) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapMessage(row));
  }

  listMessagesDueForReminder(asOf = new Date()): FleetMessage[] {
    const rows = this.database.prepare(`
      SELECT m.id, m.agent_id AS agentId, m.task_id AS taskId, m.type, m.priority, m.text, m.status,
        m.requires_human AS requiresHuman, m.reminder_at AS reminderAt, m.last_reminded_at AS lastRemindedAt,
        p.name AS projectName, a.role AS agentRole, t.title AS taskTitle, m.created_at AS createdAt
      FROM messages m
      LEFT JOIN agents a ON a.id = m.agent_id
      LEFT JOIN tasks t ON t.id = m.task_id
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE m.requires_human = 1 AND m.status IN ('delivered', 'acknowledged') AND m.reminder_at IS NOT NULL AND m.reminder_at <= ?
      ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.created_at
    `).all(asOf.toISOString()) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapMessage(row));
  }

  markMessageDelivered(id: string): FleetMessage {
    const message = this.listMessages().find((entry) => entry.id === id);
    if (!message) throw new Error(`Unknown message: ${id}`);
    const reminderAt = message.requiresHuman ? nextReminder(message.priority) : null;
    this.database.prepare("UPDATE messages SET status = 'delivered', reminder_at = ? WHERE id = ? AND status = 'unread'").run(reminderAt, id);
    return { ...message, status: "delivered", reminderAt };
  }

  markMessageReminded(id: string): FleetMessage {
    const message = this.listMessages().find((entry) => entry.id === id);
    if (!message) throw new Error(`Unknown message: ${id}`);
    const remindedAt = now();
    const reminderAt = nextReminder(message.priority);
    this.database.prepare("UPDATE messages SET last_reminded_at = ?, reminder_at = ? WHERE id = ? AND status IN ('delivered', 'acknowledged')").run(remindedAt, reminderAt, id);
    return { ...message, lastRemindedAt: remindedAt, reminderAt };
  }

  acknowledgeMessage(id: string): FleetMessage {
    this.database.prepare("UPDATE messages SET status = 'acknowledged' WHERE id = ? AND status IN ('delivered', 'unread')").run(id);
    return this.requireMessage(id);
  }

  resolveMessage(id: string): FleetMessage {
    this.database.prepare("UPDATE messages SET status = 'resolved', reminder_at = NULL WHERE id = ? AND status <> 'resolved'").run(id);
    return this.requireMessage(id);
  }

  snoozeMessage(id: string, minutes: number): FleetMessage {
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Snooze minutes must be positive");
    const reminderAt = new Date(Date.now() + minutes * 60_000).toISOString();
    this.database.prepare("UPDATE messages SET status = 'acknowledged', reminder_at = ? WHERE id = ? AND status <> 'resolved'").run(reminderAt, id);
    return this.requireMessage(id);
  }

  findProjectByRoot(rootPath: string): Project | null {
    const row = this.database.prepare(
      "SELECT id, name, root_path AS rootPath, created_at AS createdAt FROM projects WHERE root_path = ?",
    ).get(rootPath) as unknown as Project | undefined;
    return row ?? null;
  }

  listProjects(): Project[] {
    return this.database.prepare("SELECT id, name, root_path AS rootPath, created_at AS createdAt FROM projects ORDER BY created_at").all() as unknown as Project[];
  }

  hasPullRequestMerge(agentId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM pull_request_merges WHERE agent_id = ?").get(agentId));
  }

  recordPullRequestMerge(agentId: string, details: Omit<PullRequestMerge, "agentId" | "taskId" | "detectedAt">): { merge: PullRequestMerge; agent: Agent; task: Task; taskCompleted: boolean } | null {
    const context = this.getAgentContext(agentId);
    if (!context.agent.branch || context.agent.branch !== details.headRefName) {
      throw new Error(`Pull request head branch does not match agent ${agentId}`);
    }
    if (["cancelled", "failed"].includes(context.agent.status) || this.hasPullRequestMerge(agentId)) return null;

    const detectedAt = now();
    const merge: PullRequestMerge = { agentId, taskId: context.task.id, detectedAt, ...details };
    this.database.exec("BEGIN");
    try {
      this.database.prepare(`
        INSERT INTO pull_request_merges (agent_id, task_id, number, url, head_ref_name, base_ref_name, merged_at, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(merge.agentId, merge.taskId, merge.number, merge.url, merge.headRefName, merge.baseRefName, merge.mergedAt, merge.detectedAt);
      this.database.prepare("UPDATE agents SET status = 'completed' WHERE id = ?").run(agentId);
      this.addEvent("agent", agentId, context.agent.status === "completed" ? "pull_request_merge_recorded" : "completed_from_pull_request_merge", merge);
      const remaining = this.database.prepare(`
        SELECT 1
        FROM agents a
        LEFT JOIN pull_request_merges m ON m.agent_id = a.id
        WHERE a.task_id = ? AND a.status NOT IN ('failed', 'cancelled') AND m.agent_id IS NULL
        LIMIT 1
      `).get(context.task.id);
      const taskCompleted = !remaining;
      if (taskCompleted) {
        this.database.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(context.task.id);
        this.addEvent("task", context.task.id, "completed_from_pull_request_merge", { agentId, pullRequest: merge });
      }
      this.database.exec("COMMIT");
      return {
        merge,
        agent: { ...context.agent, status: "completed" },
        task: { ...context.task, status: taskCompleted ? "completed" : context.task.status },
        taskCompleted,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
      messages: this.listMessages(),
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

  markAgentCompleted(agentId: string): Agent {
    const context = this.getAgentContext(agentId);
    if (["failed", "cancelled"].includes(context.agent.status)) {
      throw new Error(`Agent ${agentId} cannot complete from ${context.agent.status}`);
    }
    this.database.prepare("UPDATE agents SET status = 'completed' WHERE id = ?").run(agentId);
    this.addEvent("agent", agentId, "completed", {});
    return { ...context.agent, status: "completed" };
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

  private requireTaskRecord(id: string): Task {
    const row = this.database.prepare("SELECT id, project_id AS projectId, title, status, created_at AS createdAt FROM tasks WHERE id = ?").get(id) as unknown as Task | undefined;
    if (!row) throw new Error(`Unknown task: ${id}`);
    return row;
  }

  private requireAgent(id: string): void {
    if (!this.database.prepare("SELECT 1 FROM agents WHERE id = ?").get(id)) throw new Error(`Unknown agent: ${id}`);
  }

  private requireMessage(id: string): FleetMessage {
    const message = this.listMessages().find((entry) => entry.id === id);
    if (!message) throw new Error(`Unknown message: ${id}`);
    return message;
  }

  private mapMessage(row: Record<string, unknown>): FleetMessage {
    return {
      id: String(row.id), agentId: row.agentId ? String(row.agentId) : null, taskId: row.taskId ? String(row.taskId) : null,
      type: String(row.type) as MessageType, priority: String(row.priority) as MessagePriority, text: String(row.text),
      status: String(row.status) as MessageStatus, requiresHuman: Boolean(row.requiresHuman),
      reminderAt: row.reminderAt ? String(row.reminderAt) : null, lastRemindedAt: row.lastRemindedAt ? String(row.lastRemindedAt) : null,
      projectName: row.projectName ? String(row.projectName) : null, agentRole: row.agentRole ? String(row.agentRole) : null,
      taskTitle: row.taskTitle ? String(row.taskTitle) : null, createdAt: String(row.createdAt),
    };
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

function nextReminder(priority: MessagePriority): string {
  const minutes = priority === "urgent" ? 5 : priority === "high" ? 15 : priority === "normal" ? 60 : 240;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function requiredRow(row: Record<string, string | null>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) throw new Error(`Database row is missing ${key}`);
  return value;
}
