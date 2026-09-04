import assert from "node:assert/strict";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  DirectSessionProfilePreferenceStoreError,
  createDirectSessionProfilePreferenceStore,
} from "../../src/workbench-shell/preference-store.ts";
import {
  createTestDirectory,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";
import { dissimilarNeutralEndpointFixtures } from "./fixtures/neutral-public-contract-fixtures.ts";

function createRegisteredPreferenceStore(
  context: TestContext,
  options: Parameters<typeof createDirectSessionProfilePreferenceStore>[0],
) {
  const store = createDirectSessionProfilePreferenceStore(options);
  registerTestClosable(context, store);
  return store;
}

test("an empty preference store returns immutable empty layers and closes without residue", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-preferences-"),
  );
  const store = createRegisteredPreferenceStore(t, {
    filePath: join(directory, "direct-profile.json"),
  });

  const snapshot = await store.read();

  assert.deepEqual(snapshot, {
    global: {},
    endpoints: [],
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.global), true);
  assert.equal(Object.isFrozen(snapshot.endpoints), true);
  assert.deepEqual(await readdir(directory), []);

  await store.close();
  await assert.rejects(store.read(), (error: unknown) => {
    assert.equal(
      error instanceof DirectSessionProfilePreferenceStoreError,
      true,
    );
    assert.deepEqual(
      error instanceof DirectSessionProfilePreferenceStoreError
        ? { category: error.category, message: error.message }
        : undefined,
      {
        category: "store-closed",
        message: "Direct Session Profile preferences are unavailable.",
      },
    );
    return true;
  });
  assert.deepEqual(await readdir(directory), []);
});

test("saved endpoint defaults survive restart and retain other model intensities", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-preferences-"),
  );
  const filePath = join(directory, "direct-profile.json");
  const store = createRegisteredPreferenceStore(t, { filePath });
  const firstInput = { model: "model-a", workIntensity: "low" };

  const first = await store.saveDefault({
    endpointKey: "codex-desktop",
    ...firstInput,
  });
  await store.saveDefault({
    endpointKey: "codex-desktop",
    model: "model-b",
    workIntensity: "medium",
  });
  const committed = await store.saveDefault({
    endpointKey: "codex-desktop",
    model: "model-a",
    workIntensity: "ultra",
  });

  assert.deepEqual(firstInput, { model: "model-a", workIntensity: "low" });
  assert.deepEqual(first, {
    global: {},
    endpoints: [
      {
        endpointKey: "codex-desktop",
        model: "model-a",
        models: [{ model: "model-a", workIntensity: "low" }],
      },
    ],
  });
  assert.deepEqual(committed, {
    global: {},
    endpoints: [
      {
        endpointKey: "codex-desktop",
        model: "model-a",
        models: [
          { model: "model-a", workIntensity: "ultra" },
          { model: "model-b", workIntensity: "medium" },
        ],
      },
    ],
  });
  assert.equal(Object.isFrozen(committed), true);
  assert.equal(Object.isFrozen(committed.endpoints), true);
  assert.equal(Object.isFrozen(committed.endpoints[0]), true);
  assert.equal(Object.isFrozen(committed.endpoints[0]?.models), true);
  assert.equal(Object.isFrozen(committed.endpoints[0]?.models[0]), true);
  await store.close();

  const reopened = createRegisteredPreferenceStore(t, { filePath });
  const recovered = await reopened.read();
  assert.deepEqual(recovered, committed);
  assert.notEqual(recovered, committed);
  assert.equal(Object.isFrozen(recovered.endpoints[0]?.models[1]), true);
  await reopened.close();
  assert.deepEqual(await readdir(directory), ["direct-profile.json"]);
});

test("a valid global-only document returns only the persisted fallback layer", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-preferences-"),
  );
  const filePath = join(directory, "direct-profile.json");
  await writeFile(
    filePath,
    `${JSON.stringify({
      schemaVersion: 1,
      global: { model: "global-model", workIntensity: "low" },
    })}\n`,
    "utf8",
  );
  const store = createRegisteredPreferenceStore(t, { filePath });

  const snapshot = await store.read();

  assert.deepEqual(snapshot, {
    global: { model: "global-model", workIntensity: "low" },
    endpoints: [],
  });
  assert.equal(Object.isFrozen(snapshot.global), true);
  await store.close();
});

