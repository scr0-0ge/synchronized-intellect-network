import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { ChildProcess } from "node:child_process";

import {
  createSubscriptionAuthenticationService,
  ownSubscriptionAuthenticationProcess,
  type SubscriptionAuthenticationScheduler,
} from "../../src/agent-runtime/subscription-authentication.ts";
import {
  createOfficialClaudeSubscriptionAuthenticationProvider,
  type ClaudeSubscriptionAuthenticationDependencies,
} from "../../src/agent-runtime/claude/subscription-authentication.ts";
import {
  createOfficialCodexSubscriptionAuthenticationProvider,
} from "../../src/agent-runtime/codex/subscription-authentication.ts";
import {
  createOfficialCodexSubscriptionLoginProcess,
  createOfficialCodexSubscriptionLogoutProcess,
  type CodexSubscriptionLoginProcessDependencies,
} from "../../src/agent-runtime/codex/process-transport.ts";
import type { CodexExecutableHandle } from "../../src/agent-runtime/codex/executable-discovery.ts";
import type { OfficialRuntimeTransport } from "../../src/agent-runtime/codex/transport.ts";

test("Claude binding fixes auth login, discards all output, scrubs credentials, and kills only its child", async () => {
  const child = fakeNativeChild();
  const launches: unknown[][] = [];
  const dependencies: ClaudeSubscriptionAuthenticationDependencies = Object.freeze({
    async discoverExecutable() {
      return "private-claude-executable";
    },
    async readAuthenticationStatus() {
      return JSON.stringify({
        loggedIn: false,
        authMethod: "none",
        apiProvider: "firstParty",
      });
    },
    spawnProcess(
      executable: string,
      arguments_: readonly string[],
      options: Parameters<
        ClaudeSubscriptionAuthenticationDependencies["spawnProcess"]
      >[2],
    ) {
      launches.push([executable, arguments_, options]);
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    },
    environment: Object.freeze({
      CLAUDECODE: "must-not-reach-login",
      ANTHROPIC_API_KEY: "must-not-reach-login",
      ANTHROPIC_AUTH_TOKEN: "must-not-reach-login",
      ANTHROPIC_BEARER_TOKEN: "must-not-reach-login",
      ANTHROPIC_MODEL: "must-not-reach-login",
      CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-login",
      CLAUDE_CODE_USE_BEDROCK: "must-not-reach-login",
      CLAUDE_CODE_USE_VERTEX: "must-not-reach-login",
      CLAUDE_CODE_USE_FOUNDRY: "must-not-reach-login",
      CLAUDE_CODE_EFFORT_LEVEL: "must-not-reach-login",
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "must-not-reach-login",
      SAFE_SETTING: "preserved",
    }),
  });
  const provider = createOfficialClaudeSubscriptionAuthenticationProvider(dependencies);

  const owned = await provider.launchLogin(new AbortController().signal);
  assert.equal(launches.length, 1);
  const [executable, arguments_, options] = launches[0] as [
    string,
    readonly string[],
    Readonly<Record<string, unknown>>,
  ];
  assert.equal(executable, "private-claude-executable");
  assert.deepEqual(arguments_, ["auth", "login"]);
  assert.equal(options.shell, false);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.windowsHide, true);
  assert.equal("cwd" in options, false);
  assertClaudeOAuthOnlyEnvironment(options.env as NodeJS.ProcessEnv);
  assert.equal((options.env as NodeJS.ProcessEnv).SAFE_SETTING, "preserved");

  await owned.terminate();
  assert.equal(child.killCalls(), 1);
});

