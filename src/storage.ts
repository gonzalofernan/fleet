import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AGENT_STATUSES,
  defaultTaskSpec,
  profileForTaskKind,
  type Agent,
  type AgentContext,
  type AgentReply,
  type AgentStatus,
  type Decision,
  type DeliveryMode,
  type FleetActivity,
  type FleetMessage,
  type FleetSnapshot,
  type Loop,
  type LoopRun,
  type LoopRunStatus,
  type MessageClaim,
  type MessagePriority,
  type MessageStatus,
  type MessageType,
  type ProcessRuntime,
  type Project,
  type PullRequestMerge,
  type ReplyClaim,
  type RuntimeKind,
  type RuntimeLaunchConfig,
  type RuntimeStatus,
  type Task,
  type TaskAttempt,
  type TaskAttemptStatus,
  type TaskKind,
  type TaskSpec,
  type TaskStatus,
} from "./domain.js";
import { recommendModel } from "./models.js";
import { assertAgentTransition, assertAttemptTransition, assertLoopRunTransition, assertRuntimeTransition, assertTaskTransition } from "./state-machine.js";

const TERMINAL_AGENT_STATUSES = new Set<AgentStatus>(["completed", "failed", "cancelled"]);
const ACTIVE_RUNTIME_STATUSES: RuntimeStatus[] = ["starting", "running", "cancelling"];
const MAX_DELIVERY_ATTEMPTS = 5;

