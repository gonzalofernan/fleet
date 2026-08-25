# Fleet

Fleet is a local, terminal-first control plane for coding agents. You speak to a captain agent; the captain will use Fleet to create, supervise, and retire workers.

This first milestone persists projects, tasks, and requested agents in SQLite. It intentionally does not yet launch a terminal or a coding model.

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
node dist/cli.js status
```

Fleet stores local runtime state in `.fleet/fleet.db`. This directory is intentionally ignored by Git.

## Design boundaries

- The user does not operate Fleet commands directly; a captain agent will.
- Markdown charters define agent behavior. SQLite stores runtime state.
- Every modifying worker will eventually receive its own branch and Git worktree.
- The first real runtime adapter will target Codex CLI authenticated with ChatGPT, not the API.

See [architecture](docs/architecture.md) for the planned components and [charters](charters/) for the instruction hierarchy.

