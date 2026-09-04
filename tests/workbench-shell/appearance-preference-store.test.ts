import assert from "node:assert/strict";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  WorkbenchAppearancePreferenceStoreError,
  createWorkbenchAppearancePreferenceStore,
  defaultWorkbenchAppearancePreference,
} from "../../src/workbench-shell/appearance-preference-store.ts";
import {
  createTestDirectory,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";

function createRegisteredAppearancePreferenceStore(
  context: TestContext,
  options: Parameters<typeof createWorkbenchAppearancePreferenceStore>[0],
) {
  const store = createWorkbenchAppearancePreferenceStore(options);
  registerTestClosable(context, store);
  return store;
}

const maximumDocumentBytes = 64 * 1024;
const versionTwoAppearance = Object.freeze({
  tone: "light" as const,
  crt: "full" as const,
  phosphor: "amber" as const,
  phosphorTier: "c" as const,
});
const nonDefaultAppearance = Object.freeze({
  ...versionTwoAppearance,
  language: "zh-CN" as const,
});

test("a missing appearance preference returns one immutable default without creating machine state", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const store = createRegisteredAppearancePreferenceStore(t, {
    filePath: join(directory, "appearance.json"),
  });

  const appearance = await store.read();

  assert.deepEqual(appearance, {
    tone: "dark",
    crt: "screen",
    phosphor: "neutral",
    phosphorTier: "b",
    language: "en",
  });
  assert.equal(appearance, defaultWorkbenchAppearancePreference);
  assert.equal(await store.readClaudePermissionHandling(), "without-asking");
  assert.equal(Object.isFrozen(appearance), true);
  assert.deepEqual(await readdir(directory), []);
  await store.close();
});

test("an exact v1 three-axis document loads with tier B and English without rewriting owner state", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const filePath = join(directory, "appearance.json");
  const legacyBytes =
    '{"schemaVersion":1,"appearance":{"tone":"light","crt":"full","phosphor":"amber"}}\n';
  await writeFile(filePath, legacyBytes, "utf8");
  const store = createRegisteredAppearancePreferenceStore(t, { filePath });

  assert.deepEqual(await store.read(), {
    tone: "light",
    crt: "full",
    phosphor: "amber",
    phosphorTier: "b",
    language: "en",
  });
  assert.equal(await readFile(filePath, "utf8"), legacyBytes);
  await store.close();
});

test("an exact v2 four-axis document loads with English without rewriting owner state", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const filePath = join(directory, "appearance.json");
  const versionTwoBytes = `${JSON.stringify({
    schemaVersion: 2,
    appearance: versionTwoAppearance,
  })}\n`;
  await writeFile(filePath, versionTwoBytes, "utf8");
  const store = createRegisteredAppearancePreferenceStore(t, { filePath });

  assert.deepEqual(await store.read(), {
    ...versionTwoAppearance,
    language: "en",
  });
  assert.equal(await readFile(filePath, "utf8"), versionTwoBytes);
  await store.close();
});

test("an exact v3 existing profile keeps its appearance, defaults Claude permission handling to without asking, and is not rewritten", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const filePath = join(directory, "appearance.json");
  const versionThreeBytes = `${JSON.stringify({
    schemaVersion: 3,
    appearance: nonDefaultAppearance,
  })}\n`;
  await writeFile(filePath, versionThreeBytes, "utf8");
  const store = createRegisteredAppearancePreferenceStore(t, { filePath });

  assert.deepEqual(await store.read(), nonDefaultAppearance);
  assert.equal(await store.readClaudePermissionHandling(), "without-asking");
  assert.equal(await readFile(filePath, "utf8"), versionThreeBytes);
  await store.close();
});

test("Ask when needed survives a clean restart without resetting appearance and a later appearance save preserves the choice", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const filePath = join(directory, "appearance.json");
  const store = createRegisteredAppearancePreferenceStore(t, { filePath });

  await store.save(nonDefaultAppearance);
  assert.equal(
    await store.saveClaudePermissionHandling("ask-when-needed"),
    "ask-when-needed",
  );
  await store.close();

  const reopened = createRegisteredAppearancePreferenceStore(t, { filePath });
  assert.deepEqual(await reopened.read(), nonDefaultAppearance);
  assert.equal(
    await reopened.readClaudePermissionHandling(),
    "ask-when-needed",
  );
  await reopened.save({
    tone: "dark",
    crt: "blocks",
    phosphor: "green",
    phosphorTier: "a",
    language: "en",
  });
  assert.equal(
    await reopened.readClaudePermissionHandling(),
    "ask-when-needed",
  );
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
    schemaVersion: 4,
    appearance: {
      tone: "dark",
      crt: "blocks",
      phosphor: "green",
      phosphorTier: "a",
      language: "en",
    },
    claudePermissionHandling: "ask-when-needed",
  });
  await reopened.close();
});

