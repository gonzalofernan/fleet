import type { AgentStatus, LoopRunStatus, RuntimeStatus, TaskAttemptStatus, TaskStatus } from "./domain.js";

const agentTransitions: Record<AgentStatus, readonly AgentStatus[]> = {
  requested: ["provisioning", "cancelled", "failed"],
  provisioning: ["running", "cancelled", "failed", "unknown"],
  running: ["waiting", "completed", "failed", "cancelled", "unknown"],
  waiting: ["running", "completed", "failed", "cancelled", "unknown"],
  completed: [],
  failed: [],
  cancelled: [],
  unknown: ["requested", "provisioning", "running", "waiting", "completed", "failed", "cancelled"],
};

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["ready", "running", "completed", "failed", "cancelled"],
  ready: ["running", "failed", "cancelled"],
  running: ["review", "completed", "failed", "cancelled"],
  review: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const attemptTransitions: Record<TaskAttemptStatus, readonly TaskAttemptStatus[]> = {
  queued: ["starting", "cancelled", "failed"],
  starting: ["running", "cancelled", "failed"],
  running: ["waiting", "succeeded", "cancelled", "failed"],
  waiting: ["running", "succeeded", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const runtimeTransitions: Record<RuntimeStatus, readonly RuntimeStatus[]> = {
  starting: ["running", "cancelling", "stopped", "failed", "cancelled"],
  running: ["cancelling", "stopped", "failed", "cancelled"],
  cancelling: ["cancelled", "stopped", "failed"],
  stopped: [],
  failed: [],
  cancelled: [],
};

const loopRunTransitions: Record<LoopRunStatus, readonly LoopRunStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function assertAgentTransition(from: AgentStatus, to: AgentStatus): void {
  assertTransition("agent", from, to, agentTransitions);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  assertTransition("task", from, to, taskTransitions);
}

export function assertAttemptTransition(from: TaskAttemptStatus, to: TaskAttemptStatus): void {
  assertTransition("attempt", from, to, attemptTransitions);
}

export function assertRuntimeTransition(from: RuntimeStatus, to: RuntimeStatus): void {
  assertTransition("runtime", from, to, runtimeTransitions);
}

export function assertLoopRunTransition(from: LoopRunStatus, to: LoopRunStatus): void {
  assertTransition("loop run", from, to, loopRunTransitions);
}

function assertTransition<T extends string>(kind: string, from: T, to: T, transitions: Record<T, readonly T[]>): void {
  if (from === to) return;
  if (!transitions[from].includes(to)) throw new Error(`Invalid ${kind} transition: ${from} -> ${to}`);
}
