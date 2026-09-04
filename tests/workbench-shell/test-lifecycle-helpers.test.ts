import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  withProcessEnvironment,
  withWorkingDirectory,
} from "../helpers/process-state.ts";
import {
  registerTestCleanup,
  registerTestClosable,
  registerTestDirectory,
} from "../helpers/test-lifecycle.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";

test("resource cleanup is idempotent and runs before temporary directory removal", async (t) => {
  let directory = "";
  let cleanupCalls = 0;
  const order: string[] = [];

  await t.test("ordered fixture", async (fixture) => {
    directory = await mkdtemp(join(tmpdir(), "uaw-lifecycle-order-"));
    registerTestDirectory(fixture, directory);
    registerTestClosable(fixture, {
      async close() {
        order.push("close");
        cleanupCalls += 1;
        await writeFile(join(directory, "resource-closed"), "closed", "utf8");
      },
    });
    registerTestCleanup(fixture, () => {
      order.push("release");
    });
  });

  assert.deepEqual(order, ["release", "close"]);
  assert.equal(cleanupCalls, 1);
  await assert.rejects(access(directory), { code: "ENOENT" });

  await t.test("idempotent fixture", async (fixture) => {
    const close = registerTestClosable(fixture, {
      close() {
      cleanupCalls += 1;
      },
    });
    await close();
    await close();
  });
  assert.equal(cleanupCalls, 2);
});

test("process environment restoration survives a failing callback", async () => {
  const key = "UAW_PROCESS_STATE_HELPER_SENTINEL";
  const previous = process.env[key];
  const failure = new Error("expected-process-environment-failure");

  await assert.rejects(
    withProcessEnvironment({ [key]: "temporary" }, () => {
      assert.equal(process.env[key], "temporary");
      throw failure;
    }),
    failure,
  );
  assert.equal(process.env[key], previous);
});

test("working directory restoration covers setup and callback failures", async (t) => {
  const previous = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "uaw-working-directory-"));
  registerTestDirectory(t, directory);

  await assert.rejects(
    withWorkingDirectory(join(directory, "missing"), () => undefined),
    { code: "ENOENT" },
  );
  assert.equal(process.cwd(), previous);

  await assert.rejects(
    withWorkingDirectory(directory, () => {
      assert.equal(process.cwd(), directory);
      throw new Error("expected-working-directory-failure");
    }),
    /expected-working-directory-failure/u,
  );
  assert.equal(process.cwd(), previous);
});

test("SSR Vite servers use independent disposable caches and disable discovery", async (t) => {
  const config = {
    appType: "custom" as const,
    logLevel: "silent" as const,
    server: { middlewareMode: true },
  };
  const first = await createViteSsrTestServer(config);
  registerTestClosable(t, first);
  const second = await createViteSsrTestServer(config);
  registerTestClosable(t, second);
  const firstRoot = dirname(first.config.cacheDir);
  const secondRoot = dirname(second.config.cacheDir);

  assert.notEqual(first.config.cacheDir, second.config.cacheDir);
  assert.equal(first.config.optimizeDeps.noDiscovery, true);
  assert.equal(second.config.optimizeDeps.noDiscovery, true);

  await first.close();
  await second.close();
  await assert.rejects(access(firstRoot), { code: "ENOENT" });
  await assert.rejects(access(secondRoot), { code: "ENOENT" });
});
