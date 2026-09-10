import assert from "node:assert/strict";
import test from "node:test";

import type { ResumableAgentRuntimeAdapter } from "../../src/agent-runtime/index.ts";
import { publicRuntimeEndpointDiscovery } from "../../src/workbench-shell/contract.ts";
import {
  createWorkbenchRuntimeEndpointAdapter,
  readWorkbenchDirectRuntimeEndpoints,
  type WorkbenchDirectRuntimeEndpointSnapshot,
} from "../../src/workbench-shell/runtime-endpoint-adapter.ts";

test("endpoint loader rejects a shape-correct endpoint Proxy before private catalog data is retained", async () => {
  const snapshot = endpointSnapshot();
  const endpoint = { ...snapshot.endpoints[0]! };
  let runtimeFamilyLabelReads = 0;
  let proxyOperations = 0;
  const mutableEndpoint = new Proxy(endpoint, {
    get(target, property, receiver) {
      proxyOperations += 1;
      if (property === "runtimeFamilyLabel") {
        runtimeFamilyLabelReads += 1;
        return runtimeFamilyLabelReads === 1
          ? Reflect.get(target, property, receiver)
          : "C:\\PRIVATE\\runtime.exe";
      }
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      proxyOperations += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  const load = loaderFor({
    ...snapshot,
    endpoints: [mutableEndpoint],
  });

  await assert.rejects(
    load("C:\\PRIVATE\\Project", "catalog-default"),
    /invalid-runtime-endpoint-catalog/u,
  );
  assert.equal(runtimeFamilyLabelReads, 0);
  assert.equal(proxyOperations, 0);
});

test("endpoint loader rejects mutating Proxies across its complete snapshot graph", async () => {
  const snapshot = endpointSnapshot();
  const endpoint = snapshot.endpoints[0]!;
  const catalog = endpoint.catalog;
  const model = catalog.models[0]!;
  const coupling = catalog.workIntensityExecutionModeCouplings?.[0];
  assert.ok(coupling);
  assert.ok(model.effortLevelLabels);
  const withEndpoint = (replacement: unknown) => ({
    ...snapshot,
    endpoints: [replacement],
  });
  const withCatalog = (replacement: unknown) =>
    withEndpoint({ ...endpoint, catalog: replacement });
  const cases = [
    adapterProxyCase(
      "snapshot record",
      { ...snapshot },
      "endpointDiscovery",
      { executable: "C:\\PRIVATE\\runtime.exe" },
      (proxy) => proxy,
    ),
    adapterProxyCase(
      "endpoints array",
      [...snapshot.endpoints],
      "0",
      { ...endpoint, runtimeFamilyLabel: "C:\\PRIVATE\\runtime.exe" },
      (proxy) => ({ ...snapshot, endpoints: proxy }),
    ),
    adapterProxyCase(
      "endpoint record",
      { ...endpoint },
      "runtimeFamilyLabel",
      "C:\\PRIVATE\\runtime.exe",
      withEndpoint,
    ),
    adapterProxyCase(
      "discovery record",
      { ...snapshot.endpointDiscovery },
      "statuses",
      [{ executable: "C:\\PRIVATE\\runtime.exe" }],
      (proxy) => ({ ...snapshot, endpointDiscovery: proxy }),
    ),
    adapterProxyCase(
      "statuses array",
      [...snapshot.endpointDiscovery.statuses],
      "0",
      { endpointId: "codex-desktop", category: "C:\\PRIVATE\\status" },
      (proxy) => ({
        ...snapshot,
        endpointDiscovery: { statuses: proxy },
      }),
    ),
    adapterProxyCase(
      "status record",
      { ...snapshot.endpointDiscovery.statuses[0]! },
      "category",
      "C:\\PRIVATE\\status",
      (proxy) => ({
        ...snapshot,
        endpointDiscovery: {
          statuses: [proxy, snapshot.endpointDiscovery.statuses[1]!],
        },
      }),
    ),
    adapterProxyCase(
      "catalog record",
      { ...catalog },
      "runtime",
      "C:\\PRIVATE\\runtime.exe",
      withCatalog,
    ),
    adapterProxyCase(
      "models array",
      [...catalog.models],
      "0",
      { ...model, id: "C:\\PRIVATE\\model" },
      (proxy) => withCatalog({ ...catalog, models: proxy }),
    ),
    adapterProxyCase(
      "model record",
      { ...model },
      "id",
      "C:\\PRIVATE\\model",
      (proxy) => withCatalog({ ...catalog, models: [proxy] }),
    ),
    adapterProxyCase(
      "effort-level array",
      [...model.effortLevels],
      "0",
      "C:\\PRIVATE\\effort",
      (proxy) =>
        withCatalog({ ...catalog, models: [{ ...model, effortLevels: proxy }] }),
    ),
    adapterProxyCase(
      "effort-label array",
      [...model.effortLevelLabels],
      "0",
      "C:\\PRIVATE\\effort-label",
      (proxy) =>
        withCatalog({
          ...catalog,
          models: [{ ...model, effortLevelLabels: proxy }],
        }),
    ),
    adapterProxyCase(
      "execution-mode array",
      [...catalog.executionModes],
      "0",
      "C:\\PRIVATE\\execution",
      (proxy) => withCatalog({ ...catalog, executionModes: proxy }),
    ),
    adapterProxyCase(
      "access-mode array",
      [...catalog.accessModes],
      "0",
      "C:\\PRIVATE\\access",
      (proxy) => withCatalog({ ...catalog, accessModes: proxy }),
    ),
    adapterProxyCase(
      "coupling array",
      [...catalog.workIntensityExecutionModeCouplings!],
      "0",
      { ...coupling, model: "C:\\PRIVATE\\model" },
      (proxy) =>
        withCatalog({
          ...catalog,
          workIntensityExecutionModeCouplings: proxy,
        }),
    ),
    adapterProxyCase(
      "coupling record",
      { ...coupling },
      "model",
      "C:\\PRIVATE\\model",
      (proxy) =>
        withCatalog({
          ...catalog,
          workIntensityExecutionModeCouplings: [proxy],
        }),
    ),
    adapterProxyCase(
      "desired-default record",
      { ...endpoint.desiredDefault! },
      "model",
      "C:\\PRIVATE\\model",
      (proxy) => withEndpoint({ ...endpoint, desiredDefault: proxy }),
    ),
  ];

  for (const row of cases) {
    const load = loaderFor(
      row.value as WorkbenchDirectRuntimeEndpointSnapshot,
    );
    await assert.rejects(
      load("C:\\PRIVATE\\Project", "catalog-default"),
      /invalid-runtime-endpoint/u,
      row.name,
    );
    assert.equal(row.reads(), 0, row.name);
  }
});

test("endpoint loader accepts one exact snapshot and rejects hostile exact-shape variants", async () => {
  const snapshot = endpointSnapshot();
  const endpoint = snapshot.endpoints[0]!;
  const accepted = await loaderFor(snapshot)(
    "C:\\PRIVATE\\Project",
    "catalog-default",
  );
  assert.deepEqual(accepted.endpointDiscovery, snapshot.endpointDiscovery);
  assert.equal(accepted.endpoints[0]?.endpointId, "codex-desktop");
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.endpoints), true);

  const hiddenRoot = { ...snapshot };
  Object.defineProperty(hiddenRoot, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  const symbolRoot = { ...snapshot };
  Object.defineProperty(symbolRoot, Symbol("PRIVATE_ROOT"), {
    value: "PRIVATE_ROOT",
    enumerable: false,
  });
  const accessorRoot = { endpointDiscovery: snapshot.endpointDiscovery };
  Object.defineProperty(accessorRoot, "endpoints", {
    get() {
      throw new Error("PRIVATE_ENDPOINTS_ACCESSOR");
    },
    enumerable: true,
  });
  const prototypeRoot = Object.assign(
    Object.create({ nativePath: "C:\\PRIVATE\\runtime.exe" }),
    snapshot,
  );
  const sparseEndpoints = new Array(1);
  const hiddenEndpoint = { ...endpoint };
  Object.defineProperty(hiddenEndpoint, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  const prototypeEndpoint = Object.assign(
    Object.create({ nativePath: "C:\\PRIVATE\\runtime.exe" }),
    endpoint,
  );
  const hiddenDiscovery = { ...snapshot.endpointDiscovery };
  Object.defineProperty(hiddenDiscovery, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  const sparseStatuses = new Array(2);
  sparseStatuses[0] = snapshot.endpointDiscovery.statuses[0];
  const thirdStatuses = [
    ...snapshot.endpointDiscovery.statuses,
    { endpointId: "codex-desktop", category: "not-inspected" },
  ];
  const accessorStatuses = [...snapshot.endpointDiscovery.statuses];
  Object.defineProperty(accessorStatuses, "0", {
    get() {
      throw new Error("PRIVATE_STATUS_ARRAY_ACCESSOR");
    },
    enumerable: true,
  });
  const hiddenStatus = { ...snapshot.endpointDiscovery.statuses[0]! };
  Object.defineProperty(hiddenStatus, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  const symbolStatus = { ...snapshot.endpointDiscovery.statuses[0]! };
  Object.defineProperty(symbolStatus, Symbol("PRIVATE_STATUS"), {
    value: "PRIVATE_STATUS",
    enumerable: false,
  });
  const accessorStatus = { endpointId: "codex-desktop" };
  Object.defineProperty(accessorStatus, "category", {
    get() {
      throw new Error("PRIVATE_STATUS_ACCESSOR");
    },
    enumerable: true,
  });
  const prototypeStatus = Object.assign(
    Object.create({ nativePath: "C:\\PRIVATE\\runtime.exe" }),
    snapshot.endpointDiscovery.statuses[0],
  );
  const cases: readonly { readonly name: string; readonly value: unknown }[] = [
    { name: "hidden snapshot key", value: hiddenRoot },
    { name: "symbol snapshot key", value: symbolRoot },
    { name: "snapshot accessor", value: accessorRoot },
    { name: "snapshot custom prototype", value: prototypeRoot },
    {
      name: "sparse endpoints array",
      value: { ...snapshot, endpoints: sparseEndpoints },
    },
    {
      name: "third endpoint row",
      value: { ...snapshot, endpoints: [endpoint, endpoint, endpoint] },
    },
    {
      name: "hidden endpoint key",
      value: { ...snapshot, endpoints: [hiddenEndpoint] },
    },
    {
      name: "endpoint custom prototype",
      value: { ...snapshot, endpoints: [prototypeEndpoint] },
    },
    {
      name: "hidden discovery key",
      value: { ...snapshot, endpointDiscovery: hiddenDiscovery },
    },
    {
      name: "sparse status tuple",
      value: {
        ...snapshot,
        endpointDiscovery: { statuses: sparseStatuses },
      },
    },
    {
      name: "third status row",
      value: {
        ...snapshot,
        endpointDiscovery: { statuses: thirdStatuses },
      },
    },
    {
      name: "status tuple accessor",
      value: {
        ...snapshot,
        endpointDiscovery: { statuses: accessorStatuses },
      },
    },
    {
      name: "hidden status key",
      value: {
        ...snapshot,
        endpointDiscovery: {
          statuses: [hiddenStatus, snapshot.endpointDiscovery.statuses[1]],
        },
      },
    },
    {
      name: "symbol status key",
      value: {
        ...snapshot,
        endpointDiscovery: {
          statuses: [symbolStatus, snapshot.endpointDiscovery.statuses[1]],
        },
      },
    },
    {
      name: "status accessor",
      value: {
        ...snapshot,
        endpointDiscovery: {
          statuses: [accessorStatus, snapshot.endpointDiscovery.statuses[1]],
        },
      },
    },
    {
      name: "status custom prototype",
      value: {
        ...snapshot,
        endpointDiscovery: {
          statuses: [prototypeStatus, snapshot.endpointDiscovery.statuses[1]],
        },
      },
    },
  ];

  for (const row of cases) {
    await assert.rejects(
      loaderFor(row.value as WorkbenchDirectRuntimeEndpointSnapshot)(
        "C:\\PRIVATE\\Project",
        "catalog-default",
      ),
      /invalid-runtime-endpoint/u,
      row.name,
    );
  }
});

function loaderFor(snapshot: WorkbenchDirectRuntimeEndpointSnapshot) {
  const delegate: ResumableAgentRuntimeAdapter = {
    async inspect() {
      return snapshot.endpoints[0]!.catalog;
    },
    async start() {
      throw new Error("unused-test-start");
    },
    async resume() {
      throw new Error("unused-test-resume");
    },
  };
  const adapter = createWorkbenchRuntimeEndpointAdapter(
    delegate,
    async () => snapshot,
  );
  const load = readWorkbenchDirectRuntimeEndpoints(adapter);
  assert.ok(load);
  return load;
}

function endpointSnapshot(): WorkbenchDirectRuntimeEndpointSnapshot {
  return {
    endpoints: [
      {
        endpointId: "codex-desktop",
        preferenceKey: "codex-desktop",
        runtimeFamilyLabel: "Codex",
        endpointLabel: "Codex desktop",
        catalog: {
          runtime: "codex-fixture",
          models: [
            {
              id: "gpt-5.6-sol",
              displayName: "gpt-5.6-sol",
              effortLevels: ["high"],
              effortLevelLabels: ["High"],
            },
          ],
          executionModes: ["single-agent"],
          accessModes: ["full-access"],
          workIntensityExecutionModeCouplings: [
            {
              model: "gpt-5.6-sol",
              workIntensity: "high",
              executionMode: "single-agent",
            },
          ],
        },
        desiredDefault: {
          model: "gpt-5.6-sol",
          effortLevel: "high",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
        directStart: "supported",
      },
    ],
    endpointDiscovery: publicRuntimeEndpointDiscovery([
      { endpointId: "codex-desktop", category: "catalog-ready" },
      { endpointId: "claude-code-desktop", category: "not-inspected" },
      { endpointId: "glm-coding-plan", category: "not-inspected" },
      { endpointId: "kimi-code", category: "not-inspected" },
      { endpointId: "deepseek-api", category: "not-inspected" },
      { endpointId: "kimi-platform", category: "not-inspected" },
      { endpointId: "claude-api", category: "not-inspected" },
      { endpointId: "codex-api", category: "not-inspected" },
    ]),
  };
}

function adapterProxyCase<T extends object>(
  name: string,
  target: T,
  property: PropertyKey,
  privateValue: unknown,
  build: (proxy: T) => unknown,
): {
  readonly name: string;
  readonly value: unknown;
  readonly reads: () => number;
} {
  let reads = 0;
  const proxy = new Proxy(target, {
    get(current, currentProperty, receiver) {
      if (currentProperty === property) {
        reads += 1;
        if (reads > 1) return privateValue;
      }
      return Reflect.get(current, currentProperty, receiver);
    },
  });
  return Object.freeze({ name, value: build(proxy), reads: () => reads });
}
