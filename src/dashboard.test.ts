import assert from "node:assert/strict";
import test from "node:test";
import { renderDashboard } from "./dashboard.js";
import { agentFixture, messageFixture, snapshotFixture, taskFixture } from "./test-fixtures.js";

test("shows recovered workers as unverified instead of active", () => {
  const dashboard = renderDashboard(snapshotFixture({
    agents: [agentFixture({ id: "agent-1234", taskId: "missing", role: "recovered", provider: "unknown", model: "unknown", status: "unknown" })],
  }));
  assert.match(dashboard, /Active agents: 0/);
  assert.match(dashboard, /UNVERIFIED WORKERS/);
  assert.match(dashboard, /unknown/);
});

test("shows running work and only canonical pending decisions", () => {
  const task = taskFixture({ id: "task-1", projectId: "project-1", title: "Add invoice export", status: "running" });
  const agent = agentFixture({ id: "agent-1234", taskId: task.id, status: "running", branch: "fleet/agent-1234" });
  const pending = messageFixture({ id: "message-1", agentId: agent.id, taskId: task.id, type: "approval", priority: "high", text: "Choose the export format", requiresHuman: true, decisionId: "decision-1" });
  const discarded = messageFixture({ id: "message-2", agentId: agent.id, taskId: task.id, type: "blocked", text: "Old blocker", status: "discarded", requiresHuman: true, decisionId: "decision-2" });
  const dashboard = renderDashboard(snapshotFixture({
    projects: [{ id: "project-1", name: "Billing API", rootPath: "C:/projects/billing", createdAt: "2026-08-26T10:00:00.000Z" }],
    tasks: [task], agents: [agent], messages: [pending, discarded],
    decisions: [
      { id: "decision-1", messageId: pending.id, taskId: task.id, agentId: agent.id, status: "pending", question: pending.text, resolution: null, decidedBy: null, createdAt: pending.createdAt, resolvedAt: null },
      { id: "decision-2", messageId: discarded.id, taskId: task.id, agentId: agent.id, status: "cancelled", question: discarded.text, resolution: "Agent ended", decidedBy: "fleet", createdAt: discarded.createdAt, resolvedAt: discarded.createdAt },
    ],
  }));

  assert.match(dashboard, /Projects: 1 \| Active tasks: 1 \| Active agents: 1/);
  assert.match(dashboard, /coding -> git-pr \| Runtime: no runtime/);
  assert.match(dashboard, /Choose the export format/);
  assert.doesNotMatch(dashboard, /Old blocker/);
});
