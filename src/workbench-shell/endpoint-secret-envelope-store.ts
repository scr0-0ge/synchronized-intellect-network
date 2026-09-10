import {
  encodeSecretEnvelope,
  parseSecretEnvelope,
  SecretEnvelopeError,
  SecretEnvelopeFormatError,
  SecretEnvelopeOwnerMismatchError,
  secretEnvelopeBelongsToSubject,
  secretEnvelopeOwnerDigest,
} from "./endpoint-secret-envelope-codec.ts";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

/**
 * Identity-bound secret envelope store for API-transport Runtime Endpoint keys.
 *
 * Mechanism provenance (cleanroom): the behavioral design — (a) self-describing
 * envelopes whose ownership is verifiable without decryption, (b) a named
 * two-state storage mode whose in-memory arm deletes the on-disk entry, warns
 * once and reports `isPersistent: false` instead of ever writing plaintext, and
 * (c) a bridge surface where names cross the boundary freely but values leave
 * only through an explicit reveal — is taken from `docs/github issue 2 backup.txt`
 * #7 (mechanism description only). All identifiers, constants, the file layout
 * and the store-file schema below are authored fresh for unified-agent-workbench.
 * The five bridge operation names and the two state strings ("encrypted",
 * "in-memory") are the Work Order's mandated contract vocabulary.
 *
 * Design of record: docs/adr/0022-api-transport-credential-envelope.md.
 *
 * Injectable dependencies (`safeStorage`, `storePath`, optional `warn` sink and
 * filesystem bridge) mean the whole store unit-tests without Electron.
 *
 * Concurrency model: every public operation re-reads the store file and performs
 * its read-modify-write synchronously on the single JavaScript thread, so
 * in-process interleaving cannot lose updates by construction. The on-disk
 * transition is atomic (temp file + fsync + rename), so a crash mid-write can
 * never leave a torn store file. Windows tradeoffs are documented at
 * `writeTextFileAtomically`.
 */

/** The slice of Electron's safeStorage surface this store depends on. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Uint8Array;
  decryptString(encrypted: Uint8Array): string;
}

export type EnvelopeStorageMode = "encrypted" | "in-memory";

/**
 * Named two-state storage mode resolution. The only input is the platform's own
 * availability claim. There is no third state and no fallback state: if
 * encryption is unavailable the mode is "in-memory", and the in-memory arm never
 * writes secret material to disk.
 */
export function resolveEnvelopeStorageMode(input: { isEncryptionAvailable: boolean }): EnvelopeStorageMode {
  if (typeof input.isEncryptionAvailable !== "boolean") {
    throw new SecretEnvelopeError("isEncryptionAvailable must be a boolean");
  }
  return input.isEncryptionAvailable ? "encrypted" : "in-memory";
}

/** Injectable filesystem seam so tests can simulate crashes between write and rename. */
export interface FilesystemBridge {
  readTextFile(path: string): string;
  writeTextFile(path: string, text: string): void;
  rename(from: string, to: string): void;
  removeFile(path: string): void;
  syncFile(path: string): void;
  syncDirectory(path: string): void;
}

export const defaultFilesystemBridge: FilesystemBridge = {
  readTextFile(path) {
    return nodeFs.readFileSync(path, "utf8");
  },
  writeTextFile(path, text) {
    nodeFs.writeFileSync(path, text, "utf8");
  },
  rename(from, to) {
    nodeFs.renameSync(from, to);
  },
  removeFile(path) {
    nodeFs.unlinkSync(path);
  },
  syncFile(path) {
    const fd = nodeFs.openSync(path, "r+");
    try {
      nodeFs.fsyncSync(fd);
    } finally {
      nodeFs.closeSync(fd);
    }
  },
  syncDirectory(path) {
    // Directory fsync is not a reliable Windows primitive (Node cannot open a
    // directory fd there). On POSIX it closes the rename-visible-in-directory
    // window; on Windows we accept the residual window and say so.
    if (process.platform === "win32") return;
    try {
      const fd = nodeFs.openSync(path, "r");
      try {
        nodeFs.fsyncSync(fd);
      } finally {
        nodeFs.closeSync(fd);
      }
    } catch {
      // Best-effort only.
    }
  },
};

export class SecretEnvelopeStoreError extends SecretEnvelopeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretEnvelopeStoreError";
  }
}

