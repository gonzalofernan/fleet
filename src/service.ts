import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { GitWorktreeAdapter } from "./adapters/git-worktree.js";
import { GitHubPullRequestAdapter, type PullRequestLookup } from "./adapters/github-pull-request.js";
import { WindowsTerminalAdapter } from "./adapters/windows-terminal.js";
import { buildCaptainPrompt } from "./captain.js";
import { ensurePullRequest, validateWorktreeReadyForCompletion } from "./completion.js";
import type { Agent, LoopRun, ProcessRuntime, TaskAttempt } from "./domain.js";
import { assertProfileSupportsTask } from "./execution-profiles.js";
import { isKnownModel, recommendModel } from "./models.js";
import { terminateLegacyCaptainBridges } from "./legacy-runtime.js";
import { initializeProjectContext, refreshProjectStatusFromFleet } from "./project-context.js";
import { isLoopDue } from "./scheduler.js";
import { ensureSettings, type FleetSettings } from "./settings.js";
import { defaultDatabasePath, FleetStore } from "./storage.js";
import { buildWorkerPrompt } from "./worker.js";

export interface AgentLaunch {
  agent: Agent;
  attempt: TaskAttempt;
  runtime: ProcessRuntime;
}

export class FleetService {
  private readonly worktrees: GitWorktreeAdapter;

  constructor(
    private readonly store: FleetStore,
    worktrees?: GitWorktreeAdapter,
    private readonly terminals = new WindowsTerminalAdapter(),
    private readonly settings: FleetSettings = ensureSettings(),
    private readonly pullRequests: PullRequestLookup = new GitHubPullRequestAdapter(),
  ) {
    this.worktrees = worktrees ?? new GitWorktreeAdapter(settings.worktreesDirectory);
  }

  launchAgent(agentId: string): AgentLaunch {
    let context = this.store.getAgentContext(agentId);
    if (context.agent.provider !== "codex") {
      throw new Error(`Provider ${context.agent.provider} is configured on the agent but no supervised adapter is registered yet.`);
    }
    assertProfileSupportsTask(context.agent.executionProfile, context.task.spec.kind);
    const activeWorkers = this.store.snapshot().runtimes.filter((runtime) => runtime.kind === "worker" && ["starting", "running", "cancelling"].includes(runtime.status));
    if (activeWorkers.length >= this.settings.maxConcurrentAgents) {
      throw new Error(`Fleet concurrency limit reached (${this.settings.maxConcurrentAgents})`);
    }
    const codexPath = findCodexPath();
    const fleetCliPath = resolve(process.argv[1] ?? join(process.cwd(), "dist", "cli.js"));
    const databasePath = process.env.FLEET_DB || defaultDatabasePath();
    const projectContext = initializeProjectContext(this.settings, context.project.name, context.project.rootPath);
    let agent = context.agent;
    if (!agent.worktreePath || !agent.branch) {
      const worktree = this.worktrees.create(context.project.rootPath, agentId);
      const terminalTitle = `FLEET | ${context.project.name} | ${agentId.slice(0, 8)}`;
      agent = this.store.provisionAgent(agentId, { branch: worktree.branch, worktreePath: worktree.path, terminalTitle });
    } else if (!["requested", "provisioning", "waiting"].includes(agent.status)) {
      throw new Error(`Agent ${agentId} cannot be launched from ${agent.status}`);
    }
    context = this.store.getAgentContext(agentId);
    const attempt = this.store.createTaskAttempt(agentId);
    const runtime = this.store.createRuntime({
      kind: "worker",
      ownerId: agentId,
      attemptId: attempt.id,
      workspaceKey: context.project.rootPath,
      provider: context.agent.provider,
      model: context.agent.model,
      executionProfile: context.agent.executionProfile,
      workingDirectory: context.agent.worktreePath!,
      launchConfig: {
        prompt: buildWorkerPrompt(context, { fleetCliPath, controlRoot: dirname(dirname(fleetCliPath)), projectContext, attemptId: attempt.id }),
        codexPath,
        fleetCliPath,
        databasePath,
      },
    });
    const boundAttempt = this.store.getAttempt(attempt.id);
    try {
      this.terminals.launch({
        runtimeId: runtime.id,
        title: context.agent.terminalTitle!,
        workingDirectory: runtime.workingDirectory,
        fleetCliPath,
        databasePath,
      });
    } catch (error) {
      const message = `No se pudo abrir el runtime del agente: ${errorMessage(error)}`;
      this.store.finishRuntime(runtime.id, "failed", null, message);
      this.store.updateAgentStatus(agentId, "failed", message);
      this.refreshProject(context.project.id, message);
      throw error;
    }
    this.refreshProject(context.project.id, `Nuevo intento ${boundAttempt.attemptNumber} para: ${context.task.title}`);
    return { agent: this.store.getAgent(agentId), attempt: boundAttempt, runtime };
  }

