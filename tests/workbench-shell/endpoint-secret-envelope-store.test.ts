import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, test } from "node:test";

import {
  encodeSecretEnvelope,
  parseSecretEnvelope,
  SECRET_ENVELOPE_DIGEST_ALGORITHM,
  SECRET_ENVELOPE_PREFIX,
  SecretEnvelopeFormatError,
  SecretEnvelopeOwnerMismatchError,
  secretEnvelopeBelongsToSubject,
  secretEnvelopeOwnerDigest,
} from "../../src/workbench-shell/endpoint-secret-envelope-codec.ts";
import {
  defaultFilesystemBridge,
  EndpointSecretEnvelopeStore,
  InvalidSecretKeyNameError,
  resolveEnvelopeStorageMode,
  SecretEnvelopeDecryptError,
  SecretEnvelopeEncryptError,
  SecretEnvelopeNotFoundError,
  SecretEnvelopeStoreFileError,
  type FilesystemBridge,
  type SafeStorageLike,
} from "../../src/workbench-shell/endpoint-secret-envelope-store.ts";

/**
 * Behaviour suite for the production endpoint secret envelope modules, migrated
 * one-for-one from the frozen prototype at
 * `prototypes/glm-endpoint-secret-envelope/`. Every credential-looking value is an
 * obviously fake test fixture of the form `test-secret-<n>`. No real key ever
 * appears here. The suite drives the real `src/workbench-shell/` modules end to
 * end without Electron: the platform secret-storage backend is injected as a
 * deterministic fake.
 */

const SUBJECT_A = "workbench://endpoint-lab/glm";
const SUBJECT_B = "workbench://endpoint-lab/codex";

let fakeStorageSeed = 0;

type FakeSafeStorageOptions = {
  available?: boolean;
  failEncryption?: boolean;
  failDecryption?: boolean;
};

/**
 * Deterministic fake of the platform secret-storage surface: XOR keystream plus
 * an integrity tag, so tampering a ciphertext byte makes decryption throw the
 * way a real DPAPI-backed backend would.
 */
function createFakeSafeStorage(options: FakeSafeStorageOptions = {}): SafeStorageLike & {
  calls: { encrypt: number; decrypt: number };
} {
  const key = createHash("sha256").update(`uaw-fake-backend-key-${(fakeStorageSeed += 1)}`).digest();
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isEncryptionAvailable: () => options.available ?? true,
    encryptString(plainText: string): Uint8Array {
      calls.encrypt += 1;
      if (options.failEncryption) {
        throw new Error("fake backend refused to encrypt");
      }
      const bytes = Buffer.from(plainText, "utf8");
      const tag = createHash("sha256").update(bytes).update(key).digest().subarray(0, 16);
      const stream = Buffer.allocUnsafe(bytes.length);
      for (let index = 0; index < bytes.length; index += 1) {
        stream[index] = bytes[index] ^ key[index % key.length];
      }
      return Buffer.concat([tag, stream]);
    },
    decryptString(encrypted: Uint8Array): string {
      calls.decrypt += 1;
      if (options.failDecryption) {
        throw new Error("fake backend keychain is unavailable");
      }
      const data = Buffer.from(encrypted);
      if (data.length < 16) {
        throw new Error("fake decryption failed: payload too short");
      }
      const tag = data.subarray(0, 16);
      const stream = data.subarray(16);
      const plain = Buffer.allocUnsafe(stream.length);
      for (let index = 0; index < stream.length; index += 1) {
        plain[index] = stream[index] ^ key[index % key.length];
      }
      const expected = createHash("sha256").update(plain).update(key).digest().subarray(0, 16);
      if (!tag.equals(expected)) {
        throw new Error("fake decryption failed: integrity tag mismatch");
      }
      return plain.toString("utf8");
    },
  };
}

