import type { WindowsRuntimeLaunch } from "../../src/agent-runtime/windows-executable-admission.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import {
  ProviderRequestBudgetError,
  type ProviderRequestBudget,
} from "../../src/agent-runtime/provider-request-budget.ts";
import type { ClaudeRuntimeDiagnostic } from "../../src/agent-runtime/claude/diagnostics.ts";
import {
  CLAUDE_CATALOG_ARGUMENTS,
  CLAUDE_CREDENTIAL_ENVIRONMENT_KEYS,
  CLAUDE_DEPLOYMENT_SELECTOR_KEYS,
  CLAUDE_PROFILE_OVERRIDE_ENVIRONMENT_KEYS,
  createOfficialClaudeCatalogTransport,
  createOfficialClaudeSessionTransport,
  createClaudeProcessEnvironment,
  createClaudeSessionArguments,
  discoverClaudeExecutable,
  type ClaudeCatalogProcessDependencies,
  nativeLaunch,
} from "../../src/agent-runtime/claude/process-transport.ts";

test("Claude start and resume request partial messages without unused input replay", () => {
  for (const resumeSessionIdentity of [undefined, "resume-fixture"]) {
    const args = createClaudeSessionArguments({
      projectDirectory: "project", permissionMode: "bypassPermissions",
      profile: { model: "model", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access" },
      ...(resumeSessionIdentity === undefined ? {} : { resumeSessionIdentity }),
    });
    assert.ok(args.includes("--include-partial-messages"), "session launch must request partial thinking frames");
    assert.equal(args.includes("--replay-user-messages"), false, "input replay has no product consumer");
  }
});

test("Claude Session transport leaves stdout readable after stream-json input ends", async () => {
  const child = fakeChild();
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return loggedInSubscriptionAuthentication();
    },
    spawnProcess() {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  const transport = await createOfficialClaudeSessionTransport(
    {
      projectDirectory: "project-directory",
      profile: {
        model: "sonnet",
        effortLevel: "low",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
      permissionMode: "bypassPermissions",
    },
    dependencies,
  );

  assert.equal(typeof transport.finishInput, "function");
  transport.finishInput?.();
  child.stdout.write('{"type":"prompt_suggestion"}\n');
  assert.equal(
    await transport.receive(),
    '{"type":"prompt_suggestion"}',
  );
  child.stdout.end();
  await transport.stop();
});

test("Claude catalog is unavailable when official subscription OAuth is logged out", async () => {
  const child = fakeChild();
  const dependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return JSON.stringify({
        loggedIn: false,
        authMethod: "none",
        apiProvider: "firstParty",
      });
    },
    spawnProcess() {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  }) as ClaudeCatalogProcessDependencies;

  let transport:
    | Awaited<ReturnType<typeof createOfficialClaudeCatalogTransport>>
    | undefined;
  let failure: unknown;
  try {
    transport = await createOfficialClaudeCatalogTransport(
      "project-directory",
      dependencies,
    );
  } catch (error) {
    failure = error;
  } finally {
    await transport?.stop();
  }

  assert.equal(
    failure instanceof RuntimeAdapterError &&
      failure.category === "authentication-required",
    true,
  );
});

test("Claude catalog accepts the real seven-key logged-in subscription response", async () => {
  const child = fakeChild();
  let spawnCount = 0;
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return loggedInSubscriptionAuthentication();
    },
    spawnProcess() {
      spawnCount += 1;
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  const transport = await createOfficialClaudeCatalogTransport(
    "project-directory",
    dependencies,
  );
  await transport.stop();

  assert.equal(spawnCount, 1);
});

