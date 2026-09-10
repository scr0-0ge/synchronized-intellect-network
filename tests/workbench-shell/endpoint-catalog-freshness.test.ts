import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  createEndpointCatalogFreshnessService,
  ENDPOINT_CATALOG_FRESHNESS_ENROLLED_EFFORT_LEVEL,
  ENDPOINT_CATALOG_FRESHNESS_STORE_FILE_NAME,
  endpointCatalogFreshnessStorePath,
  type EndpointCatalogFreshnessEndpointConfiguration,
} from "../../src/workbench-shell/endpoint-catalog-freshness.ts";

/**
 * Catalog freshness service behaviour (ticket 14 / WO16 Part 3): zero-
 * inference pulls with fake fetch only, conservative enrollment, persisted
 * across restarts, silent on every failure path.
 */

const workspaceDirectories: string[] = [];

after(() => {
  for (const directory of workspaceDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspace(): string {
  const directory = join(
    tmpdir(),
    `uaw-freshness-${process.pid}-${workspaceDirectories.length}`,
  );
  mkdirSync(directory, { recursive: true });
  workspaceDirectories.push(directory);
  return directory;
}

const KIMI_STATIC_IDS = Object.freeze([
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
  "k3-256k",
  "k3",
]);

function kimiEndpoint(
  overrides: Partial<EndpointCatalogFreshnessEndpointConfiguration> = {},
): EndpointCatalogFreshnessEndpointConfiguration {
  return {
    endpointId: "kimi-code",
    face: "kimi-platform",
    staticCatalogModelIds: KIMI_STATIC_IDS,
    resolveToken: () => "FAKE-KIMI-TOKEN",
    ...overrides,
  };
}

function modelsResponse(models: { id: string; display_name?: string }[]): Response {
  return new Response(JSON.stringify({ data: models }), { status: 200 });
}

test("a pull enrolls only shape-valid new bare ids, with display metadata, persisted across service restarts", async () => {
  const directory = workspace();
  const firstFetch: typeof globalThis.fetch = () =>
    Promise.resolve(
      modelsResponse([
        { id: "glm-5.3" },
        { id: "glm-5.3-flash" },
        { id: "glm-6", display_name: "GLM 6" },
        { id: "glm-6" },
      ]),
    );
  const first = createEndpointCatalogFreshnessService({
    endpoints: [
      kimiEndpoint({
        endpointId: "glm-coding-plan",
        face: "glm-anthropic",
        staticCatalogModelIds: ["glm-5.3[1m]", "glm-5.3-flash[1m]"],
      }),
    ],
    storeDirectory: directory,
    fetch: firstFetch,
  });
  const reports = await first.refresh();
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.status, "fresh");
  assert.deepEqual(
    reports[0]!.newModels.map((entry) => entry.id),
    ["glm-6"],
  );
  assert.equal(reports[0]!.newModels[0]!.displayName, "GLM 6");
  // Augmentation shape: bare id, single conservative default tier.
  assert.deepEqual(first.augmentedModels("glm-coding-plan"), [
    {
      id: "glm-6",
      effortLevels: [ENDPOINT_CATALOG_FRESHNESS_ENROLLED_EFFORT_LEVEL],
    },
  ]);

  // A second service instance (restart) reads the persisted enrollment…
  const secondFetch: typeof globalThis.fetch = () =>
    Promise.resolve(modelsResponse([{ id: "glm-5.3" }, { id: "glm-6" }]));
  const second = createEndpointCatalogFreshnessService({
    endpoints: [
      kimiEndpoint({
        endpointId: "glm-coding-plan",
        face: "glm-anthropic",
        staticCatalogModelIds: ["glm-5.3[1m]", "glm-5.3-flash[1m]"],
      }),
    ],
    storeDirectory: directory,
    fetch: secondFetch,
  });
  assert.deepEqual(second.enrolledModelIds("glm-coding-plan"), ["glm-6"]);
  // …and a repeat pull reports the id as known, not new again.
  const secondReports = await second.refresh();
  assert.equal(secondReports[0]!.status, "fresh");
  assert.deepEqual(secondReports[0]!.newModels, []);
  assert.deepEqual(
    secondReports[0]!.enrolledModels.map((entry) => entry.id),
    ["glm-6"],
  );
});

test("[1m]-style variant suffixes normalize: a listed base id of a suffixed catalog id is not new", async () => {
  const directory = workspace();
  const service = createEndpointCatalogFreshnessService({
    endpoints: [
      kimiEndpoint({
        endpointId: "glm-coding-plan",
        face: "glm-anthropic",
        staticCatalogModelIds: ["glm-5.3[1m]", "glm-5.3-flash[1m]"],
      }),
    ],
    storeDirectory: directory,
    fetch: (() =>
      Promise.resolve(
        modelsResponse([{ id: "glm-5.3" }, { id: "glm-5.3-flash" }, { id: "glm-6" }]),
      )) as typeof fetch,
  });
  const reports = await service.refresh();
  assert.deepEqual(
    reports[0]!.newModels.map((entry) => entry.id),
    ["glm-6"],
  );
});

test("every failure path degrades silently and enrolls nothing", async () => {
  const directory = workspace();
  const cases: readonly { name: string; fetch: typeof fetch; token?: () => string | undefined }[] = [
    {
      name: "network refusal with private detail",
      fetch: (() => Promise.reject(new Error("PRIVATE_NETWORK_DETAIL"))) as typeof fetch,
    },
    {
      name: "unauthorized",
      fetch: (() => Promise.resolve(new Response("no", { status: 401 }))) as typeof fetch,
    },
    {
      name: "malformed payload",
      fetch: (() => Promise.resolve(new Response("not json", { status: 200 }))) as typeof fetch,
    },
    {
      name: "no token configured",
      fetch: (() => Promise.resolve(modelsResponse([{ id: "kimi-x" }]))) as typeof fetch,
      token: () => undefined,
    },
  ];
  for (const row of cases) {
    const service = createEndpointCatalogFreshnessService({
      endpoints: [kimiEndpoint({ resolveToken: row.token ?? (() => "FAKE-KIMI-TOKEN") })],
      storeDirectory: directory,
      fetch: row.fetch,
    });
    const reports = await service.refresh();
    assert.equal(reports[0]!.status, "silent-failure", row.name);
    assert.deepEqual(reports[0]!.newModels, [], row.name);
    assert.deepEqual(service.enrolledModelIds("kimi-code"), [], row.name);
  }
});

test("a corrupt store file reads as no enrollment — never fatal, never wiped", async () => {
  const directory = workspace();
  writeFileSync(
    endpointCatalogFreshnessStorePath(directory),
    "{corrupt",
    "utf8",
  );
  const service = createEndpointCatalogFreshnessService({
    endpoints: [kimiEndpoint()],
    storeDirectory: directory,
    fetch: (() =>
      Promise.resolve(modelsResponse([{ id: "kimi-new" }]))) as typeof fetch,
  });
  const reports = await service.refresh();
  assert.equal(reports[0]!.status, "fresh");
  assert.deepEqual(
    reports[0]!.newModels.map((entry) => entry.id),
    ["kimi-new"],
  );
  // The corrupt file was replaced by the successful enrollment write.
  const persisted = JSON.parse(
    readFileSync(endpointCatalogFreshnessStorePath(directory), "utf8"),
  ) as { endpoints: Record<string, { id: string }[]> };
  assert.deepEqual(
    persisted.endpoints["kimi-code"]!.map((entry) => entry.id),
    ["kimi-new"],
  );
});

test("a failing write does not report an enrollment that the catalog cannot read", async () => {
  const directory = workspace();
  const service = createEndpointCatalogFreshnessService({
    endpoints: [kimiEndpoint()],
    storeDirectory: directory,
    readFile: () => {
      const error: NodeJS.ErrnoException = new Error("boom");
      error.code = "EACCES";
      throw error;
    },
    writeFile: () => {
      throw new Error("PRIVATE_WRITE_DETAIL");
    },
    fetch: (() =>
      Promise.resolve(modelsResponse([{ id: "kimi-new" }]))) as typeof fetch,
  });
  const reports = await service.refresh();
  assert.equal(reports[0]!.status, "silent-failure");
  assert.deepEqual(reports[0]!.newModels, []);
  assert.deepEqual(reports[0]!.enrolledModels, []);
  assert.deepEqual(service.enrolledModelIds("kimi-code"), []);
});

test("store path constant and per-endpoint isolation", async () => {
  assert.equal(
    ENDPOINT_CATALOG_FRESHNESS_STORE_FILE_NAME,
    "endpoint-catalog-freshness-v1.json",
  );
  assert.equal(
    endpointCatalogFreshnessStorePath("C:\\userData"),
    "C:\\userData\\endpoint-catalog-freshness-v1.json",
  );
  const directory = workspace();
  const isolatedFetch: typeof globalThis.fetch = () =>
    Promise.resolve(modelsResponse([{ id: "x-new" }]));
  const service = createEndpointCatalogFreshnessService({
    endpoints: [
      kimiEndpoint(),
      kimiEndpoint({ endpointId: "deepseek-api", face: "deepseek" }),
    ],
    storeDirectory: directory,
    fetch: isolatedFetch,
  });
  const reports = await service.refresh();
  assert.deepEqual(
    reports.map((report) => report.endpointId),
    ["kimi-code", "deepseek-api"],
  );
  assert.deepEqual(service.enrolledModelIds("glm-coding-plan"), []);
  assert.deepEqual(service.enrolledModelIds("kimi-code"), ["x-new"]);
  assert.deepEqual(service.enrolledModelIds("deepseek-api"), ["x-new"]);
});
