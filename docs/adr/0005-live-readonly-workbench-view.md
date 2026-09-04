---
status: accepted
---

# Replace the captured renderer read with one live read-only Project view

After durable live `ProjectChannel.observe()` was accepted, the next production slice will carry that observation through the Electron shell without adding mutation or Agent Runtime launch. The renderer-facing Interface will replace the one-shot `readCapturedProject` operation with one `observeProject(listener)` operation whose idempotent disposer ends the observation. The old renderer read operation will not remain as a second public path.

A deep Workbench view Module will hide durable-cursor catch-up, full-view projection, burst coalescing, ordinal key stability, sanitization, failure mapping, and cancellation. It yields an initial sanitized full Project view and then monotonically newer full views; callers do not merge raw `ProjectChannel` updates or learn Project, command, Session, native-runtime, database, or filesystem identifiers.

Electron transport remains a narrow Adapter over fixed channels with sender validation and one active observation per window. The UI stays read-only and preserves the approved A desktop plus B narrow-screen information architecture. Direct input, `ProjectChannel.act()`, Agent Runtime inspection/start, cross-process writers, multi-Project behavior, and Supervisor automation remain deferred.
