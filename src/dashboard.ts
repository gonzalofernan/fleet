import type { FleetSnapshot } from "./domain.js";

export function renderDashboard(snapshot: FleetSnapshot): string {
  const active = snapshot.agents.filter((agent) => ["provisioning", "running", "waiting"].includes(agent.status)).length;
  const lines = [
    "",
    "  FLEET CONTROL PLANE",
    "  Local agent registry",
    "",
    `  Projects  ${snapshot.projects.length}     Tasks  ${snapshot.tasks.length}     Active agents  ${active}`,
    "  -----------------------------------------------------------------",
  ];
  if (snapshot.agents.length === 0) lines.push("  No agents have been requested.");
  for (const agent of snapshot.agents) {
    const task = snapshot.tasks.find((entry) => entry.id === agent.taskId);
    lines.push(`  ${agent.status.padEnd(11)} ${agent.id.slice(0, 8)}  ${agent.role.padEnd(12)} ${task?.title ?? "Unknown task"}`);
    if (agent.worktreePath) lines.push(`              branch: ${agent.branch}  worktree: ${agent.worktreePath}`);
  }
  lines.push("  -----------------------------------------------------------------", "");
  return lines.join("\n");
}
