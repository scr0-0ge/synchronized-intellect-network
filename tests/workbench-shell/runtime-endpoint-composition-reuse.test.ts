import assert from "node:assert/strict";
import test from "node:test";

import type {
  ResumableAgentRuntimeAdapter,
  RuntimeCatalog,
} from "../../src/agent-runtime/index.ts";
import {
  createProductionRuntimeEndpointAdapter,
} from "../../src/workbench-shell/runtime-endpoint-composition.ts";
import { readWorkbenchDirectRuntimeEndpoints } from "../../src/workbench-shell/runtime-endpoint-adapter.ts";

test("continuations reuse and coalesce only the latest same-Project exact auth pair", async () => {
  const codex = new CountingCatalogAdapter("codex");
  const claude = new CountingCatalogAdapter("claude");
  let auth = exactAuthSnapshot(1, 1);
  const adapter = await createProductionRuntimeEndpointAdapter({
    codexAdapter: codex,
    claudeAdapter: claude,
    authGeneration: {
      captureRuntimeEndpointAuthGenerationSnapshot: () => auth,
    },
  });
  const load = readWorkbenchDirectRuntimeEndpoints(adapter);
  assert.ok(load);

  const initial = await load("C:\\Canonical\\Project-A", "catalog-default");
  const serializedInitial = JSON.stringify(initial);
  assert.equal(serializedInitial.includes("auth-generation"), false);
  assert.equal(serializedInitial.includes("Canonical"), false);
  await load("C:\\Canonical\\Project-A", "continuation-session");
  await load("C:\\Canonical\\Project-A", "continuation-session");
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [1, 1]);

  await load("C:\\Canonical\\Project-A", "replacement-session");
  await Promise.all([
    load("C:\\Canonical\\Project-A", "continuation-session"),
    load("C:\\Canonical\\Project-A", "continuation-session"),
  ]);
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [2, 2]);

  await load("C:\\Canonical\\Project-B", "continuation-session");
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [3, 3]);

  await load("C:\\Canonical\\Project-A", "continuation-session");
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [4, 4]);

  auth = exactAuthSnapshot(2, 1);
  await load("C:\\Canonical\\Project-A", "continuation-session");
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [5, 5]);

  await load("C:\\Canonical\\Project-A", "catalog-default");
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [6, 6]);

  const restarted = await createProductionRuntimeEndpointAdapter({
    codexAdapter: codex,
    claudeAdapter: claude,
    authGeneration: {
      captureRuntimeEndpointAuthGenerationSnapshot: () => auth,
    },
  });
  const loadAfterRestart = readWorkbenchDirectRuntimeEndpoints(restarted);
  assert.ok(loadAfterRestart);
  await loadAfterRestart("C:\\Canonical\\Project-A", "continuation-session");
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [7, 7]);
});

test("concurrent cold continuations share one pending discovery round", async () => {
  const gate = deferred();
  const codex = new CountingCatalogAdapter("codex", gate.promise);
  const claude = new CountingCatalogAdapter("claude", gate.promise);
  const adapter = await createProductionRuntimeEndpointAdapter({
    codexAdapter: codex,
    claudeAdapter: claude,
    authGeneration: {
      captureRuntimeEndpointAuthGenerationSnapshot: () => exactAuthSnapshot(1, 1),
    },
  });
  const load = readWorkbenchDirectRuntimeEndpoints(adapter);
  assert.ok(load);

  const first = load("C:\\Canonical\\Project", "continuation-session");
  const second = load("C:\\Canonical\\Project", "continuation-session");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [1, 1]);
  gate.resolve();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
});

test("concurrent non-continuation intents each discover fresh while continuations reuse the settled composition", async () => {
  const codex = new CountingCatalogAdapter("codex");
  const claude = new CountingCatalogAdapter("claude");
  const adapter = await createProductionRuntimeEndpointAdapter({
    codexAdapter: codex,
    claudeAdapter: claude,
    authGeneration: {
      captureRuntimeEndpointAuthGenerationSnapshot: () => exactAuthSnapshot(1, 1),
    },
  });
  const load = readWorkbenchDirectRuntimeEndpoints(adapter);
  assert.ok(load);

  await Promise.all([
    load("C:\\Canonical\\Project", "catalog-default"),
    load("C:\\Canonical\\Project", "catalog-default"),
  ]);
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [2, 2]);

  await Promise.all([
    load("C:\\Canonical\\Project", "replacement-session"),
    load("C:\\Canonical\\Project", "replacement-session"),
  ]);
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [4, 4]);

  const [left, right] = await Promise.all([
    load("C:\\Canonical\\Project", "continuation-session"),
    load("C:\\Canonical\\Project", "continuation-session"),
  ]);
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [4, 4]);
  assert.deepEqual(left, right);
});