test("invalid preference documents fail closed without rewrite or temporary residue", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-preferences-"),
  );
  const invalidDocuments = [
    '{"schemaVersion":1,',
    `{"schemaVersion":1,"global":{"model":"${"x".repeat(65_536)}"}}`,
    '{"schemaVersion":1,"schemaVersion":1}',
    '{"schemaVersion":1,"unknown":true}',
    '{"schemaVersion":3}',
    '{"schemaVersion":2}',
    '{"schemaVersion":2,"endpoints":[],"unknown":true}',
    '{"schemaVersion":2,"endpoints":{"unsafe/path":{}}}',
    '{"schemaVersion":2,"endpoints":{"valid-endpoint":{"unknown":true}}}',
    '{"schemaVersion":2,"endpoints":{"valid-endpoint":{"model":"a","model":"b"}}}',
    '{"schemaVersion":1,"global":{"model":"unsafe/path"}}',
    '{"schemaVersion":1,"global":{"model":"a","model":"b"}}',
    JSON.stringify({
      schemaVersion: 1,
      codex: {
        model: "model-a",
        workIntensities: [
          { model: "model-a", workIntensity: "low" },
          { model: "model-a", workIntensity: "ultra" },
        ],
      },
    }),
    JSON.stringify({
      schemaVersion: 1,
      codex: {
        model: "model-a",
        workIntensities: [
          { model: "model-a", workIntensity: "low", extra: true },
        ],
      },
    }),
    JSON.stringify({
      schemaVersion: 1,
      codex: {
        model: "model-a",
        workIntensities: Array.from({ length: 101 }, (_, index) => ({
          model: `model-${index}`,
          workIntensity: "low",
        })),
      },
    }),
  ];

  for (const [index, contents] of invalidDocuments.entries()) {
    const filePath = join(directory, `invalid-${index}.json`);
    await writeFile(filePath, contents, "utf8");
    const store = createRegisteredPreferenceStore(t, { filePath });

    await assert.rejects(store.read(), (error: unknown) => {
      assert.deepEqual(
        error instanceof DirectSessionProfilePreferenceStoreError
          ? { category: error.category, message: error.message }
          : undefined,
        {
          category: "preferences-invalid",
          message: "Direct Session Profile preferences are unavailable.",
        },
      );
      assert.equal(String(error).includes(filePath), false);
      return true;
    });
    assert.equal(await readFile(filePath, "utf8"), contents);
    await store.close();
  }
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("an atomic replacement failure preserves the prior commit and removes its temporary file", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-preferences-"),
  );
  const filePath = join(directory, "direct-profile.json");
  const original = createRegisteredPreferenceStore(t, { filePath });
  await original.saveDefault({
    endpointKey: "codex-desktop",
    model: "model-a",
    workIntensity: "low",
  });
  await original.close();

  const failing = createRegisteredPreferenceStore(t, {
    filePath,
    atomicReplace: async () => {
      throw new Error("PRIVATE_REPLACE_FAILURE");
    },
  });
  await assert.rejects(
    failing.saveDefault({
      endpointKey: "codex-desktop",
      model: "model-a",
      workIntensity: "ultra",
    }),
    (error: unknown) => {
      assert.deepEqual(
        error instanceof DirectSessionProfilePreferenceStoreError
          ? { category: error.category, message: error.message }
          : undefined,
        {
          category: "storage-unavailable",
          message: "Direct Session Profile preferences are unavailable.",
        },
      );
      assert.equal(String(error).includes("PRIVATE_REPLACE_FAILURE"), false);
      return true;
    },
  );
  assert.deepEqual(await failing.read(), {
    global: {},
    endpoints: [
      {
        endpointKey: "codex-desktop",
        model: "model-a",
        models: [{ model: "model-a", workIntensity: "low" }],
      },
    ],
  });
  await failing.close();

  const reopened = createRegisteredPreferenceStore(t, { filePath });
  assert.deepEqual(await reopened.read(), {
    global: {},
    endpoints: [
      {
        endpointKey: "codex-desktop",
        model: "model-a",
        models: [{ model: "model-a", workIntensity: "low" }],
      },
    ],
  });
  await reopened.close();
  assert.deepEqual(await readdir(directory), ["direct-profile.json"]);
});

test("store close waits for an in-flight replacement and rejects later work without residue", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-preferences-"),
  );
  const filePath = join(directory, "direct-profile.json");
  let releaseReplace!: () => void;
  let markReplaceStarted!: () => void;
  const replaceHeld = new Promise<void>((resolve) => {
    releaseReplace = resolve;
  });
  const replaceStarted = new Promise<void>((resolve) => {
    markReplaceStarted = resolve;
  });
  const store = createRegisteredPreferenceStore(t, {
    filePath,
    atomicReplace: async (temporaryPath, destinationPath) => {
      markReplaceStarted();
      await replaceHeld;
      await rename(temporaryPath, destinationPath);
    },
  });

  const save = store.saveDefault({
    endpointKey: "codex-desktop",
    model: "model-a",
    workIntensity: "ultra",
  });
  await replaceStarted;
  let closeSettled = false;
  const close = store.close().then(() => {
    closeSettled = true;
  });
  await assert.rejects(store.read(), (error: unknown) => {
    assert.equal(
      error instanceof DirectSessionProfilePreferenceStoreError
        ? error.category
        : undefined,
      "store-closed",
    );
    return true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  releaseReplace();
  assert.deepEqual(await save, {
    global: {},
    endpoints: [
      {
        endpointKey: "codex-desktop",
        model: "model-a",
        models: [{ model: "model-a", workIntensity: "ultra" }],
      },
    ],
  });
  await close;
  assert.equal(closeSettled, true);
  assert.deepEqual(await readdir(directory), ["direct-profile.json"]);
});

