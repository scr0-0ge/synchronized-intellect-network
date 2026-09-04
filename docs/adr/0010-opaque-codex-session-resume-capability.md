---
status: accepted
---

# Add opaque Codex Agent Session resume at the Agent Runtime seam

After durable Codex Session Profile preferences, the next production deepening will add the already-planned resume capability at the `AgentRuntimeAdapter` seam before changing coordinator or renderer behavior. A started binding exposes exactly one opaque native Session reference to trusted backend callers, and `resume` accepts that reference together with the immutable Project directory and effective Session Profile. The Codex Adapter owns `thread/resume`, exact identity/profile/access validation, one-input lifecycle, normalized events, and complete transport shutdown; native identifiers, payloads, authentication facts, and paths never cross the Workbench renderer seam.

This is intentionally an Adapter-only slice. It does not yet change the four-table Work Ledger, resume from the production composer, add a new Agent Session button, expose intervention controls, switch Runtime/Execution/Access, or invoke Claude. A separate deterministic state prototype will establish the durable multi-command Agent Session transitions and crash/recovery semantics before the coordinator schema is changed.
