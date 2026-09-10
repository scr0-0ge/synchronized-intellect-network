import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";
import type { ClaudeCatalogTransport } from "../../src/agent-runtime/claude/transport.ts";
import {
  createGlmEndpointContext,
  glmIsolatedClaudeConfigDir,
} from "../../src/agent-runtime/claude/glm-catalog.ts";
import {
  createOfficialClaudeSessionTransport,
  nativeLaunch,
  type ClaudeCatalogProcessDependencies,
} from "../../src/agent-runtime/claude/process-transport.ts";

const FAKE_TOKEN_ENV: NodeJS.ProcessEnv = Object.freeze({
  GLM_ANTHROPIC_AUTH_TOKEN: "FAKE-GLM-TOKEN-1234",
  ANTHROPIC_AUTH_TOKEN: "AMBIENT-ANTHROPIC-TOKEN",
  ANTHROPIC_API_KEY: "AMBIENT-ANTHROPIC-KEY",
});

function glmDependencies(
  spawnEnvironment: (environment: NodeJS.ProcessEnv) => void,
): ClaudeCatalogProcessDependencies {
  return Object.freeze({
    async discoverExecutable() {
      // main-resync: discovery returns a launch plan now (WindowsRuntimeLaunch);
      // a plain native launch with no entry script is the same fake as before.
      return nativeLaunch("C:\\fake\\claude.exe");
    },
    async readAuthenticationStatus() {
      // Live-spike-verified healthy shape for an env bearer token.
      return JSON.stringify({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
      });
    },
    spawnProcess(
      _executable: string,
      _arguments_: readonly string[],
      options: Parameters<ClaudeCatalogProcessDependencies["spawnProcess"]>[2],
    ) {
      spawnEnvironment(options.env);
      const child = fakeChild();
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    environment: FAKE_TOKEN_ENV,
  });
}

test("a GLM session spawn carries the true model name, isolated config, and no Anthropic credential", async () => {
  const captured: NodeJS.ProcessEnv[] = [];
  const transport = await createOfficialClaudeSessionTransport(
    {
      projectDirectory: "project-directory",
      profile: {
        model: "glm-5.3-flash[1m]",
        effortLevel: "default",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
      permissionMode: "bypassPermissions",
    },
    {
      ...glmDependencies((environment) => captured.push(environment)),
      endpointEnvironment: createGlmEndpointContext({
        configDir: glmIsolatedClaudeConfigDir("C:\\TEMP-GLM"),
        sourceEnvironment: FAKE_TOKEN_ENV,
      }).environmentSource,
      authenticationMode: "api-key-static",
    },
  );

  assert.equal(captured.length, 1);
  const environment = captured[0]!;
  assert.equal(environment.ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, "FAKE-GLM-TOKEN-1234");
  assert.equal(environment.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.3-flash[1m]");
  assert.equal(environment.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-5.3-flash[1m]");
  assert.equal(environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-5.3-flash[1m]");
  assert.equal(environment.CLAUDE_CONFIG_DIR, glmIsolatedClaudeConfigDir("C:\\TEMP-GLM"));
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.ANTHROPIC_BEARER_TOKEN, undefined);
  assert.equal(environment.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(environment.CLAUDE_CODE_ENTRYPOINT, "sdk-ts");
  await transport.stop();
});

test("a missing GLM token fails the spawn as authentication-required before any CLI process", async () => {
  const dependencies = glmDependencies(() => {
    throw new Error("spawn must not happen");
  });
  let failure: unknown;
  try {
    await createOfficialClaudeSessionTransport(
      {
        projectDirectory: "project-directory",
        profile: {
          model: "glm-5.3[1m]",
          effortLevel: "default",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
        permissionMode: "bypassPermissions",
      },
      {
        ...dependencies,
        environment: {},
        endpointEnvironment: createGlmEndpointContext({
          configDir: glmIsolatedClaudeConfigDir("C:\\TEMP-GLM"),
        }).environmentSource,
        authenticationMode: "api-key-static",
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "authentication-required");
});

test("a claude.ai OAuth residue shape fails the static-key gate as protocol-invalid", async () => {
  const dependencies = glmDependencies(() => {
    throw new Error("spawn must not happen");
  });
  let failure: unknown;
  try {
    await createOfficialClaudeSessionTransport(
      {
        projectDirectory: "project-directory",
        profile: {
          model: "glm-5.3[1m]",
          effortLevel: "default",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
        permissionMode: "bypassPermissions",
      },
      {
        ...dependencies,
        readAuthenticationStatus: async () =>
          JSON.stringify({
            loggedIn: true,
            authMethod: "claude.ai",
            apiProvider: "firstParty",
          }),
        endpointEnvironment: createGlmEndpointContext({
          configDir: glmIsolatedClaudeConfigDir("C:\\TEMP-GLM"),
          sourceEnvironment: FAKE_TOKEN_ENV,
        }).environmentSource,
        authenticationMode: "api-key-static",
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "protocol-invalid");
});

test("a GLM session completes over the static catalog, ignores the CLI's claude-named catalog, and surfaces no CLI model or cost", async () => {
  const adapter = new ClaudeAdapter(
    undefined,
    async () =>
      new GlmScriptedSessionTransport({
        model: "glm-5.3[1m]",
        cliCatalogModel: "claude-opus-5[1m]",
      }),
    undefined,
    undefined,
    undefined,
    undefined,
    createGlmEndpointContext({
      configDir: glmIsolatedClaudeConfigDir("C:\\TEMP-GLM"),
    }),
  );
  const binding = await adapter.start({
    projectDirectory: "project-directory",
    profile: {
      model: "glm-5.3[1m]",
      effortLevel: "default",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "hello" });
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of binding.events()) {
    events.push(event);
  }

  assert.deepEqual(
    events.filter((event) => event.kind === "session-started").length,
    1,
  );
  const completed = events.find(
    (event) => event.kind === "turn-completed",
  ) as Extract<NormalizedRuntimeEvent, { kind: "turn-completed" }> | undefined;
  assert.ok(completed);
  assert.equal(completed.context?.basis, "turn-usage");
  assert.equal(completed.context?.usedTokens, 8);

  // The CLI's fabricated identity and cost never cross the adapter boundary.
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("total_cost_usd"), false);
  assert.equal(serialized.includes("modelUsage"), false);
  assert.equal(serialized.includes("0.12"), false);
  assert.equal(serialized.includes("claude-opus"), false);
  assert.equal(serialized.includes("claude-alias"), false);
});

test("a CLI that reports a claude alias as its model cannot pass as a GLM session", async () => {
  const adapter = new ClaudeAdapter(
    undefined,
    async () =>
      new GlmScriptedSessionTransport({
        model: "claude-opus-5[1m]",
        cliCatalogModel: "claude-opus-5[1m]",
      }),
    undefined,
    undefined,
    undefined,
    undefined,
    createGlmEndpointContext({
      configDir: glmIsolatedClaudeConfigDir("C:\\TEMP-GLM"),
    }),
  );
  const binding = await adapter.start({
    projectDirectory: "project-directory",
    profile: {
      model: "glm-5.3[1m]",
      effortLevel: "default",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "hello" });
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of binding.events()) {
    events.push(event);
  }

  // The claude session reports a rejected init handshake as a terminal
  // `failed` event rather than a thrown rejection, so the guarantee under
  // test is that the session never starts: the only event on the stream is
  // the selection failure, and no turn is ever observed.
  assert.deepEqual(events, [
    { kind: "failed", category: "unsupported-selection" },
  ]);
});

test("a selection outside the static catalog is rejected by the static selection assertion", async () => {
  let transports = 0;
  const adapter = new ClaudeAdapter(
    undefined,
    async () => {
      transports += 1;
      return new GlmScriptedSessionTransport({
        model: "glm-5.3[1m]",
        cliCatalogModel: "claude-opus-5[1m]",
      });
    },
    undefined,
    undefined,
    undefined,
    undefined,
    createGlmEndpointContext({
      configDir: glmIsolatedClaudeConfigDir("C:\\TEMP-GLM"),
    }),
  );
  await assert.rejects(
    adapter.start({
      projectDirectory: "project-directory",
      profile: {
        model: "gpt-5.6-sol",
        effortLevel: "default",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    }),
    (error: unknown) =>
      error instanceof RuntimeAdapterError &&
      error.category === "unsupported-selection",
  );
  assert.equal(transports, 1);
});

/**
 * A claude-CLI-shaped scripted session transport for the GLM endpoint: the
 * initialize handshake reports the CLI's own claude-named catalog (which the
 * static-catalog endpoint must ignore), the init frame reports the wire
 * model, and the result frame carries the CLI's fabricated model/cost fields
 * exactly as the live spike observed them.
 */
class GlmScriptedSessionTransport implements ClaudeCatalogTransport {
  readonly sent: Record<string, unknown>[] = [];
  readonly #model: string;
  readonly #cliCatalogModel: string;
  // Live-verified 2026-09-03: the real CLI's Stop hook always reports a
  // concrete effort level (its internal default, "high"), never an absent
  // effort — the "default" tier must therefore tolerate the resolved level.
  readonly #stopHookEffort: string;
  readonly #lines: string[] = [];
  #hookCallbackId = "";
  stopped = 0;

  constructor(options: {
    readonly model: string;
    readonly cliCatalogModel: string;
    readonly stopHookEffort?: string;
  }) {
    this.#model = options.model;
    this.#cliCatalogModel = options.cliCatalogModel;
    this.#stopHookEffort = options.stopHookEffort ?? "high";
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === "control_request") {
      const request = message.request as Record<string, unknown>;
      if (request.subtype === "initialize") {
        const hooks = request.hooks as {
          Stop: { hookCallbackIds: string[] }[];
        };
        this.#hookCallbackId = hooks.Stop[0]!.hookCallbackIds[0]!;
        this.#lines.push(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: {
                // The CLI's built-in catalog still names claude models; a
                // static-catalog endpoint must not take identity from here.
                models: [
                  {
                    value: this.#cliCatalogModel,
                    resolvedModel: this.#cliCatalogModel,
                    displayName: "Opus",
                    supportsEffort: true,
                    supportedEffortLevels: ["default"],
                  },
                ],
              },
            },
          }),
        );
        return;
      }
      if (request.subtype === "get_settings") {
        this.#lines.push(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: claudeSettingsResponse(),
            },
          }),
        );
      }
      return;
    }
    if (message.type === "user") {
      this.#lines.push(
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: this.#model,
          permissionMode: "bypassPermissions",
          capabilities: ["interrupt_receipt_v1"],
          session_id: "glm-session-1",
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
          parent_tool_use_id: null,
          session_id: "glm-session-1",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "OK" }],
          },
          parent_tool_use_id: null,
          session_id: "glm-session-1",
        }),
        JSON.stringify({
          type: "control_request",
          request_id: "stop-hook-request",
          request: {
            subtype: "hook_callback",
            callback_id: this.#hookCallbackId,
            input: {
              hook_event_name: "Stop",
              session_id: "glm-session-1",
              permission_mode: "bypassPermissions",
              effort: { level: this.#stopHookEffort },
            },
          },
        }),
      );
      return;
    }
    if (message.type === "control_response") {
      this.#lines.push(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "OK",
          terminal_reason: "completed",
          session_id: "glm-session-1",
          usage: {
            input_tokens: 7,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          // Everything below is the CLI's client-side fabrication (live
          // spike): it must never be presented for a GLM endpoint.
          model: "claude-alias",
          total_cost_usd: 0.12,
          modelUsage: {
            "claude-opus-5[1m]": {
              inputTokens: 7,
              outputTokens: 1,
              costUSD: 0.12,
              provider: "firstParty",
            },
          },
        }),
      );
    }
  }

  async receive(): Promise<string | null> {
    return this.#lines.shift() ?? null;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

function claudeSettingsResponse(): unknown {
  // A default-effort session reports no applied effort (the CLI's own
  // vocabulary has no "default" applied level); ultracode stays off.
  return {
    effective: { effortLevel: null, ultracode: false },
    sources: [
      {
        source: "flagSettings",
        settings: { effortLevel: null, ultracode: false },
      },
    ],
    applied: {
      model: "glm-5.3[1m]",
      effort: null,
      advisor: null,
      ultracode: false,
    },
  };
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
