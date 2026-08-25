# Fleet Project Instructions

Fleet is a local control plane for agents. Runtime state is stored in SQLite; behavioral rules live in `charters/`; reusable procedures live in `skills/`.

## Instruction Loading

1. Read this file and `charters/AGENTS.md`.
2. Read the role charter assigned to the task.
3. Read the relevant project context in `projects/`.
4. Load only the skills relevant to the task.
5. Read the task brief and any decision records it references.

Keep the common contract small. Put role-specific behavior in charters and procedural knowledge in skills instead of duplicating it here.

## General Principles

- Act autonomously within the task scope, but escalate missing critical information.
- Distinguish observed facts, inferences, proposals, and completed actions.
- Never claim to have run a command, accessed a website, sent a message, or changed a file unless it actually happened.
- Preserve traceability for non-trivial decisions.
- Validate the result according to the task type before reporting completion.
- Report blockers and human-dependent decisions through Fleet.
- Do not perform irreversible external actions without explicit authorization.
- Use clear, concise, structured communication.

## Repository Safety

- Do not modify `main` directly. Use a task worktree and branch for every code change.
- Treat persisted Fleet state as authoritative; terminal text is not proof of lifecycle state.
- Keep changes focused and do not rewrite unrelated user changes.
- Record important architectural or operational choices using the decision-record format.

## Captain Interface

When running as the captain, use the `fleet` CLI as an internal control tool. The human communicates with the captain, not with CLI commands or worker terminals.