test("Claude permission handling save admits only the two exact choices before touching disk", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const store = createRegisteredAppearancePreferenceStore(t, {
    filePath: join(directory, "appearance.json"),
  });
  const saveUnknown = store.saveClaudePermissionHandling as unknown as (
    value: unknown,
  ) => Promise<unknown>;

  for (const value of [
    null,
    undefined,
    true,
    "bypassPermissions",
    "manual",
    "future-mode",
    { permissionHandling: "without-asking" },
  ]) {
    await rejectsAppearance(saveUnknown(value), "preferences-invalid");
  }
  assert.deepEqual(await readdir(directory), []);
  await store.close();
});

test("one exact non-default appearance survives a clean store restart and cannot pollute direct-profile preferences", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const appearancePath = join(directory, "appearance.json");
  const directProfilePath = join(
    directory,
    "direct-session-profile-preferences.json",
  );
  const directProfileBytes =
    '{"schemaVersion":2,"endpoints":{}}\n';
  await writeFile(directProfilePath, directProfileBytes, "utf8");
  const store = createRegisteredAppearancePreferenceStore(t, {
    filePath: appearancePath,
  });

  const saved = await store.save(nonDefaultAppearance);

  assert.deepEqual(saved, nonDefaultAppearance);
  assert.notEqual(saved, nonDefaultAppearance);
  assert.equal(Object.isFrozen(saved), true);
  assert.equal(
    await readFile(appearancePath, "utf8"),
    `${JSON.stringify({
      schemaVersion: 4,
      appearance: nonDefaultAppearance,
      claudePermissionHandling: "without-asking",
    })}\n`,
  );
  assert.equal(await readFile(directProfilePath, "utf8"), directProfileBytes);
  await store.close();

  const reopened = createRegisteredAppearancePreferenceStore(t, {
    filePath: appearancePath,
  });
  assert.deepEqual(await reopened.read(), nonDefaultAppearance);
  assert.equal(await readFile(directProfilePath, "utf8"), directProfileBytes);
  await reopened.close();
});

test("appearance persistence accepts the exact byte ceiling and fails closed one byte beyond it", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const compact = JSON.stringify({
    schemaVersion: 3,
    appearance: nonDefaultAppearance,
  });
  const exactPath = join(directory, "exact.json");
  const overPath = join(directory, "over.json");
  const exact = compact + " ".repeat(maximumDocumentBytes - compact.length);
  const over = `${exact} `;
  assert.equal(Buffer.byteLength(exact, "utf8"), maximumDocumentBytes);
  assert.equal(Buffer.byteLength(over, "utf8"), maximumDocumentBytes + 1);
  await writeFile(exactPath, exact, "utf8");
  await writeFile(overPath, over, "utf8");

  const exactStore = createRegisteredAppearancePreferenceStore(t, {
    filePath: exactPath,
  });
  assert.deepEqual(await exactStore.read(), nonDefaultAppearance);
  await exactStore.close();

  const overStore = createRegisteredAppearancePreferenceStore(t, {
    filePath: overPath,
  });
  await rejectsAppearance(overStore.read(), "preferences-invalid");
  assert.equal(await readFile(overPath, "utf8"), over);
  await overStore.close();
});

