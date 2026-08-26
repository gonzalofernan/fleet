import type { FleetActivity, FleetMessage, FleetSnapshot } from "./domain.js";

const ACTIVE_AGENT_STATUSES = new Set(["requested", "provisioning", "running", "waiting"]);
const ACTIVE_TASK_STATUSES = new Set(["ready", "running", "review"]);

export interface DashboardOptions {
  recentProjectsLimit?: number;
  recentActivityLimit?: number;
}

export function renderDashboard(snapshot: FleetSnapshot, options: DashboardOptions = {}): string {
  const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
  const activeAgents = snapshot.agents.filter((agent) => ACTIVE_AGENT_STATUSES.has(agent.status));
  const unverified = snapshot.agents.filter((agent) => agent.status === "unknown");
  const pendingHuman = snapshot.messages.filter((message) => message.requiresHuman && message.status !== "resolved");
  const activeTaskIds = new Set(activeAgents.map((agent) => agent.taskId));
  const activeTasks = snapshot.tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status) || activeTaskIds.has(task.id));
  const recentActivity = (snapshot.recentActivity ?? []).slice(0, options.recentActivityLimit ?? 8);
  const recentProjects = summarizeRecentProjects(snapshot, recentActivity, options.recentProjectsLimit ?? 5);
  const lines = [
    "",
    "  FLEET | CURRENT STATUS",
    "  ------------------------------------------------------------",
    `  Projects: ${snapshot.projects.length} | Active tasks: ${activeTasks.length} | Active agents: ${activeAgents.length}`,
    `  Decisions: ${pendingHuman.length} | Unverified workers: ${unverified.length} | Loops: ${snapshot.loops.length}`,
    "",
    "  ACTIVE WORK",
  ];

  const runningRows = activeTasks.flatMap((task) => {
    const project = projectById.get(task.projectId);
    const agents = snapshot.agents.filter((agent) => agent.taskId === task.id && ACTIVE_AGENT_STATUSES.has(agent.status));
    if (agents.length === 0) return [[task.status, project?.name ?? "-", task.title, "-", formatTime(task.createdAt)]];
    return agents.map((agent) => [
      agent.status,
      project?.name ?? "-",
      task.title,
      `${agent.role} (${agent.id.slice(0, 8)})`,
      formatTime(agent.createdAt),
    ]);
  });
  lines.push(...renderRunningItems(runningRows));

  if (unverified.length > 0) {
    lines.push("", "  UNVERIFIED WORKERS");
    const unverifiedRows = unverified.map((agent) => {
      const task = snapshot.tasks.find((entry) => entry.id === agent.taskId);
      return [agent.status, projectById.get(task?.projectId ?? "")?.name ?? "-", task?.title ?? "-", agent.role, agent.branch ?? "-"];
    });
    lines.push(...renderUnverifiedItems(unverifiedRows));
  }

  lines.push("", "  RECENT PROJECTS");
  lines.push(...renderProjectItems(recentProjects));

  lines.push("", "  RECENT ACTIVITY");
  lines.push(...renderActivityItems(recentActivity));

  lines.push("", "  PENDING HUMAN DECISIONS");
  const decisionRows = pendingHuman.map((message) => [
    message.priority,
    message.projectName ?? "-",
    `${message.agentRole ?? "agent"} / ${message.taskTitle ?? "task"}`,
    message.text,
  ]);
  lines.push(...renderDecisionItems(decisionRows));

  lines.push("  ------------------------------------------------------------", "");
  return lines.join("\n");
}

type DashboardRow = string[];

function renderRunningItems(rows: DashboardRow[]): string[] {
  if (rows.length === 0) return ["  - none"];
  return rows.flatMap(([status, project, task, agent, since]) => [
    `  - ${fit(`${status} | ${project} | ${agent}`, 88)}`,
    `    Task: ${fit(task, 82)}`,
    `    Since: ${since}`,
  ]);
}

function renderUnverifiedItems(rows: DashboardRow[]): string[] {
  return rows.flatMap(([status, project, task, role, branch]) => [
    `  - ${fit(`${status} | ${project} | ${role}`, 88)}`,
    `    Task: ${fit(task, 82)}`,
    `    Branch: ${fit(branch, 81)}`,
  ]);
}

function renderProjectItems(entries: Array<{ project: { name: string }; lastActivity: string; state: string }>): string[] {
  if (entries.length === 0) return ["  - none"];
  return entries.flatMap((entry) => [
    `  - ${fit(entry.project.name, 88)}`,
    `    Last activity: ${formatTime(entry.lastActivity)} | State: ${fit(entry.state, 53)}`,
  ]);
}

