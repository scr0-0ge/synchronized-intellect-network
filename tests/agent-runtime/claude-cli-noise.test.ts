import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";
import {
  createOfficialClaudeSessionTransport,
  type ClaudeCatalogProcessDependencies,
} from "../../src/agent-runtime/claude/process-transport.ts";
import {
  RuntimeAdapterError,
  type NormalizedRuntimeEvent,
} from "../../src/agent-runtime/index.ts";

const profile = Object.freeze({
  model: "opus-alias",
  effortLevel: "high",
  executionMode: "single-agent",
  accessMode: "full-access",
});

test("a future Claude CLI stdout notice degrades with one diagnostic and keeps the real turn", async t => {
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => {
    diagnostics.push(String(chunk));
    return true;
  });
  const fixture = await offlineAdapter(t, "future-noise");
  try {
    const binding = await fixture.adapter.start({
      projectDirectory: fixture.directory,
      profile,
    });
    await binding.send({ text: "Complete this offline fixture." });
    const events = await collect(binding.events());
    assert.deepEqual(events.filter(event => event.kind === "agent-message"), [
      { kind: "agent-message", text: "UAW_CLAUDE_NOISE_SURVIVED" },
    ]);
    assert.deepEqual(events.at(-1), {
      kind: "turn-completed",
      status: "completed",
    });
    const framingDiagnostics = diagnostics.filter(line =>
      /Claude CLI stdout.*not protocol JSON.*ignored/iu.test(line),
    );
    assert.equal(framingDiagnostics.length, 1);
    assert.doesNotMatch(framingDiagnostics[0]!, /9999\.0\.0|claude update/iu);
  } finally {
    await fixture.close();
  }
});

test("noise tolerance keeps damaged frames and an unbounded stdout flood as protocol failures", async t => {
  for (const mode of ["damaged-frame", "noise-flood"] as const) {
    await t.test(mode, async t => {
      const fixture = await offlineAdapter(t, mode);
      try {
        await assert.rejects(
          fixture.adapter.start({
            projectDirectory: fixture.directory,
            profile,
          }),
          isProtocolInvalid,
        );
      } finally {
        await fixture.close();
      }
    });
  }
});

test("stdout drift never weakens the authentication gate", async t => {
  for (const [name, authentication, category] of [
    [
      "unrecognized authentication shape",
      JSON.stringify({
        loggedIn: true,
        authMethod: "future-auth",
        apiProvider: "firstParty",
        email: "owner@example.com",
        orgId: "org-owner",
        orgName: "Owner Organization",
        subscriptionType: "max",
      }),
      "protocol-invalid",
    ],
    [
      "signed out",
      JSON.stringify({
        loggedIn: false,
        authMethod: "none",
        apiProvider: "firstParty",
      }),
      "authentication-required",
    ],
  ] as const) {
    await t.test(name, async t => {
      const fixture = await offlineAdapter(t, "future-noise", authentication);
      try {
        await assert.rejects(
          fixture.adapter.start({
            projectDirectory: fixture.directory,
            profile,
          }),
          (error: unknown) =>
            error instanceof RuntimeAdapterError && error.category === category,
        );
        assert.equal(fixture.spawnCount(), 0);
      } finally {
        await fixture.close();
      }
    });
  }
});

async function offlineAdapter(
  t: TestContext,
  mode: "future-noise" | "damaged-frame" | "noise-flood",
  authentication = loggedInSubscriptionAuthentication(),
) {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "uaw159-claude-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(
    new URL("./fixtures/noisy-claude-cli.mjs", import.meta.url),
  );
  let spawns = 0;
  const dependencies = {
    async discoverExecutable() {
      return Object.freeze({
        executable: process.execPath,
        prefixArguments: Object.freeze([script]),
      });
    },
    async readAuthenticationStatus(_launch, options) {
      assert.equal(options.env.CLAUDE_CONFIG_DIR, directory);
      return authentication;
    },
    spawnProcess(executable, arguments_, options) {
      spawns += 1;
      return spawn(executable, [...arguments_], options);
    },
    environment: Object.freeze({
      SystemRoot: process.env.SystemRoot,
      CLAUDE_CONFIG_DIR: directory,
      UAW_TEST_EXPECT_CLAUDE_CONFIG_DIR: directory,
      UAW_TEST_CLAUDE_MODE: mode,
    }),
    deploymentMode: "subscription",
    recordDiagnostic: () => undefined,
  } satisfies ClaudeCatalogProcessDependencies;
  let transport:
    | Awaited<ReturnType<typeof createOfficialClaudeSessionTransport>>
    | undefined;
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport must not run in this offline test");
    },
    async request => {
      transport = await createOfficialClaudeSessionTransport(
        request,
        dependencies,
      );
      return transport;
    },
  );
  return {
    adapter,
    directory,
    spawnCount: () => spawns,
    close: async () => transport?.stop(),
  };
}

function loggedInSubscriptionAuthentication(): string {
  return JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: "owner@example.com",
    orgId: "org-owner",
    orgName: "Owner Organization",
    subscriptionType: "max",
  });
}

function isProtocolInvalid(error: unknown): boolean {
  return (
    error instanceof RuntimeAdapterError &&
    error.category === "protocol-invalid"
  );
}

async function collect(
  values: AsyncIterable<NormalizedRuntimeEvent>,
): Promise<NormalizedRuntimeEvent[]> {
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of values) events.push(event);
  return events;
}
