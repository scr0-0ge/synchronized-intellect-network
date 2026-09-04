---
status: accepted
---

# Mediate every local/cloud delegation through the local Workbench coordinator

Supervisor and Worker are Agent Session roles, not properties of a model, provider, or execution location. Any authorized Agent Runtime Endpoint may therefore host either role: a local open-weight Supervisor may dispatch a cloud Worker, a cloud Supervisor may dispatch a local Worker, and a remote or local open-weight Supervisor may dispatch the same or a different local open-weight model.

The models do not connect directly to each other. A Supervisor produces one structured, bounded Work Order through a Workbench-owned tool Interface; the local coordinator binds the actual Supervisor identity, durably accepts and authorizes the Work Order, resolves opaque Runtime Endpoint and Session Profile selections, then starts the Worker through that endpoint's Agent Runtime Adapter. Normalized progress and the Handoff return through the Work Ledger and Supervisor Inbox. For a cloud Supervisor this tool request returns over its already-open local Runtime session rather than an internet-reachable control port; the selected Session may still exercise the full host capabilities of its explicit Access Mode through that local Runtime.

Each endpoint owns its transport, capability discovery, authentication, native Session lifecycle, and local or remote execution details behind the existing Agent Runtime seam. The Workbench never passes credentials, native references, or private paths between models; host capability is granted only through the selected Session's visible Access Mode. Direct peer-to-peer model networking, provider credential brokering, automatic public tunneling, and model-name-based trust are rejected; same-name local and remote models remain distinct endpoints with independently authorized Access, budget, concurrency, and capability policy. See ADR 0017 for the uniform Full Access ceiling.
