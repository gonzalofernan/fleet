# Fleet Architecture

## Goal

Fleet lets a human communicate with one captain agent. The captain delegates work to disposable coding workers, then reports only decisions and outcomes that need the human.

## First usable slice

The first real workflow is deliberately narrow:

1. The captain registers Fleet as a project.
2. The captain creates a task.
3. Fleet creates a Git worktree and a Windows Terminal tab.
4. A Codex worker completes the task on its own branch and opens a pull request.
5. The human reviews the pull request.

## Components

```text
captain agent
  -> Fleet CLI / future MCP server
    -> daemon (scheduler and supervisor)
      -> SQLite state and append-only events
      -> Git worktree adapter
      -> Windows Terminal adapter
      -> coding-agent adapters (Codex first, Claude Code later)
```

Fleet begins as a modular monolith. Adapters are process-local interfaces, not network services.

## State ownership

| Concern | Source of truth |
| --- | --- |
| Agent rules and role instructions | Markdown charters |
| Projects, tasks, agents, runs, schedules | SQLite |
| Human-readable history | append-only event rows and task artifacts |
| Terminal output | bounded log captures, never the authoritative state |

## Safety rules

- A task that changes code never works directly on `main`.
- Lifecycle commands are allowlisted operations, not arbitrary text injected into a terminal.
- `unknown` is safer than guessing whether an agent is idle or complete.
- Workers are stopped and their terminals closed after a completed run unless explicitly retained for diagnosis.
- Pull request merge remains human-authorized in the initial releases.

## Milestones

1. Persistent project/task/agent registry. Complete.
2. Git worktree and Windows Terminal adapters. Complete.
3. Codex CLI adapter with a single worker concurrency limit.
4. Pull request lifecycle and review task type.
5. Loops, resource policies, and a terminal UI.
