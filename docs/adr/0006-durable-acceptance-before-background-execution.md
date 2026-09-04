---
status: accepted
---

# Return durable command acceptance before background Agent Runtime execution

`ProjectChannel.act(command)` already promises a durable `CommandReceipt`, not externally completed work, but its current implementation waits for the complete Agent Runtime turn before resolving. Before exposing UI input, align the implementation with the existing Interface: commit the idempotent command and accepted update, return its receipt, and continue the one-command execution pipeline in managed background work.

The deep coordinator Module will keep acceptance ordering, canonical idempotency, one-at-a-time external execution, profile resolution, runtime events, fixed failures, restart recovery, observation wakeups, and channel shutdown behind the unchanged `ProjectChannel` Interface. Same-key retries never enqueue another effect; conflicting payloads still fail. Channel close stops new calls and observers, then safely coordinates already scheduled work before closing SQLite. Calls inside an Agent Runtime Adapter that have no cancellation Interface may delay close until they settle; no timeout, second queue Interface, detached promise, or generic job system is introduced.

This decision does not yet expose renderer input or start a live production Codex Session. It prepares the durable temporal contract required by that later bounded slice while preserving one Project, one database, one direct input, same-process serialization, runtime-owned authentication, and restart-to-recovery-required behavior.
