import { GitWorktreeAdapter } from "./adapters/git-worktree.js";
import { WindowsTerminalAdapter } from "./adapters/windows-terminal.js";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { buildCaptainPrompt } from "./captain.js";
import { isKnownModel, recommendModel } from "./models.js";
import type { Agent } from "./domain.js";
import { FleetStore } from "./storage.js";
import { ensureSettings, type FleetSettings } from "./settings.js";

export class FleetService {
  constructor(
    private readonly store: FleetStore,
    private readonly worktrees = new GitWorktreeAdapter(),
    private readonly terminals = new WindowsTerminalAdapter(),
    private readonly settings: FleetSettings = ensureSettings(),
  ) {}

  launchAgent(agentId: string): Agent {
    const context = this.store.getAgentContext(agentId);
    const worktree = this.worktrees.create(context.project.rootPath, agentId);
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
      workingDirectory,
      model,
      prompt: buildCaptainPrompt(this.store.snapshot(), this.settings),
    });
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
}
