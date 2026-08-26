# 0002: Supervised runtimes and claimed outboxes

## Context

Separate captain hosts and message bridges created independent polling loops with no shared process owner. A stale bridge could inject duplicate messages, while cancellation changed a database status without guaranteeing child-process or decision cleanup.

## Decision

Every captain and worker terminal runs one Fleet supervisor. The supervisor owns one provider child PID, provider session, heartbeat, cancellation path, and outbox consumer identity.

Messages and replies use transactional claims with leases, retry counters, and availability timestamps. Human-dependent messages create linked decisions. Decisions resolve only when their linked reply is delivered.

## Consequences

Runtime ownership and delivery can be tested without a real model using provider and process fakes. Stale runtimes become visible failures instead of silent process guesses. Provider adapters must implement command, session, injection, and cleanup capabilities before registration.
