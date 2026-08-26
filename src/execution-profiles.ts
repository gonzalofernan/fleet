import type { TaskKind } from "./domain.js";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "never" | "on-request" | "untrusted";

export interface ExecutionProfile {
  id: string;
  label: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  taskKinds: readonly TaskKind[];
  requiresWorktree: boolean;
  description: string;
}

export const EXECUTION_PROFILES: readonly ExecutionProfile[] = [
  {
    id: "captain",
    label: "Fleet captain",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    taskKinds: ["coding", "review", "research", "browser", "writing", "operations"],
    requiresWorktree: false,
    description: "Trusted local control plane. The captain is the only human-facing runtime.",
  },
  {
    id: "worker-coding",
    label: "Coding worker",
    sandbox: "workspace-write",
    approvalPolicy: "never",
    taskKinds: ["coding"],
    requiresWorktree: true,
    description: "Can modify only its isolated workspace and cannot escalate permissions interactively.",
  },
  {
    id: "worker-review",
    label: "Review worker",
    sandbox: "read-only",
    approvalPolicy: "never",
    taskKinds: ["review"],
    requiresWorktree: true,
    description: "Read-only adversarial review and verification.",
  },
  {
    id: "worker-research",
    label: "Research worker",
    sandbox: "read-only",
    approvalPolicy: "never",
    taskKinds: ["research"],
    requiresWorktree: true,
    description: "Read-only research that reports through Fleet.",
  },
  {
    id: "worker-browser",
    label: "Browser worker",
    sandbox: "workspace-write",
    approvalPolicy: "never",
    taskKinds: ["browser"],
    requiresWorktree: true,
    description: "Browser-oriented work with artifact writes limited to its workspace.",
  },
  {
    id: "worker-writing",
    label: "Writing worker",
    sandbox: "workspace-write",
    approvalPolicy: "never",
    taskKinds: ["writing"],
    requiresWorktree: true,
    description: "Document production in an isolated workspace without system-wide access.",
  },
  {
    id: "worker-operations",
    label: "Operations worker",
    sandbox: "workspace-write",
    approvalPolicy: "never",
    taskKinds: ["operations"],
    requiresWorktree: true,
    description: "Bounded local operations. Escalations are reported to the captain instead of auto-approved.",
  },
];

export function getExecutionProfile(id: string): ExecutionProfile {
  const profile = EXECUTION_PROFILES.find((entry) => entry.id === id);
  if (!profile) throw new Error(`Unknown execution profile: ${id}`);
  return profile;
}

export function assertProfileSupportsTask(profileId: string, kind: TaskKind): ExecutionProfile {
  const profile = getExecutionProfile(profileId);
  if (!profile.taskKinds.includes(kind)) throw new Error(`Execution profile ${profileId} does not support ${kind} tasks`);
  return profile;
}
