import type { WindowsRuntimeLaunch } from "../../src/agent-runtime/windows-executable-admission.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import { createSubscriptionAuthenticationService } from "../../src/agent-runtime/subscription-authentication.ts";
import {
  readOfficialClaudeAuthenticationStatus,
} from "../../src/agent-runtime/claude/authentication-status.ts";
import {
  createOfficialClaudeCatalogTransport,
  type ClaudeCatalogProcessDependencies,
  nativeLaunch,
} from "../../src/agent-runtime/claude/process-transport.ts";
import {
  createOfficialClaudeSubscriptionAuthenticationProvider,
  type ClaudeSubscriptionAuthenticationDependencies,
} from "../../src/agent-runtime/claude/subscription-authentication.ts";
import {
  completeSettingsSubscriptionAuthenticationResponse,
  initialSettingsSubscriptionAuthenticationState,
  settingsSubscriptionAuthenticationPresentation,
} from "../../src/workbench-shell/renderer/settings-view-model.ts";
import {
  createWorkbenchSubscriptionAuthenticationCoordinator,
  WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS,
} from "../../src/workbench-shell/subscription-authentication-coordinator.ts";

const fixtureModeKey = "WORKBENCH_CLAUDE_AUTH_STATUS_FIXTURE";
type ExecFile = typeof import("node:child_process").execFile;
const mutableChildProcess = createRequire(import.meta.url)(
  "node:child_process",
) as { execFile: ExecFile };
let fixtureDirectory = "";
let originalDirectory = "";

before(async () => {
  fixtureDirectory = await mkdtemp(
    join(tmpdir(), "workbench-claude-auth-status-"),
  );
  originalDirectory = process.cwd();
  await writeFile(
    join(fixtureDirectory, "auth"),
    [
      'const mode = process.env.WORKBENCH_CLAUDE_AUTH_STATUS_FIXTURE;',
      "const signedOut = JSON.stringify({",
      "  loggedIn: false,",
      '  authMethod: "none",',
      '  apiProvider: "firstParty",',
      "});",
      "switch (mode) {",
      '  case "signed-out-exit-1":',
      "    process.stdout.write(signedOut);",
      "    process.exitCode = 1;",
      "    break;",
      '  case "bound-exit-1":',
      "    process.stdout.write(JSON.stringify({",
      "      loggedIn: true,",
      '      authMethod: "claude.ai",',
      '      apiProvider: "firstParty",',
      "    }));",
      "    process.exitCode = 1;",
      "    break;",
      '  case "unknown-exit-1":',
      "    process.stdout.write(JSON.stringify({",
      "      loggedIn: false,",
      '      authMethod: "renamed-none",',
      '      apiProvider: "firstParty",',
      "    }));",
      "    process.exitCode = 1;",
      "    break;",
      '  case "shape-drift-exit-1":',
      "    process.stdout.write(JSON.stringify({",
      "      loggedIn: false,",
      '      authMethod: "none",',
      "    }));",
      "    process.exitCode = 1;",
      "    break;",
      '  case "malformed-exit-1":',
      '    process.stdout.write("not-json");',
      "    process.exitCode = 1;",
      "    break;",
      '  case "max-buffer":',
      '    process.stdout.write(signedOut + " ".repeat(20_000));',
      "    process.exitCode = 1;",
      "    break;",
      '  case "signal":',
      "    process.stdout.write(signedOut);",
      '    process.kill(process.pid, "SIGTERM");',
      "    break;",
      '  case "abort":',
      "    process.stdout.write(signedOut);",
      "    setInterval(() => undefined, 1_000);",
      "    break;",
      '  case "success-malformed":',
      '    process.stdout.write("not-json");',
      "    break;",
      "  default:",
      "    process.exitCode = 2;",
      "}",
    ].join("\n"),
    "utf8",
  );
  process.chdir(fixtureDirectory);
});

after(async () => {
  process.chdir(originalDirectory);
  await rm(fixtureDirectory, { recursive: true });
});

test("the native Claude reader preserves recognized signed-out stdout from numeric exit 1", async () => {
  const output = await readFixture("signed-out-exit-1");

  assert.deepEqual(JSON.parse(output), {
    loggedIn: false,
    authMethod: "none",
    apiProvider: "firstParty",
  });
});

test("numeric nonzero completion still rejects bound, unknown, drifted, and malformed stdout", async () => {
  for (const mode of [
    "bound-exit-1",
    "unknown-exit-1",
    "shape-drift-exit-1",
    "malformed-exit-1",
  ] as const) {
    await assert.rejects(
      readFixture(mode),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "killed" in error &&
        error.killed === false &&
        "signal" in error &&
        error.signal === null,
      mode,
    );
  }
});