test("Claude logout fixes auth logout, discards all output, scrubs credentials, and kills only its child", async () => {
  const child = fakeNativeChild();
  const launches: unknown[][] = [];
  const dependencies: ClaudeSubscriptionAuthenticationDependencies = Object.freeze({
    async discoverExecutable() {
      return "private-claude-executable";
    },
    async readAuthenticationStatus() {
      return "private status output must not be consumed by an action";
    },
    spawnProcess(
      executable: string,
      arguments_: readonly string[],
      options: Parameters<
        ClaudeSubscriptionAuthenticationDependencies["spawnProcess"]
      >[2],
    ) {
      launches.push([executable, arguments_, options]);
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    },
    environment: Object.freeze({
      CLAUDECODE: "must-not-reach-logout",
      ANTHROPIC_API_KEY: "must-not-reach-logout",
      ANTHROPIC_AUTH_TOKEN: "must-not-reach-logout",
      ANTHROPIC_BEARER_TOKEN: "must-not-reach-logout",
      ANTHROPIC_MODEL: "must-not-reach-logout",
      CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-logout",
      CLAUDE_CODE_USE_BEDROCK: "must-not-reach-logout",
      CLAUDE_CODE_USE_VERTEX: "must-not-reach-logout",
      CLAUDE_CODE_USE_FOUNDRY: "must-not-reach-logout",
      CLAUDE_CODE_EFFORT_LEVEL: "must-not-reach-logout",
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "must-not-reach-logout",
      SAFE_SETTING: "preserved",
    }),
  });
  const provider = createOfficialClaudeSubscriptionAuthenticationProvider(dependencies);

  const owned = await provider.launchLogout(new AbortController().signal);
  assert.equal(launches.length, 1);
  const [executable, arguments_, options] = launches[0] as [
    string,
    readonly string[],
    Readonly<Record<string, unknown>>,
  ];
  assert.equal(executable, "private-claude-executable");
  assert.deepEqual(arguments_, ["auth", "logout"]);
  assert.equal(options.shell, false);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.windowsHide, true);
  assert.equal("cwd" in options, false);
  assertClaudeOAuthOnlyEnvironment(options.env as NodeJS.ProcessEnv);
  assert.equal((options.env as NodeJS.ProcessEnv).SAFE_SETTING, "preserved");

  child.exitCode = 0;
  child.emit("exit", 0, null);
  await owned.finished;
  assert.equal(child.killCalls(), 0);
  assert.equal(launches.length, 1);
});

test("Claude status validates consumed primitives, discards unrelated fields, and maps only recognized tuples", async () => {
  const status = { value: "" };
  const provider = createOfficialClaudeSubscriptionAuthenticationProvider(
    claudeDependencies(status),
  );
  const signal = new AbortController().signal;

  status.value = JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: "private@example.invalid",
    organization: { id: "private-organization" },
  });
  assert.equal(await provider.inspectAuthentication(signal), "bound");
  status.value = JSON.stringify({
    loggedIn: false,
    authMethod: "none",
    apiProvider: "firstParty",
    futureNativeField: "discarded",
  });
  assert.equal(await provider.inspectAuthentication(signal), "sign-in-required");
  status.value = JSON.stringify({
    loggedIn: true,
    authMethod: "api_key",
    apiProvider: "firstParty",
  });
  assert.equal(
    await provider.inspectAuthentication(signal),
    "sign-in-required",
  );
  status.value = JSON.stringify({ loggedIn: false });
  assert.equal(await provider.inspectAuthentication(signal), "unknown");
  for (const drifted of [
    { authMethod: "none", apiProvider: "firstParty" },
    { loggedIn: false, apiProvider: "firstParty" },
    { loggedIn: false, authMethod: "none" },
    { loggedIn: false, authMethod: "renamed-none", apiProvider: "firstParty" },
    { loggedIn: false, authMethod: "none", apiProvider: "renamed-provider" },
    { loggedIn: true, authMethod: "renamed-oauth", apiProvider: "firstParty" },
    { loggedIn: true, authMethod: "claude.ai", apiProvider: "renamed-provider" },
    { loggedIn: true, authMethod: "none", apiProvider: "firstParty" },
    { loggedIn: false, authMethod: "claude.ai", apiProvider: "firstParty" },
    { loggedIn: false, authMethod: "api_key", apiProvider: "firstParty" },
    { loggedIn: "false", authMethod: "none", apiProvider: "firstParty" },
    { loggedIn: false, authMethod: 0, apiProvider: "firstParty" },
    { loggedIn: false, authMethod: "none", apiProvider: null },
  ] as const) {
    status.value = JSON.stringify(drifted);
    assert.equal(
      await provider.inspectAuthentication(signal),
      "unknown",
      JSON.stringify(drifted),
    );
  }
  status.value = "private non-json status prose";
  assert.equal(await provider.inspectAuthentication(signal), "unknown");
});