test("Claude deployment selectors are mode-selected while credential and profile canaries stay unconditionally stripped", async () => {
  const sourceEnvironment: NodeJS.ProcessEnv = Object.freeze({
    SAFE_SETTING: "preserved",
    CLAUDECODE: "PRIVATE_PROCESS_CANARY",
    ANTHROPIC_API_KEY: "PRIVATE_CREDENTIAL_CANARY",
    ANTHROPIC_AUTH_TOKEN: "PRIVATE_CREDENTIAL_CANARY",
    ANTHROPIC_BEARER_TOKEN: "PRIVATE_CREDENTIAL_CANARY",
    CLAUDE_CODE_OAUTH_TOKEN: "PRIVATE_CREDENTIAL_CANARY",
    ANTHROPIC_MODEL: "PRIVATE_PROFILE_CANARY",
    CLAUDE_CODE_EFFORT_LEVEL: "PRIVATE_PROFILE_CANARY",
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "PRIVATE_PROFILE_CANARY",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "must-not-cross-bedrock-mode",
    CLAUDE_CODE_USE_FOUNDRY: "must-not-cross-bedrock-mode",
  });

  for (const mode of ["subscription", "bedrock"] as const) {
    const environment = createClaudeProcessEnvironment(sourceEnvironment, mode);
    assert.equal(environment.SAFE_SETTING, "preserved", mode);
    for (const key of CLAUDE_CREDENTIAL_ENVIRONMENT_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(environment, key), false, `${mode}:${key}`);
    }
    for (const key of CLAUDE_PROFILE_OVERRIDE_ENVIRONMENT_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(environment, key), false, `${mode}:${key}`);
    }
    for (const key of CLAUDE_DEPLOYMENT_SELECTOR_KEYS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(environment, key),
        mode === "bedrock" && key === "CLAUDE_CODE_USE_BEDROCK",
        `${mode}:${key}`,
      );
    }
    assert.equal(
      environment.CLAUDE_CODE_USE_BEDROCK,
      mode === "bedrock" ? "1" : undefined,
      mode,
    );
  }
});

test("Claude child stderr is privately retained with explicit captured and omitted byte counts", async () => {
  const child = fakeChild();
  const diagnostics: ClaudeRuntimeDiagnostic[] = [];
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return loggedInSubscriptionAuthentication();
    },
    spawnProcess() {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    recordDiagnostic(diagnostic: ClaudeRuntimeDiagnostic) {
      diagnostics.push(diagnostic);
    },
  });

  const transport = await createOfficialClaudeCatalogTransport(
    "project-directory",
    dependencies,
  );
  const privateStderr = `PRIVATE_STDERR_CANARY_${"x".repeat(70_000)}`;
  child.stderr.write(privateStderr);
  await transport.stop();

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.kind, "child-stderr");
  if (diagnostics[0]?.kind !== "child-stderr") assert.fail("Expected stderr diagnostic.");
  assert.equal(diagnostics[0].capturedBytes, 65_536);
  assert.equal(diagnostics[0].omittedBytes, Buffer.byteLength(privateStderr) - 65_536);
  assert.match(diagnostics[0].detail ?? "", /^PRIVATE_STDERR_CANARY_/u);
});

