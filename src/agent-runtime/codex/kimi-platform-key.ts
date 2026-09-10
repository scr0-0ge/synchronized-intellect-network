/**
 * Identity constants for the kimi-platform endpoint API-transport key
 * (ticket 17). The subject binds every envelope this Workbench writes for the
 * kimi-platform endpoint; the keyName is the endpoint-scoped opaque short
 * identifier and satisfies the keyName syntax
 * `/^[a-z0-9][a-z0-9._-]{0,64}$/`. Envelopes for all endpoints coexist in
 * the single store file `endpoint-secret-envelope-store.json` (ADR 0022
 * multi-subject shape); the store file lives in the Electron userData
 * directory (`%APPDATA%\synchronized-intellect-network` on Windows).
 *
 * Design of record: docs/adr/0022-api-transport-credential-envelope.md.
 */

/** Envelope subject binding every kimi-platform endpoint secret envelope. */
export const KIMI_PLATFORM_ENDPOINT_KEY_SUBJECT =
  "workbench://runtime-endpoint/kimi-platform";

/** Endpoint-scoped opaque short identifier for stored kimi-platform keys. */
export const KIMI_PLATFORM_ENDPOINT_KEY_NAME = "kimi-platform";

/**
 * Shared multi-subject store file name — byte-identical to the GLM/Kimi/
 * DeepSeek-side constants on purpose: one store file, many subjects.
 */
export const KIMI_PLATFORM_ENDPOINT_SECRET_STORE_FILE_NAME =
  "endpoint-secret-envelope-store.json";
