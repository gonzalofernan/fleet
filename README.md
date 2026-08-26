# Fleet

Fleet is a local, terminal-first control plane for coding agents. You speak to a captain agent; the captain will use Fleet to create, supervise, and retire workers.

Fleet persists projects, tasks, and agents in SQLite, provisions isolated Git worktrees, and launches real Codex workers in Windows Terminal tabs. Workers report lifecycle updates, decisions, blockers, and validation results through the Fleet registry.

## Requirements

- Node.js 24 or newer
- Git

## Development

```powershell
npm install
npm test
node dist/cli.js project create fleet
node dist/cli.js project clone existing-project --url https://github.com/example/existing-project.git
node dist/cli.js task create --project <project-id> --title "Add Windows Terminal adapter"
node dist/cli.js agent request --task <task-id> --role implementer
node dist/cli.js agent launch <agent-id>
node dist/cli.js dashboard
node dist/cli.js status
node dist/cli.js github sync
```

`node dist/cli.js dashboard` is the human-readable Fleet overview. It shows active tasks and agents, unverified workers, recent projects, recent lifecycle activity, and unresolved human decisions. Use `--recent-projects <n>` or `--recent-activity <n>` to keep the terminal compact.

Fleet stores control-plane state in `%LOCALAPPDATA%\\Fleet\\fleet.db`. This keeps the captain and workers on one durable registry even when they run from different worktrees.

On first start, Fleet creates `%APPDATA%\\Fleet\\settings.json` and a workspace at `%USERPROFILE%\\Fleet` with this layout:

```text
Fleet/
  projects/    long-lived repositories
  loops/       recurring instructions, LOOP.md metadata, and run history
  worktrees/   worker worktrees
  archive/     retired projects, loops, and runs
```

The settings file is the configuration source of truth. SQLite remains the runtime index, so the captain can distinguish projects, loops, tasks, and agents without scanning the workspace. Fleet does not maintain a parallel global context directory: durable project context is generated inside each repository after it is added or cloned.

The captain and workers use the named Windows Terminal window `fleet`. The captain runs as a native Codex CLI session; each worker runs Codex in its own worktree and publishes structured messages into SQLite with `fleet message send`. Each project contains its durable `PROJECT.md`, `STATUS.md`, and `DECISIONS.md` context files, so every worktree can read the same project memory naturally. Small bridge processes associate each live Codex session with Fleet and use `codex queue` for captain-to-worker replies and worker-to-captain events. The captain also checks this durable registry at the beginning of each operational turn.

Worker completion is gated: Fleet accepts `agent complete` only when the assigned worktree is clean, the expected branch has a commit, an upstream remote exists, local `HEAD` matches that upstream, and `gh pr view` returns a pull request URL. Workers are instructed to run `git push -u origin HEAD` and `gh pr create --fill` before requesting completion; otherwise Fleet keeps the agent waiting and reports the missing delivery step to the captain. After the worker reaches a terminal state, Fleet removes its Codex session and runtime session pointer; the worker shell exits so Windows Terminal can close that tab, while the completed agent record remains as history.

Fleet also checks GitHub every five minutes while the Captain Host is running. It queries `gh` only for merged PRs whose head branch exactly matches a registered active agent branch, records the PR number, URL and merge timestamp, and then completes the agent. The task is completed only when it has no other active agents. You can run the same check on demand with `fleet github sync` (or restrict it with `--project <repository-path>`).

Model routing defaults to GPT-5.6 Luna for the captain and routine work, Terra for implementation and review, and Sol for architecture or high-risk tasks. The captain can override the recommendation per task.

## Design boundaries

- The user does not operate Fleet commands directly; a captain agent will.
- Markdown charters define agent behavior. SQLite stores runtime state.
- Every modifying worker will eventually receive its own branch and Git worktree.
- The first coding-model adapter will target Codex CLI authenticated with ChatGPT, not the API.
- The captain launches with `danger-full-access` and `never` approvals on this local machine; worker permissions will be configured separately by role.

See [architecture](docs/architecture.md) for the planned components and [charters](charters/) for the instruction hierarchy.
