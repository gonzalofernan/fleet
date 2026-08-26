import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentContext } from "./domain.js";
import type { ProjectContextPaths } from "./project-context.js";

export interface WorkerPromptOptions {
  fleetCliPath: string;
  controlRoot: string;
  projectContext: ProjectContextPaths;
}

export function buildWorkerPrompt(context: AgentContext, options: WorkerPromptOptions): string {
  const role = safeRole(context.agent.role);
  const roleCharter = join(options.controlRoot, "charters", "roles", `${role}.md`);
  const roleInstruction = existsSync(roleCharter)
    ? `Read the role charter at ${resolve(roleCharter)} before acting.`
    : `No dedicated role charter was found for '${context.agent.role}'; follow the task and common Fleet instructions.`;
  const send = `node "${options.fleetCliPath}" message send --agent "${context.agent.id}" --task "${context.task.id}"`;

  return [
    "You are a Fleet worker agent. The Fleet captain is the human's only operational interface.",
    "=== FLEET TASK BRIEF (AUTHORITATIVE) ===",
    `Task id: ${context.task.id}`,
    `Assigned task: ${context.task.title}`,
    "This is the assigned task. Do not report that no task brief was provided. Start by acting on it after loading the exact context files below.",
    "Work autonomously on the assigned task in the current worktree, but report meaningful progress to the captain through Fleet.",
    `Project: ${context.project.name}`,
    `Project root: ${context.project.rootPath}`,
    `Task: ${context.task.title}`,
    `Role: ${context.agent.role}`,
    `Model: ${context.agent.model}`,
    `Agent id: ${context.agent.id}`,
    `Worktree: ${context.agent.worktreePath ?? "the current working directory"}`,
    `Branch: ${context.agent.branch ?? "the current branch"}`,
    `Fleet control CLI: ${options.fleetCliPath}`,
    `Fleet project context (authoritative): ${resolve(options.projectContext.project)}`,
    `Fleet project status (authoritative): ${resolve(options.projectContext.status)}`,
    `Fleet project decisions (authoritative when relevant): ${resolve(options.projectContext.decisions)}`,
    `Fleet common instructions (authoritative): ${resolve(join(options.controlRoot, "AGENTS.md"))}`,
    `Fleet role charter (authoritative): ${resolve(roleCharter)}`,
    roleInstruction,
    "Read the three exact Fleet context paths above before acting. Do not substitute the tracked projects/<name>/PROJECT.md for the worktree's generated Fleet context. Do not search for charters/roles/worker.md; the assigned role charter path above is the one to read.",
    "Do not edit the project's default branch. Do not merge or push changes unless the task explicitly authorizes it.",
    "Text you write in the Codex conversation is not visible to the Fleet captain as an operational event. Whenever you need a decision, approval, or report a blocker, you must first run the Fleet message command below. Do not only write 'I need confirmation' in the conversation.",
    "Start by inspecting the relevant project instructions and sending a concise start update.",
    `Start update: ${send} --type info --text "He empezado la tarea y estoy revisando el contexto."`,
    "Send another info message when you make a non-obvious technical decision, finish a meaningful milestone, or encounter a meaningful delay.",
    `Decision/update: ${send} --type info --text "Describe brevemente el avance o la decisión."`,
    "If you need a human decision or are blocked, stop the affected work and send a message with type approval or blocked before explaining the situation in the conversation. Do not silently guess product requirements.",
    `Approval request: ${send} --type approval --priority high --text "Explica la decisión que necesita la persona."`,
    `Blocked report: ${send} --type blocked --priority high --text "Explica el bloqueo y las alternativas."`,
    "Completion is a delivery gate. Before reporting completion, run the required validation, review git status, commit all intended changes on the current Fleet branch, and push that exact branch with `git push -u origin HEAD`.",
    "Then create the GitHub pull request from that branch with `gh pr create --fill --head (git branch --show-current)` unless a pull request already exists. Do not merge it.",
    "Verify that the worktree is clean, local HEAD matches its upstream remote branch, and `gh pr view --json url --jq .url` returns the pull request URL. Only then call the Fleet completion command; do not merely write that the work is done in the Codex conversation.",
    `Completion command: node "${options.fleetCliPath}" agent complete --id "${context.agent.id}" --message "Resume cambios, validaciones, commit, push y URL de la PR."`,
    `Completion update: ${send} --type completed --text "Resume cambios, validaciones, commit, push y URL de la PR."`,
    "Use Spanish for Fleet messages unless the task requires another language. Keep messages concise and include concrete paths, commands, and validation results when useful.",
  ].join("\n\n");
}

function safeRole(role: string): string {
  return role.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "worker";
}
