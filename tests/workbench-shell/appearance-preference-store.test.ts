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
    schemaVersion: 9,
    appearance: {
      tone: "dark",
      crt: "blocks",
      phosphor: "green",
      phosphorTier: "a",
      language: "en",
    },
    claudePermissionHandling: "ask-when-needed",
    endpointPreference: {
      claude: "claude-code-desktop",
      codex: "codex-desktop",
      kimi: "kimi-code",
    },
    runtimeExecutables: { codex: "", claude: "" },
    endpointBaseUrls: {
      "glm-coding-plan": "",
      "deepseek-api": "",
      "kimi-code": "",
      "codex-api": "",
    },
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

test("family endpoint preferences round-trip per family, default from a v4 document, and admit only the exact members", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const filePath = join(directory, "appearance.json");
  await writeFile(
    filePath,
    `${JSON.stringify({
      schemaVersion: 4,
      appearance: {
        tone: "light",
        crt: "full",
        phosphor: "amber",
        phosphorTier: "c",
        language: "zh-CN",
      },
      claudePermissionHandling: "ask-when-needed",
    })}\n`,
    "utf8",
  );
  const store = createRegisteredAppearancePreferenceStore(t, { filePath });

  // A v4 document carries no endpoint preferences: the per-family defaults
  // (each exactly the automatic order) serve.
  assert.deepEqual(await store.readEndpointPreferences(), {
    claude: "claude-code-desktop",
    codex: "codex-desktop",
    kimi: "kimi-code",
  });

  // Each family's slot saves and reads back on its own.
  assert.equal(
    await store.saveEndpointPreference("kimi-platform"),
    "kimi-platform",
  );
  assert.equal(await store.saveEndpointPreference("claude-api"), "claude-api");
  assert.equal(await store.saveEndpointPreference("codex-api"), "codex-api");
  assert.deepEqual(await store.readEndpointPreferences(), {
    claude: "claude-api",
    codex: "codex-api",
    kimi: "kimi-platform",
  });
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
    schemaVersion: 9,
    appearance: {
      tone: "light",
      crt: "full",
      phosphor: "amber",
      phosphorTier: "c",
      language: "zh-CN",
    },
    claudePermissionHandling: "ask-when-needed",
    endpointPreference: {
      claude: "claude-api",
      codex: "codex-api",
      kimi: "kimi-platform",
    },
    runtimeExecutables: { codex: "", claude: "" },
    endpointBaseUrls: {
      "glm-coding-plan": "",
      "deepseek-api": "",
      "kimi-code": "",
      "codex-api": "",
    },
  });
  await store.close();

  const reopened = createRegisteredAppearancePreferenceStore(t, { filePath });
  assert.deepEqual(await reopened.readEndpointPreferences(), {
    claude: "claude-api",
    codex: "codex-api",
    kimi: "kimi-platform",
  });
  assert.equal(
    await reopened.readClaudePermissionHandling(),
    "ask-when-needed",
  );
  await reopened.close();

  const invalid = createRegisteredAppearancePreferenceStore(t, {
    filePath: join(directory, "invalid.json"),
  });
  const saveUnknown = invalid.saveEndpointPreference as unknown as (
    value: unknown,
  ) => Promise<unknown>;
  for (const value of [
    null,
    true,
    "kimi",
    "kimi-deployment",
    "auto",
    "claude",
    "codex-desktop ",
  ]) {
    await rejectsAppearance(saveUnknown(value), "preferences-invalid");
  }
  await invalid.close();
});