/** Filesystem bridge that can simulate a crash between the temp write and the rename. */
function createCrashingRenameBridge(renameFailures: { count: number }): FilesystemBridge {
  return {
    ...defaultFilesystemBridge,
    rename(from: string, to: string): void {
      if (renameFailures.count > 0) {
        renameFailures.count -= 1;
        throw new Error(`simulated crash before rename (${from} -> ${to})`);
      }
      defaultFilesystemBridge.rename(from, to);
    },
  };
}

/**
 * Workspace directories are removed once the file's tests finish. The prototype
 * left them in the OS temp directory; production tests clean up after themselves,
 * matching `tests/helpers/test-lifecycle.ts` discipline. No assertion depends on
 * this hook.
 */
const createdWorkspaceDirectories: string[] = [];

after(() => {
  for (const directory of createdWorkspaceDirectories) {
    nodeFs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function createWorkspace(): { directory: string; storePath: () => string } {
  const directory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "uaw-envelope-test-"));
  createdWorkspaceDirectories.push(directory);
  let counter = 0;
  return {
    directory,
    storePath: () => nodePath.join(directory, `endpoint-keys-${(counter += 1)}.json`),
  };
}

function readRawText(path: string): string {
  return nodeFs.readFileSync(path, "utf8");
}

/** Runs an action that must throw, and returns the thrown error for field assertions. */
function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to throw, but it returned");
}

function readRawEntries(path: string): Record<string, string> {
  return (JSON.parse(readRawText(path)) as { entries: Record<string, string> }).entries;
}

function tamperEnvelopeField(path: string, keyName: string, replacer: (envelope: string) => string): void {
  const document = JSON.parse(readRawText(path)) as { entries: Record<string, string> };
  document.entries[keyName] = replacer(document.entries[keyName]);
  nodeFs.writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

test("resolveEnvelopeStorageMode names exactly two states from the availability claim", () => {
  assert.equal(resolveEnvelopeStorageMode({ isEncryptionAvailable: true }), "encrypted");
  assert.equal(resolveEnvelopeStorageMode({ isEncryptionAvailable: false }), "in-memory");
  assert.throws(() => resolveEnvelopeStorageMode({ isEncryptionAvailable: 1 as unknown as boolean }));
});

test("envelope codec roundtrips encode -> parse", () => {
  const ciphertext = Buffer.from("opaque-backend-bytes-1", "utf8");
  const envelope = encodeSecretEnvelope(SUBJECT_A, ciphertext);
  const segments = envelope.split(".");
  assert.equal(segments.length, 4);
  assert.equal(segments[0], SECRET_ENVELOPE_PREFIX);
  assert.equal(segments[1], SECRET_ENVELOPE_DIGEST_ALGORITHM);
  assert.equal(segments[2], secretEnvelopeOwnerDigest(SUBJECT_A));
  const parsed = parseSecretEnvelope(envelope);
  assert.deepEqual(Buffer.from(parsed.ciphertext), ciphertext);
  assert.equal(secretEnvelopeBelongsToSubject(parsed, SUBJECT_A), true);
  assert.equal(secretEnvelopeBelongsToSubject(parsed, SUBJECT_B), false);
});

test("envelope codec rejects malformed strings without guessing", () => {
  const valid = encodeSecretEnvelope(SUBJECT_A, Buffer.from([1, 2, 3]));
  const badCases: Array<[string, string]> = [
    ["empty string", ""],
    ["no separators", "uaw-env1-sha256-abc"],
    ["too few segments", `${SECRET_ENVELOPE_PREFIX}.sha256.${"a".repeat(64)}`],
    ["too many segments", `${valid}.extra`],
    ["wrong prefix", valid.replace(SECRET_ENVELOPE_PREFIX, "other-prefix")],
    ["wrong digest algorithm", valid.replace(".sha256.", ".sha512.")],
    ["uppercase digest", valid.replace(segmentsDigest(valid), segmentsDigest(valid).toUpperCase())],
    ["short digest", valid.replace(segmentsDigest(valid), "abc123")],
    ["base64 charset violation", `${SECRET_ENVELOPE_PREFIX}.sha256.${"0".repeat(64)}.has+bad/chars`],
    ["empty payload", `${SECRET_ENVELOPE_PREFIX}.sha256.${"0".repeat(64)}.`],
    ["non-canonical base64url", `${SECRET_ENVELOPE_PREFIX}.sha256.${"0".repeat(64)}.${payloadOf(valid)}x`],
  ];
  for (const [label, raw] of badCases) {
    assert.throws(() => parseSecretEnvelope(raw), SecretEnvelopeFormatError, label);
  }
  function segmentsDigest(envelope: string): string {
    return envelope.split(".")[2]!;
  }
  function payloadOf(envelope: string): string {
    return envelope.split(".")[3]!;
  }
});

test("roundtrip: upsert -> reveal and resolve, listKeys names only, raw file holds an envelope not plaintext", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const storage = createFakeSafeStorage();
  const store = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: storage,
    storePath,
  });
  assert.equal(store.storageMode, "encrypted");
  assert.equal(store.isPersistent(), true);

  store.upsert("glm-primary", "test-secret-1");
  store.upsert("glm-backup", "test-secret-2");

  assert.equal(store.reveal("glm-primary"), "test-secret-1");
  assert.equal(store.resolve("glm-backup"), "test-secret-2");
  assert.deepEqual(store.listKeys(), ["glm-backup", "glm-primary"]);

  const raw = readRawText(storePath);
  assert.ok(raw.includes(`${SECRET_ENVELOPE_PREFIX}.`));
  assert.ok(!raw.includes("test-secret-1"));
  assert.ok(!raw.includes("test-secret-2"));

  // A second store instance over the same file sees the same keys (persistence).
  // The fake backend instance is shared: a real DPAPI backend decrypts with the
  // same user-account key across store instances.
  const reopened = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: storage,
    storePath,
  });
  assert.deepEqual(reopened.listKeys(), ["glm-backup", "glm-primary"]);
  assert.equal(reopened.reveal("glm-primary"), "test-secret-1");
});

