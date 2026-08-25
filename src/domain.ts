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

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AgentStatus = (typeof AGENT_STATUSES)[number];

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
  createdAt: string;
}

export interface Agent {
  id: string;
  taskId: string;
  role: string;
  provider: string;
  model: string;
  status: AgentStatus;
  branch: string | null;
  worktreePath: string | null;
  terminalTitle: string | null;
  createdAt: string;
}

export interface AgentContext {
  agent: Agent;
  task: Task;
  project: Project;
}

export interface Loop {
  id: string;
  projectId: string | null;
  title: string;
  schedule: string;
  enabled: boolean;
  directoryPath: string | null;
  createdAt: string;
}

export interface FleetSnapshot {
  projects: Project[];
  tasks: Task[];
  agents: Agent[];
  loops: Loop[];
}
