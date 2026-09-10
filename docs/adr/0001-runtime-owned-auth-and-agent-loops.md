---
status: accepted
---

# Keep authentication and agent loops inside official runtimes

The Workbench will own the unified UI, preferences, Work Ledger, Supervisor automation, and runtime-neutral coordination protocol, while official Agent Runtimes retain authentication, model execution, tools, permissions, and native session lifecycle. Codex, Claude, OpenCode, and future local runtimes enter through Adapters; the Workbench will neither broker subscription credentials nor reimplement their agent loops. This avoids coupling the product to OpenCode's backend model or to private provider transports while still allowing selective reuse of OpenCode's MIT-licensed UI code.

Narrowly amended by ADR-0022 (docs/adr/0022-api-transport-credential-envelope.md): the Workbench may, and only may, store key-form credentials for API-transport Runtime Endpoints; every other statement above — including the ban on brokering subscription credentials — remains in force.