test("Claude catalog and Session spawns receive the selected deployment mode at the real argv/environment boundary", async () => {
  for (const kind of ["catalog", "session"] as const) {
    for (const mode of ["subscription", "bedrock"] as const) {
      const child = fakeChild();
      let capturedArguments: readonly string[] | undefined;
      let capturedEnvironment: NodeJS.ProcessEnv | undefined;
      const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
        async discoverExecutable() {
          return nativeLaunch("claude.exe");
        },
        async readAuthenticationStatus() {
          return loggedInSubscriptionAuthentication();
        },
        spawnProcess(
          _executable: string,
          arguments_: readonly string[],
          options: Parameters<ClaudeCatalogProcessDependencies["spawnProcess"]>[2],
        ) {
          capturedArguments = arguments_;
          capturedEnvironment = options.env;
          queueMicrotask(() => child.emit("spawn"));
          return child as unknown as ChildProcessWithoutNullStreams;
        },
        environment: Object.freeze({
          ANTHROPIC_API_KEY: "PRIVATE_CREDENTIAL_CANARY",
          ANTHROPIC_MODEL: "PRIVATE_PROFILE_CANARY",
          CLAUDE_CODE_USE_BEDROCK: "1",
        }),
        deploymentMode: mode,
      });

      const transport = kind === "catalog"
        ? await createOfficialClaudeCatalogTransport("project-directory", dependencies)
        : await createOfficialClaudeSessionTransport(
            {
              projectDirectory: "project-directory",
              profile: {
                model: "opus-alias",
                effortLevel: "xhigh",
                executionMode: "ultracode",
                accessMode: "full-access",
              },
              permissionMode: "bypassPermissions",
            },
            dependencies,
          );
      await transport.stop();

      assert.deepEqual(
        capturedArguments,
        kind === "catalog"
          ? CLAUDE_CATALOG_ARGUMENTS
          : createClaudeSessionArguments({
              projectDirectory: "project-directory",
              profile: {
                model: "opus-alias",
                effortLevel: "xhigh",
                executionMode: "ultracode",
                accessMode: "full-access",
              },
              permissionMode: "bypassPermissions",
            }),
      );
      assert.equal(
        capturedEnvironment?.CLAUDE_CODE_USE_BEDROCK,
        mode === "bedrock" ? "1" : undefined,
        `${kind}:${mode}:selector`,
      );
      assert.equal(capturedEnvironment?.ANTHROPIC_API_KEY, undefined, `${kind}:${mode}:credential`);
      assert.equal(capturedEnvironment?.ANTHROPIC_MODEL, undefined, `${kind}:${mode}:profile`);
    }
  }
});

test("Claude catalog and Session transports claim auth status immediately before the inert reader", async () => {
  for (const kind of ["catalog", "session"] as const) {
    const child = fakeChild();
    const events: string[] = [];
    const budget: ProviderRequestBudget = Object.freeze({
      async claim(operation: Parameters<ProviderRequestBudget["claim"]>[0]) {
        events.push(`claim:${operation}`);
      },
    });
    const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
      async discoverExecutable() {
        return nativeLaunch("claude.exe");
      },
      async readAuthenticationStatus() {
        events.push("effect:claude-auth-status");
        return loggedInSubscriptionAuthentication();
      },
      spawnProcess() {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    const transport = kind === "catalog"
      ? await createOfficialClaudeCatalogTransport(
          "project-directory",
          dependencies,
          budget,
        )
      : await createOfficialClaudeSessionTransport(
          {
            projectDirectory: "project-directory",
            profile: {
              model: "sonnet",
              effortLevel: "low",
              executionMode: "single-agent",
              accessMode: "full-access",
            },
            permissionMode: "bypassPermissions",
          },
          dependencies,
          budget,
        );
    await transport.stop();
    assert.deepEqual(events, [
      "claim:claude-auth-status",
      "effect:claude-auth-status",
    ]);
  }

  let effects = 0;
  const denied: ProviderRequestBudget = Object.freeze({
    async claim() {
      throw new ProviderRequestBudgetError("budget-exhausted");
    },
  });
  await assert.rejects(
    createOfficialClaudeCatalogTransport(
      "project-directory",
      Object.freeze({
        async discoverExecutable() {
          return nativeLaunch("claude.exe");
        },
        async readAuthenticationStatus() {
          effects += 1;
          return loggedInSubscriptionAuthentication();
        },
        spawnProcess() {
          effects += 1;
          throw new Error("must not spawn");
        },
      }),
      denied,
    ),
    (error) =>
      error instanceof ProviderRequestBudgetError &&
      error.category === "budget-exhausted",
  );
  assert.equal(effects, 0);
});

test("Claude Session does not start when subscription OAuth expires after catalog inspection", async () => {
  const child = fakeChild();
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return JSON.stringify({
        loggedIn: false,
        authMethod: "none",
        apiProvider: "firstParty",
      });
    },
    spawnProcess() {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  let transport:
    | Awaited<ReturnType<typeof createOfficialClaudeSessionTransport>>
    | undefined;
  let failure: unknown;
  try {
    transport = await createOfficialClaudeSessionTransport(
      {
        projectDirectory: "project-directory",
        profile: {
          model: "sonnet",
          effortLevel: "low",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
        permissionMode: "bypassPermissions",
      },
      dependencies,
    );
  } catch (error) {
    failure = error;
  } finally {
    await transport?.stop();
  }

  assert.equal(
    failure instanceof RuntimeAdapterError &&
      failure.category === "authentication-required",
    true,
  );
});

test("Claude authentication status ignores fields it does not consume", async () => {
  const child = fakeChild();
  let spawnCount = 0;
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        unexpected: true,
      });
    },
    spawnProcess() {
      spawnCount += 1;
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  const transport = await createOfficialClaudeCatalogTransport(
    "project-directory",
    dependencies,
  );
  await transport.stop();

  assert.equal(spawnCount, 1);
});