test("ownership is verifiable without decryption — exactly the keychain-down case", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const writer = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  writer.upsert("glm-primary", "test-secret-3");

  const deadKeyStorage = createFakeSafeStorage({ failDecryption: true });
  const reader = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: deadKeyStorage,
    storePath,
  });
  // Names and ownership checks work with the backend unable to decrypt.
  assert.deepEqual(reader.listKeys(), ["glm-primary"]);
  assert.equal(deadKeyStorage.calls.decrypt, 0);

  const envelope = readRawEntries(storePath)["glm-primary"]!;
  const parsed = parseSecretEnvelope(envelope);
  assert.equal(secretEnvelopeBelongsToSubject(parsed, SUBJECT_A), true);
  assert.equal(secretEnvelopeBelongsToSubject(parsed, SUBJECT_B), false);
  assert.equal(deadKeyStorage.calls.decrypt, 0);

  // reveal, by contrast, does need the backend and fails loudly, not silently.
  assert.throws(() => reader.reveal("glm-primary"), SecretEnvelopeDecryptError);
  assert.equal(deadKeyStorage.calls.decrypt, 1);
});

test("tampered or corrupt envelopes fail loudly with named errors", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const storage = createFakeSafeStorage();
  const store = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: storage,
    storePath,
  });
  store.upsert("glm-primary", "test-secret-4");
  const pristine = readRawText(storePath);

  // Corrupt payload segment (canonical base64url, wrong bytes) -> backend integrity failure.
  tamperEnvelopeField(storePath, "glm-primary", (envelope) => {
    const segments = envelope.split(".");
    segments[3] = Buffer.from("attacker-bytes").toString("base64url");
    return segments.join(".");
  });
  assert.throws(() => store.reveal("glm-primary"), SecretEnvelopeDecryptError);

  // Corrupt digest segment (still valid hex, different value) -> owner mismatch, no decrypt attempted.
  const decryptCallsBeforeOwnerCheck = storage.calls.decrypt;
  nodeFs.writeFileSync(storePath, pristine, "utf8");
  tamperEnvelopeField(storePath, "glm-primary", (envelope) => {
    const segments = envelope.split(".");
    segments[2] = "f".repeat(64);
    return segments.join(".");
  });
  assert.throws(() => store.reveal("glm-primary"), SecretEnvelopeOwnerMismatchError);
  assert.equal(storage.calls.decrypt, decryptCallsBeforeOwnerCheck); // ownership ran on the cleartext digest only

  // Malformed envelope string entirely -> format error.
  nodeFs.writeFileSync(storePath, pristine, "utf8");
  tamperEnvelopeField(storePath, "glm-primary", () => "not-an-envelope");
  assert.throws(() => store.reveal("glm-primary"), SecretEnvelopeFormatError);

  // Error text never contains the secret value.
  try {
    store.reveal("glm-primary");
    assert.fail("expected SecretEnvelopeFormatError");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes("test-secret-4"));
  }
});

