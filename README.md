# Fleet

Fleet is a local, terminal-first control plane for agentic work. You speak to one captain; the captain creates explicit tasks, delegates them to supervised workers, routes decisions, and retires their processes and workspaces.

Fleet currently uses the Codex CLI authenticated through ChatGPT. The provider boundary is adapter-based, while task profiles support coding, review, research, browser, writing, and operations work.

## Requirements

- Node.js 24 or newer
- Git
- GitHub CLI for `git-pr` delivery
- Codex CLI for captain and worker sessions

## Development

```powershell
npm install
npm test
node dist/cli.js dashboard
node dist/cli.js task create --project <id> --title "Add supervisor health check" --kind coding --delivery git-pr --accept "Tests pass"
node dist/cli.js agent request --task <id> --role implementer
node dist/cli.js agent launch <agent-id>
node dist/cli.js loop create --title "Weekly audit" --project <id> --kind review --schedule "0 9 * * 1"
node dist/cli.js loop run <loop-id>
```

`dashboard` is the compact human-readable overview. It shows active tasks, agents and runtimes, recent projects, recent events, and only canonical pending decisions.

## Runtime

Fleet stores its source of truth in `%LOCALAPPDATA%\Fleet\fleet.db`. Schema migrations preserve existing history while introducing task attempts, supervised runtimes, heartbeats, outbox claims, retries, decisions, and loop runs.

Each captain or worker tab starts one Fleet supervisor. That supervisor owns exactly one provider child process and its session, updates a heartbeat, claims messages atomically, retries failed delivery, and terminates the exact child process tree on cancellation. The former `captain-host`, `captain-bridge`, and `worker-bridge` processes no longer exist. The first launch removes only legacy captain bridges that match this exact Fleet CLI path.

Workers use execution profiles instead of inheriting captain permissions. The captain remains a trusted `danger-full-access` process; coding and writable workers use `workspace-write`; review and research workers use `read-only`. Workers never receive `danger-full-access` by default.

## Task Delivery

Every task has a durable `TaskSpec`: objective, kind, delivery mode, acceptance criteria, context paths, risk, and execution profile. Every launch creates a separate `TaskAttempt` linked atomically to its runtime.

`git-pr` workers must validate, commit, push, create a pull request, and prove that local `HEAD` matches its upstream before Fleet accepts completion. The terminal and Codex session close after delivery. When the PR is merged, Fleet completes the task and removes the worktree and local Fleet branch idempotently.

`report-only` and `conversation-only` tasks do not create commits or pull requests unless their TaskSpec explicitly requires Git delivery.

## Messaging

Worker messages and captain replies are transactional outboxes. A consumer leases each item with a claim token, retries transient failures, and cannot deliver the same record concurrently from two supervisors. Approval, question, and blocker messages create linked decisions. A decision remains pending until the captain's linked reply is actually delivered to the worker.

When an agent becomes terminal, Fleet discards its stale messages and replies and cancels unresolved decisions. Late messages remain in SQLite as discarded diagnostics instead of re-entering the live queue.

## Project Context

Fleet creates `PROJECT.md`, `STATUS.md`, and `DECISIONS.md` inside each managed project repository. `PROJECT.md` contains stable knowledge, `DECISIONS.md` contains durable choices, and `STATUS.md` is a recoverable projection generated from SQLite tasks, events, agents, and decisions. SQLite remains authoritative if writing the projection fails.

The workspace defaults to `%USERPROFILE%\Fleet`:

```text
Fleet/
  projects/    long-lived repositories
  loops/       recurring TaskSpecs and run history
  worktrees/   isolated worker checkouts
  archive/     retired resources
```

## Loops

Loops are reusable TaskSpecs. `manual` loops run only on request. Scheduled loops support `@every 30m` style intervals and five-field cron expressions. The captain supervisor evaluates due loops, records every `LoopRun`, creates a task and attempt, and launches it through the same runtime path as ordinary work.

## Verification

```powershell
npm run check
npm test
$env:FLEET_RUN_WINDOWS_E2E = "1"
npm test
```

The last command enables the opt-in Windows child-process E2E. Normal tests use real SQLite databases with fake provider/process adapters and do not open terminals or consume Codex usage.

See [architecture](docs/architecture.md) and [charters](charters/) for the component and instruction boundaries.
