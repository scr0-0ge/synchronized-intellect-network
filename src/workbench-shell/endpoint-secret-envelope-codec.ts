import { createHash } from "node:crypto";

/**
 * Self-describing secret envelope format for API-transport Runtime Endpoint keys.
 *
 * Mechanism provenance (cleanroom): the *behavioral idea* — a ciphertext string
 * that names its own digest algorithm and carries a digest of its owner subject,
 * so ownership can be verified WITHOUT decrypting (precisely the situation where
 * decryption is impossible because the platform keychain is down) — comes from
 * `docs/github issue 2 backup.txt` #7. Every constant, identifier, separator
 * scheme and validation rule below is authored fresh for unified-agent-workbench;
 * nothing is copied from the upstream repository.
 *
 * Design of record: docs/adr/0022-api-transport-credential-envelope.md.
 *
 * Wire shape (4 dot-separated segments):
 *
 *   uaw-env1.sha256.<64 lowercase hex owner digest>.<base64url ciphertext>
 *
 * - `uaw-env1`: project namespace (uaw = unified-agent-workbench) + "env" for
 *   envelope + format version 1. Greppable, collision-proof against arbitrary
 *   base64 blobs, and the trailing digit allows future format migration without
 *   sniffing heuristics.
 * - `sha256`: the only digest algorithm this version accepts. An unknown
 *   algorithm tag is a hard parse failure (fail closed), never a guess.
 * - Owner digest: SHA-256 of the subject identity string, lowercase hex. This is
 *   the segment that makes ownership checkable while the ciphertext stays opaque.
 * - Ciphertext: raw bytes produced by the platform secret-storage backend
 *   (Electron safeStorage / DPAPI in production), base64url-encoded. The envelope
 *   layer never interprets these bytes.
 */

export const SECRET_ENVELOPE_PREFIX = "uaw-env1";
export const SECRET_ENVELOPE_DIGEST_ALGORITHM = "sha256";

const SEGMENT_COUNT = 4;
const OWNER_DIGEST_HEX_LENGTH = 64;
const OWNER_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export class SecretEnvelopeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretEnvelopeError";
  }
}

/** An envelope string that does not conform to the format. Corrupt or tampered — never guessed at. */
export class SecretEnvelopeFormatError extends SecretEnvelopeError {
  readonly rawEnvelope: string;
  constructor(reason: string, rawEnvelope: string) {
    super(`Secret envelope format error: ${reason}`, { cause: undefined });
    this.name = "SecretEnvelopeFormatError";
    this.rawEnvelope = rawEnvelope;
  }
}

/** The envelope is well-formed but bound to a different owner subject. */
export class SecretEnvelopeOwnerMismatchError extends SecretEnvelopeError {
  readonly expectedOwnerDigest: string;
  readonly actualOwnerDigest: string;
  constructor(expectedOwnerDigest: string, actualOwnerDigest: string) {
    super(
      `Secret envelope owner mismatch: entry belongs to subject digest ${actualOwnerDigest}, but this store is scoped to ${expectedOwnerDigest}`,
    );
    this.name = "SecretEnvelopeOwnerMismatchError";
    this.expectedOwnerDigest = expectedOwnerDigest;
    this.actualOwnerDigest = actualOwnerDigest;
  }
}

export type ParsedSecretEnvelope = {
  readonly prefix: string;
  readonly digestAlgorithm: string;
  readonly ownerDigest: string;
  readonly ciphertext: Uint8Array;
};

/** SHA-256 of the subject identity string, lowercase hex — the envelope's owner fingerprint. */
export function secretEnvelopeOwnerDigest(subject: string): string {
  return createHash(SECRET_ENVELOPE_DIGEST_ALGORITHM).update(subject, "utf8").digest("hex");
}

export function encodeSecretEnvelope(subject: string, ciphertext: Uint8Array): string {
  if (typeof subject !== "string" || subject.length === 0) {
    throw new SecretEnvelopeFormatError("subject must be a non-empty string", "");
  }
  if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength === 0) {
    throw new SecretEnvelopeFormatError("ciphertext must be a non-empty byte sequence", "");
  }
  const ownerDigest = secretEnvelopeOwnerDigest(subject);
  const payload = Buffer.from(ciphertext).toString("base64url");
  return [SECRET_ENVELOPE_PREFIX, SECRET_ENVELOPE_DIGEST_ALGORITHM, ownerDigest, payload].join(".");
}

export function parseSecretEnvelope(raw: string): ParsedSecretEnvelope {
  if (typeof raw !== "string") {
    throw new SecretEnvelopeFormatError("envelope must be a string", String(raw));
  }
  const segments = raw.split(".");
  if (segments.length !== SEGMENT_COUNT) {
    throw new SecretEnvelopeFormatError(
      `expected ${SEGMENT_COUNT} dot-separated segments, found ${segments.length}`,
      raw,
    );
  }
  const [prefix, digestAlgorithm, ownerDigest, payload] = segments as [string, string, string, string];
  if (prefix !== SECRET_ENVELOPE_PREFIX) {
    throw new SecretEnvelopeFormatError(`unknown prefix ${JSON.stringify(prefix)}`, raw);
  }
  if (digestAlgorithm !== SECRET_ENVELOPE_DIGEST_ALGORITHM) {
    throw new SecretEnvelopeFormatError(
      `unsupported digest algorithm ${JSON.stringify(digestAlgorithm)}`,
      raw,
    );
  }
  if (ownerDigest.length !== OWNER_DIGEST_HEX_LENGTH || !OWNER_DIGEST_PATTERN.test(ownerDigest)) {
    throw new SecretEnvelopeFormatError(
      "owner digest must be 64 lowercase hex characters",
      raw,
    );
  }
  if (payload.length === 0 || !BASE64URL_PATTERN.test(payload)) {
    throw new SecretEnvelopeFormatError("ciphertext segment must be non-empty base64url", raw);
  }
  const decoded = Buffer.from(payload, "base64url");
  // Node's base64url decoder silently skips stray characters; a strict round-trip
  // guarantees the wire segment is the canonical encoding of exactly these bytes.
  if (decoded.byteLength === 0 || decoded.toString("base64url") !== payload) {
    throw new SecretEnvelopeFormatError(
      "ciphertext segment is not canonical base64url (stray characters or trailing bits)",
      raw,
    );
  }
  return {
    prefix,
    digestAlgorithm,
    ownerDigest,
    ciphertext: new Uint8Array(decoded),
  };
}

/**
 * Ownership test on a parsed envelope. Uses only the cleartext digest segment —
 * the platform decryption backend is never touched, so this works exactly when
 * decryption is impossible (keychain down).
 */
export function secretEnvelopeBelongsToSubject(
  envelope: ParsedSecretEnvelope,
  subject: string,
): boolean {
  return envelope.ownerDigest === secretEnvelopeOwnerDigest(subject);
}
