# Fleet

Fleet is a local, terminal-first control plane for coding agents. You speak to a captain agent; the captain will use Fleet to create, supervise, and retire workers.

This first milestone persists projects, tasks, and agents in SQLite. It can provision a Git worktree and open an agent console in Windows Terminal. Connecting a real coding model is the next milestone.

## Requirements

- Node.js 24 or newer
- Git

## Development

```powershell
npm install
npm test
node dist/cli.js project add fleet --path .
node dist/cli.js task create --project <project-id> --title "Add Windows Terminal adapter"
node dist/cli.js agent request --task <task-id> --role implementer
node dist/cli.js agent launch <agent-id>
node dist/cli.js dashboard
node dist/cli.js status
```

Fleet stores control-plane state in `%LOCALAPPDATA%\\Fleet\\fleet.db`. This keeps the captain and workers on one durable registry even when they run from different worktrees.

On first start, Fleet creates `%APPDATA%\\Fleet\\settings.json` and a workspace at `%USERPROFILE%\\Fleet` with this layout:

```text
Fleet/
  projects/    long-lived repositories and PROJECT.md metadata
  loops/       recurring instructions, LOOP.md metadata, and run history
  worktrees/   worker worktrees
  archive/     retired projects, loops, and runs
```

The settings file is the configuration source of truth. SQLite remains the runtime index, so the captain can distinguish projects, loops, tasks, and agents without scanning the workspace.

Model routing defaults to GPT-5.6 Luna for the captain and routine work, Terra for implementation and review, and Sol for architecture or high-risk tasks. The captain can override the recommendation per task.

## Design boundaries

- The user does not operate Fleet commands directly; a captain agent will.
- Markdown charters define agent behavior. SQLite stores runtime state.
- Every modifying worker will eventually receive its own branch and Git worktree.
- The first coding-model adapter will target Codex CLI authenticated with ChatGPT, not the API.
- The captain launches with `danger-full-access` and `never` approvals on this local machine; worker permissions will be configured separately by role.

See [architecture](docs/architecture.md) for the planned components and [charters](charters/) for the instruction hierarchy.
