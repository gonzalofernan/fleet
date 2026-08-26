import { GitWorktreeAdapter } from "./adapters/git-worktree.js";
import { GitHubPullRequestAdapter, type PullRequestLookup } from "./adapters/github-pull-request.js";
import { WindowsTerminalAdapter } from "./adapters/windows-terminal.js";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildCaptainPrompt } from "./captain.js";
import { isKnownModel, recommendModel } from "./models.js";
import type { Agent } from "./domain.js";
import { defaultDatabasePath, FleetStore } from "./storage.js";
import { ensureSettings, type FleetSettings } from "./settings.js";
import { buildWorkerPrompt } from "./worker.js";
import { ensurePullRequest, validateWorktreeReadyForCompletion } from "./completion.js";
import { initializeProjectContext } from "./project-context.js";

export class FleetService {
  constructor(
    private readonly store: FleetStore,
    private readonly worktrees = new GitWorktreeAdapter(),
    private readonly terminals = new WindowsTerminalAdapter(),
    private readonly settings: FleetSettings = ensureSettings(),
    private readonly pullRequests: PullRequestLookup = new GitHubPullRequestAdapter(),
  ) {}

  launchAgent(agentId: string): Agent {
    const context = this.store.getAgentContext(agentId);
    if (context.agent.provider !== "codex") {
      throw new Error(`Provider ${context.agent.provider} is not implemented yet; only Codex workers can be launched.`);
    }
    const codexPath = process.env.FLEET_CODEX_PATH ?? join(process.env.APPDATA ?? "", "npm", "codex.cmd");
    if (!existsSync(codexPath)) {
      throw new Error("Codex CLI was not found. Set FLEET_CODEX_PATH to the codex.cmd executable.");
    }
    const worktree = this.worktrees.create(context.project.rootPath, agentId);
    const projectContext = initializeProjectContext(this.settings, context.project.name, worktree.path);
    const terminalTitle = `FLEET | ${context.project.name} | ${agentId.slice(0, 8)}`;
    const agent = this.store.provisionAgent(agentId, {
      branch: worktree.branch,
      worktreePath: worktree.path,
      terminalTitle,
    });
    this.terminals.launch({
      title: terminalTitle,
      workingDirectory: worktree.path,
      taskTitle: context.task.title,
      agentId,
      taskId: context.task.id,
      codexPath,
      fleetCliPath: resolve(process.argv[1] ?? join(process.cwd(), "dist", "cli.js")),
      databasePath: process.env.FLEET_DB || defaultDatabasePath(),
      model: context.agent.model,
      prompt: buildWorkerPrompt({
        ...context,
        agent: { ...context.agent, branch: worktree.branch, worktreePath: worktree.path },
      }, {
        fleetCliPath: resolve(process.argv[1] ?? join(process.cwd(), "dist", "cli.js")),
        controlRoot: process.cwd(),
        projectContext,
      }),
    });
    return agent;
  }

  launchCaptain(workingDirectory: string): void {
    const codexPath = process.env.FLEET_CODEX_PATH ?? join(process.env.APPDATA ?? "", "npm", "codex.cmd");
    if (!existsSync(codexPath)) {
      throw new Error("Codex CLI was not found. Set FLEET_CODEX_PATH to the codex.cmd executable.");
    }
    this.reconcileProject(workingDirectory);
    const model = process.env.FLEET_CAPTAIN_MODEL || recommendModel("captain");
    if (!isKnownModel(model)) throw new Error(`Unknown captain model: ${model}`);
    this.terminals.launchCaptain({
      codexPath,
      fleetCliPath: process.argv[1] ?? join(process.cwd(), "dist", "cli.js"),
      databasePath: process.env.FLEET_DB || defaultDatabasePath(),
      workingDirectory,
      model,
      prompt: buildCaptainPrompt(this.store.snapshot(), this.settings),
    });
  }

  completeAgent(agentId: string, message: string): Agent {
    const context = this.store.getAgentContext(agentId);
    if (context.agent.status === "completed") return context.agent;
    if (!context.agent.worktreePath || !context.agent.branch) {
      throw new Error(`Agent ${agentId} has no provisioned worktree`);
    }
    ensurePullRequest(context.agent.worktreePath, context.agent.branch);
    const proof = validateWorktreeReadyForCompletion(context.agent.worktreePath, context.agent.branch);
    const summary = `${message}\nCommit: ${proof.commit}\nUpstream: ${proof.upstream}\nPull request: ${proof.pullRequestUrl}`;
    return this.store.updateAgentStatus(agentId, "completed", summary);
  }

  reconcileProject(projectRoot: string): Agent[] {
    const project = this.store.findProjectByRoot(projectRoot) ?? this.store.addProject(basename(projectRoot), projectRoot);
    const recovered: Agent[] = [];
    for (const worktree of this.worktrees.list(projectRoot)) {
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
    const project = projectRoot ? this.store.findProjectByRoot(projectRoot) : null;
    if (projectRoot && !project) throw new Error(`Unknown project root: ${projectRoot}`);
    const projects = project ? [project] : this.store.listProjects();
    const merged: ReconciledPullRequest[] = [];
    const errors: PullRequestReconciliationError[] = [];
    const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
    for (const project of projects) {
      const agents = this.store.snapshot().agents.filter((agent) => agent.branch && !terminalStatuses.has(agent.status));
      for (const agent of agents) {
        const context = this.store.getAgentContext(agent.id);
        if (context.project.id !== project.id || !agent.branch) continue;
        try {
          const pullRequest = this.pullRequests.findMergedPullRequest(project.rootPath, agent.branch);
          if (!pullRequest) continue;
          const recorded = this.store.recordPullRequestMerge(agent.id, pullRequest);
          if (recorded) merged.push({ ...recorded, projectName: project.name });
        } catch (error) {
          errors.push({ agentId: agent.id, projectName: project.name, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return { merged, errors };
  }
}

export interface ReconciledPullRequest {
  projectName: string;
  merge: { number: number; url: string; mergedAt: string };
  agent: Agent;
  task: { id: string; title: string; status: string };
  taskCompleted: boolean;
}

export interface PullRequestReconciliationError {
  agentId: string;
  projectName: string;
  message: string;
}

export interface PullRequestReconciliation {
  merged: ReconciledPullRequest[];
  errors: PullRequestReconciliationError[];
}
