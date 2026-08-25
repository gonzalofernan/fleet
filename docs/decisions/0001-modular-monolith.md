# 0001: Start as a modular monolith

## Decision

Fleet runs as one local Node.js process with SQLite storage. Agent, terminal, and workspace integrations are adapters behind local interfaces.

## Rationale

The first version runs on one Windows computer and needs transparent failure recovery more than distributed scalability. A single process and one database make state inspection and testing straightforward.

## Consequences

Remote agents and a web dashboard remain possible later, but they cannot define the initial data model or operational complexity.