test("Codex binding fixes login, discards output, scrubs API credentials, and kills only its child", async () => {
  const child = fakeNativeChild();
  const executable = Object.freeze({}) as CodexExecutableHandle;
  const launches: unknown[][] = [];
  const dependencies: CodexSubscriptionLoginProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return { kind: "located" as const, executable };
    },
    spawnProcess(
      handle: CodexExecutableHandle,
      arguments_: readonly string[],
      options: Parameters<
        CodexSubscriptionLoginProcessDependencies["spawnProcess"]
      >[2],
    ) {
      launches.push([handle, arguments_, options]);
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    },
    async stageExecutable() {
      throw new Error("staging must not run");
    },
    async removeCleanupDirectory() {},
    environment: Object.freeze({
      OPENAI_API_KEY: "must-not-reach-login",
      CODEX_API_KEY: "must-not-reach-login",
      AZURE_OPENAI_API_KEY: "must-not-reach-login",
      OPENAI_BASE_URL: "must-not-reach-login",
      SAFE_SETTING: "preserved",
    }),
  });

  const owned = await createOfficialCodexSubscriptionLoginProcess(dependencies);
  const [launchedHandle, arguments_, options] = launches[0] as [
    CodexExecutableHandle,
    readonly string[],
    Readonly<Record<string, unknown>>,
  ];
  assert.equal(launchedHandle, executable);
  assert.deepEqual(arguments_, ["login"]);
  assert.equal(options.shell, false);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.windowsHide, true);
  assert.equal("cwd" in options, false);
  assertCodexOAuthOnlyEnvironment(options.env as NodeJS.ProcessEnv);
  assert.equal((options.env as NodeJS.ProcessEnv).SAFE_SETTING, "preserved");

  await owned.terminate();
  assert.equal(child.killCalls(), 1);
});

test("Codex logout fixes logout, discards output, scrubs API credentials, and owns only its child", async () => {
  const child = fakeNativeChild();
  const executable = Object.freeze({}) as CodexExecutableHandle;
  const launches: unknown[][] = [];
  const dependencies: CodexSubscriptionLoginProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return { kind: "located" as const, executable };
    },
    spawnProcess(
      handle: CodexExecutableHandle,
      arguments_: readonly string[],
      options: Parameters<
        CodexSubscriptionLoginProcessDependencies["spawnProcess"]
      >[2],
    ) {
      launches.push([handle, arguments_, options]);
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    },
    async stageExecutable() {
      throw new Error("staging must not run");
    },
    async removeCleanupDirectory() {},
    environment: Object.freeze({
      OPENAI_API_KEY: "must-not-reach-logout",
      CODEX_API_KEY: "must-not-reach-logout",
      AZURE_OPENAI_API_KEY: "must-not-reach-logout",
      OPENAI_BASE_URL: "must-not-reach-logout",
      SAFE_SETTING: "preserved",
    }),
  });

  const owned = await createOfficialCodexSubscriptionLogoutProcess(dependencies);
  const [launchedHandle, arguments_, options] = launches[0] as [
    CodexExecutableHandle,
    readonly string[],
    Readonly<Record<string, unknown>>,
  ];
  assert.equal(launchedHandle, executable);
  assert.deepEqual(arguments_, ["logout"]);
  assert.equal(options.shell, false);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.windowsHide, true);
  assert.equal("cwd" in options, false);
  assertCodexOAuthOnlyEnvironment(options.env as NodeJS.ProcessEnv);
  assert.equal((options.env as NodeJS.ProcessEnv).SAFE_SETTING, "preserved");

  child.exitCode = 1;
  child.emit("exit", 1, null);
  await owned.finished;
  assert.equal(child.killCalls(), 0);
  assert.equal(launches.length, 1);
});

