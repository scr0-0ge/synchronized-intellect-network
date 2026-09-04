---
status: accepted
---

# Continue one selected Agent Session through the durable Project Channel

The Workbench will treat an Agent Session as a persistent Project-owned conversation with one immutable Session Profile and a one-to-many sequence of Direct Project Commands. A command explicitly either starts a new Agent Session or continues the currently selected resumable Agent Session; continuation retains the original Project, Codex Runtime, model, Work Intensity, `single-agent` Execution Mode, and `full-access` Access Mode, and dispatches through the accepted opaque `resume` Adapter capability rather than starting a replacement native Session.

The existing four-table Work Ledger will move behind a versioned, fail-closed coordinator migration. Durable acceptance stores the command kind, canonical digest version, private input, target link, and ordered cursor before any external effect; an Agent Session stores its immutable profile and opaque native reference only in trusted backend state. Accepted work remains serial. A crash before a claimed effect may be retried from durable state, while a claimed external effect without a durably committed outcome becomes `recovery-required` with outcome unknown and blocks later dispatch instead of being blindly replayed. Legacy rows remain observable, but only completed rows with a valid committed opaque reference are resumable.

Renderer requests use only sanitized, snapshot-scoped selection keys, and the backend resolves those keys to trusted Agent Session targets. The first command in an empty Project may still start a Session; when a resumable Session is selected, the same composer continues it and does not allow its profile to drift. This slice does not add a separate new-Session control, steer/interrupt, Project management, multiple Projects, Runtime/Execution/Access changes, generic settings, Claude, Runtime idempotency/reconciliation, or a coordinator rewrite.
