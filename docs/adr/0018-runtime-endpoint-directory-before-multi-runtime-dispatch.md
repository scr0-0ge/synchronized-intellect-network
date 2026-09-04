---
status: accepted
---

# Put endpoint resolution and Work Order authorization behind one production seam

Before production can dispatch across Agent Runtimes, one deep Runtime Endpoint Directory Module will own immutable endpoint identity, sanitized capability snapshots, exact-snapshot endpoint/profile resolution, local policy checks, and private Adapter selection. A Runtime-neutral Work Order may name only opaque snapshot keys and bounded intent; the local coordinator binds the actual Supervisor Session, durably accepts the Work Order, then asks this Module to resolve and authorize it before any Adapter effect.

The first production slice will prove this seam with at least two in-memory endpoint Adapters while keeping the running application on its single existing Codex endpoint. It will not add a live second Runtime, provider protocol, network listener or tunnel, persistence migration, renderer workflow, authentication mechanism, or Access/trust change; Runtime-owned authentication, opaque native Session references, uniform explicit Full Access, restrictive Access, and durable effect ordering remain unchanged.

Issue 27 implements that foundation as `createRuntimeEndpointDirectory(registrations)`, returning one Interface with only `snapshot()` and `authorizeAcceptedWorkOrder(accepted, boundSupervisor)`. The Module clones immutable trusted registration data, publishes frozen sanitized exact-snapshot keys, and keeps the selected Adapter plus native Session Profile in ECMAScript-private state. The bounded Work Order contains only its idempotency key, objective/input, directory/endpoint/profile keys, requested Access Mode, budget, and concurrency; the actual Supervisor Session is bound separately. Authorization returns frozen start eligibility after confirmed durable acceptance and performs no Adapter inspection, start, resume, process, filesystem, persistence, or network effect. Current Electron composition does not import or call the factory and still constructs only the accepted Codex Adapter.