export class FleetStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.createBaseSchema();
    this.runMigrations();
  }

  schemaVersion(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
    return Number(row.version);
  }

  addProject(name: string, rootPath: string): Project {
    const project: Project = { id: randomUUID(), name, rootPath, createdAt: now() };
    this.database.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)")
      .run(project.id, project.name, project.rootPath, project.createdAt);
    this.addEvent("project", project.id, "created", { name, rootPath });
    return project;
  }

  createTask(projectId: string, title: string, specOverrides: Partial<TaskSpec> = {}): Task {
    this.requireProject(projectId);
    const createdAt = now();
    const task: Task = {
      id: randomUUID(),
      projectId,
      title,
      status: "pending",
      spec: defaultTaskSpec(title, specOverrides),
      createdAt,
      updatedAt: createdAt,
    };
    this.database.prepare(
      "INSERT INTO tasks (id, project_id, title, status, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(task.id, task.projectId, task.title, task.status, JSON.stringify(task.spec), task.createdAt, task.updatedAt);
    this.addEvent("task", task.id, "created", { projectId, title, spec: task.spec });
    return task;
  }

  updateTaskStatus(taskId: string, status: TaskStatus, reason?: string): Task {
    const task = this.getTask(taskId);
    assertTaskTransition(task.status, status);
    if (task.status === status) return task;
    const updatedAt = now();
    this.database.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, taskId);
    this.addEvent("task", taskId, "status", { from: task.status, status, reason: reason ?? null });
    return { ...task, status, updatedAt };
  }

  requestAgent(taskId: string, role: string, provider = "codex", model = recommendModel(role), executionProfile?: string): Agent {
    const task = this.getTask(taskId);
    const createdAt = now();
    const agent: Agent = {
      id: randomUUID(),
      taskId,
      role,
      provider,
      model,
      executionProfile: executionProfile ?? task.spec.executionProfile,
      status: "requested",
      branch: null,
      worktreePath: null,
      terminalTitle: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.database.prepare(`
      INSERT INTO agents (id, task_id, role, provider, model, execution_profile, status, branch, worktree_path, terminal_title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agent.id, agent.taskId, agent.role, agent.provider, agent.model, agent.executionProfile, agent.status,
      agent.branch, agent.worktreePath, agent.terminalTitle, agent.createdAt, agent.updatedAt);
    this.addEvent("agent", agent.id, "requested", { taskId, role, provider, model, executionProfile: agent.executionProfile });
    return agent;
  }

  provisionAgent(agentId: string, details: { branch: string; worktreePath: string; terminalTitle: string }): Agent {
    const context = this.getAgentContext(agentId);
    assertAgentTransition(context.agent.status, "provisioning");
    const updatedAt = now();
    this.database.prepare(`
      UPDATE agents SET status = 'provisioning', branch = ?, worktree_path = ?, terminal_title = ?, updated_at = ? WHERE id = ?
    `).run(details.branch, details.worktreePath, details.terminalTitle, updatedAt, agentId);
    this.addEvent("agent", agentId, "provisioned", details);
    return { ...context.agent, status: "provisioning", updatedAt, ...details };
  }

  updateAgentStatus(agentId: string, status: AgentStatus, message?: string): Agent {
    if (!AGENT_STATUSES.includes(status)) throw new Error(`Unknown agent status: ${status}`);
    const context = this.getAgentContext(agentId);
    assertAgentTransition(context.agent.status, status);
    if (context.agent.status === status) return context.agent;
    const updatedAt = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE agents SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, agentId);
      this.updateTaskFromAgent(context.task, agentId, status, updatedAt);
      this.updateAttemptFromAgent(agentId, status, message);
      if (TERMINAL_AGENT_STATUSES.has(status)) {
        this.database.prepare(`
          UPDATE runtimes SET status = 'cancelling', updated_at = ?
          WHERE owner_id = ? AND status IN ('starting', 'running')
        `).run(updatedAt, agentId);
        this.database.prepare(`
          UPDATE agent_replies SET status = 'discarded', last_error = 'Agent reached a terminal state'
          WHERE agent_id = ? AND status IN ('queued', 'claimed')
        `).run(agentId);
        this.database.prepare(`
          UPDATE messages SET status = 'discarded', reminder_at = NULL, claim_token = NULL, claimed_by = NULL, claimed_at = NULL,
            last_error = COALESCE(last_error, 'Agent reached a terminal state before this message was resolved')
          WHERE agent_id = ? AND status IN ('unread', 'claimed', 'delivered', 'acknowledged')
        `).run(agentId);
        this.database.prepare(`
          UPDATE decisions SET status = 'cancelled', resolution = 'Agent reached a terminal state', decided_by = 'fleet', resolved_at = ?
          WHERE agent_id = ? AND status = 'pending'
        `).run(updatedAt, agentId);
      }
      this.addEvent("agent", agentId, "status", { from: context.agent.status, status, message: message ?? null });
      if (message) {
        this.sendMessageInternal({
          agentId,
          taskId: context.task.id,
          attemptId: context.attempt?.id ?? null,
          type: status === "completed" ? "completed" : status === "failed" ? "blocked" : "info",
          priority: status === "failed" ? "high" : "normal",
          text: message,
          allowTerminalAgent: true,
          dedupeKey: `agent-status:${status}:${updatedAt}`,
        });
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { ...context.agent, status, updatedAt };
  }

  cancelAgent(agentId: string, reason: string): Agent {
    const context = this.getAgentContext(agentId);
    if (context.agent.status === "cancelled") return context.agent;
    if (TERMINAL_AGENT_STATUSES.has(context.agent.status)) {
      throw new Error(`Agent ${agentId} is already terminal: ${context.agent.status}`);
    }
    return this.updateAgentStatus(agentId, "cancelled", reason);
  }

  createTaskAttempt(agentId: string): TaskAttempt {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const context = this.getAgentContext(agentId);
      if (!["requested", "provisioning"].includes(context.agent.status)) {
        throw new Error(`Agent ${agentId} cannot start an attempt from ${context.agent.status}`);
      }
      const active = this.database.prepare(`
        SELECT id FROM task_attempts WHERE agent_id = ? AND status IN ('queued', 'starting', 'running', 'waiting') LIMIT 1
      `).get(agentId) as { id: string } | undefined;
      if (active) throw new Error(`Agent ${agentId} already has active attempt ${active.id}`);
      const row = this.database.prepare("SELECT COALESCE(MAX(attempt_number), 0) AS value FROM task_attempts WHERE task_id = ?")
        .get(context.task.id) as { value: number };
      const createdAt = now();
      const attempt: TaskAttempt = {
        id: randomUUID(), taskId: context.task.id, agentId, attemptNumber: Number(row.value) + 1,
        status: "queued", runtimeId: null, startedAt: null, endedAt: null, failure: null,
        createdAt, updatedAt: createdAt,
      };
      this.database.prepare(`
        INSERT INTO task_attempts (id, task_id, agent_id, attempt_number, status, runtime_id, started_at, ended_at, failure, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(attempt.id, attempt.taskId, attempt.agentId, attempt.attemptNumber, attempt.status, attempt.runtimeId,
        attempt.startedAt, attempt.endedAt, attempt.failure, attempt.createdAt, attempt.updatedAt);
      this.addEvent("attempt", attempt.id, "created", { taskId: attempt.taskId, agentId, attemptNumber: attempt.attemptNumber });
      this.database.exec("COMMIT");
      return attempt;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  bindAttemptRuntime(attemptId: string, runtimeId: string): TaskAttempt {
    const attempt = this.getAttempt(attemptId);
    assertAttemptTransition(attempt.status, "starting");
    const updatedAt = now();
    this.database.prepare("UPDATE task_attempts SET runtime_id = ?, status = 'starting', updated_at = ? WHERE id = ?")
      .run(runtimeId, updatedAt, attemptId);
    this.addEvent("attempt", attemptId, "runtime_bound", { runtimeId });
    return { ...attempt, runtimeId, status: "starting", updatedAt };
  }

  transitionAttempt(attemptId: string, status: TaskAttemptStatus, failure?: string): TaskAttempt {
    const attempt = this.getAttempt(attemptId);
    assertAttemptTransition(attempt.status, status);
    if (attempt.status === status) return attempt;
    const updatedAt = now();
    const startedAt = status === "running" && !attempt.startedAt ? updatedAt : attempt.startedAt;
    const endedAt = ["succeeded", "failed", "cancelled"].includes(status) ? updatedAt : attempt.endedAt;
    this.database.prepare(`
      UPDATE task_attempts SET status = ?, started_at = ?, ended_at = ?, failure = ?, updated_at = ? WHERE id = ?
    `).run(status, startedAt, endedAt, failure ?? attempt.failure, updatedAt, attemptId);
    this.addEvent("attempt", attemptId, "status", { from: attempt.status, status, failure: failure ?? null });
    return { ...attempt, status, startedAt, endedAt, failure: failure ?? attempt.failure, updatedAt };
  }

  getAttempt(attemptId: string): TaskAttempt {
    const row = this.database.prepare(this.attemptSelect("WHERE id = ?")).get(attemptId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown task attempt: ${attemptId}`);
    return this.mapAttempt(row);
  }

  getLatestAttemptForAgent(agentId: string): TaskAttempt | null {
    const row = this.database.prepare(this.attemptSelect("WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"))
      .get(agentId) as Record<string, unknown> | undefined;
    return row ? this.mapAttempt(row) : null;
  }

  createRuntime(details: {
    kind: RuntimeKind;
    ownerId?: string | null;
    attemptId?: string | null;
    workspaceKey: string;
    provider: string;
    model: string;
    executionProfile: string;
    workingDirectory: string;
    launchConfig: RuntimeLaunchConfig;
  }): ProcessRuntime {
    const createdAt = now();
    const id = randomUUID();
    const ownerId = details.ownerId ?? null;
    const attemptId = details.attemptId ?? null;
    const singletonKey = details.kind === "captain" ? `captain:${normalizeKey(details.workspaceKey)}` : `${details.kind}:${ownerId ?? id}`;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT id FROM runtimes WHERE singleton_key = ? AND status IN ('starting', 'running', 'cancelling') LIMIT 1
      `).get(singletonKey) as { id: string } | undefined;
      if (existing) throw new Error(`An active ${details.kind} runtime already exists: ${existing.id}`);
      if (attemptId) {
        const attempt = this.getAttempt(attemptId);
        if (ownerId !== attempt.agentId) throw new Error(`Runtime owner ${ownerId ?? "none"} does not match attempt agent ${attempt.agentId}`);
        assertAttemptTransition(attempt.status, "starting");
      }
      this.database.prepare(`
        INSERT INTO runtimes (
          id, kind, owner_id, attempt_id, workspace_key, singleton_key, provider, model, execution_profile,
          working_directory, status, supervisor_pid, child_pid, session_id, heartbeat_at, started_at, ended_at,
          exit_code, last_error, launch_config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
      `).run(id, details.kind, ownerId, attemptId, details.workspaceKey, singletonKey, details.provider, details.model,
        details.executionProfile, details.workingDirectory, JSON.stringify(details.launchConfig), createdAt, createdAt);
      if (attemptId) {
        this.database.prepare("UPDATE task_attempts SET runtime_id = ?, status = 'starting', updated_at = ? WHERE id = ? AND status = 'queued'")
          .run(id, createdAt, attemptId);
        this.addEvent("attempt", attemptId, "runtime_bound", { runtimeId: id });
      }
      this.addEvent("runtime", id, "created", { kind: details.kind, ownerId, attemptId, workspaceKey: details.workspaceKey });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getRuntime(id);
  }

  startRuntime(runtimeId: string, supervisorPid: number): ProcessRuntime {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const runtime = this.getRuntime(runtimeId);
      assertRuntimeTransition(runtime.status, "running");
      const timestamp = now();
      const result = this.database.prepare(`
        UPDATE runtimes SET status = 'running', supervisor_pid = ?, started_at = ?, heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND status = 'starting' AND supervisor_pid IS NULL
      `).run(supervisorPid, timestamp, timestamp, timestamp, runtimeId);
      if (Number(result.changes) !== 1) throw new Error(`Runtime ${runtimeId} was already claimed by another supervisor`);
      if (runtime.attemptId) this.transitionAttempt(runtime.attemptId, "running");
      this.addEvent("runtime", runtimeId, "started", { supervisorPid });
      this.database.exec("COMMIT");
      return { ...runtime, status: "running", supervisorPid, startedAt: timestamp, heartbeatAt: timestamp, updatedAt: timestamp };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  setRuntimeChild(runtimeId: string, childPid: number): ProcessRuntime {
    const runtime = this.getRuntime(runtimeId);
    const updatedAt = now();
    this.database.prepare("UPDATE runtimes SET child_pid = ?, updated_at = ? WHERE id = ?").run(childPid, updatedAt, runtimeId);
    this.addEvent("runtime", runtimeId, "child_started", { childPid });
    return { ...runtime, childPid, updatedAt };
  }

  attachRuntimeSession(runtimeId: string, sessionId: string): ProcessRuntime {
    const runtime = this.getRuntime(runtimeId);
    const updatedAt = now();
    this.database.prepare("UPDATE runtimes SET session_id = ?, updated_at = ? WHERE id = ?").run(sessionId, updatedAt, runtimeId);
    if (runtime.kind === "worker" && runtime.ownerId) this.attachAgentSession(runtime.ownerId, sessionId, runtime.startedAt ?? runtime.createdAt);
    this.addEvent("runtime", runtimeId, "session_attached", { sessionId });
    return { ...runtime, sessionId, updatedAt };
  }

  heartbeatRuntime(runtimeId: string, supervisorPid: number): ProcessRuntime {
    const runtime = this.getRuntime(runtimeId);
    if (!["starting", "running", "cancelling"].includes(runtime.status)) return runtime;
    if (runtime.supervisorPid !== null && runtime.supervisorPid !== supervisorPid) {
      throw new Error(`Runtime ${runtimeId} is owned by supervisor PID ${runtime.supervisorPid}`);
    }
    const heartbeatAt = now();
    this.database.prepare("UPDATE runtimes SET supervisor_pid = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?")
      .run(supervisorPid, heartbeatAt, heartbeatAt, runtimeId);
    return { ...runtime, supervisorPid, heartbeatAt, updatedAt: heartbeatAt };
  }

  requestRuntimeCancellation(runtimeId: string, reason: string): ProcessRuntime {
    const runtime = this.getRuntime(runtimeId);
    if (["cancelled", "stopped", "failed"].includes(runtime.status)) return runtime;
    assertRuntimeTransition(runtime.status, "cancelling");
    const updatedAt = now();
    this.database.prepare("UPDATE runtimes SET status = 'cancelling', last_error = ?, updated_at = ? WHERE id = ?")
      .run(reason, updatedAt, runtimeId);
    this.addEvent("runtime", runtimeId, "cancellation_requested", { reason });
    return { ...runtime, status: "cancelling", lastError: reason, updatedAt };
  }

  finishRuntime(runtimeId: string, status: "stopped" | "failed" | "cancelled", exitCode: number | null, error?: string): ProcessRuntime {
    const runtime = this.getRuntime(runtimeId);
    if (["stopped", "failed", "cancelled"].includes(runtime.status)) return runtime;
    assertRuntimeTransition(runtime.status, status);
    const endedAt = now();
    this.database.prepare(`
      UPDATE runtimes SET status = ?, exit_code = ?, last_error = ?, ended_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?
    `).run(status, exitCode, error ?? runtime.lastError, endedAt, endedAt, endedAt, runtimeId);
    if (runtime.kind === "worker" && runtime.ownerId) this.clearAgentSession(runtime.ownerId);
    this.addEvent("runtime", runtimeId, "finished", { status, exitCode, error: error ?? null });
    return { ...runtime, status, exitCode, lastError: error ?? runtime.lastError, endedAt, heartbeatAt: endedAt, updatedAt: endedAt };
  }

  reapStaleRuntimes(staleBefore: string): ProcessRuntime[] {
    const rows = this.database.prepare(`
      SELECT id FROM runtimes
      WHERE status IN ('starting', 'running', 'cancelling')
        AND COALESCE(heartbeat_at, created_at) < ?
    `).all(staleBefore) as Array<{ id: string }>;
    return rows.map(({ id }) => this.finishRuntime(id, "failed", null, "Runtime heartbeat expired"));
  }

  getRuntime(runtimeId: string): ProcessRuntime {
    const row = this.database.prepare(this.runtimeSelect("WHERE id = ?")).get(runtimeId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown runtime: ${runtimeId}`);
    return this.mapRuntime(row);
  }

  findActiveRuntimeForAgent(agentId: string): ProcessRuntime | null {
    const row = this.database.prepare(this.runtimeSelect(`
      WHERE kind = 'worker' AND owner_id = ? AND status IN ('starting', 'running', 'cancelling') ORDER BY created_at DESC LIMIT 1
    `)).get(agentId) as Record<string, unknown> | undefined;
    return row ? this.mapRuntime(row) : null;
  }

  findActiveCaptainRuntime(workspaceKey: string): ProcessRuntime | null {
    const row = this.database.prepare(this.runtimeSelect(`
      WHERE kind = 'captain' AND workspace_key = ? AND status IN ('starting', 'running', 'cancelling') ORDER BY created_at DESC LIMIT 1
    `)).get(workspaceKey) as Record<string, unknown> | undefined;
    return row ? this.mapRuntime(row) : null;
  }

  sendMessage(details: {
    agentId?: string | null;
    taskId?: string | null;
    attemptId?: string | null;
    type: MessageType;
    priority?: MessagePriority;
    text: string;
    requiresHuman?: boolean;
    dedupeKey?: string | null;
    correlationId?: string | null;
    allowTerminalAgent?: boolean;
  }): FleetMessage {
    return this.sendMessageInternal(details);
  }

  claimMessages(consumerId: string, limit = 20, leaseMs = 30_000): MessageClaim[] {
    const claimed: MessageClaim[] = [];
    const asOf = new Date();
    const expiredAt = new Date(asOf.getTime() - leaseMs).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE messages SET status = CASE WHEN delivery_attempts >= ? THEN 'failed' ELSE 'unread' END,
          claim_token = NULL, claimed_by = NULL, claimed_at = NULL,
          last_error = CASE WHEN delivery_attempts >= ? THEN 'Delivery claim expired too many times' ELSE last_error END
        WHERE status = 'claimed' AND claimed_at < ?
      `).run(MAX_DELIVERY_ATTEMPTS, MAX_DELIVERY_ATTEMPTS, expiredAt);
      const ids = this.database.prepare(`
        SELECT id FROM messages WHERE status = 'unread' AND available_at <= ?
        ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at LIMIT ?
      `).all(asOf.toISOString(), limit) as Array<{ id: string }>;
      for (const { id } of ids) {
        const token = randomUUID();
        const result = this.database.prepare(`
          UPDATE messages SET status = 'claimed', claim_token = ?, claimed_by = ?, claimed_at = ?, delivery_attempts = delivery_attempts + 1
          WHERE id = ? AND status = 'unread'
        `).run(token, consumerId, asOf.toISOString(), id);
        if (Number(result.changes) === 1) claimed.push({ message: this.requireMessage(id), token });
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return claimed;
  }

  acknowledgeMessageClaim(id: string, token: string): FleetMessage {
    const message = this.requireMessage(id);
    const deliveredAt = now();
    const reminderAt = message.requiresHuman ? nextReminder(message.priority) : null;
    const result = this.database.prepare(`
      UPDATE messages SET status = 'delivered', delivered_at = ?, reminder_at = ?, claim_token = NULL, claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND status = 'claimed' AND claim_token = ?
    `).run(deliveredAt, reminderAt, id, token);
    if (Number(result.changes) !== 1) {
      const latest = this.requireMessage(id);
      if (["discarded", "resolved"].includes(latest.status)) return latest;
      throw new Error(`Message claim is no longer owned: ${id}`);
    }
    return this.requireMessage(id);
  }

  releaseMessageClaim(id: string, token: string, error: string, retryDelayMs = 1_000): FleetMessage {
    const message = this.requireMessage(id);
    const failed = message.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS;
    const availableAt = new Date(Date.now() + retryDelayMs).toISOString();
    const result = this.database.prepare(`
      UPDATE messages SET status = ?, available_at = ?, last_error = ?, claim_token = NULL, claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND status = 'claimed' AND claim_token = ?
    `).run(failed ? "failed" : "unread", availableAt, error, id, token);
    if (Number(result.changes) !== 1) {
      const latest = this.requireMessage(id);
      if (["discarded", "resolved"].includes(latest.status)) return latest;
      throw new Error(`Message claim is no longer owned: ${id}`);
    }
    return this.requireMessage(id);
  }

  markMessageDelivered(id: string): FleetMessage {
    const message = this.requireMessage(id);
    if (message.status === "delivered") return message;
    if (message.status !== "unread") throw new Error(`Message ${id} requires an outbox claim from ${message.status}`);
    const deliveredAt = now();
    const reminderAt = message.requiresHuman ? nextReminder(message.priority) : null;
    const result = this.database.prepare(`
      UPDATE messages SET status = 'delivered', delivered_at = ?, reminder_at = ? WHERE id = ? AND status = 'unread'
    `).run(deliveredAt, reminderAt, id);
    if (Number(result.changes) !== 1) throw new Error(`Message ${id} was claimed concurrently`);
    return this.requireMessage(id);
  }

  listMessages(status: MessageStatus | null = null): FleetMessage[] {
    const rows = status
      ? this.database.prepare(this.messageSelect("WHERE m.status = ?") + this.messageOrder()).all(status)
      : this.database.prepare(this.messageSelect() + " ORDER BY m.created_at").all();
    return (rows as Array<Record<string, unknown>>).map((row) => this.mapMessage(row));
  }

  listMessagesDueForReminder(asOf = new Date()): FleetMessage[] {
    const rows = this.database.prepare(this.messageSelect(`
      WHERE m.requires_human = 1 AND m.status IN ('delivered', 'acknowledged')
        AND m.reminder_at IS NOT NULL AND m.reminder_at <= ?
    `) + this.messageOrder()).all(asOf.toISOString()) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapMessage(row));
  }

  markMessageReminded(id: string): FleetMessage {
    const message = this.requireMessage(id);
    const remindedAt = now();
    const reminderAt = nextReminder(message.priority);
    const result = this.database.prepare(`
      UPDATE messages SET last_reminded_at = ?, reminder_at = ? WHERE id = ? AND status IN ('delivered', 'acknowledged')
    `).run(remindedAt, reminderAt, id);
    if (Number(result.changes) !== 1) throw new Error(`Message ${id} cannot be reminded from ${message.status}`);
    return this.requireMessage(id);
  }

  acknowledgeMessage(id: string): FleetMessage {
    const message = this.requireMessage(id);
    const reminderAt = message.requiresHuman ? message.reminderAt ?? nextReminder(message.priority) : null;
    this.database.prepare("UPDATE messages SET status = 'acknowledged', reminder_at = ? WHERE id = ? AND status IN ('delivered', 'unread')")
      .run(reminderAt, id);
    return this.requireMessage(id);
  }

  resolveMessage(id: string, resolution?: string, decidedBy = "captain"): FleetMessage {
    const message = this.requireMessage(id);
    if (message.requiresHuman && message.agentId) {
      const agent = this.getAgent(message.agentId);
      if (!TERMINAL_AGENT_STATUSES.has(agent.status)) {
        throw new Error(`Message ${id} belongs to active agent ${agent.id}; use a linked agent reply`);
      }
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE messages SET status = 'resolved', reminder_at = NULL WHERE id = ? AND status <> 'resolved'").run(id);
      if (message.decisionId) this.resolveDecisionInternal(message.decisionId, resolution ?? "Resolved without a linked worker reply", decidedBy);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.requireMessage(id);
  }

  snoozeMessage(id: string, minutes: number): FleetMessage {
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Snooze minutes must be positive");
    const reminderAt = new Date(Date.now() + minutes * 60_000).toISOString();
    this.database.prepare("UPDATE messages SET status = 'acknowledged', reminder_at = ? WHERE id = ? AND status <> 'resolved'")
      .run(reminderAt, id);
    return this.requireMessage(id);
  }

  queueAgentReply(agentId: string, text: string, replyToMessageId: string | null = null): AgentReply {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const context = this.getAgentContext(agentId);
      if (!["provisioning", "running", "waiting"].includes(context.agent.status)) {
        throw new Error(`Agent ${agentId} is not active; cannot deliver a reply from ${context.agent.status}`);
      }
      let decisionId: string | null = null;
      if (replyToMessageId) {
        const message = this.requireMessage(replyToMessageId);
        if (message.agentId !== agentId) throw new Error(`Message ${replyToMessageId} does not belong to agent ${agentId}`);
        if (["resolved", "discarded", "failed"].includes(message.status)) throw new Error(`Message ${replyToMessageId} is already ${message.status}`);
        decisionId = message.decisionId;
        const reminderAt = message.requiresHuman ? message.reminderAt ?? nextReminder(message.priority) : null;
        this.database.prepare(`
          UPDATE messages SET status = 'acknowledged', reminder_at = ? WHERE id = ? AND status IN ('delivered', 'unread')
        `).run(reminderAt, replyToMessageId);
      }
      const createdAt = now();
      const reply: AgentReply = {
        id: randomUUID(), agentId, text, status: "queued", replyToMessageId, decisionId,
        claimToken: null, claimedBy: null, claimedAt: null, availableAt: createdAt,
        deliveryAttempts: 0, lastError: null, createdAt, deliveredAt: null,
      };
      this.database.prepare(`
        INSERT INTO agent_replies (
          id, agent_id, text, status, reply_to_message_id, decision_id, claim_token, claimed_by, claimed_at,
          available_at, delivery_attempts, last_error, created_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(reply.id, reply.agentId, reply.text, reply.status, reply.replyToMessageId, reply.decisionId, reply.claimToken,
        reply.claimedBy, reply.claimedAt, reply.availableAt, reply.deliveryAttempts, reply.lastError, reply.createdAt, reply.deliveredAt);
      this.addEvent("agent", agentId, "reply_queued", { replyId: reply.id, replyToMessageId, decisionId });
      this.database.exec("COMMIT");
      return reply;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimAgentReplies(agentId: string, consumerId: string, limit = 20, leaseMs = 30_000): ReplyClaim[] {
    const claims: ReplyClaim[] = [];
    const timestamp = now();
    const expiredAt = new Date(Date.now() - leaseMs).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE agent_replies SET status = CASE WHEN delivery_attempts >= ? THEN 'failed' ELSE 'queued' END,
          claim_token = NULL, claimed_by = NULL, claimed_at = NULL,
          last_error = CASE WHEN delivery_attempts >= ? THEN 'Reply claim expired too many times' ELSE last_error END
        WHERE agent_id = ? AND status = 'claimed' AND claimed_at < ?
      `).run(MAX_DELIVERY_ATTEMPTS, MAX_DELIVERY_ATTEMPTS, agentId, expiredAt);
      const ids = this.database.prepare(`
        SELECT id FROM agent_replies WHERE agent_id = ? AND status = 'queued' AND available_at <= ? ORDER BY created_at LIMIT ?
      `).all(agentId, timestamp, limit) as Array<{ id: string }>;
      for (const { id } of ids) {
        const token = randomUUID();
        const result = this.database.prepare(`
          UPDATE agent_replies SET status = 'claimed', claim_token = ?, claimed_by = ?, claimed_at = ?, delivery_attempts = delivery_attempts + 1
          WHERE id = ? AND status = 'queued'
        `).run(token, consumerId, timestamp, id);
        if (Number(result.changes) === 1) claims.push({ reply: this.requireAgentReply(id), token });
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return claims;
  }

  acknowledgeAgentReplyClaim(replyId: string, token: string): AgentReply {
    const reply = this.requireAgentReply(replyId);
    const deliveredAt = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE agent_replies SET status = 'delivered', delivered_at = ?, claim_token = NULL, claimed_by = NULL, claimed_at = NULL
        WHERE id = ? AND status = 'claimed' AND claim_token = ?
      `).run(deliveredAt, replyId, token);
      if (Number(result.changes) !== 1) {
        const latest = this.requireAgentReply(replyId);
        if (latest.status === "discarded") {
          this.database.exec("COMMIT");
          return latest;
        }
        throw new Error(`Reply claim is no longer owned: ${replyId}`);
      }
      if (reply.replyToMessageId) {
        this.database.prepare("UPDATE messages SET status = 'resolved', reminder_at = NULL WHERE id = ?").run(reply.replyToMessageId);
      }
      if (reply.decisionId) this.resolveDecisionInternal(reply.decisionId, reply.text, "captain");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.requireAgentReply(replyId);
  }

  releaseAgentReplyClaim(replyId: string, token: string, error: string, retryDelayMs = 1_000): AgentReply {
    const reply = this.requireAgentReply(replyId);
    const failed = reply.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS;
    const availableAt = new Date(Date.now() + retryDelayMs).toISOString();
    const result = this.database.prepare(`
      UPDATE agent_replies SET status = ?, available_at = ?, last_error = ?, claim_token = NULL, claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND status = 'claimed' AND claim_token = ?
    `).run(failed ? "failed" : "queued", availableAt, error, replyId, token);
    if (Number(result.changes) !== 1) {
      const latest = this.requireAgentReply(replyId);
      if (latest.status === "discarded") return latest;
      throw new Error(`Reply claim is no longer owned: ${replyId}`);
    }
    return this.requireAgentReply(replyId);
  }

  listQueuedAgentReplies(agentId: string): AgentReply[] {
    const rows = this.database.prepare(this.replySelect("WHERE agent_id = ? AND status = 'queued' ORDER BY created_at"))
      .all(agentId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapAgentReply(row));
  }

  markAgentReplyDelivered(replyId: string): AgentReply {
    const reply = this.requireAgentReply(replyId);
    if (reply.status === "delivered") return reply;
    if (reply.status !== "queued") throw new Error(`Reply ${replyId} requires an outbox claim from ${reply.status}`);
    const token = randomUUID();
    const result = this.database.prepare(`
      UPDATE agent_replies SET status = 'claimed', claim_token = ?, claimed_by = 'legacy', claimed_at = ?, delivery_attempts = delivery_attempts + 1
      WHERE id = ? AND status = 'queued'
    `).run(token, now(), replyId);
    if (Number(result.changes) !== 1) throw new Error(`Reply ${replyId} was claimed concurrently`);
    return this.acknowledgeAgentReplyClaim(replyId, token);
  }

  listDecisions(status: "pending" | "resolved" | "cancelled" | null = null): Decision[] {
    const rows = status
      ? this.database.prepare(this.decisionSelect("WHERE status = ? ORDER BY created_at")).all(status)
      : this.database.prepare(this.decisionSelect("ORDER BY created_at")).all();
    return (rows as Array<Record<string, unknown>>).map((row) => this.mapDecision(row));
  }

  createLoop(
    title: string,
    schedule: string,
    projectId: string | null,
    directoryPath: string | null = null,
    options: { taskSpec?: Partial<TaskSpec>; role?: string; provider?: string; model?: string } = {},
  ): Loop {
    if (projectId) this.requireProject(projectId);
    const createdAt = now();
    const requestedSpec = options.taskSpec ?? {};
    const kind = requestedSpec.kind ?? "operations";
    const taskSpec = defaultTaskSpec(title, {
      ...requestedSpec,
      kind,
      deliveryMode: requestedSpec.deliveryMode ?? (kind === "coding" ? "git-pr" : "report-only"),
    });
    const loop: Loop = {
      id: randomUUID(), projectId, title, schedule, enabled: true, directoryPath, taskSpec,
      role: options.role ?? "researcher", provider: options.provider ?? "codex",
      model: options.model ?? recommendModel(options.role ?? "researcher"), lastScheduledAt: null,
      createdAt, updatedAt: createdAt,
    };
    this.database.prepare(`
      INSERT INTO loops (
        id, project_id, title, schedule, enabled, directory_path, task_spec_json, role, provider, model,
        last_scheduled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(loop.id, loop.projectId, loop.title, loop.schedule, Number(loop.enabled), loop.directoryPath,
      JSON.stringify(loop.taskSpec), loop.role, loop.provider, loop.model, loop.lastScheduledAt, loop.createdAt, loop.updatedAt);
    this.addEvent("loop", loop.id, "created", { title, schedule, projectId, directoryPath, taskSpec });
    return loop;
  }

  getLoop(loopId: string): Loop {
    const row = this.database.prepare(this.loopSelect("WHERE id = ?")).get(loopId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown loop: ${loopId}`);
    return this.mapLoop(row);
  }

  createLoopRun(loopId: string, scheduledFor = now()): LoopRun {
    const loop = this.getLoop(loopId);
    if (!loop.enabled) throw new Error(`Loop ${loopId} is disabled`);
    const run: LoopRun = {
      id: randomUUID(), loopId, taskId: null, status: "queued", scheduledFor,
      startedAt: null, endedAt: null, error: null, createdAt: now(),
    };
    this.database.prepare(`
      INSERT INTO loop_runs (id, loop_id, task_id, status, scheduled_for, started_at, ended_at, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.loopId, run.taskId, run.status, run.scheduledFor, run.startedAt, run.endedAt, run.error, run.createdAt);
    this.database.prepare("UPDATE loops SET last_scheduled_at = ?, updated_at = ? WHERE id = ?").run(scheduledFor, now(), loopId);
    this.addEvent("loop_run", run.id, "created", { loopId, scheduledFor });
    return run;
  }

  updateLoopRun(runId: string, status: LoopRunStatus, details: { taskId?: string | null; error?: string | null } = {}): LoopRun {
    const run = this.getLoopRun(runId);
    assertLoopRunTransition(run.status, status);
    if (run.status === status) return run;
    const timestamp = now();
    const startedAt = status === "running" && !run.startedAt ? timestamp : run.startedAt;
    const endedAt = ["completed", "failed", "cancelled"].includes(status) ? timestamp : run.endedAt;
    const taskId = details.taskId === undefined ? run.taskId : details.taskId;
    const error = details.error === undefined ? run.error : details.error;
    this.database.prepare(`
      UPDATE loop_runs SET status = ?, task_id = ?, started_at = ?, ended_at = ?, error = ? WHERE id = ?
    `).run(status, taskId, startedAt, endedAt, error, runId);
    this.addEvent("loop_run", runId, "status", { status, taskId, error });
    return { ...run, status, taskId, startedAt, endedAt, error };
  }

  getLoopRun(runId: string): LoopRun {
    const row = this.database.prepare(this.loopRunSelect("WHERE id = ?")).get(runId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown loop run: ${runId}`);
    return this.mapLoopRun(row);
  }

  findProjectByRoot(rootPath: string): Project | null {
    const row = this.database.prepare(this.projectSelect("WHERE root_path = ?")).get(rootPath) as Record<string, unknown> | undefined;
    return row ? this.mapProject(row) : null;
  }

  listProjects(): Project[] {
    return (this.database.prepare(this.projectSelect("ORDER BY created_at")).all() as Array<Record<string, unknown>>)
      .map((row) => this.mapProject(row));
  }

  getProject(projectId: string): Project {
    const row = this.database.prepare(this.projectSelect("WHERE id = ?")).get(projectId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown project: ${projectId}`);
    return this.mapProject(row);
  }

  getTask(taskId: string): Task {
    const row = this.database.prepare(this.taskSelect("WHERE id = ?")).get(taskId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown task: ${taskId}`);
    return this.mapTask(row);
  }

  getAgent(agentId: string): Agent {
    const row = this.database.prepare(this.agentSelect("WHERE id = ?")).get(agentId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown agent: ${agentId}`);
    return this.mapAgent(row);
  }

  getAgentContext(agentId: string): AgentContext {
    const agent = this.getAgent(agentId);
    const task = this.getTask(agent.taskId);
    return { agent, task, project: this.getProject(task.projectId), attempt: this.getLatestAttemptForAgent(agentId) };
  }

  findAgentByWorktree(worktreePath: string): Agent | null {
    const row = this.database.prepare(this.agentSelect("WHERE worktree_path = ?")).get(worktreePath) as Record<string, unknown> | undefined;
    return row ? this.mapAgent(row) : null;
  }

  recoverAgent(taskId: string, details: { branch: string; worktreePath: string; terminalTitle: string }): Agent {
    const task = this.getTask(taskId);
    const createdAt = now();
    const agent: Agent = {
      id: randomUUID(), taskId, role: "recovered", provider: "unknown", model: "unknown",
      executionProfile: task.spec.executionProfile, status: "unknown", branch: details.branch,
      worktreePath: details.worktreePath, terminalTitle: details.terminalTitle, createdAt, updatedAt: createdAt,
    };
    this.database.prepare(`
      INSERT INTO agents (id, task_id, role, provider, model, execution_profile, status, branch, worktree_path, terminal_title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agent.id, agent.taskId, agent.role, agent.provider, agent.model, agent.executionProfile, agent.status,
      agent.branch, agent.worktreePath, agent.terminalTitle, agent.createdAt, agent.updatedAt);
    this.addEvent("agent", agent.id, "recovered", details);
    return agent;
  }

  recordPullRequestMerge(agentId: string, details: Omit<PullRequestMerge, "agentId" | "taskId" | "detectedAt">): {
    merge: PullRequestMerge;
    agent: Agent;
    task: Task;
    taskCompleted: boolean;
  } | null {
    const context = this.getAgentContext(agentId);
    if (!context.agent.branch || context.agent.branch !== details.headRefName) {
      throw new Error(`Pull request head branch does not match agent ${agentId}`);
    }
    if (this.database.prepare("SELECT 1 FROM pull_request_merges WHERE agent_id = ?").get(agentId)) return null;
    const merge: PullRequestMerge = { agentId, taskId: context.task.id, detectedAt: now(), ...details };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO pull_request_merges (agent_id, task_id, number, url, head_ref_name, base_ref_name, merged_at, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(merge.agentId, merge.taskId, merge.number, merge.url, merge.headRefName, merge.baseRefName, merge.mergedAt, merge.detectedAt);
      if (!TERMINAL_AGENT_STATUSES.has(context.agent.status)) {
        this.database.prepare("UPDATE agents SET status = 'completed', updated_at = ? WHERE id = ?").run(merge.detectedAt, agentId);
      }
      const attempt = context.attempt;
      if (attempt && !["succeeded", "failed", "cancelled"].includes(attempt.status)) {
        this.database.prepare("UPDATE task_attempts SET status = 'succeeded', ended_at = ?, updated_at = ? WHERE id = ?")
          .run(merge.detectedAt, merge.detectedAt, attempt.id);
      }
      const remaining = this.database.prepare(`
        SELECT 1 FROM agents WHERE task_id = ? AND id <> ? AND status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1
      `).get(context.task.id, agentId);
      const taskCompleted = !remaining;
      if (taskCompleted && context.task.status !== "completed") {
        this.database.prepare("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ?").run(merge.detectedAt, context.task.id);
      }
      this.addEvent("agent", agentId, "pull_request_merge_recorded", { ...merge });
      if (taskCompleted) this.addEvent("task", context.task.id, "completed_from_pull_request_merge", { agentId, pullRequest: merge });
      this.database.exec("COMMIT");
      return {
        merge,
        agent: { ...context.agent, status: TERMINAL_AGENT_STATUSES.has(context.agent.status) ? context.agent.status : "completed" },
        task: { ...context.task, status: taskCompleted ? "completed" : context.task.status },
        taskCompleted,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  attachAgentSession(agentId: string, sessionId: string, startedAt: string): void {
    this.requireAgent(agentId);
    this.database.prepare(`
      INSERT INTO agent_sessions (agent_id, session_id, started_at, attached_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET session_id = excluded.session_id, started_at = excluded.started_at, attached_at = excluded.attached_at
    `).run(agentId, sessionId, startedAt, now());
    this.addEvent("agent", agentId, "session_attached", { sessionId, startedAt });
  }

  clearAgentSession(agentId: string): void {
    this.requireAgent(agentId);
    const session = this.database.prepare("SELECT session_id AS sessionId FROM agent_sessions WHERE agent_id = ?")
      .get(agentId) as { sessionId?: string } | undefined;
    this.database.prepare("DELETE FROM agent_sessions WHERE agent_id = ?").run(agentId);
    if (session?.sessionId) this.addEvent("agent", agentId, "session_detached", { sessionId: session.sessionId });
  }

  snapshot(): FleetSnapshot {
    return {
      projects: this.listProjects(),
      tasks: (this.database.prepare(this.taskSelect("ORDER BY created_at")).all() as Array<Record<string, unknown>>).map((row) => this.mapTask(row)),
      agents: (this.database.prepare(this.agentSelect("ORDER BY created_at")).all() as Array<Record<string, unknown>>).map((row) => this.mapAgent(row)),
      attempts: (this.database.prepare(this.attemptSelect("ORDER BY created_at")).all() as Array<Record<string, unknown>>).map((row) => this.mapAttempt(row)),
      runtimes: (this.database.prepare(this.runtimeSelect("ORDER BY created_at")).all() as Array<Record<string, unknown>>).map((row) => this.mapRuntime(row)),
      loops: (this.database.prepare(this.loopSelect("ORDER BY created_at")).all() as Array<Record<string, unknown>>).map((row) => this.mapLoop(row)),
      loopRuns: (this.database.prepare(this.loopRunSelect("ORDER BY created_at")).all() as Array<Record<string, unknown>>).map((row) => this.mapLoopRun(row)),
      decisions: this.listDecisions(),
      messages: this.listMessages(),
      recentActivity: this.listRecentActivity(30),
    };
  }

  listRecentActivity(limit = 30): FleetActivity[] {
    const events = this.database.prepare(`
      SELECT id, entity_type AS entityType, entity_id AS entityId, event_type AS eventType, payload, created_at AS createdAt
      FROM events ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return events.map((row) => {
      const entityType = String(row.entityType);
      const entityId = String(row.entityId);
      let projectName: string | null = null;
      let agentRole: string | null = null;
      let taskTitle: string | null = null;
      try {
        if (entityType === "agent") {
          const context = this.getAgentContext(entityId);
          projectName = context.project.name;
          agentRole = context.agent.role;
          taskTitle = context.task.title;
        } else if (entityType === "task") {
          const task = this.getTask(entityId);
          projectName = this.getProject(task.projectId).name;
          taskTitle = task.title;
        } else if (entityType === "message") {
          const message = this.requireMessage(entityId);
          projectName = message.projectName;
          agentRole = message.agentRole;
          taskTitle = message.taskTitle;
        } else if (entityType === "project") {
          projectName = this.getProject(entityId).name;
        } else if (entityType === "attempt") {
          const attempt = this.getAttempt(entityId);
          const context = this.getAgentContext(attempt.agentId);
          projectName = context.project.name;
          agentRole = context.agent.role;
          taskTitle = context.task.title;
        }
      } catch {
        // Historical events may point at records removed by an older Fleet build.
      }
      return {
        id: String(row.id), entityType, entityId, eventType: String(row.eventType),
        payload: safeJson<Record<string, unknown>>(String(row.payload), {}), createdAt: String(row.createdAt),
        projectName, agentRole, taskTitle,
      };
    });
  }

  close(): void {
    this.database.close();
  }

  private createBaseSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, root_path TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, status TEXT NOT NULL,
        spec_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'gpt-5.6-luna', execution_profile TEXT NOT NULL DEFAULT 'worker-coding', status TEXT NOT NULL,
        branch TEXT, worktree_path TEXT, terminal_title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, event_type TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS loops (
        id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), title TEXT NOT NULL, schedule TEXT NOT NULL,
        enabled INTEGER NOT NULL, directory_path TEXT, task_spec_json TEXT NOT NULL DEFAULT '{}', role TEXT NOT NULL DEFAULT 'researcher',
        provider TEXT NOT NULL DEFAULT 'codex', model TEXT NOT NULL DEFAULT 'gpt-5.6-luna', last_scheduled_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id), task_id TEXT REFERENCES tasks(id), attempt_id TEXT,
        type TEXT NOT NULL, priority TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
        requires_human INTEGER NOT NULL DEFAULT 0, dedupe_key TEXT, decision_id TEXT, correlation_id TEXT,
        claim_token TEXT, claimed_by TEXT, claimed_at TEXT, available_at TEXT NOT NULL DEFAULT '', delivery_attempts INTEGER NOT NULL DEFAULT 0,
        delivered_at TEXT, last_error TEXT, reminder_at TEXT, last_reminded_at TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS pull_request_merges (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id), task_id TEXT NOT NULL REFERENCES tasks(id), number INTEGER NOT NULL,
        url TEXT NOT NULL, head_ref_name TEXT NOT NULL, base_ref_name TEXT NOT NULL, merged_at TEXT NOT NULL, detected_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_sessions (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id), session_id TEXT NOT NULL, started_at TEXT NOT NULL, attached_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_replies (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), text TEXT NOT NULL, status TEXT NOT NULL,
        reply_to_message_id TEXT, decision_id TEXT, claim_token TEXT, claimed_by TEXT, claimed_at TEXT,
        available_at TEXT NOT NULL DEFAULT '', delivery_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        created_at TEXT NOT NULL, delivered_at TEXT
      ) STRICT;
    `);
  }

  private runMigrations(): void {
    this.applyMigration(1, "legacy compatibility", () => {
      this.addColumnIfMissing("agents", "branch", "TEXT");
      this.addColumnIfMissing("agents", "worktree_path", "TEXT");
      this.addColumnIfMissing("agents", "terminal_title", "TEXT");
      this.addColumnIfMissing("agents", "model", "TEXT NOT NULL DEFAULT 'gpt-5.6-luna'");
      this.addColumnIfMissing("loops", "directory_path", "TEXT");
      this.addColumnIfMissing("messages", "requires_human", "INTEGER NOT NULL DEFAULT 0");
      this.addColumnIfMissing("messages", "reminder_at", "TEXT");
      this.addColumnIfMissing("messages", "last_reminded_at", "TEXT");
    });
    this.applyMigration(2, "task attempts and supervised runtimes", () => {
      this.addColumnIfMissing("tasks", "spec_json", "TEXT NOT NULL DEFAULT '{}'");
      this.addColumnIfMissing("tasks", "updated_at", "TEXT NOT NULL DEFAULT ''");
      this.addColumnIfMissing("agents", "execution_profile", "TEXT NOT NULL DEFAULT 'worker-coding'");
      this.addColumnIfMissing("agents", "updated_at", "TEXT NOT NULL DEFAULT ''");
      this.addColumnIfMissing("loops", "task_spec_json", "TEXT NOT NULL DEFAULT '{}'");
      this.addColumnIfMissing("loops", "role", "TEXT NOT NULL DEFAULT 'researcher'");
      this.addColumnIfMissing("loops", "provider", "TEXT NOT NULL DEFAULT 'codex'");
      this.addColumnIfMissing("loops", "model", "TEXT NOT NULL DEFAULT 'gpt-5.6-luna'");
      this.addColumnIfMissing("loops", "last_scheduled_at", "TEXT");
      this.addColumnIfMissing("loops", "updated_at", "TEXT NOT NULL DEFAULT ''");
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS task_attempts (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent_id TEXT NOT NULL REFERENCES agents(id),
          attempt_number INTEGER NOT NULL, status TEXT NOT NULL, runtime_id TEXT, started_at TEXT, ended_at TEXT,
          failure TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_id, attempt_number)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS runtimes (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT, attempt_id TEXT REFERENCES task_attempts(id),
          workspace_key TEXT NOT NULL, singleton_key TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
          execution_profile TEXT NOT NULL, working_directory TEXT NOT NULL, status TEXT NOT NULL,
          supervisor_pid INTEGER, child_pid INTEGER, session_id TEXT, heartbeat_at TEXT, started_at TEXT, ended_at TEXT,
          exit_code INTEGER, last_error TEXT, launch_config_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS runtimes_one_active_owner
          ON runtimes(singleton_key) WHERE status IN ('starting', 'running', 'cancelling');
        CREATE INDEX IF NOT EXISTS runtimes_heartbeat ON runtimes(status, heartbeat_at);
        CREATE TABLE IF NOT EXISTS loop_runs (
          id TEXT PRIMARY KEY, loop_id TEXT NOT NULL REFERENCES loops(id), task_id TEXT REFERENCES tasks(id), status TEXT NOT NULL,
          scheduled_for TEXT NOT NULL, started_at TEXT, ended_at TEXT, error TEXT, created_at TEXT NOT NULL
        ) STRICT;
      `);
      this.backfillTaskSpecs();
      this.backfillLoopSpecs();
      this.database.prepare("UPDATE tasks SET updated_at = created_at WHERE updated_at = ''").run();
      this.database.prepare("UPDATE agents SET updated_at = created_at WHERE updated_at = ''").run();
      this.database.prepare("UPDATE loops SET updated_at = created_at WHERE updated_at = ''").run();
    });
    this.applyMigration(3, "claimed outbox and linked decisions", () => {
      for (const [column, definition] of [
        ["attempt_id", "TEXT"], ["dedupe_key", "TEXT"], ["decision_id", "TEXT"], ["correlation_id", "TEXT"],
        ["claim_token", "TEXT"], ["claimed_by", "TEXT"], ["claimed_at", "TEXT"],
        ["available_at", "TEXT NOT NULL DEFAULT ''"], ["delivery_attempts", "INTEGER NOT NULL DEFAULT 0"],
        ["delivered_at", "TEXT"], ["last_error", "TEXT"],
      ] as const) this.addColumnIfMissing("messages", column, definition);
      for (const [column, definition] of [
        ["reply_to_message_id", "TEXT"], ["decision_id", "TEXT"], ["claim_token", "TEXT"],
        ["claimed_by", "TEXT"], ["claimed_at", "TEXT"], ["delivery_attempts", "INTEGER NOT NULL DEFAULT 0"],
        ["last_error", "TEXT"],
      ] as const) this.addColumnIfMissing("agent_replies", column, definition);
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS decisions (
          id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), task_id TEXT REFERENCES tasks(id),
          agent_id TEXT REFERENCES agents(id), status TEXT NOT NULL, question TEXT NOT NULL, resolution TEXT,
          decided_by TEXT, created_at TEXT NOT NULL, resolved_at TEXT
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS messages_dedupe
          ON messages(agent_id, task_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS messages_outbox ON messages(status, available_at, priority, created_at);
        CREATE INDEX IF NOT EXISTS replies_outbox ON agent_replies(agent_id, status, created_at);
      `);
      this.database.prepare("UPDATE messages SET available_at = created_at WHERE available_at = ''").run();
      this.database.prepare(`
        DELETE FROM agent_sessions WHERE agent_id IN (
          SELECT id FROM agents WHERE status IN ('completed', 'failed', 'cancelled')
        )
      `).run();
    });
    this.applyMigration(4, "runtime ownership and terminal outbox hygiene", () => {
      this.addColumnIfMissing("agent_replies", "available_at", "TEXT NOT NULL DEFAULT ''");
      this.database.prepare("UPDATE agent_replies SET available_at = created_at WHERE available_at = ''").run();
      const timestamp = now();
      this.database.prepare(`
        UPDATE messages SET status = 'discarded', reminder_at = NULL, claim_token = NULL, claimed_by = NULL, claimed_at = NULL,
          last_error = COALESCE(last_error, 'Historical message belonged to a terminal agent')
        WHERE agent_id IN (SELECT id FROM agents WHERE status IN ('completed', 'failed', 'cancelled'))
          AND status IN ('unread', 'claimed', 'delivered', 'acknowledged')
      `).run();
      this.database.prepare(`
        UPDATE decisions SET status = 'cancelled', resolution = 'Historical agent is terminal', decided_by = 'fleet', resolved_at = ?
        WHERE status = 'pending' AND agent_id IN (SELECT id FROM agents WHERE status IN ('completed', 'failed', 'cancelled'))
      `).run(timestamp);
      this.database.prepare(`
        UPDATE agent_replies SET status = 'discarded', claim_token = NULL, claimed_by = NULL, claimed_at = NULL,
          last_error = COALESCE(last_error, 'Historical agent is terminal')
        WHERE agent_id IN (SELECT id FROM agents WHERE status IN ('completed', 'failed', 'cancelled'))
          AND status IN ('queued', 'claimed')
      `).run();
      this.database.prepare(`
        DELETE FROM agent_sessions WHERE agent_id IN (
          SELECT id FROM agents WHERE status IN ('completed', 'failed', 'cancelled')
        )
      `).run();
      this.database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS runtimes_unique_session ON runtimes(session_id) WHERE session_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_unique_session ON agent_sessions(session_id);
      `);
    });
    this.applyMigration(5, "legacy task intent reconstruction", () => {
      const legacyTasks = this.database.prepare(`
        SELECT t.id, t.title FROM tasks t
        WHERE NOT EXISTS (
          SELECT 1 FROM events e WHERE e.entity_type = 'task' AND e.entity_id = t.id
            AND e.event_type = 'created' AND e.payload LIKE '%"spec":%'
        )
      `).all() as Array<{ id: string; title: string }>;
      for (const task of legacyTasks) {
        const roles = (this.database.prepare("SELECT role FROM agents WHERE task_id = ?").all(task.id) as Array<{ role: string }>)
          .map((row) => row.role);
        const kind = inferLegacyTaskKind(roles);
        const deliveryMode = kind === "coding" ? "git-pr" : "report-only";
        const spec = defaultTaskSpec(task.title, { kind, deliveryMode, executionProfile: profileForTaskKind(kind) });
        this.database.prepare("UPDATE tasks SET spec_json = ? WHERE id = ?").run(JSON.stringify(spec), task.id);
        this.database.prepare("UPDATE agents SET execution_profile = ? WHERE task_id = ?")
          .run(spec.executionProfile, task.id);
      }
      const completedBeforeCleanup = this.database.prepare(`
        SELECT DISTINCT a.id AS agentId, a.task_id AS taskId
        FROM agents a JOIN events e ON e.entity_type = 'agent' AND e.entity_id = a.id
        JOIN tasks t ON t.id = a.task_id
        WHERE a.status = 'cancelled' AND t.spec_json LIKE '%"deliveryMode":"report-only"%'
          AND e.event_type = 'status' AND e.payload LIKE '%"status":"completed"%'
      `).all() as Array<{ agentId: string; taskId: string }>;
      const timestamp = now();
      for (const row of completedBeforeCleanup) {
        this.database.prepare("UPDATE agents SET status = 'completed', updated_at = ? WHERE id = ?").run(timestamp, row.agentId);
        this.database.prepare("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'review'")
          .run(timestamp, row.taskId);
        this.addEvent("agent", row.agentId, "legacy_completion_restored", { taskId: row.taskId });
      }
    });
  }

  private applyMigration(version: number, name: string, migration: () => void): void {
    if (this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      migration();
      this.database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(version, name, now());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private backfillTaskSpecs(): void {
    const rows = this.database.prepare("SELECT id, title, spec_json AS specJson FROM tasks").all() as Array<{ id: string; title: string; specJson: string }>;
    for (const row of rows) {
      if (isTaskSpec(row.specJson)) continue;
      this.database.prepare("UPDATE tasks SET spec_json = ? WHERE id = ?").run(JSON.stringify(defaultTaskSpec(row.title)), row.id);
    }
  }

  private backfillLoopSpecs(): void {
    const rows = this.database.prepare("SELECT id, title, task_spec_json AS specJson FROM loops").all() as Array<{ id: string; title: string; specJson: string }>;
    for (const row of rows) {
      if (isTaskSpec(row.specJson)) continue;
      const spec = defaultTaskSpec(row.title, { kind: "operations", deliveryMode: "report-only" });
      this.database.prepare("UPDATE loops SET task_spec_json = ? WHERE id = ?").run(JSON.stringify(spec), row.id);
    }
  }

  private sendMessageInternal(details: {
    agentId?: string | null;
    taskId?: string | null;
    attemptId?: string | null;
    type: MessageType;
    priority?: MessagePriority;
    text: string;
    requiresHuman?: boolean;
    dedupeKey?: string | null;
    correlationId?: string | null;
    allowTerminalAgent?: boolean;
  }): FleetMessage {
    let agent: Agent | null = null;
    if (details.agentId) agent = this.getAgent(details.agentId);
    if (details.taskId) this.requireTask(details.taskId);
    if (details.attemptId) this.getAttempt(details.attemptId);
    if (details.dedupeKey) {
      const existing = this.database.prepare(`
        SELECT id FROM messages WHERE agent_id IS ? AND task_id IS ? AND dedupe_key = ? LIMIT 1
      `).get(details.agentId ?? null, details.taskId ?? null, details.dedupeKey) as { id: string } | undefined;
      if (existing) return this.requireMessage(existing.id);
    }
    const requiresHuman = details.requiresHuman ?? ["question", "approval", "blocked"].includes(details.type);
    const createdAt = now();
    const terminalAgent = agent && TERMINAL_AGENT_STATUSES.has(agent.status) && !details.allowTerminalAgent;
    const id = randomUUID();
    const status: MessageStatus = terminalAgent ? "discarded" : "unread";
    this.database.prepare(`
      INSERT INTO messages (
        id, agent_id, task_id, attempt_id, type, priority, text, status, requires_human, dedupe_key, decision_id,
        correlation_id, claim_token, claimed_by, claimed_at, available_at, delivery_attempts, delivered_at,
        last_error, reminder_at, last_reminded_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, 0, NULL, ?, NULL, NULL, ?)
    `).run(id, details.agentId ?? null, details.taskId ?? null, details.attemptId ?? null, details.type,
      details.priority ?? "normal", details.text, status, Number(requiresHuman), details.dedupeKey ?? null,
      details.correlationId ?? null, createdAt, terminalAgent ? `Agent is ${agent!.status}; late message retained for diagnostics` : null, createdAt);
    let decisionId: string | null = null;
    if (requiresHuman && !terminalAgent) {
      decisionId = randomUUID();
      this.database.prepare(`
        INSERT INTO decisions (id, message_id, task_id, agent_id, status, question, resolution, decided_by, created_at, resolved_at)
        VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, NULL)
      `).run(decisionId, id, details.taskId ?? null, details.agentId ?? null, details.text, createdAt);
      this.database.prepare("UPDATE messages SET decision_id = ? WHERE id = ?").run(decisionId, id);
    }
    this.addEvent("message", id, terminalAgent ? "discarded" : "created", { ...details, decisionId, status });
    return this.requireMessage(id);
  }

  private updateTaskFromAgent(task: Task, agentId: string, agentStatus: AgentStatus, updatedAt: string): void {
    let desired: TaskStatus | null = null;
    if (agentStatus === "running" && ["pending", "ready"].includes(task.status)) desired = "running";
    if (agentStatus === "completed") desired = task.spec.deliveryMode === "git-pr" ? "review" : "completed";
    if (["failed", "cancelled"].includes(agentStatus)) {
      const otherActive = this.database.prepare(`
        SELECT 1 FROM agents WHERE task_id = ? AND id <> ? AND status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1
      `).get(task.id, agentId);
      if (!otherActive && !["completed", "review"].includes(task.status)) {
        desired = agentStatus === "failed" ? "failed" : "cancelled";
      }
    }
    if (!desired || desired === task.status) return;
    assertTaskTransition(task.status, desired);
    this.database.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(desired, updatedAt, task.id);
    this.addEvent("task", task.id, "status", { from: task.status, status: desired, sourceAgentId: agentId });
  }

  private updateAttemptFromAgent(agentId: string, agentStatus: AgentStatus, failure?: string): void {
    const attempt = this.getLatestAttemptForAgent(agentId);
    if (!attempt || ["succeeded", "failed", "cancelled"].includes(attempt.status)) return;
    const mapping: Partial<Record<AgentStatus, TaskAttemptStatus>> = {
      running: "running", waiting: "waiting", completed: "succeeded", failed: "failed", cancelled: "cancelled",
    };
    const target = mapping[agentStatus];
    if (!target || target === attempt.status) return;
    assertAttemptTransition(attempt.status, target);
    const timestamp = now();
    this.database.prepare(`
      UPDATE task_attempts SET status = ?, started_at = COALESCE(started_at, ?), ended_at = ?, failure = ?, updated_at = ? WHERE id = ?
    `).run(target, target === "running" ? timestamp : attempt.startedAt,
      ["succeeded", "failed", "cancelled"].includes(target) ? timestamp : attempt.endedAt,
      target === "failed" ? failure ?? "Agent failed" : attempt.failure, timestamp, attempt.id);
    this.addEvent("attempt", attempt.id, "status", { from: attempt.status, status: target, sourceAgentStatus: agentStatus });
  }

  private resolveDecisionInternal(decisionId: string, resolution: string, decidedBy: string): void {
    this.database.prepare(`
      UPDATE decisions SET status = 'resolved', resolution = ?, decided_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'
    `).run(resolution, decidedBy, now(), decisionId);
    this.addEvent("decision", decisionId, "resolved", { resolution, decidedBy });
  }

  private requireProject(projectId: string): void { this.getProject(projectId); }
  private requireTask(taskId: string): void { this.getTask(taskId); }
  private requireAgent(agentId: string): void { this.getAgent(agentId); }

  private requireMessage(id: string): FleetMessage {
    const row = this.database.prepare(this.messageSelect("WHERE m.id = ?")).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown message: ${id}`);
    return this.mapMessage(row);
  }

  private requireAgentReply(id: string): AgentReply {
    const row = this.database.prepare(this.replySelect("WHERE id = ?")).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown agent reply: ${id}`);
    return this.mapAgentReply(row);
  }

  private addEvent(entityType: string, entityId: string, eventType: string, payload: Record<string, unknown>): void {
    this.database.prepare("INSERT INTO events (id, entity_type, entity_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), entityType, entityId, eventType, JSON.stringify(payload), now());
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private projectSelect(suffix = ""): string {
    return `SELECT id, name, root_path AS rootPath, created_at AS createdAt FROM projects ${suffix}`;
  }

  private taskSelect(suffix = ""): string {
    return `SELECT id, project_id AS projectId, title, status, spec_json AS specJson, created_at AS createdAt, updated_at AS updatedAt FROM tasks ${suffix}`;
  }

  private agentSelect(suffix = ""): string {
    return `SELECT id, task_id AS taskId, role, provider, model, execution_profile AS executionProfile, status, branch,
      worktree_path AS worktreePath, terminal_title AS terminalTitle, created_at AS createdAt, updated_at AS updatedAt FROM agents ${suffix}`;
  }

  private attemptSelect(suffix = ""): string {
    return `SELECT id, task_id AS taskId, agent_id AS agentId, attempt_number AS attemptNumber, status,
      runtime_id AS runtimeId, started_at AS startedAt, ended_at AS endedAt, failure,
      created_at AS createdAt, updated_at AS updatedAt FROM task_attempts ${suffix}`;
  }

  private runtimeSelect(suffix = ""): string {
    return `SELECT id, kind, owner_id AS ownerId, attempt_id AS attemptId, workspace_key AS workspaceKey,
      provider, model, execution_profile AS executionProfile, working_directory AS workingDirectory, status,
      supervisor_pid AS supervisorPid, child_pid AS childPid, session_id AS sessionId, heartbeat_at AS heartbeatAt,
      started_at AS startedAt, ended_at AS endedAt, exit_code AS exitCode, last_error AS lastError,
      launch_config_json AS launchConfigJson, created_at AS createdAt, updated_at AS updatedAt FROM runtimes ${suffix}`;
  }

  private loopSelect(suffix = ""): string {
    return `SELECT id, project_id AS projectId, title, schedule, enabled, directory_path AS directoryPath,
      task_spec_json AS taskSpecJson, role, provider, model, last_scheduled_at AS lastScheduledAt,
      created_at AS createdAt, updated_at AS updatedAt FROM loops ${suffix}`;
  }

  private loopRunSelect(suffix = ""): string {
    return `SELECT id, loop_id AS loopId, task_id AS taskId, status, scheduled_for AS scheduledFor,
      started_at AS startedAt, ended_at AS endedAt, error, created_at AS createdAt FROM loop_runs ${suffix}`;
  }

  private messageSelect(suffix = ""): string {
    return `SELECT m.id, m.agent_id AS agentId, m.task_id AS taskId, m.attempt_id AS attemptId, m.type, m.priority,
      m.text, m.status, m.requires_human AS requiresHuman, m.dedupe_key AS dedupeKey, m.decision_id AS decisionId,
      m.correlation_id AS correlationId, m.claim_token AS claimToken, m.claimed_by AS claimedBy, m.claimed_at AS claimedAt,
      m.available_at AS availableAt, m.delivery_attempts AS deliveryAttempts, m.delivered_at AS deliveredAt,
      m.last_error AS lastError, m.reminder_at AS reminderAt, m.last_reminded_at AS lastRemindedAt,
      p.name AS projectName, a.role AS agentRole, t.title AS taskTitle, m.created_at AS createdAt
      FROM messages m LEFT JOIN agents a ON a.id = m.agent_id LEFT JOIN tasks t ON t.id = m.task_id
      LEFT JOIN projects p ON p.id = t.project_id ${suffix}`;
  }

  private messageOrder(): string {
    return " ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.created_at";
  }

  private replySelect(suffix = ""): string {
    return `SELECT id, agent_id AS agentId, text, status, reply_to_message_id AS replyToMessageId, decision_id AS decisionId,
      claim_token AS claimToken, claimed_by AS claimedBy, claimed_at AS claimedAt, available_at AS availableAt, delivery_attempts AS deliveryAttempts,
      last_error AS lastError, created_at AS createdAt, delivered_at AS deliveredAt FROM agent_replies ${suffix}`;
  }

  private decisionSelect(suffix = ""): string {
    return `SELECT id, message_id AS messageId, task_id AS taskId, agent_id AS agentId, status, question, resolution,
      decided_by AS decidedBy, created_at AS createdAt, resolved_at AS resolvedAt FROM decisions ${suffix}`;
  }

  private mapProject(row: Record<string, unknown>): Project {
    return { id: stringValue(row.id), name: stringValue(row.name), rootPath: stringValue(row.rootPath), createdAt: stringValue(row.createdAt) };
  }

  private mapTask(row: Record<string, unknown>): Task {
    const title = stringValue(row.title);
    return {
      id: stringValue(row.id), projectId: stringValue(row.projectId), title, status: stringValue(row.status) as TaskStatus,
      spec: parseTaskSpec(row.specJson, title), createdAt: stringValue(row.createdAt),
      updatedAt: nullableString(row.updatedAt) || stringValue(row.createdAt),
    };
  }

  private mapAgent(row: Record<string, unknown>): Agent {
    return {
      id: stringValue(row.id), taskId: stringValue(row.taskId), role: stringValue(row.role), provider: stringValue(row.provider),
      model: stringValue(row.model), executionProfile: nullableString(row.executionProfile) || "worker-coding",
      status: stringValue(row.status) as AgentStatus, branch: nullableString(row.branch), worktreePath: nullableString(row.worktreePath),
      terminalTitle: nullableString(row.terminalTitle), createdAt: stringValue(row.createdAt),
      updatedAt: nullableString(row.updatedAt) || stringValue(row.createdAt),
    };
  }

  private mapAttempt(row: Record<string, unknown>): TaskAttempt {
    return {
      id: stringValue(row.id), taskId: stringValue(row.taskId), agentId: stringValue(row.agentId),
      attemptNumber: Number(row.attemptNumber), status: stringValue(row.status) as TaskAttemptStatus,
      runtimeId: nullableString(row.runtimeId), startedAt: nullableString(row.startedAt), endedAt: nullableString(row.endedAt),
      failure: nullableString(row.failure), createdAt: stringValue(row.createdAt), updatedAt: stringValue(row.updatedAt),
    };
  }

  private mapRuntime(row: Record<string, unknown>): ProcessRuntime {
    return {
      id: stringValue(row.id), kind: stringValue(row.kind) as RuntimeKind, ownerId: nullableString(row.ownerId),
      attemptId: nullableString(row.attemptId), workspaceKey: stringValue(row.workspaceKey), provider: stringValue(row.provider),
      model: stringValue(row.model), executionProfile: stringValue(row.executionProfile),
      workingDirectory: stringValue(row.workingDirectory), status: stringValue(row.status) as RuntimeStatus,
      supervisorPid: nullableNumber(row.supervisorPid), childPid: nullableNumber(row.childPid), sessionId: nullableString(row.sessionId),
      heartbeatAt: nullableString(row.heartbeatAt), startedAt: nullableString(row.startedAt), endedAt: nullableString(row.endedAt),
      exitCode: nullableNumber(row.exitCode), lastError: nullableString(row.lastError),
      launchConfig: safeJson<RuntimeLaunchConfig>(stringValue(row.launchConfigJson), { prompt: "", fleetCliPath: "", databasePath: "" }),
      createdAt: stringValue(row.createdAt), updatedAt: stringValue(row.updatedAt),
    };
  }

  private mapLoop(row: Record<string, unknown>): Loop {
    const title = stringValue(row.title);
    return {
      id: stringValue(row.id), projectId: nullableString(row.projectId), title, schedule: stringValue(row.schedule),
      enabled: Boolean(row.enabled), directoryPath: nullableString(row.directoryPath),
      taskSpec: parseTaskSpec(row.taskSpecJson, title, { kind: "operations", deliveryMode: "report-only" }),
      role: nullableString(row.role) || "researcher", provider: nullableString(row.provider) || "codex",
      model: nullableString(row.model) || recommendModel("researcher"), lastScheduledAt: nullableString(row.lastScheduledAt),
      createdAt: stringValue(row.createdAt), updatedAt: nullableString(row.updatedAt) || stringValue(row.createdAt),
    };
  }

  private mapLoopRun(row: Record<string, unknown>): LoopRun {
    return {
      id: stringValue(row.id), loopId: stringValue(row.loopId), taskId: nullableString(row.taskId),
      status: stringValue(row.status) as LoopRunStatus, scheduledFor: stringValue(row.scheduledFor),
      startedAt: nullableString(row.startedAt), endedAt: nullableString(row.endedAt), error: nullableString(row.error),
      createdAt: stringValue(row.createdAt),
    };
  }

  private mapMessage(row: Record<string, unknown>): FleetMessage {
    return {
      id: stringValue(row.id), agentId: nullableString(row.agentId), taskId: nullableString(row.taskId),
      attemptId: nullableString(row.attemptId), type: stringValue(row.type) as MessageType,
      priority: stringValue(row.priority) as MessagePriority, text: stringValue(row.text), status: stringValue(row.status) as MessageStatus,
      requiresHuman: Boolean(row.requiresHuman), dedupeKey: nullableString(row.dedupeKey), decisionId: nullableString(row.decisionId),
      correlationId: nullableString(row.correlationId), claimToken: nullableString(row.claimToken), claimedBy: nullableString(row.claimedBy),
      claimedAt: nullableString(row.claimedAt), availableAt: nullableString(row.availableAt) || stringValue(row.createdAt),
      deliveryAttempts: Number(row.deliveryAttempts ?? 0), deliveredAt: nullableString(row.deliveredAt), lastError: nullableString(row.lastError),
      reminderAt: nullableString(row.reminderAt), lastRemindedAt: nullableString(row.lastRemindedAt),
      projectName: nullableString(row.projectName), agentRole: nullableString(row.agentRole), taskTitle: nullableString(row.taskTitle),
      createdAt: stringValue(row.createdAt),
    };
  }

  private mapAgentReply(row: Record<string, unknown>): AgentReply {
    return {
      id: stringValue(row.id), agentId: stringValue(row.agentId), text: stringValue(row.text), status: stringValue(row.status) as AgentReply["status"],
      replyToMessageId: nullableString(row.replyToMessageId), decisionId: nullableString(row.decisionId),
      claimToken: nullableString(row.claimToken), claimedBy: nullableString(row.claimedBy), claimedAt: nullableString(row.claimedAt),
      availableAt: nullableString(row.availableAt) || stringValue(row.createdAt),
      deliveryAttempts: Number(row.deliveryAttempts ?? 0), lastError: nullableString(row.lastError),
      createdAt: stringValue(row.createdAt), deliveredAt: nullableString(row.deliveredAt),
    };
  }

  private mapDecision(row: Record<string, unknown>): Decision {
    return {
      id: stringValue(row.id), messageId: stringValue(row.messageId), taskId: nullableString(row.taskId),
      agentId: nullableString(row.agentId), status: stringValue(row.status) as Decision["status"], question: stringValue(row.question),
      resolution: nullableString(row.resolution), decidedBy: nullableString(row.decidedBy), createdAt: stringValue(row.createdAt),
      resolvedAt: nullableString(row.resolvedAt),
    };
  }
}

export function defaultDatabasePath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "Fleet", "fleet.db");
}

function nextReminder(priority: MessagePriority): string {
  const minutes = priority === "urgent" ? 5 : priority === "high" ? 15 : priority === "normal" ? 60 : 180;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function now(): string { return new Date().toISOString(); }
function normalizeKey(value: string): string { return value.replaceAll("/", "\\").toLowerCase(); }
function stringValue(value: unknown): string { return value === null || value === undefined ? "" : String(value); }
function nullableString(value: unknown): string | null { return value === null || value === undefined || value === "" ? null : String(value); }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }

function safeJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function isTaskSpec(value: string): boolean {
  const parsed = safeJson<Partial<TaskSpec>>(value, {});
  return typeof parsed.objective === "string" && typeof parsed.kind === "string" && typeof parsed.deliveryMode === "string";
}

function inferLegacyTaskKind(roles: string[]): TaskKind {
  const normalized = roles.map((role) => role.trim().toLowerCase());
  if (normalized.some((role) => ["implementer", "coder", "developer", "engineer"].includes(role))) return "coding";
  if (normalized.some((role) => ["reviewer", "qa-tester", "tester"].includes(role))) return "review";
  if (normalized.some((role) => ["researcher", "seo-auditor", "analyst"].includes(role))) return "research";
  if (normalized.some((role) => ["ux-designer", "browser", "web-auditor"].includes(role))) return "browser";
  if (normalized.some((role) => ["writer", "editor"].includes(role))) return "writing";
  return "operations";
}

function parseTaskSpec(value: unknown, title: string, fallback: Partial<TaskSpec> = {}): TaskSpec {
  const parsed = safeJson<Partial<TaskSpec>>(stringValue(value), {});
  return defaultTaskSpec(title, { ...fallback, ...parsed });
}

export function deliveryNeedsPullRequest(mode: DeliveryMode): boolean { return mode === "git-pr"; }
