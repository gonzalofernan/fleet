# Fleet Architecture

## Goal

Fleet lets a human communicate with one captain agent. The captain delegates work to disposable coding workers, then reports only decisions and outcomes that need the human.

## First usable slice

The first real workflow is deliberately narrow:

1. The captain registers Fleet as a project.
2. The captain creates a task.
3. Fleet creates a Git worktree and a Windows Terminal tab in the shared `fleet` window.
4. A Codex worker receives the task context, reports progress through Fleet, and completes the task on its own branch.
5. The human reviews the pull request.

## Components

```text
captain agent
  -> Fleet CLI / future MCP server
    -> daemon (scheduler and supervisor)
      -> SQLite state, messages, replies, and append-only events
      -> Git worktree adapter
      -> Windows Terminal adapter
      -> coding-agent adapters (Codex first, Claude Code later)
      -> Codex session bridges for queued inter-agent messages
```

Fleet begins as a modular monolith. Adapters are process-local interfaces, not network services.

## State ownership

| Concern | Source of truth |
| --- | --- |
| Agent rules and role instructions | Markdown charters |
| Projects, tasks, agents, runs, schedules | SQLite |
| Human-readable history | append-only event rows and task artifacts |
| Durable project context | `PROJECT.md`, `STATUS.md`, and `DECISIONS.md` inside each project repository |
| Terminal output | bounded log captures, never the authoritative state |

## Safety rules

- A task that changes code never works directly on `main`.
- Lifecycle commands are allowlisted operations, not arbitrary text injected into a terminal.
- `unknown` is safer than guessing whether an agent is idle or complete.
- Workers are stopped and their terminals closed after a completed run unless explicitly retained for diagnosis.
- A worker is not complete until its worktree is clean and its local `HEAD` matches the configured upstream branch.
- A worker is not complete until its pushed branch has a GitHub pull request; merge remains a separate human-authorized action.
- Completing a worker retires its Codex session and runtime session pointer, but preserves the agent record and lifecycle events for history.
- Pull request merge remains human-authorized in the initial releases.

## Milestones

1. Persistent project/task/agent registry. Complete.
2. Git worktree and Windows Terminal adapters. Complete.
3. Codex CLI adapter with real worker sessions, session bridges, and a single worker concurrency limit. Complete for the first local slice.
4. Pull request lifecycle and review task type.
5. Loops, resource policies, and a terminal UI.
