---
status: accepted
---

# Select a direct Codex Session Profile through an opaque catalog snapshot

After the fixed direct-submission path proved durable acceptance and live execution, the first profile-control slice will let the backend lazily inspect the Codex Runtime Catalog and expose only sanitized display values plus opaque option keys. One atomic submission references the exact loaded snapshot; the backend maps those keys to a model and Effort Level while retaining the accepted `single-agent` Execution Mode and independent `full-access` Access Mode. This avoids trusting renderer-supplied native values or silently downgrading defaults, while keeping construction and Project observation runtime-free and deferring persisted preferences, Access changes, runtime switching, Claude, and intervention controls.
