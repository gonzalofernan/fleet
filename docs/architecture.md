# Fleet Architecture

## Goal

Fleet gives a human one conversational captain while supervised workers execute bounded coding and non-coding tasks. Operational state must remain correct when terminals close, providers fail, messages race, or pull requests are merged outside Fleet.

## Shape

Fleet is a modular monolith with multiple local runtime processes:

```text
human
  -> captain provider session
    -> Fleet CLI
      -> SQLite control plane and append-only events
      -> terminal, Git, GitHub, provider, and project-context adapters

Windows Terminal tab
  -> Fleet runtime supervisor
    -> one provider child process
    -> one provider session
    -> heartbeat, cancellation, outbox delivery, and maintenance
```

There is no independent bridge or host process. The supervisor is the only owner of the child PID, session ID, heartbeat, and delivery claims for its runtime.

## Domain Model

- `Project` registers one durable repository.
- `TaskSpec` defines objective, task kind, delivery, acceptance, context, risk, and permissions.
- `Task` tracks the requested outcome.
- `Agent` records the selected role, provider, model, profile, branch, and lifecycle.
- `TaskAttempt` represents one execution attempt and never gets reused.
- `ProcessRuntime` owns one supervisor, provider process, session, and heartbeat.
- `FleetMessage` and `AgentReply` are claimed outbox records.
- `Decision` links a human-dependent message to its delivered resolution.
- `Loop` stores a reusable TaskSpec; `LoopRun` records each execution.

State changes pass through explicit transition guards. Terminal records cannot be resurrected. Runtime and attempt binding, runtime singleton ownership, outbox claims, and linked reply creation use SQLite `BEGIN IMMEDIATE` transactions.

## Delivery Semantics

Messages are at-least-once attempted and effectively once-claimed. A claim has a consumer, token, timestamp, attempt count, and availability time. Failed sends are released for retry; expired leases are recovered; records become failed after the configured maximum attempts.

Human-dependent messages create decisions. Queueing a captain reply acknowledges the source message in the same transaction. The message and decision become resolved only after the worker provider confirms delivery.

Terminal agents discard outstanding messages and replies, cancel old decisions, and reject late operational messages into a diagnostic `discarded` state. This prevents stale rows from creating reminder loops.

## Runtime Recovery

Only one active runtime may own a captain workspace or worker agent. Startup claims a `starting` runtime with a compare-and-set on an empty supervisor PID. Heartbeats reject a different PID. Cancellation records intent first and then terminates the exact child process tree.

At captain startup, expired runtimes become failed and their non-terminal agents fail visibly. Legacy captain bridges are terminated only when both their exact Fleet CLI path and legacy command token match.

## Permissions

Execution profiles map task kinds to sandbox and approval settings. Only the captain profile uses `danger-full-access`. Worker profiles are `workspace-write` or `read-only` with non-interactive approvals. A profile must explicitly support the TaskSpec kind before launch.

## Project Memory

SQLite and events are authoritative. `PROJECT.md` and `DECISIONS.md` hold durable knowledge inside the project. `STATUS.md` is regenerated from actual state after lifecycle events and message delivery. Projection failures never fail the underlying task or runtime.

## Pull Requests And Cleanup

Git delivery completes in two phases. A worker first proves commit, push, upstream equality, and PR existence; Fleet moves the task to review and closes the worker runtime/session. Merge reconciliation later matches the exact registered head branch, records the merge once, completes the task when no other agents remain, and idempotently removes the worktree and local Fleet branch.

## Loops And Providers

Manual and scheduled loops use the same TaskSpec, agent, attempt, supervisor, outbox, and completion paths as one-off tasks. Schedules support `@every` intervals and five-field cron.

Providers implement command construction, session discovery, message injection, and session cleanup behind `AgentProviderAdapter`. Codex is the first registered provider. Adding another provider does not change storage or task semantics, but it must implement all required adapter capabilities before Fleet exposes it.

## Testing

Integration tests use temporary real SQLite databases and fake provider/process adapters. They cover migrations, competing claims, linked decisions, terminal hygiene, state transitions, scheduler behavior, runtime ownership, and end-to-end supervisor completion. A separate environment-gated Windows test launches a controlled real child process.