test("Codex provider exposes only fixed login and logout action entry points", async () => {
  const actions: string[] = [];
  const provider = createOfficialCodexSubscriptionAuthenticationProvider({
    async launchLogin() {
      actions.push("login");
      return controlledAuthenticationChild();
    },
    async launchLogout() {
      actions.push("logout");
      return controlledAuthenticationChild();
    },
    async createTransport() {
      throw new Error("inspection must not run for an action");
    },
  });

  await provider.launchLogin(new AbortController().signal);
  await provider.launchLogout(new AbortController().signal);
  assert.deepEqual(actions, ["login", "logout"]);
  assert.deepEqual(Object.keys(provider).sort(), [
    "endpointId",
    "inspectAuthentication",
    "launchLogin",
    "launchLogout",
  ]);
});

test("both provider adapters treat exit zero, nonzero, and signal as output-free lifecycle only", async () => {
  for (const exitMode of ["zero", "nonzero", "signal"] as const) {
    const claudeChild = fakeNativeChildWithPoisonedOutput();
    let claudeStatusReads = 0;
    const claudeProvider = createOfficialClaudeSubscriptionAuthenticationProvider(
      Object.freeze({
        async discoverExecutable() {
          return "private-claude-executable";
        },
        async readAuthenticationStatus() {
          claudeStatusReads += 1;
          return "private action output must never be parsed as status";
        },
        spawnProcess() {
          queueMicrotask(() => claudeChild.emit("spawn"));
          return claudeChild as unknown as ChildProcess;
        },
        environment: Object.freeze({}),
      }),
    );
    const claudeOwned = await (exitMode === "zero"
      ? claudeProvider.launchLogin(new AbortController().signal)
      : claudeProvider.launchLogout(new AbortController().signal));
    finishNativeChild(claudeChild, exitMode);
    await claudeOwned.finished;
    assert.equal(claudeStatusReads, 0);
    assert.equal(claudeChild.killCalls(), 0);

    const codexChild = fakeNativeChildWithPoisonedOutput();
    const executable = Object.freeze({}) as CodexExecutableHandle;
    const codexDependencies: CodexSubscriptionLoginProcessDependencies =
      Object.freeze({
        async discoverExecutable() {
          return { kind: "located" as const, executable };
        },
        spawnProcess() {
          queueMicrotask(() => codexChild.emit("spawn"));
          return codexChild as unknown as ChildProcess;
        },
        async stageExecutable() {
          throw new Error("staging must not run");
        },
        async removeCleanupDirectory() {},
        environment: Object.freeze({}),
      });
    const codexOwned = await (exitMode === "zero"
      ? createOfficialCodexSubscriptionLoginProcess(codexDependencies)
      : createOfficialCodexSubscriptionLogoutProcess(codexDependencies));
    finishNativeChild(codexChild, exitMode);
    await codexOwned.finished;
    assert.equal(codexChild.killCalls(), 0);
  }
});

