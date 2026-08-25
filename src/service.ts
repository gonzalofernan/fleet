import { GitWorktreeAdapter } from "./adapters/git-worktree.js";
import { WindowsTerminalAdapter } from "./adapters/windows-terminal.js";
import type { Agent } from "./domain.js";
import { FleetStore } from "./storage.js";

export class FleetService {
  constructor(
    private readonly store: FleetStore,
    private readonly worktrees = new GitWorktreeAdapter(),
    private readonly terminals = new WindowsTerminalAdapter(),
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
}
