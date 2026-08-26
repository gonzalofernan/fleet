import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { FleetStore } from "./storage.js";

function databasePath(prefix = "fleet-storage-"): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "fleet.db");
}

function activeAgent(store: FleetStore) {
  const project = store.addProject("fleet", join(tmpdir(), `fleet-project-${Date.now()}`));
  const task = store.createTask(project.id, "Implement supervisor");
  const agent = store.requestAgent(task.id, "implementer");
  store.provisionAgent(agent.id, { branch: `fleet/agent-${agent.id.slice(0, 8)}`, worktreePath: project.rootPath, terminalTitle: "worker" });
  store.updateAgentStatus(agent.id, "running");
  return { project, task, agent: store.getAgent(agent.id) };
}

test("claims each captain outbox message once and resolves its linked decision only after reply delivery", () => {
  const path = databasePath();
  const first = new FleetStore(path);
  const { task, agent } = activeAgent(first);
  const message = first.sendMessage({ agentId: agent.id, taskId: task.id, type: "approval", priority: "high", text: "Choose A or B" });
  const second = new FleetStore(path);

  const claim = first.claimMessages("captain-a");
  assert.equal(claim.length, 1);
  assert.equal(second.claimMessages("captain-b").length, 0);
  first.acknowledgeMessageClaim(message.id, claim[0]!.token);
  assert.equal(first.listDecisions("pending").length, 1);
  assert.throws(() => first.resolveMessage(message.id), /use a linked agent reply/);

  const reply = first.queueAgentReply(agent.id, "Use A", message.id);
  assert.equal(first.listMessages()[0]?.status, "acknowledged");
  const replyClaim = second.claimAgentReplies(agent.id, "worker-a")[0]!;
  assert.equal(replyClaim.reply.id, reply.id);
  second.acknowledgeAgentReplyClaim(reply.id, replyClaim.token);
  assert.equal(first.listMessages()[0]?.status, "resolved");
  assert.equal(first.listDecisions("pending").length, 0);
  assert.equal(first.listDecisions("resolved")[0]?.resolution, "Use A");
  second.close();
  first.close();
});

test("binds attempts atomically and allows only one supervisor owner", () => {
  const store = new FleetStore(databasePath());
  const { project, task, agent } = activeAgentForAttempt(store);
  const attempt = store.createTaskAttempt(agent.id);
  const runtime = store.createRuntime({
    kind: "worker", ownerId: agent.id, attemptId: attempt.id, workspaceKey: project.rootPath, provider: "codex",
    model: agent.model, executionProfile: agent.executionProfile, workingDirectory: project.rootPath,
    launchConfig: { prompt: task.title, fleetCliPath: "cli.js", databasePath: "fleet.db", codexPath: "codex.cmd" },
  });
  assert.equal(store.getAttempt(attempt.id).runtimeId, runtime.id);
  assert.equal(store.getAttempt(attempt.id).status, "starting");
  assert.throws(() => store.createRuntime({
    kind: "worker", ownerId: agent.id, workspaceKey: project.rootPath, provider: "codex", model: agent.model,
    executionProfile: agent.executionProfile, workingDirectory: project.rootPath,
    launchConfig: { prompt: "duplicate", fleetCliPath: "cli.js", databasePath: "fleet.db" },
  }), /active worker runtime already exists/);
  assert.equal(store.startRuntime(runtime.id, 111).supervisorPid, 111);
  assert.throws(() => store.startRuntime(runtime.id, 222), /already claimed/);
  assert.throws(() => store.heartbeatRuntime(runtime.id, 222), /owned by supervisor PID 111/);
  store.close();
});

test("terminal agents discard stale decisions, replies, and late messages", () => {
  const store = new FleetStore(databasePath());
  const { task, agent } = activeAgent(store);
  const message = store.sendMessage({ agentId: agent.id, taskId: task.id, type: "approval", text: "Need a choice" });
  store.markMessageDelivered(message.id);
  const reply = store.queueAgentReply(agent.id, "Pending response", message.id);
  store.cancelAgent(agent.id, "No longer needed");

  assert.equal(store.listMessages().find((entry) => entry.id === message.id)?.status, "discarded");
  assert.equal(store.listDecisions().find((entry) => entry.messageId === message.id)?.status, "cancelled");
  assert.equal(store.snapshot().agents[0]?.status, "cancelled");
  assert.equal(store.listQueuedAgentReplies(agent.id).length, 0);
  const late = store.sendMessage({ agentId: agent.id, taskId: task.id, type: "approval", text: "Too late" });
  assert.equal(late.status, "discarded");
  assert.equal(reply.status, "queued");
  store.close();
});

test("migrates legacy terminal-agent state without retaining live sessions or pending messages", () => {
  const path = databasePath("fleet-migration-");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, root_path TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, agent_id TEXT, task_id TEXT, type TEXT NOT NULL, priority TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE agent_sessions (agent_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_at TEXT NOT NULL, attached_at TEXT NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO projects VALUES ('project-1', 'fleet', 'C:/fleet', '2026-08-25T10:00:00.000Z');
    INSERT INTO tasks VALUES ('task-1', 'project-1', 'Old task', 'completed', '2026-08-25T10:00:00.000Z');
    INSERT INTO agents VALUES ('agent-1', 'task-1', 'implementer', 'codex', 'completed', '2026-08-25T10:00:00.000Z');
    INSERT INTO tasks VALUES ('task-2', 'project-1', 'SEO audit', 'review', '2026-08-25T11:00:00.000Z');
    INSERT INTO agents VALUES ('agent-2', 'task-2', 'seo-auditor', 'codex', 'cancelled', '2026-08-25T11:00:00.000Z');
    INSERT INTO events VALUES ('event-1', 'agent', 'agent-2', 'status', '{"status":"completed","message":"Delivered without PR"}', '2026-08-25T11:30:00.000Z');
    INSERT INTO messages VALUES ('message-1', 'agent-1', 'task-1', 'approval', 'high', 'Stale question', 'delivered', '2026-08-25T10:01:00.000Z');
    INSERT INTO agent_sessions VALUES ('agent-1', 'session-1', '2026-08-25T10:00:00.000Z', '2026-08-25T10:00:01.000Z');
  `);
  legacy.close();

  const store = new FleetStore(path);
  assert.equal(store.schemaVersion(), 5);
  assert.equal(store.snapshot().tasks[0]?.spec.objective, "Old task");
  assert.equal(store.listMessages()[0]?.status, "discarded");
  assert.equal(store.snapshot().agents[0]?.updatedAt, "2026-08-25T10:00:00.000Z");
  assert.equal(store.getTask("task-2").spec.kind, "research");
  assert.equal(store.getTask("task-2").spec.deliveryMode, "report-only");
  assert.equal(store.getTask("task-2").status, "completed");
  assert.equal(store.getAgent("agent-2").status, "completed");
  store.close();
});

function activeAgentForAttempt(store: FleetStore) {
  const project = store.addProject("fleet", join(tmpdir(), `fleet-attempt-${Date.now()}`));
  const task = store.createTask(project.id, "Own one runtime");
  const requested = store.requestAgent(task.id, "implementer");
  const agent = store.provisionAgent(requested.id, { branch: `fleet/agent-${requested.id.slice(0, 8)}`, worktreePath: project.rootPath, terminalTitle: "worker" });
  return { project, task, agent };
}