test("Claude API-key authentication is refused as authentication-required", async () => {
  const child = fakeChild();
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return JSON.stringify({
        loggedIn: true,
        authMethod: "api_key",
        apiProvider: "firstParty",
      });
    },
    spawnProcess() {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  let failure: unknown;
  try {
    await createOfficialClaudeCatalogTransport(
      "project-directory",
      dependencies,
    );
  } catch (error) {
    failure = error;
  }

  assert.equal(
    failure instanceof RuntimeAdapterError &&
      failure.category === "authentication-required",
    true,
  );
});

test("Claude authentication status with missing consumed fields is protocol-invalid", async () => {
  const child = fakeChild();
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
      });
    },
    spawnProcess() {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  let failure: unknown;
  try {
    await createOfficialClaudeCatalogTransport(
      "project-directory",
      dependencies,
    );
  } catch (error) {
    failure = error;
  }

  assert.equal(
    failure instanceof RuntimeAdapterError &&
      failure.category === "protocol-invalid",
    true,
  );
});

test("Claude authentication literal drift is protocol-invalid rather than logged out", async () => {
  for (const status of [
    { loggedIn: false, authMethod: "renamed-none", apiProvider: "firstParty" },
    { loggedIn: false, authMethod: "none", apiProvider: "renamed-provider" },
    { loggedIn: true, authMethod: "renamed-oauth", apiProvider: "firstParty" },
    { loggedIn: true, authMethod: "claude.ai", apiProvider: "renamed-provider" },
  ] as const) {
    const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
      async discoverExecutable() {
        return nativeLaunch("claude.exe");
      },
      async readAuthenticationStatus() {
        return JSON.stringify(status);
      },
      spawnProcess() {
        assert.fail("literal drift must fail before catalog spawn");
      },
    });
    await assert.rejects(
      createOfficialClaudeCatalogTransport("project-directory", dependencies),
      (error) =>
        error instanceof RuntimeAdapterError && error.category === "protocol-invalid",
      JSON.stringify(status),
    );
  }
});

test("unparseable Claude authentication status is protocol-invalid", async () => {
  const child = fakeChild();
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return "not-json";
    },
    spawnProcess() {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  let failure: unknown;
  try {
    await createOfficialClaudeCatalogTransport(
      "project-directory",
      dependencies,
    );
  } catch (error) {
    failure = error;
  }

  assert.equal(
    failure instanceof RuntimeAdapterError &&
      failure.category === "protocol-invalid",
    true,
  );
});