test("Codex status uses account/read refreshToken false and projects only recognized account states", async () => {
  for (const [account, expected] of [
    [
      { type: "chatgpt", email: "private@example.invalid", plan: "private" },
      "bound",
    ],
    [{ type: "apiKey", privateTokenHint: "discarded" }, "sign-in-required"],
    [{ type: "future-provider-type" }, "unknown"],
    [{ type: 42 }, "unknown"],
    [{ renamedType: "chatgpt" }, "unknown"],
    [null, "sign-in-required"],
    ["logged out", "unknown"],
  ] as const) {
    const transport = scriptedCodexAccountTransport(account);
    const provider = createOfficialCodexSubscriptionAuthenticationProvider({
      async launchLogin() {
        throw new Error("not used");
      },
      async launchLogout() {
        throw new Error("not used");
      },
      async createTransport() {
        return transport;
      },
    });

    assert.equal(
      await provider.inspectAuthentication(new AbortController().signal),
      expected,
    );
    assert.deepEqual(transport.requests(), [
      {
        method: "initialize",
        params: {
          clientInfo: {
            name: "unified-agent-workbench",
            title: "Synchronized Intellect Network",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
      },
      { method: "initialized", params: {} },
      { method: "account/read", params: { refreshToken: false } },
    ]);
    assert.equal(transport.stopCalls(), 1);
  }
});

test("official provider logout actions do not spawn after service cancellation wins deferred discovery", async () => {
  const claudeDiscovery = deferred<string>();
  let claudeSpawns = 0;
  const claudeProvider = createOfficialClaudeSubscriptionAuthenticationProvider(
    Object.freeze({
      discoverExecutable: () => claudeDiscovery.promise,
      async readAuthenticationStatus() {
        return "{}";
      },
      spawnProcess() {
        claudeSpawns += 1;
        const child = fakeNativeChild();
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcess;
      },
      environment: Object.freeze({}),
    }),
  );
  const claudeService = createSubscriptionAuthenticationService({
    providers: [claudeProvider],
    timeoutMilliseconds: 30_000,
  });
  const claudeBinding = claudeService.requestAction(
    "claude-code-desktop",
    "logout",
  );
  await tick();
  await claudeService.close();
  claudeDiscovery.resolve("private-claude-executable");
  await tick();
  await tick();
  assert.equal((await claudeBinding).effect, "cancelled");
  assert.equal(claudeSpawns, 0);

  const codexDiscovery = deferred<
    Readonly<{ kind: "located"; executable: CodexExecutableHandle }>
  >();
  const executable = Object.freeze({}) as CodexExecutableHandle;
  let codexSpawns = 0;
  const codexProcessDependencies: CodexSubscriptionLoginProcessDependencies =
    Object.freeze({
      discoverExecutable: () => codexDiscovery.promise,
      spawnProcess() {
        codexSpawns += 1;
        const child = fakeNativeChild();
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcess;
      },
      async stageExecutable() {
        throw new Error("not used");
      },
      async removeCleanupDirectory() {},
      environment: Object.freeze({}),
    });
  const codexProvider = createOfficialCodexSubscriptionAuthenticationProvider({
    launchLogin: (signal: AbortSignal) =>
      createOfficialCodexSubscriptionLoginProcess(
        codexProcessDependencies,
        signal,
      ),
    launchLogout: (signal: AbortSignal) =>
      createOfficialCodexSubscriptionLogoutProcess(
        codexProcessDependencies,
        signal,
      ),
    async createTransport() {
      throw new Error("not used");
    },
  });
  const codexService = createSubscriptionAuthenticationService({
    providers: [codexProvider],
    timeoutMilliseconds: 30_000,
  });
  const codexBinding = codexService.requestAction("codex-desktop", "logout");
  await tick();
  await codexService.cancel("codex-desktop");
  codexDiscovery.resolve({ kind: "located", executable });
  await tick();
  await tick();
  assert.equal((await codexBinding).effect, "cancelled");
  assert.equal(codexSpawns, 0);
  await codexService.close();
});

test("Codex cancellation after staging cleans the exact staged runtime without spawning it", async () => {
  const directExecutable = Object.freeze({}) as CodexExecutableHandle;
  const stagedExecutable = Object.freeze({}) as CodexExecutableHandle;
  const staging = deferred<{
    readonly executable: CodexExecutableHandle;
    readonly cleanupDirectory: string;
    readonly stagedFiles: readonly string[];
  }>();
  let directLaunches = 0;
  let stagedLaunches = 0;
  let cleanupCalls = 0;
  const controller = new AbortController();
  const launch = createOfficialCodexSubscriptionLoginProcess(
    Object.freeze({
      async discoverExecutable() {
        return { kind: "located" as const, executable: directExecutable };
      },
      spawnProcess(executable: CodexExecutableHandle) {
        if (executable === directExecutable) {
          directLaunches += 1;
          throw Object.assign(new Error("private direct access failure"), {
            code: "EACCES",
          });
        }
        stagedLaunches += 1;
        const child = fakeNativeChild();
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcess;
      },
      stageExecutable: () => staging.promise,
      async removeCleanupDirectory(directory: string) {
        assert.equal(directory, "private-staged-directory");
        cleanupCalls += 1;
      },
      environment: Object.freeze({}),
    }),
    controller.signal,
  );

  await tick();
  controller.abort();
  staging.resolve({
    executable: stagedExecutable,
    cleanupDirectory: "private-staged-directory",
    stagedFiles: Object.freeze([]),
  });

  await assert.rejects(launch);
  assert.equal(directLaunches, 1);
  assert.equal(stagedLaunches, 0);
  assert.equal(cleanupCalls, 1);
});

test("post-spawn native error is not process exit and cannot trigger cleanup", async () => {
  const child = fakeNativeChild();
  let cleanups = 0;
  const owned = ownSubscriptionAuthenticationProcess(
    child as unknown as ChildProcess,
    async () => {
      cleanups += 1;
    },
  );
  let finished = false;
  void owned.finished.then(() => {
    finished = true;
  });

  child.emit("error", new Error("private post-spawn error"));
  await tick();
  assert.equal(finished, false);
  assert.equal(cleanups, 0);

  child.exitCode = 1;
  child.emit("exit", 1, null);
  await owned.finished;
  assert.equal(finished, true);
  assert.equal(cleanups, 1);
});

test("inspection timeout aborts the exact Claude status command once", async () => {
  const scheduler = controlledScheduler();
  let aborts = 0;
  const provider = createOfficialClaudeSubscriptionAuthenticationProvider(
    Object.freeze({
      async discoverExecutable() {
        return "private-claude-executable";
      },
      readAuthenticationStatus(
        _executable: string,
        options: Parameters<
          ClaudeSubscriptionAuthenticationDependencies["readAuthenticationStatus"]
        >[1],
      ) {
        options.signal.addEventListener(
          "abort",
          () => {
            aborts += 1;
          },
          { once: true },
        );
        return new Promise<never>(() => undefined);
      },
      spawnProcess() {
        throw new Error("not used");
      },
      environment: Object.freeze({}),
    }),
  );
  const service = createSubscriptionAuthenticationService({
    providers: [provider],
    scheduler,
    timeoutMilliseconds: 30_000,
    inspectionTimeoutMilliseconds: 2_000,
  });

  const inspection = service.inspect("claude-code-desktop");
  await tick();
  scheduler.fireNext();
  assert.deepEqual(await inspection, {
    endpointId: "claude-code-desktop",
    authentication: "unknown",
  });
  assert.equal(aborts, 1);
  await service.close();
});

test("inspection timeout stops the exact Codex app-server transport once", async () => {
  const scheduler = controlledScheduler();
  let stopCalls = 0;
  let resolveReceive!: (value: string | null) => void;
  const receive = new Promise<string | null>((resolve) => {
    resolveReceive = resolve;
  });
  const transport: OfficialRuntimeTransport = Object.freeze({
    async send() {},
    receive: () => receive,
    async stop() {
      stopCalls += 1;
      resolveReceive(null);
    },
  });
  const provider = createOfficialCodexSubscriptionAuthenticationProvider({
    async launchLogin() {
      throw new Error("not used");
    },
    async launchLogout() {
      throw new Error("not used");
    },
    async createTransport() {
      return transport;
    },
  });
  const service = createSubscriptionAuthenticationService({
    providers: [provider],
    scheduler,
    timeoutMilliseconds: 30_000,
    inspectionTimeoutMilliseconds: 2_000,
  });

  const inspection = service.inspect("codex-desktop");
  await tick();
  scheduler.fireNext();
  assert.deepEqual(await inspection, {
    endpointId: "codex-desktop",
    authentication: "unknown",
  });
  await tick();
  assert.equal(stopCalls, 1);
  await service.close();
});

function claudeDependencies(status: { value: string }): ClaudeSubscriptionAuthenticationDependencies {
  return Object.freeze({
    async discoverExecutable() {
      return "claude";
    },
    async readAuthenticationStatus() {
      return status.value;
    },
    spawnProcess() {
      throw new Error("not used");
    },
    environment: Object.freeze({}),
  });
}

function assertClaudeOAuthOnlyEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of [
    "CLAUDECODE",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BEARER_TOKEN",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_EFFORT_LEVEL",
    "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(environment, key), false);
  }
}

function assertCodexOAuthOnlyEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "OPENAI_BASE_URL",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(environment, key), false);
  }
}