// Ticket 25 migration: the pre-family v6 document carries the Kimi facade
// preference under its old kimi-only key; the family record reads the kimi
// value verbatim and defaults claude/codex (subscription first).
test("a v6 document's kimiEndpointPreference migrates into the endpointPreference record's kimi slot", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const filePath = join(directory, "v6-migration.json");
  const v6Bytes = `${JSON.stringify({
    schemaVersion: 6,
    appearance: {
      tone: "light",
      crt: "full",
      phosphor: "amber",
      phosphorTier: "c",
      language: "zh-CN",
    },
    claudePermissionHandling: "ask-when-needed",
    kimiEndpointPreference: "kimi-platform",
    runtimeExecutables: { codex: "D:\\codex\\codex.exe", claude: "" },
  })}\n`;
  await writeFile(filePath, v6Bytes, "utf8");
  const store = createRegisteredAppearancePreferenceStore(t, { filePath });

  assert.deepEqual(await store.readEndpointPreferences(), {
    claude: "claude-code-desktop",
    codex: "codex-desktop",
    kimi: "kimi-platform",
  });
  assert.deepEqual(await store.readRuntimeExecutables(), {
    codex: "D:\\codex\\codex.exe",
    claude: "",
  });
  assert.equal(await readFile(filePath, "utf8"), v6Bytes);
  // The next write upgrades the document to the v7 family record.
  await store.saveEndpointPreference("codex-api");
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
    schemaVersion: 9,
    appearance: {
      tone: "light",
      crt: "full",
      phosphor: "amber",
      phosphorTier: "c",
      language: "zh-CN",
    },
    claudePermissionHandling: "ask-when-needed",
    endpointPreference: {
      claude: "claude-code-desktop",
      codex: "codex-api",
      kimi: "kimi-platform",
    },
    runtimeExecutables: { codex: "D:\\codex\\codex.exe", claude: "" },
    endpointBaseUrls: {
      "glm-coding-plan": "",
      "deepseek-api": "",
      "kimi-code": "",
      "codex-api": "",
    },
  });
  await store.close();
});

// A v7 record with a member under the wrong family key fails closed.
test("a v7 endpointPreference record with a misplaced family value fails closed without rewrite", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const filePath = join(directory, "v7-invalid.json");
  const bytes =
    '{"schemaVersion":7,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"en"},"claudePermissionHandling":"without-asking","endpointPreference":{"claude":"codex-desktop","codex":"codex-desktop","kimi":"kimi-code"},"runtimeExecutables":{"codex":"","claude":""}}';
  await writeFile(filePath, bytes, "utf8");
  const store = createRegisteredAppearancePreferenceStore(t, { filePath });
  await rejectsAppearance(store.readEndpointPreferences(), "preferences-invalid");
  assert.equal(await readFile(filePath, "utf8"), bytes);
  await store.close();
});