/** The store file exists but is not a valid envelope store (corrupt JSON, wrong marker, wrong version). Never wiped, never guessed at. */
export class SecretEnvelopeStoreFileError extends SecretEnvelopeStoreError {
  readonly storePath: string;
  constructor(storePath: string, reason: string, options?: { cause?: unknown }) {
    super(`Secret envelope store file at ${storePath} is unusable: ${reason}`, options);
    this.name = "SecretEnvelopeStoreFileError";
    this.storePath = storePath;
  }
}

export class SecretEnvelopeNotFoundError extends SecretEnvelopeStoreError {
  readonly keyName: string;
  constructor(keyName: string) {
    super(`No secret envelope is stored under key name ${JSON.stringify(keyName)}`);
    this.name = "SecretEnvelopeNotFoundError";
    this.keyName = keyName;
  }
}

export class SecretEnvelopeEncryptError extends SecretEnvelopeStoreError {
  readonly keyName: string;
  constructor(keyName: string, cause: unknown) {
    super(`Platform secret-storage backend refused to encrypt key ${JSON.stringify(keyName)}`, { cause });
    this.name = "SecretEnvelopeEncryptError";
    this.keyName = keyName;
  }
}

export class SecretEnvelopeDecryptError extends SecretEnvelopeStoreError {
  readonly keyName: string;
  constructor(keyName: string, cause: unknown) {
    super(`Platform secret-storage backend failed to decrypt key ${JSON.stringify(keyName)}`, { cause });
    this.name = "SecretEnvelopeDecryptError";
    this.keyName = keyName;
  }
}

export class InvalidSecretKeyNameError extends SecretEnvelopeStoreError {
  readonly keyName: string;
  constructor(keyName: string) {
    super(`Invalid secret key name ${JSON.stringify(keyName)}: must match /^[a-z0-9][a-z0-9._-]{0,63}$/`);
    this.name = "InvalidSecretKeyNameError";
    this.keyName = keyName;
  }
}

/**
 * Consumption shape for the Phase 2 per-endpoint env factory: absent key →
 * undefined (endpoint not configured); a key that is present but broken throws
 * rather than silently reading as unconfigured.
 */
export type EndpointSecretResolver = (keyName: string) => string | undefined;

export type EndpointSecretEnvelopeStoreOptions = {
  /** Identity this store's envelopes are bound to (e.g. an endpoint scope). Non-empty string. */
  readonly subject: string;
  readonly safeStorage: SafeStorageLike;
  readonly storePath: string;
  /** Degradation sink. Defaults to console.warn. Invoked at most once per store instance. */
  readonly warn?: (message: string) => void;
  readonly filesystem?: FilesystemBridge;
};

const ENVELOPE_STORE_FILE_MARKER = "uawEnvelopeStoreFile";
const ENVELOPE_STORE_FILE_VERSION = 1;
const TEMP_FILE_STEM = "uaw-tmp";
const KEY_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEGRADED_MODE_WARNING =
  "Endpoint key storage is degraded: platform encryption is unavailable, so keys are kept in memory for this session only and previously stored copies are removed from disk. Keys are never written in plaintext.";

type StoredEntry = {
  readonly rawEnvelope: string;
  readonly parsed: ReturnType<typeof parseSecretEnvelope>;
};

type StoreFileContents = {
  readonly marker: number;
  readonly entries: Map<string, StoredEntry>;
};

export class EndpointSecretEnvelopeStore {
  readonly #subject: string;
  readonly #safeStorage: SafeStorageLike;
  readonly #storePath: string;
  readonly #warn: (message: string) => void;
  readonly #filesystem: FilesystemBridge;
  readonly #mode: EnvelopeStorageMode;
  readonly #volatileEntries = new Map<string, string>();
  #degradationWarned = false;
  #tempFileCounter = 0;