test("subject mismatch across stores sharing one file is explicit, not silent", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const storeA = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  storeA.upsert("glm-primary", "test-secret-5");

  const storeB = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_B,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  assert.deepEqual(storeB.listKeys(), []); // not ours to list
  const mismatched = captureError(() => storeB.reveal("glm-primary")) as SecretEnvelopeOwnerMismatchError;
  assert.ok(mismatched instanceof SecretEnvelopeOwnerMismatchError);
  assert.equal(mismatched.actualOwnerDigest, secretEnvelopeOwnerDigest(SUBJECT_A));
  assert.equal(mismatched.expectedOwnerDigest, secretEnvelopeOwnerDigest(SUBJECT_B));
  // The original owner still reads its own entry.
  assert.equal(storeA.reveal("glm-primary"), "test-secret-5");
});

test("foreign-owned entries survive another subject's rewrite byte-identically", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const storeA = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  storeA.upsert("glm-primary", "test-secret-6");
  const foreignEnvelope = readRawEntries(storePath)["glm-primary"]!;

  const storeB = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_B,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  storeB.upsert("codex-primary", "test-secret-7");

  const entries = readRawEntries(storePath);
  assert.equal(entries["glm-primary"], foreignEnvelope);
  assert.deepEqual(storeA.listKeys(), ["glm-primary"]);
  assert.deepEqual(storeB.listKeys(), ["codex-primary"]);
});

test("in-memory arm: deletes the on-disk entry, warns exactly once, isPersistent false, never plaintext", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();

  // Seed an encrypted entry while the backend is healthy.
  const healthy = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  healthy.upsert("glm-primary", "test-secret-8");

  // Backend goes down; the store degrades by name.
  const warnings: string[] = [];
  const degraded = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage({ available: false, failDecryption: true }),
    storePath,
    warn: (message) => warnings.push(message),
  });
  assert.equal(degraded.storageMode, "in-memory");
  assert.equal(degraded.isPersistent(), false);

  degraded.upsert("glm-primary", "test-secret-9");
  degraded.upsert("glm-spare", "test-secret-10");

  assert.equal(warnings.length, 1); // once per store instance, not per operation
  assert.equal(degraded.reveal("glm-primary"), "test-secret-9");
  assert.equal(degraded.resolve("glm-spare"), "test-secret-10");

  const raw = readRawText(storePath);
  assert.ok(!raw.includes("glm-primary")); // stale on-disk entry removed
  assert.ok(!raw.includes("glm-spare")); // volatile key never persisted
  assert.ok(!raw.includes("test-secret-9"));
  assert.ok(!raw.includes("test-secret-10"));

  // Non-persistence is honest: a fresh instance over the same file sees neither key.
  const reopened = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage({ available: false, failDecryption: true }),
    storePath,
  });
  assert.deepEqual(reopened.listKeys(), []);
  assert.throws(() => reopened.reveal("glm-primary"), SecretEnvelopeNotFoundError);
});