test("Claude catalog launch uses the captured headless OAuth-only process shape", async () => {
  const captured: {
    executable?: string;
    arguments_?: readonly string[];
    authenticationExecutable?: string;
    authenticationOptions?: Parameters<
      ClaudeCatalogProcessDependencies["readAuthenticationStatus"]
    >[1];
    options?: Parameters<ClaudeCatalogProcessDependencies["spawnProcess"]>[2];
  } = {};
  const child = fakeChild();
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus(
      launch: WindowsRuntimeLaunch,
      options: Parameters<
        ClaudeCatalogProcessDependencies["readAuthenticationStatus"]
      >[1],
    ) {
      captured.authenticationExecutable = launch.executable;
      captured.authenticationOptions = options;
      return loggedInSubscriptionAuthentication();
    },
    spawnProcess(
      executable: string,
      arguments_: readonly string[],
      options: Parameters<ClaudeCatalogProcessDependencies["spawnProcess"]>[2],
    ) {
      captured.executable = executable;
      captured.arguments_ = arguments_;
      captured.options = options;
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  const protectedKeys = [
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
  ] as const;
  const previous = new Map(
    protectedKeys.map((key) => [key, process.env[key]] as const),
  );
  for (const key of protectedKeys) process.env[key] = "PRIVATE_CANARY";
  try {
    const transport = await createOfficialClaudeCatalogTransport(
      "project-directory",
      dependencies,
    );
    await Promise.all([transport.stop(), transport.stop()]);
  } finally {
    for (const key of protectedKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(captured.executable, "claude.exe");
  assert.equal(captured.authenticationExecutable, "claude.exe");
  assert.equal(captured.authenticationOptions?.windowsHide, true);
  assert.deepEqual(captured.arguments_, [
    "--output-format",
    "stream-json",
    "--verbose",
    "--system-prompt",
    "",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources=",
    "--input-format",
    "stream-json",
    "--settings",
    '{"ultracode":true}',
    "--effort",
    "xhigh",
  ]);
  assertNoUltracodeEffort(captured.arguments_);
  assert.deepEqual(
    {
      cwd: captured.options?.cwd,
      stdio: captured.options?.stdio,
      windowsHide: captured.options?.windowsHide,
      shell: captured.options?.shell,
    },
    {
      cwd: "project-directory",
      stdio: "pipe",
      windowsHide: true,
      shell: false,
    },
  );
  for (const key of protectedKeys) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        captured.authenticationOptions?.env,
        key,
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(captured.options?.env, key),
      false,
    );
  }
  assert.equal(captured.options?.env.CLAUDE_CODE_ENTRYPOINT, "sdk-ts");
  assert.equal(captured.options?.env.CLAUDE_AGENT_SDK_VERSION, "0.3.220");
  assert.equal(captured.arguments_?.includes("--bare"), false);
  assert.equal(captured.arguments_?.includes("--print"), false);
  assert.equal(captured.arguments_?.some((value) => value === "-p"), false);
});

test("Claude session launch uses streaming input, explicit profile, OAuth-only environment, and optional native resume privately", async () => {
  const captured: {
    arguments_?: readonly string[];
    options?: Parameters<ClaudeCatalogProcessDependencies["spawnProcess"]>[2];
  } = {};
  const child = fakeChild();
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return loggedInSubscriptionAuthentication();
    },
    spawnProcess(
      _executable: string,
      arguments_: readonly string[],
      options: Parameters<ClaudeCatalogProcessDependencies["spawnProcess"]>[2],
    ) {
      captured.arguments_ = arguments_;
      captured.options = options;
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  const protectedKeys = [
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
  ] as const;
  const previous = new Map(
    protectedKeys.map((key) => [key, process.env[key]] as const),
  );
  for (const key of protectedKeys) process.env[key] = "PRIVATE_CANARY";
  try {
    const transport = await createOfficialClaudeSessionTransport(
      {
        projectDirectory: "project-directory",
        profile: {
          model: "opus-alias",
          effortLevel: "max",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
        permissionMode: "bypassPermissions",
        resumeSessionIdentity: "native-resume-private",
      },
      dependencies,
    );
    await transport.stop();
  } finally {
    for (const key of protectedKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.deepEqual(captured.arguments_, [
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--input-format",
    "stream-json",
    "--model",
    "opus-alias",
    "--effort",
    "max",
    "--settings",
    '{"ultracode":false}',
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources=",
    "--permission-mode",
    "bypassPermissions",
    "--allow-dangerously-skip-permissions",
    "--resume=native-resume-private",
  ]);
  assertNoUltracodeEffort(captured.arguments_);
  assert.equal(captured.arguments_?.includes("--bare"), false);
  assert.equal(captured.arguments_?.includes("--print"), false);
  assert.equal(captured.arguments_?.includes("--setting-sources="), true);
  assert.equal(captured.arguments_?.includes("--tools"), false);
  for (const key of protectedKeys) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(captured.options?.env, key),
      false,
    );
  }
});

test("Claude Ask when needed launch uses manual stdio approval and omits the dangerous bypass flag", async () => {
  let capturedArguments: readonly string[] | undefined;
  const child = fakeChild();
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return loggedInSubscriptionAuthentication();
    },
    spawnProcess(
      _executable: string,
      arguments_: readonly string[],
    ) {
      capturedArguments = arguments_;
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  const transport = await createOfficialClaudeSessionTransport(
    {
      projectDirectory: "project-directory",
      profile: {
        model: "sonnet-alias",
        effortLevel: "default",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
      permissionMode: "manual",
    },
    dependencies,
  );
  await transport.stop();

  assert.deepEqual(capturedArguments, [
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--input-format",
    "stream-json",
    "--model",
    "sonnet-alias",
    "--settings",
    '{"ultracode":false}',
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources=",
    "--permission-mode",
    "manual",
    "--permission-prompt-tool",
    "stdio",
  ]);
  assert.equal(
    capturedArguments?.includes("--allow-dangerously-skip-permissions"),
    false,
  );
});

test("Claude session transport rejects every unadmitted permission mode before discovery", async () => {
  let externalOperations = 0;
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      externalOperations += 1;
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      externalOperations += 1;
      return loggedInSubscriptionAuthentication();
    },
    spawnProcess() {
      externalOperations += 1;
      return fakeChild() as unknown as ChildProcessWithoutNullStreams;
    },
  });
  for (const permissionMode of [
    "default",
    "auto",
    "dontAsk",
    "plan",
    "future-mode",
    "",
  ]) {
    await assert.rejects(
      createOfficialClaudeSessionTransport(
        {
          projectDirectory: "project-directory",
          profile: {
            model: "sonnet-alias",
            effortLevel: "default",
            executionMode: "single-agent",
            accessMode: "full-access",
          },
          permissionMode,
        } as never,
        dependencies,
      ),
      isInvalidInput,
    );
  }
  assert.equal(externalOperations, 0);
});