  constructor(options: EndpointSecretEnvelopeStoreOptions) {
    if (typeof options.subject !== "string" || options.subject.trim().length === 0) {
      throw new SecretEnvelopeStoreError("subject must be a non-empty string");
    }
    if (typeof options.storePath !== "string" || options.storePath.length === 0) {
      throw new SecretEnvelopeStoreError("storePath must be a non-empty string");
    }
    this.#subject = options.subject;
    this.#safeStorage = options.safeStorage;
    this.#storePath = options.storePath;
    this.#warn = options.warn ?? ((message) => console.warn(message));
    this.#filesystem = options.filesystem ?? defaultFilesystemBridge;
    this.#mode = resolveEnvelopeStorageMode({
      isEncryptionAvailable: options.safeStorage.isEncryptionAvailable(),
    });
    // Fail fast on an unusable store file (corruption surfaces at construction,
    // not at first mutation) — without modifying it.
    this.#readStoreFile();
  }

  get storageMode(): EnvelopeStorageMode {
    return this.#mode;
  }

  /** True iff the mode is "encrypted" and secret material persists through restarts. */
  isPersistent(): boolean {
    return this.#mode === "encrypted";
  }

  /**
   * Names only — values never cross the bridge through this method. Includes
   * volatile (in-memory) names and this subject's on-disk names; entries owned
   * by other subjects in a shared file are not ours to list. A structurally
   * corrupt envelope anywhere in the file fails loudly instead of quietly
   * shortening the list.
   */
  listKeys(): string[] {
    const { entries } = this.#readStoreFile();
    const names = new Set<string>();
    for (const [name, entry] of entries) {
      if (secretEnvelopeBelongsToSubject(entry.parsed, this.#subject)) {
        names.add(name);
      }
    }
    for (const name of this.#volatileEntries.keys()) {
      names.add(name);
    }
    return [...names].sort();
  }

  /**
   * Store a secret under a key name. In "encrypted" mode: envelope written
   * atomically; a backend encryption failure throws and writes nothing. In
   * "in-memory" mode: value kept in process memory only, any on-disk entry under
   * the same name removed, one degradation warning per store instance —
   * plaintext never touches disk.
   */
  upsert(keyName: string, secretValue: string): void {
    this.#assertValidKeyName(keyName);
    if (typeof secretValue !== "string" || secretValue.length === 0) {
      throw new SecretEnvelopeStoreError("secret value must be a non-empty string");
    }
    if (this.#mode === "in-memory") {
      this.#warnDegradedOnce();
      const { entries } = this.#readStoreFile();
      if (entries.has(keyName)) {
        entries.delete(keyName);
        this.#writeStoreFile(entries);
      }
      this.#volatileEntries.set(keyName, secretValue);
      return;
    }
    let ciphertext: Uint8Array;
    try {
      ciphertext = this.#safeStorage.encryptString(secretValue);
    } catch (error) {
      throw new SecretEnvelopeEncryptError(keyName, error);
    }
    const rawEnvelope = encodeSecretEnvelope(this.#subject, ciphertext);
    const { entries } = this.#readStoreFile();
    entries.set(keyName, { rawEnvelope, parsed: parseSecretEnvelope(rawEnvelope) });
    this.#writeStoreFile(entries);
  }

  /**
   * Remove a key: volatile copy first, then any on-disk entry under that name
   * (any owner — the name slot is being cleared). Returns whether anything was
   * removed. Foreign-owned entries under *other* names are preserved.
   */
  remove(keyName: string): boolean {
    this.#assertValidKeyName(keyName);
    let removed = this.#volatileEntries.delete(keyName);
    const { entries } = this.#readStoreFile();
    if (entries.has(keyName)) {
      entries.delete(keyName);
      this.#writeStoreFile(entries);
      removed = true;
    }
    return removed;
  }

  /**
   * Explicit, on-demand value access. Order: volatile memory, then on-disk
   * envelope. Ownership is verified from the envelope's cleartext digest segment
   * BEFORE any decryption is attempted. Fails loudly with named errors for a
   * missing key, a corrupt envelope, a foreign owner, or a backend decryption
   * failure. Never includes the secret value in any error.
   */
  reveal(keyName: string): string {
    this.#assertValidKeyName(keyName);
    const volatile = this.#volatileEntries.get(keyName);
    if (volatile !== undefined) {
      return volatile;
    }
    const { entries } = this.#readStoreFile();
    const entry = entries.get(keyName);
    if (entry === undefined) {
      throw new SecretEnvelopeNotFoundError(keyName);
    }
    if (!secretEnvelopeBelongsToSubject(entry.parsed, this.#subject)) {
      throw new SecretEnvelopeOwnerMismatchError(
        secretEnvelopeOwnerDigest(this.#subject),
        entry.parsed.ownerDigest,
      );
    }
    try {
      return this.#safeStorage.decryptString(entry.parsed.ciphertext);
    } catch (error) {
      throw new SecretEnvelopeDecryptError(keyName, error);
    }
  }

  /**
   * Env-factory consumption shape: `undefined` only for "not configured"
   * (missing key); a configured-but-broken entry still throws, so a degraded
   * store can never silently masquerade as an unconfigured endpoint.
   */
  resolve(keyName: string): string | undefined {
    try {
      return this.reveal(keyName);
    } catch (error) {
      if (error instanceof SecretEnvelopeNotFoundError) {
        return undefined;
      }
      throw error;
    }
  }

  #assertValidKeyName(keyName: string): void {
    if (typeof keyName !== "string" || !KEY_NAME_PATTERN.test(keyName)) {
      throw new InvalidSecretKeyNameError(keyName);
    }
  }

  #warnDegradedOnce(): void {
    if (!this.#degradationWarned) {
      this.#degradationWarned = true;
      this.#warn(DEGRADED_MODE_WARNING);
    }
  }

  /** Re-reads and re-parses the store file on every call — no cached state, so updates cannot be lost to a stale view. */
  #readStoreFile(): StoreFileContents {
    let text: string;
    try {
      text = this.#filesystem.readTextFile(this.#storePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        return { marker: ENVELOPE_STORE_FILE_VERSION, entries: new Map() };
      }
      throw new SecretEnvelopeStoreFileError(this.#storePath, "store file could not be read", {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new SecretEnvelopeStoreFileError(this.#storePath, "content is not valid JSON", {
        cause: error,
      });
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new SecretEnvelopeStoreFileError(this.#storePath, "top level must be an object");
    }
    const record = parsed as Record<string, unknown>;
    if (record[ENVELOPE_STORE_FILE_MARKER] !== ENVELOPE_STORE_FILE_VERSION) {
      throw new SecretEnvelopeStoreFileError(
        this.#storePath,
        `missing or wrong ${JSON.stringify(ENVELOPE_STORE_FILE_MARKER)}: ${JSON.stringify(
          record[ENVELOPE_STORE_FILE_MARKER],
        )}`,
      );
    }
    const rawEntries = record.entries;
    if (typeof rawEntries !== "object" || rawEntries === null || Array.isArray(rawEntries)) {
      throw new SecretEnvelopeStoreFileError(this.#storePath, "entries must be an object");
    }
    const entries = new Map<string, StoredEntry>();
    for (const [name, value] of Object.entries(rawEntries)) {
      if (typeof value !== "string") {
        throw new SecretEnvelopeStoreFileError(
          this.#storePath,
          `entry ${JSON.stringify(name)} must be an envelope string`,
        );
      }
      entries.set(name, { rawEnvelope: value, parsed: parseSecretEnvelope(value) });
    }
    return { marker: ENVELOPE_STORE_FILE_VERSION, entries };
  }

  #writeStoreFile(entries: Map<string, StoredEntry>): void {
    const sortedEntries: Record<string, string> = {};
    for (const name of [...entries.keys()].sort()) {
      sortedEntries[name] = entries.get(name)!.rawEnvelope;
    }
    const document = `${JSON.stringify(
      { [ENVELOPE_STORE_FILE_MARKER]: ENVELOPE_STORE_FILE_VERSION, entries: sortedEntries },
      null,
      2,
    )}\n`;
    this.#writeTextFileAtomically(this.#storePath, document);
  }

  /**
   * Atomic text-file replacement: write sibling temp file → fsync it → rename
   * over the destination. Rename-over-existing on Windows goes through
   * MoveFileEx(REPLACE_EXISTING); it can still fail with EPERM if an external
   * process (e.g. an AV scanner) holds the destination open without
   * FILE_SHARE_DELETE — surfaced loudly here, with no retry loop (ADR 0022 §2.5
   * records the backoff decision as deferred to real-machine observation).
   * The destination can never be left torn: it is only ever replaced wholesale.
   * Temp leftovers are cleaned best-effort on failure.
   */
  #writeTextFileAtomically(path: string, text: string): void {
    const directory = nodePath.dirname(path);
    this.#tempFileCounter += 1;
    const tempPath = nodePath.join(
      directory,
      `${nodePath.basename(path)}.${TEMP_FILE_STEM}-${process.pid}-${this.#tempFileCounter}`,
    );
    try {
      this.#filesystem.writeTextFile(tempPath, text);
      this.#filesystem.syncFile(tempPath);
      this.#filesystem.rename(tempPath, path);
      this.#filesystem.syncDirectory(directory);
    } catch (error) {
      try {
        this.#filesystem.removeFile(tempPath);
      } catch {
        // Best-effort cleanup; the store file itself was never opened for write.
      }
      throw new SecretEnvelopeStoreFileError(path, "atomic replacement of the store file failed", {
        cause: error,
      });
    }
  }
}