test("spawn, abort, signal, and max-buffer failures reject even with recognized stdout", async () => {
  await assert.rejects(
    readOfficialClaudeAuthenticationStatus(
      nativeLaunch(join(fixtureDirectory, "missing-claude-executable")),
      fixtureOptions("signed-out-exit-1"),
    ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ENOENT",
    "spawn failure",
  );
  await assert.rejects(
    readFixture("abort", AbortSignal.timeout(50)),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ABORT_ERR",
    "abort failure",
  );
  await withExecFileCallback(
    Object.assign(new Error("signalled child"), {
      code: 1,
      killed: true,
      signal: "SIGTERM" as NodeJS.Signals,
    }),
    JSON.stringify({
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty",
    }),
    async () =>
      assert.rejects(
        readFixture("signed-out-exit-1"),
        (error: unknown) =>
          error instanceof Error &&
          "signal" in error &&
          error.signal === "SIGTERM",
        "signal failure",
      ),
  );
  await assert.rejects(
    readFixture("max-buffer"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    "max-buffer failure",
  );
});

test("the observed exit-1 tuple reaches the Claude catalog as authentication-required", async () => {
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch(process.execPath);
    },
    readAuthenticationStatus(
      launch: WindowsRuntimeLaunch,
      options: Parameters<
        ClaudeCatalogProcessDependencies["readAuthenticationStatus"]
      >[1],
    ) {
      return readOfficialClaudeAuthenticationStatus(
        launch,
        Object.freeze({
          ...options,
          env: fixtureEnvironment("signed-out-exit-1"),
        }),
      );
    },
    spawnProcess() {
      assert.fail("signed-out catalog inspection must not spawn Claude");
    },
  });

  await assert.rejects(
    createOfficialClaudeCatalogTransport("project-directory", dependencies),
    (error: unknown) =>
      error instanceof RuntimeAdapterError &&
      error.category === "authentication-required",
  );
});

test("repeated exit-1 subscription reads move Settings from Unknown / Re-check sign-in to Sign-in required / Login", async () => {
  const dependencies: ClaudeSubscriptionAuthenticationDependencies =
    Object.freeze({
      async discoverExecutable() {
        return nativeLaunch(process.execPath);
      },
      readAuthenticationStatus: readOfficialClaudeAuthenticationStatus,
      spawnProcess() {
        assert.fail("inspection must not launch an authentication action");
      },
      environment: fixtureEnvironment("signed-out-exit-1"),
    });
  const service = createSubscriptionAuthenticationService({
    providers: Object.freeze([
      createOfficialClaudeSubscriptionAuthenticationProvider(dependencies),
    ]),
    timeoutMilliseconds: 1_000,
    inspectionTimeoutMilliseconds: 1_000,
  });
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: Object.freeze([
      Object.freeze({
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
        endpointId: "codex-desktop" as const,
        label: "Codex" as const,
      }),
      Object.freeze({
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
        endpointId: "claude-code-desktop" as const,
        label: "Claude" as const,
      }),
    ]),
    authentication: service,
    mutations: Object.freeze({
      prepare() {
        assert.fail("inspection must not prepare an authentication action");
      },
      begin() {
        assert.fail("inspection must not begin an authentication action");
      },
      cancel() {
        assert.fail("inspection must not cancel an authentication action");
      },
    }),
  });
  try {
    const initial = initialSettingsSubscriptionAuthenticationState();
    const initialPresentation = settingsSubscriptionAuthenticationPresentation(
      initial["claude-code-desktop"]!,
    );
    // The renderer's verb is "Check sign-in" since w233 (one verb root on the
    // page); the coordinator's model-level card below keeps its own label.
    assert.deepEqual(
      [initialPresentation.label, initialPresentation.actionLabel],
      ["Unknown", "Check sign-in"],
    );
    const initialCard = coordinator.renderSettings().cards[1];
    assert.deepEqual(
      [initialCard?.authentication, initialCard?.actions[0]?.label],
      ["Unknown", "Re-check sign-in"],
    );

    const first = await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
    });
    const second = await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
    });
    assert.equal(first.accepted, true);
    assert.equal(second.accepted, true);
    if (!first.accepted || !second.accepted) {
      assert.fail("recognized status inspection must cross the public boundary");
    }
    assert.deepEqual(
      [
        first.value.kind === "authentication-state"
          ? first.value.state
          : first.value.kind,
        second.value.kind === "authentication-state"
          ? second.value.state
          : second.value.kind,
      ],
      ["sign-in-required", "sign-in-required"],
    );

    const refreshed = completeSettingsSubscriptionAuthenticationResponse(
      initial,
      "claude-code-desktop",
      second.value,
    );
    const refreshedPresentation =
      settingsSubscriptionAuthenticationPresentation(
        refreshed["claude-code-desktop"]!,
      );
    assert.deepEqual(
      [refreshedPresentation.label, refreshedPresentation.actionLabel],
      ["Sign-in required", "Login"],
    );
    const refreshedCard = coordinator.renderSettings().cards[1];
    assert.deepEqual(
      [refreshedCard?.authentication, refreshedCard?.actions[0]?.label],
      ["Sign-in required", "Login"],
    );
  } finally {
    await coordinator.close();
  }
});

function readFixture(
  mode: string,
  signal?: AbortSignal,
): Promise<string> {
  return readOfficialClaudeAuthenticationStatus(
    nativeLaunch(process.execPath),
    fixtureOptions(mode, signal),
  );
}

function fixtureOptions(
  mode: string,
  signal?: AbortSignal,
): Readonly<{
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  windowsHide: true;
}> {
  return Object.freeze({
    env: fixtureEnvironment(mode),
    ...(signal === undefined ? {} : { signal }),
    windowsHide: true as const,
  });
}

function fixtureEnvironment(mode: string): NodeJS.ProcessEnv {
  return Object.freeze({
    ...process.env,
    [fixtureModeKey]: mode,
  });
}

async function withExecFileCallback(
  error: Error,
  stdout: string,
  action: () => Promise<unknown>,
): Promise<void> {
  const originalExecFile = mutableChildProcess.execFile;
  mutableChildProcess.execFile = ((
    _executable: string,
    _arguments: readonly string[],
    _options: unknown,
    callback: (error: Error, stdout: string, stderr: string) => void,
  ) => {
    queueMicrotask(() => callback(error, stdout, ""));
    return Object.freeze({});
  }) as unknown as ExecFile;
  syncBuiltinESMExports();
  try {
    await action();
  } finally {
    mutableChildProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  }
}