test("listKeys never returns values", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const store = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  store.upsert("glm-primary", "test-secret-11");
  store.upsert("glm-spare", "test-secret-12");
  const keys = store.listKeys();
  assert.deepEqual(keys, ["glm-primary", "glm-spare"]);
  for (const key of keys) {
    assert.equal(typeof key, "string");
  }
  const raw = readRawText(storePath);
  assert.ok(!raw.includes("test-secret-11") && !raw.includes("test-secret-12"));
});

test("reveal of a missing key fails explicitly; resolve of a missing key is undefined", () => {
  const workspace = createWorkspace();
  const store = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath: workspace.storePath(),
  });
  const notFound = captureError(() => store.reveal("never-stored")) as SecretEnvelopeNotFoundError;
  assert.ok(notFound instanceof SecretEnvelopeNotFoundError);
  assert.equal(notFound.keyName, "never-stored");
  assert.equal(store.resolve("never-stored"), undefined);
});

test("resolve propagates configured-but-broken entries instead of reading as unconfigured", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const store = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  store.upsert("glm-primary", "test-secret-13");
  tamperEnvelopeField(storePath, "glm-primary", (envelope) => {
    const segments = envelope.split(".");
    segments[3] = Buffer.from("broken-bytes").toString("base64url");
    return segments.join(".");
  });
  assert.throws(() => store.resolve("glm-primary"), SecretEnvelopeDecryptError);
});

test("backend that claims availability but refuses to encrypt fails loudly and writes nothing", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const store = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage({ failEncryption: true }),
    storePath,
  });
  assert.equal(store.isPersistent(), true); // the mode tracks availability, the failure is per-operation
  assert.throws(() => store.upsert("glm-primary", "test-secret-14"), SecretEnvelopeEncryptError);
  assert.equal(nodeFs.existsSync(storePath), false); // nothing written, no plaintext fallback
  assert.deepEqual(store.listKeys(), []);
});

test("corrupt store file fails construction and is never wiped or silently replaced", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const garbageCases: Array<[string, string]> = [
    ["not JSON at all", "<<<not json>>>"],
    ["wrong marker", JSON.stringify({ entries: {} })],
    ["wrong version", JSON.stringify({ uawEnvelopeStoreFile: 99, entries: {} })],
    ["entries not an object", JSON.stringify({ uawEnvelopeStoreFile: 1, entries: [] })],
    ["entry not a string", JSON.stringify({ uawEnvelopeStoreFile: 1, entries: { k: 42 } })],
  ];
  for (const [label, garbage] of garbageCases) {
    nodeFs.writeFileSync(storePath, `${garbage}\n`, "utf8");
    assert.throws(
      () =>
        new EndpointSecretEnvelopeStore({
          subject: SUBJECT_A,
          safeStorage: createFakeSafeStorage(),
          storePath,
        }),
      SecretEnvelopeStoreFileError,
      label,
    );
    assert.equal(readRawText(storePath), `${garbage}\n`, `${label}: file preserved byte-identically`);
  }

  // A missing file is a legitimately empty store, not an error.
  const fresh = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath: workspace.storePath(),
  });
  assert.deepEqual(fresh.listKeys(), []);
});

test("key names are validated; invalid names never reach the file", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const store = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  for (const invalid of ["", "UPPER", "has space", "a".repeat(100), "emoji-\u{1F511}", "-leading", ".leading"]) {
    assert.throws(() => store.upsert(invalid, "test-secret-15"), InvalidSecretKeyNameError, JSON.stringify(invalid));
  }
  assert.throws(() => store.upsert("good-name", ""), /non-empty string/); // empty secret value rejected too
  assert.equal(nodeFs.existsSync(storePath), false);
});

test("remove deletes from disk in encrypted mode and reports absence honestly", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const store = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  store.upsert("glm-primary", "test-secret-16");
  assert.equal(store.remove("glm-primary"), true);
  assert.deepEqual(store.listKeys(), []);
  assert.ok(!("glm-primary" in readRawEntries(storePath)));
  assert.equal(store.remove("glm-primary"), false);
  assert.throws(() => store.reveal("glm-primary"), SecretEnvelopeNotFoundError);
});

