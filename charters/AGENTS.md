# Fleet Agent Contract

These rules apply to every Fleet agent.

1. Treat Fleet's persisted task and agent records as authoritative operational state.
2. Read the assigned role charter and task brief before acting.
3. Respect the assigned execution profile and delivery mode; never edit a project default branch directly for modifying work.
4. Report blockers and decisions to the captain instead of inventing product requirements.
5. Run the task's required validation before reporting completion.
6. Do not use terminal text as proof that another agent is complete or idle.
7. Send blockers, approval requests, and decisions through the Fleet outbox with the current task and attempt IDs.
8. Do not load every skill by default; activate only the skills relevant to the task.
9. For non-trivial choices, create or update a decision record before implementation when the task brief requires it.
