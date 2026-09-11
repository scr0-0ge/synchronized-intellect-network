import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { nativeLaunch } from "../../src/agent-runtime/claude/process-transport.ts";
import {
  createOfficialClaudeSubscriptionAuthenticationProvider,
  type ClaudeSubscriptionAuthenticationDependencies,
} from "../../src/agent-runtime/claude/subscription-authentication.ts";
import { createOfficialCodexSubscriptionLoginProcess } from "../../src/agent-runtime/codex/process-transport.ts";
import type { CodexSubscriptionLoginProcessDependencies } from "../../src/agent-runtime/codex/process-transport.ts";
import type { CodexExecutableHandle } from "../../src/agent-runtime/codex/executable-discovery.ts";

// F-w187 / public issue #4. The owner's own observation settled the normal
// path: clicking Login does pop a browser, because `windowsHide: true` hides
// the CLI's own console and the browser is a different process. What was
// really broken is the OTHER path -- both shipped CLIs print the sign-in URL
// for a machine whose browser did not open, and `stdio: "ignore"` sent it to
// the null device. These tests drive a fake CLI; no real sign-in is performed
// and every URL is synthetic.

const fixture = fileURLToPath(
  new URL("./fixtures/sign-in-url-cli.mjs", import.meta.url),
);
const syntheticUrl =
  "https://auth.example.invalid/oauth/authorize?client_id=synthetic&code=SYNTHETIC-NOT-A-REAL-CODE";

test("a login prints its sign-in URL and the Workbench now receives it", async () => {
  const launches: Readonly<Record<string, unknown>>[] = [];
  const provider = createOfficialClaudeSubscriptionAuthenticationProvider(
    claudeDependencies("with-url", launches),
  );

  const owned = await provider.launchLogin(new AbortController().signal);
  assert.equal(await owned.signInUrl, syntheticUrl);
  await owned.finished;

  // The console stays hidden and stdin stays closed. Only the two output
  // streams were opened, and only for a login.
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0]!.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(launches[0]!.windowsHide, true);
  assert.equal(launches[0]!.shell, false);
});

test("the localhost callback server is never offered as the sign-in link", async () => {
  const provider = createOfficialClaudeSubscriptionAuthenticationProvider(
    claudeDependencies("no-url"),
  );

  const owned = await provider.launchLogin(new AbortController().signal);
  // The CLI printed `http://localhost:1455` and nothing else. Showing that
  // would send the reader to a callback endpoint that signs nobody in, and
  // showing a placeholder would claim a state the product cannot see.
  assert.equal(await owned.signInUrl, undefined);
  await owned.finished;
});

test("a sign-in URL split across writes is reported whole, never truncated", async () => {
  const provider = createOfficialClaudeSubscriptionAuthenticationProvider(
    claudeDependencies("split"),
  );

  const owned = await provider.launchLogin(new AbortController().signal);
  assert.equal(await owned.signInUrl, syntheticUrl);
  await owned.finished;
});

test("a sign-in URL printed on stderr is read too", async () => {
  const provider = createOfficialClaudeSubscriptionAuthenticationProvider(
    claudeDependencies("stderr-url"),
  );

  const owned = await provider.launchLogin(new AbortController().signal);
  assert.equal(await owned.signInUrl, syntheticUrl);
  await owned.finished;
});

test("a non-https scheme the CLI printed never becomes a sign-in link", async () => {
  const provider = createOfficialClaudeSubscriptionAuthenticationProvider(
    claudeDependencies("hostile-url"),
  );

  const owned = await provider.launchLogin(new AbortController().signal);
  assert.equal(await owned.signInUrl, undefined);
  await owned.finished;
});

test("a logout is still spawned with its output discarded and reports no URL", async () => {
  const launches: Readonly<Record<string, unknown>>[] = [];
  const provider = createOfficialClaudeSubscriptionAuthenticationProvider(
    claudeDependencies("with-url", launches),
  );

  const owned = await provider.launchLogout(new AbortController().signal);
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.stdio, "ignore");
  assert.equal(owned.signInUrl, undefined);
  await owned.finished;
});

test("the Codex login path reads its sign-in URL on the same terms", async () => {
  const launches: Readonly<Record<string, unknown>>[] = [];
  const executable = Object.freeze({}) as CodexExecutableHandle;
  const dependencies: CodexSubscriptionLoginProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return { kind: "located" as const, executable };
    },
    spawnProcess(
      _handle: CodexExecutableHandle,
      _arguments: readonly string[],
      options: Parameters<
        CodexSubscriptionLoginProcessDependencies["spawnProcess"]
      >[2],
    ) {
      launches.push(options);
      return spawnFixture("with-url", options);
    },
    async stageExecutable() {
      throw new Error("staging must not run");
    },
    async removeCleanupDirectory() {},
    environment: Object.freeze({}),
  });

  const owned = await createOfficialCodexSubscriptionLoginProcess(dependencies);
  assert.equal(await owned.signInUrl, syntheticUrl);
  await owned.finished;
  assert.deepEqual(launches[0]!.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(launches[0]!.windowsHide, true);
});

test("reading the login output never becomes a reading of the sign-in status", async () => {
  // The output is read for one purpose. A CLI that prints "Logged in as ..."
  // must not move the card: only `inspectAuthentication` decides that, and it
  // is the thing that actually asks the CLI.
  let statusReads = 0;
  const provider = createOfficialClaudeSubscriptionAuthenticationProvider(
    Object.freeze({
      ...claudeDependencies("with-url"),
      async readAuthenticationStatus() {
        statusReads += 1;
        return JSON.stringify({ loggedIn: true, authMethod: "claudeai" });
      },
    }),
  );

  const owned = await provider.launchLogin(new AbortController().signal);
  await owned.signInUrl;
  await owned.finished;
  assert.equal(statusReads, 0);
});

function claudeDependencies(
  mode: string,
  launches?: Readonly<Record<string, unknown>>[],
): ClaudeSubscriptionAuthenticationDependencies {
  return Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("private-claude-executable");
    },
    async readAuthenticationStatus() {
      return "status must not be read by an action";
    },
    spawnProcess(
      _executable: string,
      _arguments: readonly string[],
      options: Parameters<
        ClaudeSubscriptionAuthenticationDependencies["spawnProcess"]
      >[2],
    ) {
      launches?.push(options);
      return spawnFixture(mode, options);
    },
    environment: Object.freeze({}),
  });
}

/**
 * Run the fake CLI under the options the product chose.
 *
 * The `stdio` and `windowsHide` values are the product's, not the test's, so a
 * change that stopped opening the pipes would fail here rather than be papered
 * over by a test that opens them itself.
 */
function spawnFixture(
  mode: string,
  options: { readonly stdio: unknown; readonly windowsHide: true },
): ChildProcess {
  return spawn(process.execPath, [fixture], {
    stdio: options.stdio as "ignore",
    windowsHide: options.windowsHide,
    env: { ...process.env, UAW_TEST_SIGN_IN_MODE: mode },
  });
}