test("Claude ultracode launch couples the private flag to native xhigh and never serializes ultracode as effort", async () => {
  const captured: { arguments_?: readonly string[] } = {};
  const child = fakeChild();
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      return loggedInSubscriptionAuthentication();
    },
    spawnProcess(
      _executable: string,
      arguments_: readonly string[],
    ) {
      captured.arguments_ = arguments_;
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });

  const transport = await createOfficialClaudeSessionTransport(
    {
      projectDirectory: "project-directory",
      profile: {
        model: "opus-alias",
        effortLevel: "xhigh",
        executionMode: "ultracode",
        accessMode: "full-access",
      },
      permissionMode: "bypassPermissions",
    },
    dependencies,
  );
  await transport.stop();

  assert.deepEqual(captured.arguments_, [
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--input-format",
    "stream-json",
    "--model",
    "opus-alias",
    "--effort",
    "xhigh",
    "--settings",
    '{"ultracode":true}',
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources=",
    "--permission-mode",
    "bypassPermissions",
    "--allow-dangerously-skip-permissions",
  ]);
  assertNoUltracodeEffort(captured.arguments_);
});

test("Claude rejects impossible ultracode combinations before discovery or launch", async () => {
  let externalOperationCount = 0;
  const child = fakeChild();
  const dependencies: ClaudeCatalogProcessDependencies = Object.freeze({
    async discoverExecutable() {
      externalOperationCount += 1;
      return nativeLaunch("claude.exe");
    },
    async readAuthenticationStatus() {
      externalOperationCount += 1;
      return loggedInSubscriptionAuthentication();
    },
    spawnProcess() {
      externalOperationCount += 1;
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  const cases = [
    {
      name: "max plus private ultracode mode",
      profile: {
        model: "opus-alias",
        effortLevel: "max",
        executionMode: "ultracode",
        accessMode: "full-access",
      },
    },
    {
      name: "ultracode supplied as an effort literal",
      profile: {
        model: "opus-alias",
        effortLevel: "ultracode",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    },
    {
      name: "unrecognized private execution mode",
      profile: {
        model: "opus-alias",
        effortLevel: "xhigh",
        executionMode: "ultracode-future",
        accessMode: "full-access",
      },
    },
  ] as const;

  for (const row of cases) {
    await assert.rejects(
      createOfficialClaudeSessionTransport(
        {
          projectDirectory: "project-directory",
          profile: row.profile,
          permissionMode: "bypassPermissions",
        },
        dependencies,
      ),
      isInvalidInput,
      row.name,
    );
  }
  assert.equal(externalOperationCount, 0);
});

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

function assertNoUltracodeEffort(
  arguments_: readonly string[] | undefined,
): void {
  assert.ok(arguments_);
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] !== "--effort") continue;
    assert.notEqual(arguments_[index + 1], undefined);
    assert.notEqual(arguments_[index + 1], "ultracode");
  }
  assert.equal(arguments_.includes("ultracode"), false);
}

function isInvalidInput(error: unknown): boolean {
  return (
    error instanceof RuntimeAdapterError &&
    error.category === "invalid-input" &&
    error.message === "Agent Runtime operation failed."
  );
}

function fakeChild(): EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(): boolean;
} {
  const child = new EventEmitter() as ReturnType<typeof fakeChild>;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const exit = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  child.stdin.once("finish", exit);
  child.kill = () => {
    exit();
    return true;
  };
  return child;
}