  launchCaptain(workingDirectory: string): ProcessRuntime {
    const codexPath = findCodexPath();
    const fleetCliPath = resolve(process.argv[1] ?? join(process.cwd(), "dist", "cli.js"));
    const databasePath = process.env.FLEET_DB || defaultDatabasePath();
    terminateLegacyCaptainBridges(fleetCliPath);
    this.reconcileProject(workingDirectory);
    for (const stale of this.store.reapStaleRuntimes(new Date(Date.now() - this.settings.runtimeStaleMs).toISOString())) {
      if (stale.kind !== "worker" || !stale.ownerId) continue;
      const agent = this.store.getAgent(stale.ownerId);
      if (!["completed", "failed", "cancelled"].includes(agent.status)) {
        this.store.updateAgentStatus(agent.id, "failed", `El heartbeat del runtime ${stale.id.slice(0, 8)} expiró.`);
      }
    }
    const existing = this.store.findActiveCaptainRuntime(workingDirectory);
    if (existing) throw new Error(`Fleet captain is already running in runtime ${existing.id.slice(0, 8)}`);
    const model = process.env.FLEET_CAPTAIN_MODEL || recommendModel("captain");
    if (!isKnownModel(model)) throw new Error(`Unknown captain model: ${model}`);
    const runtime = this.store.createRuntime({
      kind: "captain",
      ownerId: null,
      attemptId: null,
      workspaceKey: workingDirectory,
      provider: "codex",
      model,
      executionProfile: "captain",
      workingDirectory,
      launchConfig: {
        prompt: buildCaptainPrompt(this.store.snapshot(), this.settings),
        codexPath,
        fleetCliPath,
        databasePath,
      },
    });
    try {
      this.terminals.launchCaptain({ runtimeId: runtime.id, workingDirectory, fleetCliPath, databasePath });
    } catch (error) {
      this.store.finishRuntime(runtime.id, "failed", null, `No se pudo abrir Windows Terminal: ${errorMessage(error)}`);
      throw error;
    }
    return runtime;
  }

  completeAgent(agentId: string, message: string): Agent {
    const context = this.store.getAgentContext(agentId);
    if (context.agent.status === "completed") return context.agent;
    if (context.task.spec.deliveryMode !== "git-pr") {
      const completed = this.store.updateAgentStatus(agentId, "completed", message);
      this.refreshProject(context.project.id, message);
      return completed;
    }
    if (!context.agent.worktreePath || !context.agent.branch) throw new Error(`Agent ${agentId} has no provisioned worktree`);
    ensurePullRequest(context.agent.worktreePath, context.agent.branch);
    const proof = validateWorktreeReadyForCompletion(context.agent.worktreePath, context.agent.branch);
    const summary = `${message}\nCommit: ${proof.commit}\nUpstream: ${proof.upstream}\nPull request: ${proof.pullRequestUrl}`;
    const completed = this.store.updateAgentStatus(agentId, "completed", summary);
    this.refreshProject(context.project.id, `PR preparada para revisión: ${proof.pullRequestUrl}`);
    return completed;
  }

  cancelAgent(agentId: string, reason: string): Agent {
    const runtime = this.store.findActiveRuntimeForAgent(agentId);
    if (runtime) this.store.requestRuntimeCancellation(runtime.id, reason);
    const agent = this.store.cancelAgent(agentId, reason);
    const context = this.store.getAgentContext(agentId);
    this.refreshProject(context.project.id, `Agente ${agentId.slice(0, 8)} cancelado: ${reason}`);
    return agent;
  }

  reconcileProject(projectRoot: string): Agent[] {
    const normalizedRoot = resolve(projectRoot);
    const project = this.store.findProjectByRoot(normalizedRoot) ?? this.store.addProject(basename(normalizedRoot), normalizedRoot);
    initializeProjectContext(this.settings, project.name, project.rootPath);
    const recovered: Agent[] = [];
    for (const worktree of this.worktrees.list(normalizedRoot)) {
      if (this.store.findAgentByWorktree(worktree.path)) continue;
      const task = this.store.createTask(project.id, `Recovered worker worktree ${worktree.branch}`);
      const shortId = worktree.branch.replace("fleet/agent-", "");
      recovered.push(this.store.recoverAgent(task.id, {
        branch: worktree.branch,
        worktreePath: worktree.path,
        terminalTitle: `FLEET | ${project.name} | ${shortId}`,
      }));
    }
    return recovered;
  }