test("a version 1 preference document maps to the Codex endpoint without rewriting the file", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-preferences-"),
  );
  const filePath = join(directory, "direct-profile.json");
  const before = `${JSON.stringify({
    schemaVersion: 1,
    global: { model: "global-model", workIntensity: "low" },
    codex: {
      model: "model-a",
      workIntensities: [
        { model: "model-a", workIntensity: "ultra" },
        { model: "model-b", workIntensity: "medium" },
      ],
    },
  })}\n`;
  await writeFile(filePath, before, "utf8");
  const store = createRegisteredPreferenceStore(t, { filePath });

  const snapshot = await store.read();

  assert.deepEqual(snapshot, {
    global: { model: "global-model", workIntensity: "low" },
    endpoints: [
      {
        endpointKey: "codex-desktop",
        model: "model-a",
        models: [
          { model: "model-a", workIntensity: "ultra" },
          { model: "model-b", workIntensity: "medium" },
        ],
      },
    ],
  });
  assert.equal(await readFile(filePath, "utf8"), before);
  await store.saveDefault({
    endpointKey: "codex-desktop",
    model: "model-a",
    workIntensity: "low",
  });
  assert.equal(
    await readFile(filePath, "utf8"),
    `${JSON.stringify({
      schemaVersion: 2,
      global: { model: "global-model", workIntensity: "low" },
      endpoints: {
        "codex-desktop": {
          model: "model-a",
          workIntensities: [
            { model: "model-a", workIntensity: "low" },
            { model: "model-b", workIntensity: "medium" },
          ],
        },
      },
    })}\n`,
  );
  await store.close();
});

test("explicit neutral default writes version 2 with two independent fake endpoints and no mode fields", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-preferences-"),
  );
  const filePath = join(directory, "direct-profile.json");
  const store = createRegisteredPreferenceStore(t, { filePath });
  const [quartz, nimbus] = dissimilarNeutralEndpointFixtures();
  const quartzModel = quartz.adapter.catalog.models[0]!;
  const nimbusModel = nimbus.adapter.catalog.models[0]!;
  const saveUnknown = store.saveDefault as unknown as (
    selection: unknown,
  ) => Promise<unknown>;

  await assert.rejects(
    saveUnknown({
      endpointKey: quartz.preferenceKey,
      model: quartzModel.id,
      workIntensity: quartzModel.effortLevels[1]!,
      executionMode: "single-agent",
      accessMode: "full-access",
    }),
    (error: unknown) => {
      assert.equal(
        error instanceof DirectSessionProfilePreferenceStoreError
          ? error.category
          : undefined,
        "preferences-invalid",
      );
      return true;
    },
  );
  assert.deepEqual(await readdir(directory), []);

  await store.saveDefault({
    endpointKey: quartz.preferenceKey,
    model: quartzModel.id,
    workIntensity: quartzModel.effortLevels[1]!,
  });
  const committed = await store.saveDefault({
    endpointKey: nimbus.preferenceKey,
    model: nimbusModel.id,
    workIntensity: nimbusModel.effortLevels[2]!,
  });

  assert.deepEqual(committed, {
    global: {},
    endpoints: [
      {
        endpointKey: quartz.preferenceKey,
        model: quartzModel.id,
        models: [
          {
            model: quartzModel.id,
            workIntensity: quartzModel.effortLevels[1],
          },
        ],
      },
      {
        endpointKey: nimbus.preferenceKey,
        model: nimbusModel.id,
        models: [
          {
            model: nimbusModel.id,
            workIntensity: nimbusModel.effortLevels[2],
          },
        ],
      },
    ],
  });
  const exactDocument = `${JSON.stringify({
    schemaVersion: 2,
    endpoints: {
      [quartz.preferenceKey]: {
        model: quartzModel.id,
        workIntensities: [
          {
            model: quartzModel.id,
            workIntensity: quartzModel.effortLevels[1],
          },
        ],
      },
      [nimbus.preferenceKey]: {
        model: nimbusModel.id,
        workIntensities: [
          {
            model: nimbusModel.id,
            workIntensity: nimbusModel.effortLevels[2],
          },
        ],
      },
    },
  })}\n`;
  assert.equal(await readFile(filePath, "utf8"), exactDocument);
  assert.equal(exactDocument.includes("executionMode"), false);
  assert.equal(exactDocument.includes("accessMode"), false);
  await store.close();

  const reopened = createRegisteredPreferenceStore(t, { filePath });
  assert.deepEqual(await reopened.read(), committed);
  await reopened.close();
});