function fakeNativeChild() {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(): boolean;
    killCalls(): number;
  };
  child.exitCode = null;
  child.signalCode = null;
  let kills = 0;
  child.kill = () => {
    kills += 1;
    child.signalCode = "SIGTERM";
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    return true;
  };
  child.killCalls = () => kills;
  return child;
}

function fakeNativeChildWithPoisonedOutput() {
  const child = fakeNativeChild();
  for (const key of ["stdout", "stderr"] as const) {
    Object.defineProperty(child, key, {
      configurable: false,
      get() {
        throw new Error(`native ${key} must not be read`);
      },
    });
  }
  return child;
}

function finishNativeChild(
  child: ReturnType<typeof fakeNativeChild>,
  mode: "zero" | "nonzero" | "signal",
): void {
  if (mode === "signal") {
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
    return;
  }
  child.exitCode = mode === "zero" ? 0 : 17;
  child.emit("exit", child.exitCode, null);
}

function controlledAuthenticationChild() {
  return Object.freeze({
    finished: Promise.resolve(),
    async terminate() {},
  });
}

function scriptedCodexAccountTransport(account: unknown): OfficialRuntimeTransport & {
  requests(): readonly unknown[];
  stopCalls(): number;
} {
  const outbound: unknown[] = [];
  const responses: string[] = [];
  let stops = 0;
  return Object.freeze({
    async send(line: string) {
      const request = JSON.parse(line) as {
        readonly id?: number;
        readonly method: string;
        readonly params?: unknown;
      };
      outbound.push(
        request.params === undefined
          ? { method: request.method }
          : { method: request.method, params: request.params },
      );
      if (request.id !== undefined) {
        responses.push(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result:
              request.method === "initialize"
                ? { server: "synthetic" }
                : { account },
          }),
        );
      }
    },
    async receive() {
      return responses.shift() ?? null;
    },
    async stop() {
      stops += 1;
    },
    requests: () => Object.freeze([...outbound]),
    stopCalls: () => stops,
  });
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  return Object.freeze({ promise, resolve });
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function controlledScheduler(): SubscriptionAuthenticationScheduler & {
  fireNext(): void;
} {
  let identifier = 0;
  const callbacks = new Map<number, () => void>();
  return Object.freeze({
    setTimeout(callback: () => void) {
      identifier += 1;
      callbacks.set(identifier, callback);
      return identifier;
    },
    clearTimeout(handle: unknown) {
      if (typeof handle === "number") callbacks.delete(handle);
    },
    fireNext() {
      const entry = callbacks.entries().next().value as
        | readonly [number, () => void]
        | undefined;
      assert.notEqual(entry, undefined);
      if (entry === undefined) return;
      callbacks.delete(entry[0]);
      entry[1]();
    },
  });
}
