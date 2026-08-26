import assert from "node:assert/strict";
import test from "node:test";
import { renderDashboard } from "./dashboard.js";

test("shows recovered workers as unverified instead of active", () => {
  const dashboard = renderDashboard({
    projects: [],
    tasks: [],
    loops: [],
    messages: [],
    agents: [{
      id: "agent-1234", taskId: "missing", role: "recovered", provider: "unknown", model: "unknown", status: "unknown",
      branch: "fleet/agent-1234", worktreePath: "C:/worktree", terminalTitle: "FLEET | test", createdAt: "2026-01-01T00:00:00.000Z",
    }],
  });

  assert.match(dashboard, /Active agents: 0/);
  assert.match(dashboard, /Unverified workers: 1/);
  assert.match(dashboard, /ACTIVE WORK/);
  assert.match(dashboard, /unknown/);
});

test("shows running work, recent projects, and pending decisions", () => {
  const dashboard = renderDashboard({
    projects: [{ id: "project-1", name: "Billing API", rootPath: "C:/projects/billing", createdAt: "2026-08-26T10:00:00.000Z" }],
    tasks: [{ id: "task-1", projectId: "project-1", title: "Add invoice export", status: "running", createdAt: "2026-08-26T10:05:00.000Z" }],
    agents: [{
      id: "agent-1234", taskId: "task-1", role: "implementer", provider: "codex", model: "gpt-5.6-terra", status: "running",
      branch: "fleet/agent-1234", worktreePath: "C:/worktree", terminalTitle: "FLEET | Billing API", createdAt: "2026-08-26T10:06:00.000Z",
    }],
    loops: [],
    messages: [{
      id: "message-1", agentId: "agent-1234", taskId: "task-1", type: "approval", priority: "high",
      text: "Choose the export format", status: "unread", requiresHuman: true, reminderAt: null, lastRemindedAt: null,
      projectName: "Billing API", agentRole: "implementer", taskTitle: "Add invoice export", createdAt: "2026-08-26T10:07:00.000Z",
    }],
    recentActivity: [{
      id: "event-1", entityType: "agent", entityId: "agent-1234", eventType: "status", payload: { status: "running" },
      createdAt: "2026-08-26T10:06:00.000Z", projectName: "Billing API", agentRole: "implementer", taskTitle: "Add invoice export",
    }],
  });

  assert.match(dashboard, /Billing API/);
  assert.match(dashboard, /Add invoice export/);
  assert.match(dashboard, /Projects: 1 \| Active tasks: 1 \| Active agents: 1/);
  assert.match(dashboard, /- running \| Billing API \| implementer/);
  assert.match(dashboard, /Task: Add invoice export/);
  assert.match(dashboard, /RECENT PROJECTS/);
  assert.match(dashboard, /RECENT ACTIVITY/);
  assert.match(dashboard, /PENDING HUMAN DECISIONS/);
  assert.match(dashboard, /Choose the export format/);
});
