import { defaultTaskSpec, type Agent, type FleetMessage, type FleetSnapshot, type Task } from "./domain.js";

export function taskFixture(overrides: Partial<Task> = {}): Task {
  const title = overrides.title ?? "Test task";
  return {
    id: "task-1", projectId: "project-1", title, status: "pending", spec: defaultTaskSpec(title),
    createdAt: "2026-08-26T10:00:00.000Z", updatedAt: "2026-08-26T10:00:00.000Z", ...overrides,
  };
}

export function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1", taskId: "task-1", role: "implementer", provider: "codex", model: "gpt-5.6-terra",
    executionProfile: "worker-coding", status: "requested", branch: null, worktreePath: null, terminalTitle: null,
    createdAt: "2026-08-26T10:00:00.000Z", updatedAt: "2026-08-26T10:00:00.000Z", ...overrides,
  };
}

export function messageFixture(overrides: Partial<FleetMessage> = {}): FleetMessage {
  return {
    id: "message-1", agentId: "agent-1", taskId: "task-1", attemptId: null, type: "info", priority: "normal",
    text: "Test message", status: "unread", requiresHuman: false, dedupeKey: null, decisionId: null, correlationId: null,
    claimToken: null, claimedBy: null, claimedAt: null, availableAt: "2026-08-26T10:00:00.000Z",
    deliveryAttempts: 0, deliveredAt: null, lastError: null, reminderAt: null, lastRemindedAt: null,
    projectName: "Fleet", agentRole: "implementer", taskTitle: "Test task", createdAt: "2026-08-26T10:00:00.000Z",
    ...overrides,
  };
}

export function snapshotFixture(overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    projects: [], tasks: [], agents: [], attempts: [], runtimes: [], loops: [], loopRuns: [], decisions: [], messages: [],
    recentActivity: [], ...overrides,
  };
}
