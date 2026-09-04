import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RuntimeAdapterError,
  type RuntimeFailureCategory,
} from "../../src/agent-runtime/index.ts";
import { sanitizeHeadlessCatalogFailure } from "../e2e/headless-catalog-failure.ts";

const runtimeFailureCategoryCoverage = {
  "approval-required": true,
  "authentication-required": true,
  "catalog-invalid": true,
  "correlation-invalid": true,
  "invalid-input": true,
  "protocol-invalid": true,
  "protocol-rejected": true,
  "runtime-shutdown": true,
  "runtime-not-located": true,
  "runtime-unavailable": true,
  "temp-cleanup": true,
  "temp-cleanup-guard": true,
  "transport-failed": true,
  "turn-failed": true,
  "unexpected-server-request": true,
  "unsupported-selection": true,
} as const satisfies Readonly<Record<RuntimeFailureCategory, true>>;

const runtimeFailureCategories = Object.freeze(
  Object.keys(runtimeFailureCategoryCoverage) as RuntimeFailureCategory[],
);
const unknownEvidence = Object.freeze({
  runtimeAdapterFailureCategory: "unknown",
});

test("headless catalog failure evidence preserves every closed RuntimeAdapterError category", () => {
  for (const category of runtimeFailureCategories) {
    const evidence = sanitizeHeadlessCatalogFailure(
      new RuntimeAdapterError(category),
    );

    assert.deepEqual(evidence, { runtimeAdapterFailureCategory: category });
    assert.deepEqual(Object.keys(evidence), ["runtimeAdapterFailureCategory"]);
    assert.equal(Object.isFrozen(evidence), true);
  }
});

test("headless catalog failure evidence recognizes genuine RuntimeAdapterError subclasses without retaining extra fields", () => {
  class DerivedRuntimeAdapterError extends RuntimeAdapterError {
    readonly diagnosticReason = "private-adapter-diagnostic";
  }

  const evidence = sanitizeHeadlessCatalogFailure(
    new DerivedRuntimeAdapterError("transport-failed"),
  );
  assert.deepEqual(evidence, {
    runtimeAdapterFailureCategory: "transport-failed",
  });
  assert.equal(JSON.stringify(evidence).includes("private-adapter-diagnostic"), false);
});

test("headless catalog failure evidence rejects hostile public error fields without reading them", () => {
  let getterReads = 0;
  const hostileGetter = () => {
    getterReads += 1;
    throw new Error("hostile-runtime-error-field");
  };
  for (const key of ["category", "message", "stack"] as const) {
    const error = new RuntimeAdapterError("catalog-invalid");
    Object.defineProperty(error, key, {
      configurable: true,
      get: hostileGetter,
    });
    assert.deepEqual(sanitizeHeadlessCatalogFailure(error), unknownEvidence);
  }
  assert.equal(getterReads, 0);
});

test("headless catalog failure evidence maps every unknown or forged input to one fixed discriminator", () => {
  const secrets = [
    "raw-provider-message",
    "raw-provider-stack",
    "native-owner-path",
    "account-identity",
    "provider-model-payload",
  ] as const;
  const hostileError = new Error(secrets[0]);
  hostileError.stack = secrets[1];

  let getterReads = 0;
  const getterObject = Object.defineProperties({}, {
    category: {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(secrets[0]);
      },
    },
    message: {
      enumerable: true,
      get() {
        getterReads += 1;
        return secrets[0];
      },
    },
    stack: {
      enumerable: true,
      get() {
        getterReads += 1;
        return secrets[1];
      },
    },
  });
  const forgedRuntimeError = Object.create(RuntimeAdapterError.prototype) as object;
  Object.defineProperties(forgedRuntimeError, {
    category: { value: "catalog-invalid" },
    message: { value: secrets[0] },
    stack: { value: secrets[1] },
  });
  const prototypeSwizzledError = new Error(secrets[0]);
  Object.setPrototypeOf(prototypeSwizzledError, RuntimeAdapterError.prototype);
  Object.defineProperty(prototypeSwizzledError, "category", {
    configurable: true,
    enumerable: true,
    value: "catalog-invalid",
    writable: true,
  });

  let proxyTrapReads = 0;
  const throwingProxy = new Proxy(
    { category: "catalog-invalid" },
    {
      get() {
        proxyTrapReads += 1;
        throw new Error(secrets[0]);
      },
      getPrototypeOf() {
        proxyTrapReads += 1;
        throw new Error(secrets[1]);
      },
      getOwnPropertyDescriptor() {
        proxyTrapReads += 1;
        throw new Error(secrets[2]);
      },
      ownKeys() {
        proxyTrapReads += 1;
        throw new Error(secrets[3]);
      },
    },
  );
  const proxiedRuntimeError = new Proxy(
    new RuntimeAdapterError("catalog-invalid"),
    {
      get() {
        proxyTrapReads += 1;
        throw new Error(secrets[0]);
      },
      getPrototypeOf() {
        proxyTrapReads += 1;
        throw new Error(secrets[1]);
      },
    },
  );
  const revokedRuntimeError = Proxy.revocable(
    new RuntimeAdapterError("catalog-invalid"),
    {},
  );
  revokedRuntimeError.revoke();
  const providerPayload = {
    category: "catalog-invalid",
    account: secrets[3],
    models: [{ id: secrets[4], path: secrets[2] }],
    response: { message: secrets[0], stack: secrets[1] },
  };
  const invalidRuntimeCategory = new RuntimeAdapterError(
    secrets[4] as RuntimeFailureCategory,
  );

  const unknownInputs: readonly unknown[] = [
    undefined,
    null,
    false,
    42,
    "catalog-invalid",
    Symbol("catalog-invalid"),
    hostileError,
    getterObject,
    forgedRuntimeError,
    prototypeSwizzledError,
    throwingProxy,
    proxiedRuntimeError,
    revokedRuntimeError.proxy,
    providerPayload,
    invalidRuntimeCategory,
  ];

  for (const value of unknownInputs) {
    const evidence = sanitizeHeadlessCatalogFailure(value);
    assert.deepEqual(evidence, unknownEvidence);
    assert.deepEqual(Object.keys(evidence), ["runtimeAdapterFailureCategory"]);
    assert.equal(Object.isFrozen(evidence), true);
    const serialized = JSON.stringify(evidence);
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  }
  assert.equal(getterReads, 0);
  assert.equal(proxyTrapReads, 0);
});

test("Codex and Claude headless catalog catches use the same sanitizer without changing the outer category", async () => {
  const electronMain = await readFile(
    new URL("../e2e/electron-e2e.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    (
      electronMain.match(
        /throw toHeadlessCatalogHarnessFailure\("(?:codex|claude)", error\);/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.match(
    electronMain,
    /throw toHeadlessCatalogHarnessFailure\("codex", error\);/u,
  );
  assert.match(
    electronMain,
    /throw toHeadlessCatalogHarnessFailure\("claude", error\);/u,
  );
  assert.match(
    electronMain,
    /function toHeadlessCatalogHarnessFailure\([\s\S]*"E2E_HEADLESS_CATALOG_FAILED"[\s\S]*JSON\.stringify\(sanitizeHeadlessCatalogFailure\(error\)\)/u,
  );
});
