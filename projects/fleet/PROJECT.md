# Fleet Project Context

## Purpose

Fleet is a local, terminal-first control plane where a human communicates with one captain agent. The captain delegates bounded work to isolated agents and reports decisions and outcomes back to the human.

## Current Boundaries

- Runtime state is stored in SQLite.
- Agent behavior is defined by Markdown charters and skills.
- Coding work uses Git branches and worktrees.
- Codex CLI is the first agent provider; provider adapters should remain replaceable.
- The human authorizes pull-request merges and irreversible external actions.

## Decision Records

Architecture decisions are stored in `docs/decisions/`. New records should use `templates/DECISION.md` and a sequential filename.

## Validation

For code changes, run `npm test` and `npm run check` before reporting completion.
