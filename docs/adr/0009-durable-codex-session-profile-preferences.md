---
status: accepted
---

# Persist Codex Session Profile preferences behind a backend-owned store

After catalog-backed Codex profile controls, the Workbench will persist the direct Session Profile default through one small versioned file-backed preference-store seam owned by the backend, separate from the four-table Work Ledger. Resolution remains `global -> Agent Runtime -> selected model -> explicit selection`: the fixed initial preference is the global fallback, the explicit “Use as default” action atomically records the selected Codex model at Agent Runtime scope and its Work Intensity at that model’s scope, and each catalog load validates the resulting preference against that exact Runtime Catalog without downgrade. Renderer requests contain only opaque keys from the current sanitized snapshot; Execution Mode remains fixed to `single-agent`, Access Mode remains independently fixed to `full-access`, and neither is a mutable persisted preference in this slice. Generic settings, Runtime/Execution/Access changes, multiple Projects, and coordinator-schema changes remain deferred.
