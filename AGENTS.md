# Fleet Project Instructions

Fleet is a local control plane for coding agents. Runtime state is stored in SQLite; behavioral rules live in `charters/`.

At the start of a task, read `charters/AGENTS.md` and the role charter named by the task prompt. Do not modify `main` directly. Use a task worktree and branch for every code change.

When running as the captain, use the `fleet` CLI as an internal control tool. The human communicates with the captain, not with CLI commands or worker terminals.