test("old, malformed, extra, repeated, and non-exact appearance documents fail closed without rewrite", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const invalidDocuments = [
    '{"schemaVersion":1,',
    '{"schemaVersion":0,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral"}}',
    '{"schemaVersion":2,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral"}}',
    '{"schemaVersion":2,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"en"}}',
    '{"schemaVersion":3,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b"}}',
    '{"schemaVersion":3,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"fr"}}',
    '{"schemaVersion":3,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"en","extra":true}}',
    '{"schemaVersion":3,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"en"},"extra":true}',
    '{"schemaVersion":4,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"en"},"claudePermissionHandling":"future-mode"}',
    '{"schemaVersion":4,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"en"},"claudePermissionHandling":"without-asking","extra":true}',
    '{"schemaVersion":4,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"en"}}',
    '{"schemaVersion":3,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"en","language":"zh-CN"}}',
    '{"schemaVersion":1,"schemaVersion":1,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral"}}',
    '{"schemaVersion":1,"appearance":{"tone":"dark","tone":"light","crt":"screen","phosphor":"neutral"}}',
    '{"schemaVersion":1,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral"},"extra":true}',
    '{"schemaVersion":1,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","extra":true}}',
    '{"schemaVersion":1}',
    '{"schemaVersion":1,"appearance":null}',
    '{"schemaVersion":1,"appearance":[]}',
    '{"schemaVersion":1,"appearance":{"tone":"dark","crt":"screen"}}',
    '{"schemaVersion":1,"appearance":{"tone":"sepia","crt":"screen","phosphor":"neutral"}}',
    '{"schemaVersion":1,"appearance":{"tone":"dark","crt":"tube","phosphor":"neutral"}}',
    '{"schemaVersion":1,"appearance":{"tone":"dark","crt":"screen","phosphor":"blue"}}',
  ] as const;

  for (const [index, contents] of invalidDocuments.entries()) {
    const filePath = join(directory, `invalid-${index}.json`);
    await writeFile(filePath, contents, "utf8");
    const store = createRegisteredAppearancePreferenceStore(t, { filePath });
    await rejectsAppearance(store.read(), "preferences-invalid");
    assert.equal(await readFile(filePath, "utf8"), contents, String(index));
    await store.close();
  }
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("save validates an exact owned appearance before touching disk", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const store = createRegisteredAppearancePreferenceStore(t, {
    filePath: join(directory, "appearance.json"),
  });
  const saveUnknown = store.save as unknown as (
    value: unknown,
  ) => Promise<unknown>;
  const invalid = [
    null,
    [],
    { ...nonDefaultAppearance, extra: true },
    { tone: "light", crt: "full" },
    { ...versionTwoAppearance },
    { ...nonDefaultAppearance, language: "fr" },
    Object.assign(Object.create(null), nonDefaultAppearance),
    Object.defineProperty(
      {
        crt: "full",
        language: "zh-CN",
        phosphor: "amber",
        phosphorTier: "c",
      },
      "tone",
      { enumerable: true, get: () => "light" },
    ),
  ];

  for (const value of invalid) {
    await rejectsAppearance(saveUnknown(value), "preferences-invalid");
  }
  assert.deepEqual(await readdir(directory), []);
  await store.close();
});

test("an atomic appearance replacement failure keeps the prior bytes and reports only the public category", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const filePath = join(directory, "appearance.json");
  const original = createRegisteredAppearancePreferenceStore(t, { filePath });
  await original.save(nonDefaultAppearance);
  await original.close();
  const before = await readFile(filePath, "utf8");
  const failing = createRegisteredAppearancePreferenceStore(t, {
    filePath,
    atomicReplace: async () => {
      throw new Error("PRIVATE_APPEARANCE_REPLACE_FAILURE");
    },
  });

  await rejectsAppearance(
    failing.save({
      tone: "dark",
      crt: "blocks",
      phosphor: "green",
      phosphorTier: "a",
      language: "en",
    }),
    "storage-unavailable",
    "PRIVATE_APPEARANCE_REPLACE_FAILURE",
  );
  assert.equal(await readFile(filePath, "utf8"), before);
  assert.deepEqual(await failing.read(), nonDefaultAppearance);
  await failing.close();
  assert.deepEqual(await readdir(directory), ["appearance.json"]);
});

test("close flushes an in-flight appearance save and rejects every later operation", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const filePath = join(directory, "appearance.json");
  let releaseReplace!: () => void;
  let markReplaceStarted!: () => void;
  const replaceHeld = new Promise<void>((resolve) => {
    releaseReplace = resolve;
  });
  const replaceStarted = new Promise<void>((resolve) => {
    markReplaceStarted = resolve;
  });
  const store = createRegisteredAppearancePreferenceStore(t, {
    filePath,
    atomicReplace: async (temporaryPath, destinationPath) => {
      markReplaceStarted();
      await replaceHeld;
      await rename(temporaryPath, destinationPath);
    },
  });

  const saving = store.save(nonDefaultAppearance);
  await replaceStarted;
  let closeSettled = false;
  const closing = store.close().then(() => {
    closeSettled = true;
  });
  await rejectsAppearance(store.read(), "store-closed");
  await rejectsAppearance(store.save(nonDefaultAppearance), "store-closed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  releaseReplace();
  assert.deepEqual(await saving, nonDefaultAppearance);
  await closing;
  assert.equal(closeSettled, true);
  assert.equal(
    await readFile(filePath, "utf8"),
    `${JSON.stringify({
      schemaVersion: 4,
      appearance: nonDefaultAppearance,
      claudePermissionHandling: "without-asking",
    })}\n`,
  );
});

async function rejectsAppearance(
  operation: Promise<unknown>,
  category: "preferences-invalid" | "storage-unavailable" | "store-closed",
  privateMarker?: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.deepEqual(
      error instanceof WorkbenchAppearancePreferenceStoreError
        ? { category: error.category, message: error.message }
        : undefined,
      {
        category,
        message: "Appearance preferences are unavailable.",
      },
    );
    if (privateMarker !== undefined) {
      assert.equal(String(error).includes(privateMarker), false);
    }
    return true;
  });
}
