export const TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "review",
  "completed",
  "failed",
  "cancelled",
] as const;

export const AGENT_STATUSES = [
  "requested",
  "provisioning",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const;

export const TASK_KINDS = ["coding", "review", "research", "browser", "writing", "operations"] as const;
export const DELIVERY_MODES = ["git-pr", "report-only", "conversation-only"] as const;
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export const ATTEMPT_STATUSES = ["queued", "starting", "running", "waiting", "succeeded", "failed", "cancelled"] as const;
export const RUNTIME_STATUSES = ["starting", "running", "cancelling", "stopped", "failed", "cancelled"] as const;
export const RUNTIME_KINDS = ["captain", "worker", "loop"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type TaskKind = (typeof TASK_KINDS)[number];
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type TaskAttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export const MESSAGE_TYPES = ["info", "question", "approval", "blocked", "completed"] as const;
export const MESSAGE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const MESSAGE_STATUSES = ["unread", "claimed", "delivered", "acknowledged", "resolved", "failed", "discarded"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export type MessagePriority = (typeof MESSAGE_PRIORITIES)[number];
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export type AgentReplyStatus = "queued" | "claimed" | "delivered" | "failed" | "discarded";
export type DecisionStatus = "pending" | "resolved" | "cancelled";
export type LoopRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface TaskSpec {
  objective: string;
  kind: TaskKind;
  deliveryMode: DeliveryMode;
  acceptanceCriteria: string[];
  contextPaths: string[];
  riskLevel: RiskLevel;
  executionProfile: string;
}

export function defaultTaskSpec(title: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  const kind = overrides.kind ?? "coding";
  return {
    objective: overrides.objective ?? title,
    kind,
    deliveryMode: overrides.deliveryMode ?? (kind === "coding" ? "git-pr" : "report-only"),
    acceptanceCriteria: overrides.acceptanceCriteria ?? [],
    contextPaths: overrides.contextPaths ?? [],
    riskLevel: overrides.riskLevel ?? "medium",
    executionProfile: overrides.executionProfile ?? profileForTaskKind(kind),
  };
}

export function profileForTaskKind(kind: TaskKind): string {
  switch (kind) {
    case "coding": return "worker-coding";
    case "review": return "worker-review";
    case "research": return "worker-research";
    case "browser": return "worker-browser";
    case "writing": return "worker-writing";
    case "operations": return "worker-operations";
  }
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  spec: TaskSpec;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  taskId: string;
  role: string;
  provider: string;
  model: string;
  executionProfile: string;
  status: AgentStatus;
  branch: string | null;
  worktreePath: string | null;
  terminalTitle: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAttempt {
  id: string;
  taskId: string;
  agentId: string;
  attemptNumber: number;
  status: TaskAttemptStatus;
  runtimeId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  failure: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessRuntime {
  id: string;
  kind: RuntimeKind;
  ownerId: string | null;
  attemptId: string | null;
  workspaceKey: string;
  provider: string;
  model: string;
  executionProfile: string;
  workingDirectory: string;
  status: RuntimeStatus;
  supervisorPid: number | null;
  childPid: number | null;
  sessionId: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  launchConfig: RuntimeLaunchConfig;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeLaunchConfig {
  prompt: string;
  codexPath?: string;
  fleetCliPath: string;
  databasePath: string;
}

export interface AgentContext {
  agent: Agent;
  task: Task;
  project: Project;
  attempt?: TaskAttempt | null;
}

export interface PullRequestMerge {
  agentId: string;
  taskId: string;
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  mergedAt: string;
  detectedAt: string;
}

export interface Loop {
  id: string;
  projectId: string | null;
  title: string;
  schedule: string;
  enabled: boolean;
  directoryPath: string | null;
  taskSpec: TaskSpec;
  role: string;
  provider: string;
  model: string;
  lastScheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoopRun {
  id: string;
  loopId: string;
  taskId: string | null;
  status: LoopRunStatus;
  scheduledFor: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface FleetMessage {
  id: string;
  agentId: string | null;
  taskId: string | null;
  attemptId: string | null;
  type: MessageType;
  priority: MessagePriority;
  text: string;
  status: MessageStatus;
  requiresHuman: boolean;
  dedupeKey: string | null;
  decisionId: string | null;
  correlationId: string | null;
  claimToken: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  availableAt: string;
  deliveryAttempts: number;
  deliveredAt: string | null;
  lastError: string | null;
  reminderAt: string | null;
  lastRemindedAt: string | null;
  projectName: string | null;
  agentRole: string | null;
  taskTitle: string | null;
  createdAt: string;
}

export interface MessageClaim {
  message: FleetMessage;
  token: string;
}

export interface Decision {
  id: string;
  messageId: string;
  taskId: string | null;
  agentId: string | null;
  status: DecisionStatus;
  question: string;
  resolution: string | null;
  decidedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AgentReply {
  id: string;
  agentId: string;
  text: string;
  status: AgentReplyStatus;
  replyToMessageId: string | null;
  decisionId: string | null;
  claimToken: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  availableAt: string;
  deliveryAttempts: number;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface ReplyClaim {
  reply: AgentReply;
  token: string;
}

export interface FleetActivity {
  id: string;
  entityType: string;
  entityId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
  projectName: string | null;
  agentRole: string | null;
  taskTitle: string | null;
}

export interface FleetSnapshot {
  projects: Project[];
  tasks: Task[];
  agents: Agent[];
  attempts: TaskAttempt[];
  runtimes: ProcessRuntime[];
  loops: Loop[];
  loopRuns: LoopRun[];
  decisions: Decision[];
  messages: FleetMessage[];
  recentActivity?: FleetActivity[];
}
