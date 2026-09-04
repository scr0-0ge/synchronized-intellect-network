---
status: accepted
---

# Deepen ProjectChannel observation into durable live follow

The next Codex-only production slice will deepen the existing `ProjectChannel.observe()` Interface rather than add a second subscription method or expose an event-emitter seam. Observation without a cursor yields one consistent Project snapshot and then follows later durable updates. Observation with `after` first replays every durable update after that cursor, then waits for later commits without gaps or duplicates.

The SQLite-backed module will hide catch-up queries, race-free in-process wakeups, multiple-observer bookkeeping, cancellation, and channel-close completion behind the existing AsyncIterable Interface. A slow observer reads again from the durable ledger instead of accumulating an unbounded in-memory queue. Cross-process writers remain deferred because an in-process wakeup cannot observe another process reliably.

Finite consumers such as the accepted read-only Workbench shell capture a snapshot tail, consume through that cursor, and close their iterator; this preserves finite replay without weakening the shared live Interface. Tests cross the public `ProjectChannel` seam and must prove snapshot-to-live continuity, cursor catch-up, cancellation, close behavior, and restart durability.
