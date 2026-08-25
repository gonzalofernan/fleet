import assert from "node:assert/strict";
import test from "node:test";
import { formatCaptainEvent } from "./captain-host.js";

test("formats an agent message as an explicit captain event", () => {
  const event = formatCaptainEvent({
    id: "message-1", agentId: "agent-1", taskId: "task-1", type: "approval", priority: "urgent",
    text: "Need confirmation", status: "unread", requiresHuman: true, reminderAt: null, lastRemindedAt: null,
    projectName: "Fleet", agentRole: "reviewer", taskTitle: "Review messages", createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(event, /\[FLEET EVENT \| URGENT \| approval\]/);
  assert.match(event, /Proyecto: Fleet/);
  assert.match(event, /Agente: reviewer \(agent-1\)/);
  assert.match(event, /Tarea: Review messages/);
});

test("marks a reminder distinctly", () => {
  const event = formatCaptainEvent({
    id: "message-1", agentId: null, taskId: null, type: "blocked", priority: "high",
    text: "Still blocked", status: "acknowledged", requiresHuman: true, reminderAt: null, lastRemindedAt: null,
    projectName: null, agentRole: null, taskTitle: null, createdAt: "2026-01-01T00:00:00.000Z",
  }, true);
  assert.match(event, /FLEET EVENT \| REMINDER \| HIGH/);
});
