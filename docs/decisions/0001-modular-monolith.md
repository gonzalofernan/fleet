# 0001: Start as a modular monolith

## Decision

Fleet runs as one local application with SQLite storage. Each interactive captain or worker gets a small local supervisor process, while agent, terminal, and workspace integrations remain adapters behind local interfaces.

## Rationale

The first version runs on one Windows computer and needs transparent failure recovery more than distributed scalability. One database and process-local adapters make state inspection and testing straightforward; per-runtime supervisors provide exact process ownership without introducing a network service.

## Consequences

Remote agents and a web dashboard remain possible later, but they cannot define the initial data model or operational complexity.
Supervisors must coordinate through SQLite transactions and heartbeats rather than in-memory singleton assumptions.