  reconcileMergedPullRequests(projectRoot?: string): PullRequestReconciliation {
    const selectedProject = projectRoot ? this.store.findProjectByRoot(resolve(projectRoot)) : null;
    if (projectRoot && !selectedProject) throw new Error(`Unknown project root: ${projectRoot}`);
    const projects = selectedProject ? [selectedProject] : this.store.listProjects();
    const snapshot = this.store.snapshot();
    const merged: ReconciledPullRequest[] = [];
    const errors: PullRequestReconciliationError[] = [];
    for (const project of projects) {
      const agents = snapshot.agents.filter((agent) => agent.branch && !["failed", "cancelled"].includes(agent.status));
      for (const agent of agents) {
        const context = this.store.getAgentContext(agent.id);
        if (context.project.id !== project.id || !agent.branch || context.task.spec.deliveryMode !== "git-pr") continue;
        try {
          const pullRequest = this.pullRequests.findMergedPullRequest(project.rootPath, agent.branch);
          if (!pullRequest) continue;
          const recorded = this.store.recordPullRequestMerge(agent.id, pullRequest);
          if (this.settings.autoCleanupWorktrees && agent.worktreePath) {
            this.worktrees.remove(project.rootPath, { branch: agent.branch, path: agent.worktreePath });
          }
          if (!recorded) continue;
          merged.push({ ...recorded, projectName: project.name });
          this.refreshProject(project.id, `PR #${pullRequest.number} fusionada: ${pullRequest.url}`);
        } catch (error) {
          errors.push({ agentId: agent.id, projectName: project.name, message: errorMessage(error) });
        }
      }
    }
    return { merged, errors };
  }

  runLoop(loopId: string, scheduledFor = new Date()): LoopExecution {
    const loop = this.store.getLoop(loopId);
    if (!loop.projectId) throw new Error(`Loop ${loopId} needs a project before Fleet can execute it`);
    const run = this.store.createLoopRun(loopId, scheduledFor.toISOString());
    try {
      const task = this.store.createTask(loop.projectId, `${loop.title} [${run.id.slice(0, 8)}]`, loop.taskSpec);
      this.store.updateLoopRun(run.id, "running", { taskId: task.id });
      const agent = this.store.requestAgent(task.id, loop.role, loop.provider, loop.model, loop.taskSpec.executionProfile);
      const launch = this.launchAgent(agent.id);
      return { run: this.store.getLoopRun(run.id), launch };
    } catch (error) {
      this.store.updateLoopRun(run.id, "failed", { error: errorMessage(error) });
      throw error;
    }
  }

  runDueLoops(asOf = new Date()): LoopMaintenanceResult {
    this.reconcileLoopRuns();
    const launched: LoopExecution[] = [];
    const errors: Array<{ loopId: string; message: string }> = [];
    for (const loop of this.store.snapshot().loops) {
      try {
        if (isLoopDue(loop, asOf)) launched.push(this.runLoop(loop.id, asOf));
      } catch (error) {
        errors.push({ loopId: loop.id, message: errorMessage(error) });
      }
    }
    return { launched, errors };
  }

  refreshProject(projectId: string, activity: string): boolean {
    try {
      const project = this.store.getProject(projectId);
      refreshProjectStatusFromFleet(this.settings, project, this.store.snapshot(), activity);
      return true;
    } catch {
      // STATUS.md is a recoverable projection; SQLite remains authoritative.
      return false;
    }
  }

  private reconcileLoopRuns(): void {
    const snapshot = this.store.snapshot();
    for (const run of snapshot.loopRuns.filter((entry) => ["queued", "running"].includes(entry.status) && entry.taskId)) {
      const task = snapshot.tasks.find((entry) => entry.id === run.taskId);
      if (!task) continue;
      if (task.status === "completed") this.store.updateLoopRun(run.id, "completed");
      if (task.status === "failed") this.store.updateLoopRun(run.id, "failed", { error: "Loop task failed" });
      if (task.status === "cancelled") this.store.updateLoopRun(run.id, "cancelled");
    }
  }
}

export interface LoopExecution { run: LoopRun; launch: AgentLaunch }
export interface LoopMaintenanceResult { launched: LoopExecution[]; errors: Array<{ loopId: string; message: string }> }

export interface ReconciledPullRequest {
  projectName: string;
  merge: { number: number; url: string; mergedAt: string };
  agent: Agent;
  task: { id: string; title: string; status: string };
  taskCompleted: boolean;
}

export interface PullRequestReconciliationError { agentId: string; projectName: string; message: string }
export interface PullRequestReconciliation { merged: ReconciledPullRequest[]; errors: PullRequestReconciliationError[] }

function findCodexPath(): string {
  const codexPath = process.env.FLEET_CODEX_PATH ?? join(process.env.APPDATA ?? "", "npm", "codex.cmd");
  if (!existsSync(codexPath)) throw new Error("Codex CLI was not found. Set FLEET_CODEX_PATH to the codex.cmd executable.");
  return codexPath;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
