/**
 * Identity constants for the Kimi Code endpoint API-transport key (ticket
 * 11, design of record 2026-09-04). The subject binds every envelope this
 * Workbench writes for the Kimi endpoint; the keyName is the
 * endpoint-scoped opaque short identifier and satisfies the keyName syntax
 * `/^[a-z0-9][a-z0-9._-]{0,64}$/`. Envelopes for all endpoints coexist in
 * the single store file `endpoint-secret-envelope-store.json` (ADR 0022
 * multi-subject shape); the store file lives in the Electron userData
 * directory (`%APPDATA%\synchronized-intellect-network` on Windows).
 *
 * Design of record: docs/adr/0022-api-transport-credential-envelope.md.
 *
 * This module deliberately pins only the identity constants. The store /
 * probe / IPC source that consumes them (mirroring the GLM
 * `createWorkbenchGlmEndpointKeySource` shape) is wiring-ticket territory:
 * composition, roster, backend, coordinator, and settings are explicitly
 * out of scope for this lazy-module ticket.
 *
 * Kimi-specific facts the wiring ticket must carry: authentication is
 * Bearer-only (an x-api-key header is not accepted), keys are created in
 * the Kimi Code console with a hard limit of 5 and are shown exactly once
 * at creation (the reveal UX copy must warn: a lost key can only be
 * recreated), and the client must not tamper with the User-Agent
 * identifier (subscription-face terms).
 */

/** Envelope subject binding every Kimi endpoint secret envelope. */
export const KIMI_ENDPOINT_KEY_SUBJECT =
  "workbench://runtime-endpoint/kimi-code";

/** Endpoint-scoped opaque short identifier for stored Kimi keys. */
export const KIMI_ENDPOINT_KEY_NAME = "kimi-code";

/**
 * Shared multi-subject store file name — byte-identical to the GLM-side
 * constant on purpose: one store file, many subjects (ADR 0022).
 */
export const KIMI_ENDPOINT_SECRET_STORE_FILE_NAME =
  "endpoint-secret-envelope-store.json";
