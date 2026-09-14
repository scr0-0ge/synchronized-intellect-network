---
status: accepted
---

# Keep the first auto-iteration loop in the Project authority

The first loop will extend the existing Project SQLite authority. Work Orders,
attempts, Handoffs, role inbox entries, review decisions, and pending delivery
actions must commit through its caller-owned transaction boundary. The dormant
ADR-0020 ledger cannot be opened beside it unchanged: it owns a second SQLite
connection and rejects every schema object outside its private seven-table
fingerprint. Its transition, idempotency, effect-claim, and slot-accounting logic
remain useful, but lane A will move that logic behind the Project store rather
than preserve the old storage interface.

Business progress and Runtime execution remain separate. `WorkOrderStatus`
continues through delivery, review, and integration; the existing
`RuntimeWorkOrderLifecycle` and monotonic slot state belong only to an
`ExecutionAttempt`. A Handoff therefore cannot by itself prove that a process
slot or workspace is safe to release.

`RoleSlot` is the stable inbox address. `SupervisorTenure` binds that role to a
host-known Session and generation, so rotation changes the binding rather than
worker report destinations. Model-tool requests carry an idempotency key,
expected record version, and observed tenure, while the MCP bridge supplies the
actual Session identity separately. The bridge exposes only the supervisor or
worker request unions in the frozen coordinator contract.

Session creation reuses the production `DurableRuntimeEndpointId` and
`SessionProfile`; model and `effortLevel` are already per-Session adapter inputs.
The record distinguishes requested, Runtime-confirmed, and unknown effective
configuration. Existing renderer profile projections may present that fact,
but they are not a second state authority.