// discoverClaudeExecutable consults PATH, then homedir()\.local\bin, before it
// ever reaches the managed root. Both have to be pointed somewhere empty, or
// these tests answer according to what the machine running them happens to have
// installed. ~/.local/bin/claude.exe in particular is exactly where the native
// installer puts Claude Code -- that is, on the box of the contributor most
// likely to be editing this file.
function isolateDiscovery(
  register: (teardown: () => void) => void,
  home: string,
  appData: string,
): void {
  const previous = new Map<string, string | undefined>([
    ["APPDATA", process.env.APPDATA],
    ["USERPROFILE", process.env.USERPROFILE],
    ["PATH", process.env.PATH],
  ]);
  register(() => {
    for (const [key, value] of previous) {
      // Assigning a captured undefined back would set the literal string
      // "undefined" and poison every later test in this process.
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.USERPROFILE = home;
  process.env.APPDATA = appData;
  // System32 stays on PATH so where.exe still runs; it just finds no claude.exe.
  process.env.PATH = join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    "System32",
  );
}

async function managedFixture(
  register: (teardown: () => void) => void,
  versions: readonly string[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "claude-managed-"));
  register(() => {
    void rm(root, { recursive: true, force: true });
  });
  const managed = join(root, "Claude", "claude-code");
  for (const version of versions) {
    await mkdir(join(managed, version), { recursive: true });
    await writeFile(join(managed, version, "claude.exe"), "");
  }
  isolateDiscovery(register, join(root, "home"), root);
  return managed;
}

test("the desktop app's managed Claude Code is discovered, newest version first", async (t) => {
  if (process.platform !== "win32") return;

  // Two wrong answers are named here on purpose. 2.10.0 is the newest, but it is
  // NOT what a directory read hands back first -- NTFS enumerates these as
  // 2.0.10, 2.0.9, 2.10.0 -- and it is not what a string comparison picks
  // either. Without 2.10.0 in this list the correct answer is already the first
  // entry, and the whole version ordering can be deleted with this test still
  // green. "brand-new" parses as no version at all: it must rank last, not
  // vanish, so it cannot win here and cannot be dropped in the test below.
  const managed = await managedFixture((teardown) => t.after(teardown), [
    "2.0.9",
    "2.0.10",
    "2.10.0",
    "brand-new",
  ]);

  assert.equal(
    await discoverClaudeExecutable(),
    await realpath(join(managed, "2.10.0", "claude.exe")),
  );
});

test("a managed version directory this scan cannot parse is still driven, not discarded", async (t) => {
  if (process.platform !== "win32") return;

  // A prerelease is the whole install. Dropping names that do not parse would
  // tell this user their working, signed-in Claude Code does not exist -- the
  // exact failure the managed scan was added to remove, moved one naming
  // convention over.
  const managed = await managedFixture((teardown) => t.after(teardown), [
    "2.1.0-rc.1",
  ]);

  assert.equal(
    await discoverClaudeExecutable(),
    await realpath(join(managed, "2.1.0-rc.1", "claude.exe")),
  );
});

for (const version of ["999.0.0", "3.0", "garbage-version"]) {
  test(`Claude CLI drift: managed discovery admits isolated fake version ${version}`, async (t) => {
    if (process.platform !== "win32") return;
    const managed = await managedFixture((teardown) => t.after(teardown), [version]);
    assert.equal(
      await discoverClaudeExecutable(),
      await realpath(join(managed, version, "claude.exe")),
    );
  });
}

test("a managed root past the entry bound still yields its newest runtime", async (t) => {
  if (process.platform !== "win32") return;

  // An upgrade leaves the previous version behind, so this directory only grows.
  // A bound that abandons the scan instead of trimming it would make the fix
  // expire on exactly the machines that have run Claude Code the longest.
  const versions: string[] = [];
  for (let minor = 0; minor < 300; minor += 1) versions.push(`1.${minor}.0`);
  const managed = await managedFixture((teardown) => t.after(teardown), versions);

  assert.equal(
    await discoverClaudeExecutable(),
    await realpath(join(managed, "1.299.0", "claude.exe")),
  );
});

test("a managed root holding no runtime is not located rather than half-answered", async (t) => {
  if (process.platform !== "win32") return;

  const root = await mkdtemp(join(tmpdir(), "claude-managed-empty-"));
  t.after(() => {
    void rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "Claude", "claude-code", "2.0.10"), {
    recursive: true,
  });
  isolateDiscovery((teardown) => t.after(teardown), join(root, "home"), root);

  await assert.rejects(
    () => discoverClaudeExecutable(),
    (error: unknown) =>
      error instanceof RuntimeAdapterError &&
      error.category === "runtime-not-located",
  );
});

test("a managed root reached through a junction is resolved, not refused", async (t) => {
  if (process.platform !== "win32") return;

  // Relocating AppData to another drive leaves a junction at exactly this path.
  // Node reports a junction as a link, so refusing links here would hide a
  // perfectly good install behind one.
  const root = await mkdtemp(join(tmpdir(), "claude-managed-junction-"));
  t.after(() => {
    void rm(root, { recursive: true, force: true });
  });
  const real = join(root, "elsewhere");
  await mkdir(join(real, "2.0.10"), { recursive: true });
  await writeFile(join(real, "2.0.10", "claude.exe"), "");
  await mkdir(join(root, "Claude"), { recursive: true });
  await symlink(real, join(root, "Claude", "claude-code"), "junction");
  isolateDiscovery((teardown) => t.after(teardown), join(root, "home"), root);

  assert.equal(
    await discoverClaudeExecutable(),
    await realpath(join(real, "2.0.10", "claude.exe")),
  );
});

test("a version directory that junctions out of the managed root is skipped, not spawned", async (t) => {
  if (process.platform !== "win32") return;

  // The path discovery returns is spawned. Allowing a junctioned ROOT must not
  // also allow a junction INSIDE the root to nominate a binary from anywhere on
  // the disk -- so the newest-looking entry here points outside and must lose to
  // the older one that really lives in the tree.
  const root = await mkdtemp(join(tmpdir(), "claude-managed-escape-"));
  t.after(() => {
    void rm(root, { recursive: true, force: true });
  });
  const managed = join(root, "Claude", "claude-code");
  await mkdir(join(managed, "2.0.9"), { recursive: true });
  await writeFile(join(managed, "2.0.9", "claude.exe"), "");
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "claude.exe"), "");
  await symlink(outside, join(managed, "2.0.10"), "junction");
  isolateDiscovery((teardown) => t.after(teardown), join(root, "home"), root);

  assert.equal(
    await discoverClaudeExecutable(),
    await realpath(join(managed, "2.0.9", "claude.exe")),
  );
});
