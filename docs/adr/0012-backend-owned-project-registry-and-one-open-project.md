---
status: accepted
---

# Own the local Project Registry and one open Project in the Workbench host

After the deterministic Project-registry prototype, the Workbench will add one backend-owned Project Registry separate from every Project's Work Ledger and compose it with the unchanged per-Project Workbench backend through a deep Project Host Module. The host owns canonical trusted-directory registration, versioned atomic registry state, private ledger-slot mapping, startup reopening, and serialized switching while keeping at most one `ProjectChannel` open; its renderer Interface exposes only basename labels, availability, selection state, and snapshot-scoped opaque keys. Renderer-supplied paths, native directory selection, simultaneously open Projects, coordinator or Agent Runtime Interface changes, and any host-trust change remain separate later decisions.