test("failed refresh replaces prior success and continuation never falls back or retries", async () => {
  const codex = new CountingCatalogAdapter("codex");
  const claude = new CountingCatalogAdapter("claude");
  const adapter = await createProductionRuntimeEndpointAdapter({
    codexAdapter: codex,
    claudeAdapter: claude,
    authGeneration: {
      captureRuntimeEndpointAuthGenerationSnapshot: () => exactAuthSnapshot(1, 1),
    },
  });
  const load = readWorkbenchDirectRuntimeEndpoints(adapter);
  assert.ok(load);

  const successful = await load("C:\\Canonical\\Project", "catalog-default");
  assert.equal(successful.endpoints.length, 2);
  codex.available = false;
  claude.available = false;
  const failed = await load("C:\\Canonical\\Project", "catalog-default");
  assert.equal(failed.endpoints.length, 0);
  codex.available = true;
  claude.available = true;

  const continuation = await load(
    "C:\\Canonical\\Project",
    "continuation-session",
  );
  assert.equal(continuation.endpoints.length, 0);
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [2, 2]);
});

test("missing or malformed auth snapshots fail before discovery", async (t) => {
  const malformed = [
    undefined,
    { codex: exactContext("codex-desktop", 1) },
    {
      codex: { ...exactContext("codex-desktop", 1), extra: true },
      claude: exactContext("claude-code-desktop", 1),
    },
    {
      codex: exactContext("claude-code-desktop", 1),
      claude: exactContext("codex-desktop", 1),
    },
    new Proxy(exactAuthSnapshot(1, 1), {}),
  ] as const;
  for (const [index, snapshot] of malformed.entries()) {
    await t.test(String(index), async () => {
      const codex = new CountingCatalogAdapter("codex");
      const claude = new CountingCatalogAdapter("claude");
      const adapter = await createProductionRuntimeEndpointAdapter({
        codexAdapter: codex,
        claudeAdapter: claude,
        authGeneration: {
          captureRuntimeEndpointAuthGenerationSnapshot: () => snapshot as never,
        },
      });
      const load = readWorkbenchDirectRuntimeEndpoints(adapter);
      assert.ok(load);
      await assert.rejects(
        load("C:\\Canonical\\Project", "continuation-session"),
        /runtime-auth-generation-unavailable/u,
      );
      assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [0, 0]);
    });
  }
});

test("a mid-flight generation change discards without retry or partial exposure", async () => {
  const gate = deferred();
  const codex = new CountingCatalogAdapter("codex", gate.promise);
  const claude = new CountingCatalogAdapter("claude", gate.promise);
  let auth = exactAuthSnapshot(1, 1);
  const adapter = await createProductionRuntimeEndpointAdapter({
    codexAdapter: codex,
    claudeAdapter: claude,
    authGeneration: {
      captureRuntimeEndpointAuthGenerationSnapshot: () => auth,
    },
  });
  const load = readWorkbenchDirectRuntimeEndpoints(adapter);
  assert.ok(load);
  let exposed: unknown;
  const pending = load("C:\\Canonical\\Project", "continuation-session").then(
    (value) => {
      exposed = value;
    },
    (error: unknown) => Promise.reject(error),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  auth = exactAuthSnapshot(1, 2);
  gate.resolve();

  await assert.rejects(pending, /runtime-auth-generation-changed/u);
  assert.equal(exposed, undefined);
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [1, 1]);

  auth = exactAuthSnapshot(1, 1);
  const recovered = await load(
    "C:\\Canonical\\Project",
    "continuation-session",
  );
  assert.equal(recovered.endpoints.length, 2);
  assert.deepEqual([codex.inspectCalls, claude.inspectCalls], [2, 2]);
});

class CountingCatalogAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  available = true;
  readonly #runtime: string;
  readonly #gate: Promise<void> | undefined;

  constructor(runtime: string, gate?: Promise<void>) {
    this.#runtime = runtime;
    this.#gate = gate;
  }

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    await this.#gate;
    if (!this.available) throw new Error("synthetic unavailable");
    return Object.freeze({
      runtime: this.#runtime,
      models: Object.freeze([
        Object.freeze({
          id: `${this.#runtime}-model`,
          effortLevels: Object.freeze(["high"]),
        }),
      ]),
      executionModes: Object.freeze(["single-agent"]),
      accessModes: Object.freeze(["full-access"]),
    });
  }

  async start(): Promise<never> {
    throw new Error("unused start");
  }

  async resume(): Promise<never> {
    throw new Error("unused resume");
  }
}

function exactAuthSnapshot(codexGeneration: number, claudeGeneration: number) {
  return Object.freeze({
    codex: exactContext("codex-desktop", codexGeneration),
    claude: exactContext("claude-code-desktop", claudeGeneration),
  });
}

function exactContext(
  endpointId: "codex-desktop" | "claude-code-desktop",
  generation: number,
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    endpointId,
    management: "managed" as const,
    generation: `auth-generation-v1-00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`,
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}