test("remove in in-memory mode clears both the volatile copy and any stale disk entry", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const healthy = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  healthy.upsert("glm-primary", "test-secret-17");

  const degraded = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage({ available: false, failDecryption: true }),
    storePath,
    warn: () => {},
  });
  degraded.upsert("glm-primary", "test-secret-18");
  assert.equal(degraded.remove("glm-primary"), true);
  assert.deepEqual(degraded.listKeys(), []);
  assert.ok(!("glm-primary" in readRawEntries(storePath)));
  assert.throws(() => degraded.reveal("glm-primary"), SecretEnvelopeNotFoundError);
});

test("burst of upserts and removes loses no updates (single-threaded serialized read-modify-write)", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const store = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  const expected = new Set<string>();
  for (let index = 0; index < 30; index += 1) {
    const name = `burst-key-${index.toString().padStart(2, "0")}`;
    store.upsert(name, `test-secret-burst-${index}`);
    expected.add(name);
  }
  for (const name of ["burst-key-03", "burst-key-17", "burst-key-29"]) {
    store.remove(name);
    expected.delete(name);
  }
  store.upsert("burst-key-00", "test-secret-burst-0-final"); // overwrite keeps a single slot
  assert.deepEqual(store.listKeys(), [...expected].sort());
  assert.equal(Object.keys(readRawEntries(storePath)).length, expected.size);
  assert.equal(store.reveal("burst-key-00"), "test-secret-burst-0-final");
});

test("simulated crash before rename leaves the store file byte-identical and fails loudly", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const setup = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  setup.upsert("glm-primary", "test-secret-19");
  const pristine = readRawText(storePath);

  const failing = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
    filesystem: createCrashingRenameBridge({ count: 1 }),
  });
  const failure = captureError(
    () => failing.upsert("glm-spare", "test-secret-20"),
  ) as SecretEnvelopeStoreFileError;
  assert.ok(failure instanceof SecretEnvelopeStoreFileError);
  assert.ok(failure.cause instanceof Error);
  assert.match(failure.cause.message, /simulated crash/);

  // Destination untouched, no temp litter, recovery on the next successful write.
  assert.equal(readRawText(storePath), pristine);
  const leftovers = nodeFs
    .readdirSync(workspace.directory)
    .filter((name) => name.includes("uaw-tmp-"));
  assert.deepEqual(leftovers, []);
  failing.upsert("glm-spare", "test-secret-20");
  assert.deepEqual(failing.listKeys(), ["glm-primary", "glm-spare"]);
});

test("degraded warning fires once per store instance and defaults are injectable", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const first: string[] = [];
  const second: string[] = [];
  const storeOne = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage({ available: false }),
    storePath,
    warn: (message) => first.push(message),
  });
  const storeTwo = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage({ available: false }),
    storePath,
    warn: (message) => second.push(message),
  });
  storeOne.upsert("a", "test-secret-21");
  storeOne.upsert("b", "test-secret-22");
  storeTwo.upsert("c", "test-secret-23");
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.match(first[0]!, /never written in plaintext/i);
});

test("stale on-disk entry under a dead keychain fails loudly rather than vanishing", () => {
  const workspace = createWorkspace();
  const storePath = workspace.storePath();
  const healthy = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
  healthy.upsert("glm-primary", "test-secret-24");

  // Backend claims available but cannot decrypt (keychain lost mid-life).
  const reader = new EndpointSecretEnvelopeStore({
    subject: SUBJECT_A,
    safeStorage: createFakeSafeStorage({ failDecryption: true }),
    storePath,
  });
  assert.deepEqual(reader.listKeys(), ["glm-primary"]); // still listed by name
  assert.throws(() => reader.reveal("glm-primary"), SecretEnvelopeDecryptError);
  assert.throws(() => reader.resolve("glm-primary"), SecretEnvelopeDecryptError);
});
