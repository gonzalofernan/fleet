import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { AGENT_STATUSES, type Agent, type AgentContext, type AgentReply, type AgentStatus, type FleetActivity, type FleetMessage, type FleetSnapshot, type Loop, type MessagePriority, type MessageStatus, type MessageType, type Project, type PullRequestMerge, type Task } from "./domain.js";
import { recommendModel } from "./models.js";

export class FleetStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
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
      CREATE TABLE IF NOT EXISTS agent_sessions (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        attached_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_replies (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT
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

  queueAgentReply(agentId: string, text: string): AgentReply {
    const context = this.getAgentContext(agentId);
    if (!["provisioning", "running", "waiting"].includes(context.agent.status)) {
      throw new Error(`Agent ${agentId} is not active; cannot deliver a reply from ${context.agent.status}`);
    }
    const reply: AgentReply = { id: randomUUID(), agentId, text, status: "queued", createdAt: now(), deliveredAt: null };
    this.database.prepare(
      "INSERT INTO agent_replies (id, agent_id, text, status, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(reply.id, reply.agentId, reply.text, reply.status, reply.createdAt, reply.deliveredAt);
    this.addEvent("agent", agentId, "reply_queued", { replyId: reply.id, text });
    return reply;
  }

  listQueuedAgentReplies(agentId: string): AgentReply[] {
    const rows = this.database.prepare(
      "SELECT id, agent_id AS agentId, text, status, created_at AS createdAt, delivered_at AS deliveredAt FROM agent_replies WHERE agent_id = ? AND status = 'queued' ORDER BY created_at",
    ).all(agentId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapAgentReply(row));
  }

  markAgentReplyDelivered(replyId: string): AgentReply {
    const deliveredAt = now();
    this.database.prepare("UPDATE agent_replies SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'queued'").run(deliveredAt, replyId);
    const row = this.database.prepare(
      "SELECT id, agent_id AS agentId, text, status, created_at AS createdAt, delivered_at AS deliveredAt FROM agent_replies WHERE id = ?",
    ).get(replyId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown agent reply: ${replyId}`);
    return this.mapAgentReply(row);
  }

  attachAgentSession(agentId: string, sessionId: string, startedAt: string): void {
    this.requireAgent(agentId);
    this.database.prepare(
      "INSERT INTO agent_sessions (agent_id, session_id, started_at, attached_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET session_id = excluded.session_id, started_at = excluded.started_at, attached_at = excluded.attached_at",
    ).run(agentId, sessionId, startedAt, now());
    this.addEvent("agent", agentId, "session_attached", { sessionId, startedAt });
  }

  clearAgentSession(agentId: string): void {
    this.requireAgent(agentId);
    const session = this.database.prepare("SELECT session_id AS sessionId FROM agent_sessions WHERE agent_id = ?").get(agentId) as { sessionId?: string } | undefined;
    this.database.prepare("DELETE FROM agent_sessions WHERE agent_id = ?").run(agentId);
    if (session?.sessionId) this.addEvent("agent", agentId, "session_detached", { sessionId: session.sessionId });
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

  recordPullRequestMerge(agentId: string, details: Omit<PullRequestMerge, "agentId" | "taskId" | "detectedAt">): { merge: PullRequestMerge; agent: Agent; task: Task; taskCompleted: boolean } | null {
    const context = this.getAgentContext(agentId);
    if (!context.agent.branch || context.agent.branch !== details.headRefName) {
      throw new Error(`Pull request head branch does not match agent ${agentId}`);
    }
    if (["completed", "cancelled", "failed"].includes(context.agent.status)) return null;
    const existing = this.database.prepare("SELECT 1 FROM pull_request_merges WHERE agent_id = ?").get(agentId);
    if (existing) return null;

    const detectedAt = now();
    const merge: PullRequestMerge = { agentId, taskId: context.task.id, detectedAt, ...details };
    this.database.exec("BEGIN");
    try {
      this.database.prepare(`
        INSERT INTO pull_request_merges (agent_id, task_id, number, url, head_ref_name, base_ref_name, merged_at, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(merge.agentId, merge.taskId, merge.number, merge.url, merge.headRefName, merge.baseRefName, merge.mergedAt, merge.detectedAt);
      this.database.prepare("UPDATE agents SET status = 'completed' WHERE id = ?").run(agentId);
      this.addEvent("agent", agentId, "completed_from_pull_request_merge", merge);
      const remaining = this.database.prepare(`
        SELECT 1 FROM agents WHERE task_id = ? AND id <> ? AND status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1
      `).get(context.task.id, agentId);
      const taskCompleted = !remaining;
      if (taskCompleted) {
        this.database.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(context.task.id);
        this.addEvent("task", context.task.id, "completed_from_pull_request_merge", { agentId, pullRequest: merge });
      } else {
        this.database.prepare("UPDATE agents SET status = 'waiting' WHERE task_id = ? AND id <> ? AND status IN ('requested', 'provisioning', 'running')").run(context.task.id, agentId);
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

  getProject(projectId: string): Project {
    const row = this.database.prepare(
      "SELECT id, name, root_path AS rootPath, created_at AS createdAt FROM projects WHERE id = ?",
    ).get(projectId) as unknown as Project | undefined;
    if (!row) throw new Error(`Unknown project: ${projectId}`);
    return row;
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
      recentActivity: this.listRecentActivity(),
    };
  }

  listRecentActivity(limit = 10): FleetActivity[] {
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT
        e.id,
        e.entity_type AS entityType,
        e.entity_id AS entityId,
        e.event_type AS eventType,
        e.payload,
        e.created_at AS createdAt,
        COALESCE(project_direct.name, project_related.name) AS projectName,
        COALESCE(agent_direct.role, agent_related.role) AS agentRole,
        COALESCE(task_direct.title, task_related.title) AS taskTitle
      FROM events e
      LEFT JOIN projects project_direct
        ON e.entity_type = 'project' AND project_direct.id = e.entity_id
      LEFT JOIN tasks task_direct
        ON e.entity_type = 'task' AND task_direct.id = e.entity_id
      LEFT JOIN agents agent_direct
        ON e.entity_type = 'agent' AND agent_direct.id = e.entity_id
      LEFT JOIN messages message_direct
        ON e.entity_type = 'message' AND message_direct.id = e.entity_id
      LEFT JOIN agents agent_related
        ON agent_related.id = message_direct.agent_id
      LEFT JOIN tasks task_related
        ON task_related.id = COALESCE(task_direct.id, agent_direct.task_id, message_direct.task_id, agent_related.task_id)
      LEFT JOIN loops loop_direct
        ON e.entity_type = 'loop' AND loop_direct.id = e.entity_id
      LEFT JOIN projects project_related
        ON project_related.id = COALESCE(task_direct.project_id, task_related.project_id, loop_direct.project_id)
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapActivity(row));
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
      SET status = 'provisioning', branch = ?, worktree_path = ?, terminal_title = ?
      WHERE id = ?
    `).run(details.branch, details.worktreePath, details.terminalTitle, agentId);
    this.addEvent("agent", agentId, "provisioned", details);
    return { ...context.agent, status: "provisioning", ...details };
  }

  updateAgentStatus(agentId: string, status: AgentStatus, message?: string): Agent {
    if (!AGENT_STATUSES.includes(status)) throw new Error(`Unknown agent status: ${status}`);
    const context = this.getAgentContext(agentId);
    this.database.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, agentId);
    const taskStatus = status === "running" ? "running" : status === "completed" ? "review" : status === "failed" ? "failed" : null;
    if (taskStatus) this.database.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(taskStatus, context.task.id);
    this.addEvent("agent", agentId, "status", { status, message: message ?? null });
    if (message) {
      this.sendMessage({
        agentId,
        taskId: context.task.id,
        type: status === "completed" ? "completed" : status === "failed" ? "blocked" : "info",
        priority: status === "failed" ? "high" : "normal",
        text: message,
      });
    }
    return { ...context.agent, status };
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

  private mapAgentReply(row: Record<string, unknown>): AgentReply {
    return {
      id: String(row.id),
      agentId: String(row.agentId),
      text: String(row.text),
      status: String(row.status) as AgentReply["status"],
      createdAt: String(row.createdAt),
      deliveredAt: row.deliveredAt ? String(row.deliveredAt) : null,
    };
  }

  private mapActivity(row: Record<string, unknown>): FleetActivity {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(row.payload));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
    return {
      id: String(row.id),
      entityType: String(row.entityType),
      entityId: String(row.entityId),
      eventType: String(row.eventType),
      payload,
      createdAt: String(row.createdAt),
      projectName: row.projectName ? String(row.projectName) : null,
      agentRole: row.agentRole ? String(row.agentRole) : null,
      taskTitle: row.taskTitle ? String(row.taskTitle) : null,
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
