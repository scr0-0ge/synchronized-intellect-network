import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type ResumableAgentRuntimeAdapter,
  type ResumableRuntimeBinding,
  RuntimeAdapterError,
  type RuntimeInput,
} from "../../src/agent-runtime/index.ts";
import { createPackagedBootstrapRuntimeAdapter } from "../../src/workbench-shell/electron/bootstrap-runtime-adapter.ts";
import { initializeWorkbenchProjectHost } from "../../src/workbench-shell/electron/startup.ts";
import { createWorkbenchProjectHost } from "../../src/workbench-shell/project-host.ts";
import {
  createTestDirectory,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";

test("the packaged bootstrap blocks Codex inspect, start, resume, and send before delegation", async () => {
  const bootstrapProjectDirectory = join("C:\\Workbench-Data", "Workbench Home");
  const calls = { inspect: 0, start: 0, resume: 0, send: 0 };
  const adapter = createPackagedBootstrapRuntimeAdapter({
    bootstrapProjectDirectory,
    delegate: fakeRuntimeAdapter(calls),
  });

  await assert.rejects(
    adapter.inspect(bootstrapProjectDirectory),
    isRuntimeUnavailable,
  );
  await assert.rejects(
    adapter.start({ projectDirectory: bootstrapProjectDirectory, profile }),
    isRuntimeUnavailable,
  );
  await assert.rejects(
    adapter.resume({
      projectDirectory: bootstrapProjectDirectory,
      profile,
      opaqueSessionReference: "opaque-test-reference",
    }),
    isRuntimeUnavailable,
  );

  assert.deepEqual(calls, { inspect: 0, start: 0, resume: 0, send: 0 });
});

test("the packaged bootstrap guard preserves the accepted Runtime adapter for external Projects", async () => {
  const calls = { inspect: 0, start: 0, resume: 0, send: 0 };
  const adapter = createPackagedBootstrapRuntimeAdapter({
    bootstrapProjectDirectory: join("C:\\Workbench-Data", "Workbench Home"),
    delegate: fakeRuntimeAdapter(calls),
  });
  const externalProjectDirectory = "C:\\Accepted-External-Project";

  await adapter.inspect(externalProjectDirectory);
  const started = await adapter.start({
    projectDirectory: externalProjectDirectory,
    profile,
  });
  await started.send({ text: "accepted test input" });
  await adapter.resume({
    projectDirectory: externalProjectDirectory,
    profile,
    opaqueSessionReference: "opaque-test-reference",
  });

  assert.deepEqual(calls, { inspect: 1, start: 1, resume: 1, send: 1 });
});

test("the observed packaged bootstrap and its blocked profile request close the real backend promptly", async (t) => {
  const userDataDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-packaged-close-test-"),
  );
  const calls = { inspect: 0, start: 0, resume: 0, send: 0 };

  const host = await initializeWorkbenchProjectHost({
    isPackaged: true,
    userDataDirectory,
    currentWorkingDirectory: join(userDataDirectory, "neutral"),
    createProjectHost(startup) {
      return createWorkbenchProjectHost({
        ...startup,
        adapter: createPackagedBootstrapRuntimeAdapter({
          bootstrapProjectDirectory: startup.fallbackProjectDirectory,
          delegate: fakeRuntimeAdapter(calls),
        }),
      });
    },
  });
  registerTestClosable(t, host);
  const firstView = new Promise<void>((resolve) => {
    host.observeProject((result) => {
      if (result.ok) resolve();
    });
  });

  await within(firstView, 2_000);
  const profileResult = await host.loadDirectSessionProfile({
    kind: "catalog-default",
  });
  assert.equal(profileResult.ok, false);
  if (profileResult.ok) assert.fail("The bootstrap profile must stay unavailable.");
  assert.equal(profileResult.error.category, "profile-unavailable");
  await within(host.close(), 2_000);

  assert.deepEqual(calls, { inspect: 0, start: 0, resume: 0, send: 0 });
});

const profile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});

function fakeRuntimeAdapter(calls: {
  inspect: number;
  start: number;
  resume: number;
  send: number;
}): ResumableAgentRuntimeAdapter {
  const binding: ResumableRuntimeBinding = Object.freeze({
    profile,
    opaqueSessionReference: "opaque-test-reference",
    async send(_input: RuntimeInput) {
      calls.send += 1;
    },
    async *events() {
      yield { kind: "turn-completed" as const, status: "completed" as const };
    },
  });
  return Object.freeze({
    async inspect() {
      calls.inspect += 1;
      return {
        runtime: "codex",
        models: [
          {
            id: profile.model,
            displayName: profile.model,
            effortLevels: [profile.effortLevel],
            effortLevelLabels: [profile.effortLevel],
          },
        ],
        executionModes: [profile.executionMode],
        accessModes: [profile.accessMode],
      };
    },
    async start() {
      calls.start += 1;
      return binding;
    },
    async resume() {
      calls.resume += 1;
      return binding;
    },
  });
}

function isRuntimeUnavailable(error: unknown): boolean {
  return (
    error instanceof RuntimeAdapterError &&
    error.category === "runtime-unavailable" &&
    error.message === "Agent Runtime operation failed."
  );
}

async function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("packaged-close-timeout")),
      milliseconds,
    );
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