// main-resync: both lines minted a v5 with their own third field. The merged
// reader tells the two shapes apart by exact key set and defaults the field
// the document never carried; only v6 carries both.
test("both schemaVersion 5 lineages stay readable and default the field they never wrote", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const appearance = {
    tone: "light",
    crt: "full",
    phosphor: "amber",
    phosphorTier: "c",
    language: "zh-CN",
  };

  const lanePath = join(directory, "lane-v5.json");
  await writeFile(
    lanePath,
    `${JSON.stringify({
      schemaVersion: 5,
      appearance,
      claudePermissionHandling: "ask-when-needed",
      kimiEndpointPreference: "kimi-platform",
    })}\n`,
    "utf8",
  );
  const laneStore = createRegisteredAppearancePreferenceStore(t, {
    filePath: lanePath,
  });
  assert.deepEqual(await laneStore.readEndpointPreferences(), {
    claude: "claude-code-desktop",
    codex: "codex-desktop",
    kimi: "kimi-platform",
  });
  assert.deepEqual(await laneStore.readRuntimeExecutables(), {
    codex: "",
    claude: "",
  });
  await laneStore.close();

  const mainPath = join(directory, "main-v5.json");
  await writeFile(
    mainPath,
    `${JSON.stringify({
      schemaVersion: 5,
      appearance,
      claudePermissionHandling: "ask-when-needed",
      runtimeExecutables: { codex: "D:\\codex\\codex.exe", claude: "" },
    })}\n`,
    "utf8",
  );
  const mainStore = createRegisteredAppearancePreferenceStore(t, {
    filePath: mainPath,
  });
  assert.deepEqual(await mainStore.readRuntimeExecutables(), {
    codex: "D:\\codex\\codex.exe",
    claude: "",
  });
  assert.deepEqual(await mainStore.readEndpointPreferences(), {
    claude: "claude-code-desktop",
    codex: "codex-desktop",
    kimi: "kimi-code",
  });
  await mainStore.close();
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
      schemaVersion: 9,
      appearance: nonDefaultAppearance,
      claudePermissionHandling: "without-asking",
      endpointPreference: {
        claude: "claude-code-desktop",
        codex: "codex-desktop",
        kimi: "kimi-code",
      },
      runtimeExecutables: { codex: "", claude: "" },
      endpointBaseUrls: {
        "glm-coding-plan": "",
        "deepseek-api": "",
        "kimi-code": "",
        "codex-api": "",
      },
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
    '{"schemaVersion":5,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"en"},"claudePermissionHandling":"without-asking","kimiEndpointPreference":"kimi-deployment"}',
    '{"schemaVersion":5,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"en"},"claudePermissionHandling":"without-asking","kimiEndpointPreference":"kimi-platform","extra":true}',
    '{"schemaVersion":5,"appearance":{"tone":"dark","crt":"screen","phosphor":"neutral","phosphorTier":"b","language":"en"},"claudePermissionHandling":"without-asking"}',
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
      schemaVersion: 9,
      appearance: nonDefaultAppearance,
      claudePermissionHandling: "without-asking",
      endpointPreference: {
        claude: "claude-code-desktop",
        codex: "codex-desktop",
        kimi: "kimi-code",
      },
      runtimeExecutables: { codex: "", claude: "" },
      endpointBaseUrls: {
        "glm-coding-plan": "",
        "deepseek-api": "",
        "kimi-code": "",
        "codex-api": "",
      },
    })}\n`,
  );
});

test("each base-URL endpoint defaults empty, round-trips independently, and survives an unrelated save (w232)", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const store = createRegisteredAppearancePreferenceStore(t, {
    filePath: join(directory, "base-urls.json"),
  });

  for (const endpointId of [
    "glm-coding-plan",
    "deepseek-api",
    "kimi-code",
    "codex-api",
  ] as const) {
    assert.equal(await store.readBaseUrl(endpointId), "");
  }

  assert.equal(
    await store.saveBaseUrl("codex-api", "https://gateway.example.com/v1"),
    "https://gateway.example.com/v1",
  );
  assert.equal(
    await store.saveBaseUrl("glm-coding-plan", "https://glm.example.com/anthropic"),
    "https://glm.example.com/anthropic",
  );

  // One endpoint's saved value never clobbers another's, and unset endpoints
  // stay empty.
  assert.equal(
    await store.readBaseUrl("codex-api"),
    "https://gateway.example.com/v1",
  );
  assert.equal(
    await store.readBaseUrl("glm-coding-plan"),
    "https://glm.example.com/anthropic",
  );
  assert.equal(await store.readBaseUrl("deepseek-api"), "");
  assert.equal(await store.readBaseUrl("kimi-code"), "");

  // An unrelated save (Claude permission handling) must not clobber either.
  await store.saveClaudePermissionHandling("ask-when-needed");
  assert.equal(
    await store.readBaseUrl("codex-api"),
    "https://gateway.example.com/v1",
  );
  assert.equal(
    await store.readBaseUrl("glm-coding-plan"),
    "https://glm.example.com/anthropic",
  );

  // Clearing one back to "" (the escape hatch) also round-trips and leaves
  // the other endpoint's value alone.
  assert.equal(await store.saveBaseUrl("codex-api", ""), "");
  assert.equal(await store.readBaseUrl("codex-api"), "");
  assert.equal(
    await store.readBaseUrl("glm-coding-plan"),
    "https://glm.example.com/anthropic",
  );
  await store.close();
});

test("a v7 document migrates to v9 with every endpointBaseUrls slot defaulted empty, and a save upgrades the bytes on disk", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const filePath = join(directory, "v7-migration.json");
  const v7Bytes = `${JSON.stringify({
    schemaVersion: 7,
    appearance: defaultWorkbenchAppearancePreference,
    claudePermissionHandling: "without-asking",
    endpointPreference: {
      claude: "claude-code-desktop",
      codex: "codex-desktop",
      kimi: "kimi-code",
    },
    runtimeExecutables: { codex: "D:\\codex\\codex.exe", claude: "" },
  })}\n`;
  await writeFile(filePath, v7Bytes, "utf8");
  const store = createRegisteredAppearancePreferenceStore(t, { filePath });

  assert.equal(await store.readBaseUrl("codex-api"), "");
  assert.equal(await readFile(filePath, "utf8"), v7Bytes);

  await store.saveBaseUrl("codex-api", "https://gateway.example.com/v1");
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
    schemaVersion: 9,
    appearance: defaultWorkbenchAppearancePreference,
    claudePermissionHandling: "without-asking",
    endpointPreference: {
      claude: "claude-code-desktop",
      codex: "codex-desktop",
      kimi: "kimi-code",
    },
    runtimeExecutables: { codex: "D:\\codex\\codex.exe", claude: "" },
    endpointBaseUrls: {
      "glm-coding-plan": "",
      "deepseek-api": "",
      "kimi-code": "",
      "codex-api": "https://gateway.example.com/v1",
    },
  });
  await store.close();
});

// w232: the pre-w232 v8 document carries only the codex-api override under
// its own top-level key. The migration must carry that value over into the
// new record's codex-api slot verbatim, defaulting the three new endpoints.
test("a v8 document's codexApiBaseUrl migrates into the endpointBaseUrls record's codex-api slot", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  const filePath = join(directory, "v8-migration.json");
  const v8Bytes = `${JSON.stringify({
    schemaVersion: 8,
    appearance: defaultWorkbenchAppearancePreference,
    claudePermissionHandling: "without-asking",
    endpointPreference: {
      claude: "claude-code-desktop",
      codex: "codex-desktop",
      kimi: "kimi-code",
    },
    runtimeExecutables: { codex: "", claude: "" },
    codexApiBaseUrl: "https://old-gateway.example.com/v1",
  })}\n`;
  await writeFile(filePath, v8Bytes, "utf8");
  const store = createRegisteredAppearancePreferenceStore(t, { filePath });

  assert.equal(
    await store.readBaseUrl("codex-api"),
    "https://old-gateway.example.com/v1",
  );
  assert.equal(await store.readBaseUrl("glm-coding-plan"), "");
  assert.equal(await store.readBaseUrl("deepseek-api"), "");
  assert.equal(await store.readBaseUrl("kimi-code"), "");
  assert.equal(await readFile(filePath, "utf8"), v8Bytes);

  await store.saveBaseUrl("kimi-code", "https://kimi.example.com/coding/");
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
    schemaVersion: 9,
    appearance: defaultWorkbenchAppearancePreference,
    claudePermissionHandling: "without-asking",
    endpointPreference: {
      claude: "claude-code-desktop",
      codex: "codex-desktop",
      kimi: "kimi-code",
    },
    runtimeExecutables: { codex: "", claude: "" },
    endpointBaseUrls: {
      "glm-coding-plan": "",
      "deepseek-api": "",
      "kimi-code": "https://kimi.example.com/coding/",
      "codex-api": "https://old-gateway.example.com/v1",
    },
  });
  await store.close();
});

test("a base URL with a control character fails closed without rewrite, for every base-URL endpoint", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-appearance-"),
  );
  for (const endpointId of [
    "glm-coding-plan",
    "deepseek-api",
    "kimi-code",
    "codex-api",
  ] as const) {
    const store = createRegisteredAppearancePreferenceStore(t, {
      filePath: join(directory, `base-url-invalid-${endpointId}.json`),
    });
    const saveUnknown = store.saveBaseUrl as unknown as (
      endpointId: string,
      value: unknown,
    ) => Promise<unknown>;
    await rejectsAppearance(
      saveUnknown(endpointId, "https://example.com/\u0000"),
      "preferences-invalid",
    );
    assert.equal(await store.readBaseUrl(endpointId), "");
    await store.close();
  }
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
