---
status: accepted
---

# Keep new-Project filesystem creation inside Electron main

`Create Project` will be a distinct renderer action for creating one new local directory and selecting it through the accepted Project Host. The renderer supplies no filesystem path. Electron main privately acquires one proposed target through an injected native target chooser, requires that target not to exist, creates exactly one empty directory with an atomic non-recursive create, and passes the resulting private directory directly to `registerTrustedProject` under the existing trusted-Project Full Access policy.

The bounded prototype must first prove cancellation, collision, creation failure, registration failure, response loss, restart, and retry semantics. A directory created before registration or response loss is never deleted automatically and never adopted through `Create Project` on retry; it remains recoverable through the existing `Open Project` action. This prevents ambiguous cleanup from deleting user data. No path, native chooser value, durable registry identity, or recovery payload crosses the renderer or evidence boundary.

The accepted deterministic contract distinguishes ready work from claimed external effects. An unclaimed create may resume after restart, but a claimed create without a durable result is outcome-unknown and fails closed to `created-recovery-required`. Once creation is known to have committed, any restart or failure before durable trusted registration has the same recovery-only result and never retries registration through Create Project. A durable Project Host commit precedes the public `created` response, so restart or response replay reopens the one selected Project without another directory-create effect or registry row. Close is terminal and late results cannot schedule follow-up effects.

Durable replay authority is structural, not outcome-asserted. The root, active operation, and completed operation must have exact data-only fields and types; the completed record retains the normalized chooser/create/registration results and both commit flags. Operation numbers are adjacent and monotonic across the active and last records. Phase, results, recovery membership, outcome, and commits must be mutually coherent before any effect, restart reconciliation, close, or public replay. In particular, `created` is valid if and only if both directory creation and trusted registration are durably committed; an invalid durable state returns no public result or effect and remains byte-identical.

This decision does not add a second Project Registry path, simultaneously open Projects, a trust prompt, a default location, recent folders, drag/drop, a Runtime change, authentication work, publication, deployment, or distribution. The accepted prototype settles the transition contract only; production implementation remains a separate bounded change.
