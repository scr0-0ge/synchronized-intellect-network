/**
 * Identity constants for the DeepSeek API endpoint API-transport key
 * (ticket 12, design of record 2026-09-04). The subject binds every
 * envelope this Workbench writes for the DeepSeek endpoint; the keyName is
 * the endpoint-scoped opaque short identifier and satisfies the keyName
 * syntax `/^[a-z0-9][a-z0-9._-]{0,64}$/`. Envelopes for all endpoints
 * coexist in the single store file `endpoint-secret-envelope-store.json`
 * (ADR 0022 multi-subject shape); the store file lives in the Electron
 * userData directory (`%APPDATA%\synchronized-intellect-network` on Windows).
 *
 * Design of record: docs/adr/0022-api-transport-credential-envelope.md.
 *
 * This module deliberately pins only the identity constants. The store /
 * probe / IPC source that consumes them (mirroring the GLM
 * `createWorkbenchGlmEndpointKeySource` shape) is wiring-ticket territory:
 * composition, roster, backend, coordinator, and settings are explicitly
 * out of scope for this lazy-module ticket.
 *
 * DeepSeek-specific facts the wiring ticket must carry: the endpoint has
 * no subscription face (id/keyName deliberately carry no "plan"), the
 * preferred probe is the zero-inference `GET /models` with a Bearer
 * header, a probe success only proves auth+connectivity — NEVER model
 * identity, because unknown model names are silently mapped to
 * `deepseek-v4-flash` (see deepseek-catalog.ts hard design constraint) —
 * and pricing is off-peak halved outside UTC business hours.
 */

/** Envelope subject binding every DeepSeek endpoint secret envelope. */
export const DEEPSEEK_ENDPOINT_KEY_SUBJECT =
  "workbench://runtime-endpoint/deepseek-api";

/** Endpoint-scoped opaque short identifier for stored DeepSeek keys. */
export const DEEPSEEK_ENDPOINT_KEY_NAME = "deepseek-api";

/**
 * Shared multi-subject store file name — byte-identical to the GLM-side
 * constant on purpose: one store file, many subjects (ADR 0022).
 */
export const DEEPSEEK_ENDPOINT_SECRET_STORE_FILE_NAME =
  "endpoint-secret-envelope-store.json";
