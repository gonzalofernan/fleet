import type { FleetSnapshot } from "./domain.js";

export function renderDashboard(snapshot: FleetSnapshot): string {
  const active = snapshot.agents.filter((agent) => ["provisioning", "running", "waiting"].includes(agent.status)).length;
  const unverified = snapshot.agents.filter((agent) => agent.status === "unknown").length;
  const pending = snapshot.messages.filter((message) => message.requiresHuman && message.status !== "resolved");
  const lines = [
    "",
    "  FLEET CONTROL PLANE",
    "  Local agent registry",
    "",
    `  Projects  ${snapshot.projects.length}     Tasks  ${snapshot.tasks.length}     Loops  ${snapshot.loops.length}     Pending  ${pending.length}`,
    `  Workers   ${active} active     ${unverified} unverified`,
    "  -----------------------------------------------------------------",
  ];
  if (snapshot.agents.length === 0) lines.push("  No agents have been requested.");
  for (const agent of snapshot.agents) {
    const task = snapshot.tasks.find((entry) => entry.id === agent.taskId);
    lines.push(`  ${agent.status.padEnd(11)} ${agent.id.slice(0, 8)}  ${agent.role.padEnd(12)} ${agent.model.padEnd(15)} ${task?.title ?? "Unknown task"}`);
    if (agent.worktreePath) lines.push(`              branch: ${agent.branch}  worktree: ${agent.worktreePath}`);
  }
  if (snapshot.loops.length > 0) {
    lines.push("", "  LOOPS");
    for (const loop of snapshot.loops) {
      lines.push(`  ${loop.enabled ? "enabled" : "paused "}     ${loop.title} (${loop.schedule})`);
    }
  }
  if (pending.length > 0) {
    lines.push("", "  PENDING HUMAN DECISIONS");
    for (const message of pending) {
      const source = [message.projectName, message.agentRole, message.taskTitle].filter(Boolean).join(" / ") || "Unattributed agent message";
      lines.push(`  ${message.priority.padEnd(7)} ${message.status.padEnd(12)} ${source}`);
      lines.push(`           ${message.text}`);
    }
  }
  lines.push("  -----------------------------------------------------------------", "");
  return lines.join("\n");
}
