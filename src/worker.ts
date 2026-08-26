import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentContext } from "./domain.js";
import type { ProjectContextPaths } from "./project-context.js";

export interface WorkerPromptOptions {
  fleetCliPath: string;
  controlRoot: string;
  projectContext: ProjectContextPaths;
  attemptId: string;
}

export function buildWorkerPrompt(context: AgentContext, options: WorkerPromptOptions): string {
  const role = safeRole(context.agent.role);
  const roleCharter = join(options.controlRoot, "charters", "roles", `${role}.md`);
  const roleInstruction = existsSync(roleCharter)
    ? `Read the role charter at ${resolve(roleCharter)} before acting.`
    : `No dedicated role charter was found for '${context.agent.role}'; follow the task and common Fleet instructions.`;
  const messageBase = [
    `node "${options.fleetCliPath}" message send`,
    `--agent "${context.agent.id}"`,
    `--task "${context.task.id}"`,
    `--attempt "${options.attemptId}"`,
  ].join(" ");
  const task = context.task.spec;

  return [
    "You are a Fleet worker. The Fleet captain is the human's only operational interface.",
    "=== FLEET TASK SPEC (AUTHORITATIVE) ===",
    `Task id: ${context.task.id}`,
    `Attempt id: ${options.attemptId}`,
    `Objective: ${task.objective}`,
    `Kind: ${task.kind}`,
    `Delivery mode: ${task.deliveryMode}`,
    `Risk: ${task.riskLevel}`,
    `Acceptance criteria:\n${task.acceptanceCriteria.length ? task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n") : "- Deliver the stated objective and report concrete verification."}`,
    `Additional context paths:\n${task.contextPaths.length ? task.contextPaths.map((path) => `- ${path}`).join("\n") : "- none"}`,
    `Project: ${context.project.name}`,
    `Repository: ${context.project.rootPath}`,
    `Role: ${context.agent.role}`,
    `Provider/model: ${context.agent.provider}/${context.agent.model}`,
    `Execution profile: ${context.agent.executionProfile}`,
    `Worktree: ${context.agent.worktreePath ?? "the current working directory"}`,
    `Branch: ${context.agent.branch ?? "the current branch"}`,
    `Fleet control CLI: ${options.fleetCliPath}`,
    `Project context: ${resolve(options.projectContext.project)}`,
    `Project status: ${resolve(options.projectContext.status)}`,
    `Project decisions: ${resolve(options.projectContext.decisions)}`,
    `Common instructions: ${resolve(join(options.controlRoot, "AGENTS.md"))}`,
    `Role charter: ${resolve(roleCharter)}`,
    roleInstruction,
    "Read the exact context paths above before acting. PROJECT.md is stable knowledge; STATUS.md is generated operational state; DECISIONS.md contains durable choices.",
    "The conversation text alone is not an operational event. Use Fleet messaging immediately for progress, questions, approvals, blockers, and completion. Never wait silently for a response after merely writing a question in this terminal.",
    `Start update: ${messageBase} --type info --dedupe-key "attempt:${options.attemptId}:started" --text "He empezado la tarea y estoy revisando el contexto."`,
    `Progress update: ${messageBase} --type info --dedupe-key "attempt:${options.attemptId}:milestone:<name>" --text "Describe brevemente el avance y su verificación."`,
    `Approval request: ${messageBase} --type approval --priority high --dedupe-key "attempt:${options.attemptId}:decision:<name>" --text "Explica la decisión exacta, alternativas y recomendación."`,
    `Blocked report: ${messageBase} --type blocked --priority high --dedupe-key "attempt:${options.attemptId}:blocker:<name>" --text "Explica el bloqueo, evidencia y alternativas."`,
    deliveryInstructions(context, options),
    "Use Spanish for Fleet messages unless the task requires another language. Keep them concise, factual, and specific enough for the captain to act without rereading the terminal.",
  ].join("\n\n");
}

function deliveryInstructions(context: AgentContext, options: WorkerPromptOptions): string {
  const completion = `node "${options.fleetCliPath}" agent complete --id "${context.agent.id}" --message`;
  const completionMessage = `node "${options.fleetCliPath}" message send --agent "${context.agent.id}" --task "${context.task.id}" --attempt "${options.attemptId}" --type completed --dedupe-key "attempt:${options.attemptId}:completed" --text`;
  if (context.task.spec.deliveryMode === "git-pr") {
    return [
      "Delivery gate: run validation, inspect git status, commit all intended changes on the assigned Fleet branch, and push exactly that branch with `git push -u origin HEAD`.",
      "Create a GitHub pull request with `gh pr create --fill --head (git branch --show-current)` unless one already exists. Never merge it without an explicit instruction.",
      "Verify the worktree is clean, local HEAD equals the upstream branch, and `gh pr view --json url --jq .url` returns the PR URL.",
      `${completion} "Resume cambios, validaciones, commit, push y URL de la PR."`,
      `${completionMessage} "Resume cambios, validaciones, commit, push y URL de la PR."`,
    ].join("\n");
  }
  return [
    `Delivery gate: this is a ${context.task.spec.deliveryMode} task. Do not create a commit, push, or pull request unless the task explicitly adds that requirement.`,
    "Produce the requested result, verify it against the acceptance criteria, and include any artifact paths or evidence in the completion summary.",
    `${completion} "Resume el resultado, criterios verificados, evidencia y rutas de artefactos."`,
    `${completionMessage} "Resume el resultado, criterios verificados, evidencia y rutas de artefactos."`,
  ].join("\n");
}

function safeRole(role: string): string {
  return role.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "worker";
}