function renderActivityItems(activities: FleetActivity[]): string[] {
  if (activities.length === 0) return ["  - none"];
  return activities.flatMap((activity) => [
    `  - ${formatTime(activity.createdAt)} | ${fit(activity.projectName ?? "Fleet", 70)}`,
    `    ${fit(describeActivity(activity), 84)}`,
  ]);
}

function renderDecisionItems(rows: DashboardRow[]): string[] {
  if (rows.length === 0) return ["  - none"];
  return rows.flatMap(([priority, project, source, decision]) => [
    `  - ${priority.toUpperCase()} | ${fit(project, 26)} | ${fit(source, 48)}`,
    `    Need: ${fit(decision, 80)}`,
  ]);
}

function summarizeRecentProjects(snapshot: FleetSnapshot, activity: FleetActivity[], limit: number): Array<{ project: { id: string; name: string }; lastActivity: string; state: string }> {
  const taskById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const agentByTaskId = new Map<string, typeof snapshot.agents>();
  for (const agent of snapshot.agents) {
    const agents = agentByTaskId.get(agent.taskId) ?? [];
    agents.push(agent);
    agentByTaskId.set(agent.taskId, agents);
  }
  const messageByProjectId = new Map<string, FleetMessage[]>();
  for (const message of snapshot.messages) {
    const task = message.taskId ? taskById.get(message.taskId) : undefined;
    if (!task) continue;
    const messages = messageByProjectId.get(task.projectId) ?? [];
    messages.push(message);
    messageByProjectId.set(task.projectId, messages);
  }

  return snapshot.projects
    .map((project) => {
      const projectTasks = snapshot.tasks.filter((task) => task.projectId === project.id);
      const projectAgents = projectTasks.flatMap((task) => agentByTaskId.get(task.id) ?? []);
      const projectMessages = messageByProjectId.get(project.id) ?? [];
      const projectActivity = activity.filter((entry) => entry.projectName === project.name);
      const timestamps = [
        project.createdAt,
        ...projectTasks.map((task) => task.createdAt),
        ...projectAgents.map((agent) => agent.createdAt),
        ...projectMessages.map((message) => message.createdAt),
        ...projectActivity.map((entry) => entry.createdAt),
      ];
      const pending = projectMessages.some((message) => message.requiresHuman && message.status !== "resolved");
      const active = projectAgents.filter((agent) => ACTIVE_AGENT_STATUSES.has(agent.status)).length;
      const latestTask = [...projectTasks].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      const state = pending ? "needs human decision" : active > 0 ? `${active} active agent${active === 1 ? "" : "s"}` : latestTask?.status ?? "registered";
      return { project, lastActivity: timestamps.sort().at(-1) ?? project.createdAt, state };
    })
    .sort((left, right) => right.lastActivity.localeCompare(left.lastActivity))
    .slice(0, Math.max(1, limit));
}

function describeActivity(activity: FleetActivity): string {
  const payload = activity.payload;
  const message = typeof payload.text === "string" ? payload.text : "";
  const role = activity.agentRole ?? "agent";
  if (activity.eventType === "created" && activity.entityType === "project") return `Project created: ${payload.name ?? activity.projectName ?? "unknown"}`;
  if (activity.eventType === "created" && activity.entityType === "task") return `Task created: ${activity.taskTitle ?? payload.title ?? "unknown"}`;
  if (activity.eventType === "created" && activity.entityType === "agent") return `Agent requested: ${payload.role ?? role}`;
  if (activity.eventType === "created" && activity.entityType === "loop") return `Loop created: ${payload.title ?? "unknown"}`;
  if (activity.eventType === "created" && activity.entityType === "message") return `Message ${payload.type ?? "info"}: ${message}`;
  if (activity.eventType === "status") return `Agent ${role} -> ${payload.status ?? "updated"}${message ? `: ${message}` : ""}`;
  if (activity.eventType === "provisioned") return `Agent provisioned: ${role}`;
  if (activity.eventType === "recovered") return `Worker recovered: ${role}`;
  if (activity.eventType === "reply_queued") return `Reply queued for ${role}`;
  if (activity.eventType === "session_attached") return `Codex session attached to ${role}`;
  return `${activity.eventType} ${activity.entityType}`;
}

function fit(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function formatTime(value: string): string {
  return value.slice(0, 16).replace("T", " ");
}
