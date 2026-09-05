import { nativeLaunch } from "../../src/agent-runtime/claude/process-transport.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { CodexAdapter } from "../../src/agent-runtime/codex-adapter.ts";
import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";
import { CodexJsonlPeer } from "../../src/agent-runtime/codex/protocol.ts";
import { createOfficialClaudeSubscriptionAuthenticationProvider } from "../../src/agent-runtime/claude/subscription-authentication.ts";
import { initializeClaudeCatalog } from "../../src/agent-runtime/claude/protocol.ts";
import {
  ClaudeRuntimeBinding,
  initializeClaudeSession,
} from "../../src/agent-runtime/claude/session.ts";
import type { ClaudeCatalogTransport } from "../../src/agent-runtime/claude/transport.ts";
import {
  ProviderRequestBudgetError,
  type ProviderOperationKind,
  type ProviderRequestBudget,
} from "../../src/agent-runtime/provider-request-budget.ts";
import type { OfficialRuntimeTransport } from "../../src/agent-runtime/codex/transport.ts";

test("every counted provider operation claims immediately before its inert boundary effect", async () => {
  const events: string[] = [];
  const budget = observingBudget(events);
  const codexTransport = new ResponsiveCodexTransport(events);

  const catalog = await new CodexAdapter(async () => codexTransport, budget).inspect(
    "C:\\synthetic-project",
  );
  assert.deepEqual(catalog.models.map((model) => model.id), ["model-1", "model-2"]);

  const claudeCatalogTransport = new ResponsiveClaudeTransport(events);
  await initializeClaudeCatalog(claudeCatalogTransport, budget);
  const claudeSessionTransport = new ResponsiveClaudeTransport(events);
  const initialized = await initializeClaudeSession(claudeSessionTransport, budget);
  const binding = new ClaudeRuntimeBinding({
    transport: claudeSessionTransport,
    profile: {
      model: "synthetic-model",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
    opaqueSessionReference: "synthetic-session",
    expectedModel: "synthetic-model",
    stopHookCallbackId: initialized.stopHookCallbackId,
    observeSessionIdentity: () => undefined,
    providerRequestBudget: budget,
    permissionMode: "bypassPermissions",
    ultracodeConfirmed: false,
  });
  await binding.send({ text: "synthetic input" });

  const claudeAuthentication = createOfficialClaudeSubscriptionAuthenticationProvider(
    {
      async discoverExecutable() {
        return nativeLaunch("synthetic-executable");
      },
      async readAuthenticationStatus() {
        events.push("effect:claude-auth-status");
        return JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
        });
      },
      spawnProcess() {
        throw new Error("authentication action must remain inert");
      },
      environment: Object.freeze({ SAFE_SYNTHETIC: "true" }),
    },
    budget,
  );
  assert.equal(
    await claudeAuthentication.inspectAuthentication(new AbortController().signal),
    "bound",
  );

  assert.deepEqual(events, [
    "claim:codex-initialize",
    "effect:codex-initialize",
    "effect:codex-initialized-notification",
    "claim:codex-account-read",
    "effect:codex-account-read",
    "claim:codex-model-list-page",
    "effect:codex-model-list-page",
    "claim:codex-model-list-page",
    "effect:codex-model-list-page",
    "claim:claude-catalog-initialize",
    "effect:claude-catalog-initialize",
    "effect:claude-catalog-settings-read",
    "claim:claude-session-initialize",
    "effect:claude-session-initialize",
    "effect:claude-session-settings-read",
    "claim:claude-inference-frame",
    "effect:claude-inference-frame",
    "claim:claude-auth-status",
    "effect:claude-auth-status",
  ]);
});

test("an enforced Codex peer allows initialized for free and rejects unknown requests before send", async () => {
  const events: string[] = [];
  const transport: OfficialRuntimeTransport = {
    async send(line) {
      const message = JSON.parse(line) as { readonly method: string };
      events.push(`effect:${message.method}`);
    },
    async receive() {
      return null;
    },
    async stop() {},
  };
  const peer = new CodexJsonlPeer(transport, observingBudget(events));

  await peer.notify("initialized");
  await assert.rejects(
    peer.request("thread/start"),
    (error) =>
      error instanceof ProviderRequestBudgetError &&
      error.category === "unknown-operation",
  );

  assert.deepEqual(events, ["effect:initialized"]);
});

test("transport factories are inert construction seams and a denied first claim prevents every send", async () => {
  const events: string[] = [];
  const denyingBudget: ProviderRequestBudget = Object.freeze({
    async claim(operation: ProviderOperationKind) {
      events.push(`claim:${operation}`);
      throw new ProviderRequestBudgetError("budget-exhausted");
    },
  });
  const transport = (): OfficialRuntimeTransport => ({
    async send() {
      events.push("effect:provider-send");
    },
    async receive() {
      return null;
    },
    async stop() {},
  });

  await assert.rejects(
    new CodexAdapter(async () => {
      events.push("construct:codex-inert");
      return transport();
    }, denyingBudget).inspect("C:\\synthetic-project"),
  );
  await assert.rejects(
    new ClaudeAdapter(
      async () => {
        events.push("construct:claude-inert");
        return transport();
      },
      undefined,
      denyingBudget,
    ).inspect("C:\\synthetic-project"),
  );

  assert.deepEqual(events, [
    "construct:codex-inert",
    "claim:codex-initialize",
    "construct:claude-inert",
    "claim:claude-catalog-initialize",
  ]);
});

function observingBudget(events: string[]): ProviderRequestBudget {
  return Object.freeze({
    async claim(operation: ProviderOperationKind) {
      events.push(`claim:${operation}`);
    },
  });
}

class ResponsiveCodexTransport implements OfficialRuntimeTransport {
  readonly #events: string[];
  readonly #responses: string[] = [];
  #page = 0;

  constructor(events: string[]) {
    this.#events = events;
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as {
      readonly id?: number;
      readonly method: string;
    };
    if (message.method === "initialized") {
      this.#events.push("effect:codex-initialized-notification");
      return;
    }
    const operation = codexOperation(message.method);
    this.#events.push(`effect:${operation}`);
    if (message.method === "initialize") {
      this.#respond(message.id, { server: "synthetic" });
    } else if (message.method === "account/read") {
      this.#respond(message.id, {
        account: { type: "chatgpt" },
        requiresOpenaiAuth: true,
      });
    } else {
      this.#page += 1;
      this.#respond(message.id, {
        data: [
          {
            id: `model-${this.#page}`,
            supportedReasoningEfforts: ["low"],
          },
        ],
        nextCursor: this.#page === 1 ? "page-2" : null,
      });
    }
  }

  async receive(): Promise<string | null> {
    return this.#responses.shift() ?? null;
  }

  async stop(): Promise<void> {}

  #respond(id: number | undefined, result: unknown): void {
    this.#responses.push(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
}

class ResponsiveClaudeTransport implements ClaudeCatalogTransport {
  readonly #events: string[];
  readonly #responses: string[] = [];

  constructor(events: string[]) {
    this.#events = events;
  }

  async send(line: string): Promise<void> {
    const frame = JSON.parse(line) as {
      readonly type: string;
      readonly request_id?: string;
      readonly request?: { readonly subtype?: string };
    };
    if (frame.type === "user") {
      this.#events.push("effect:claude-inference-frame");
      return;
    }
    const catalogRequest = frame.request_id?.startsWith("catalog-") === true;
    const operation =
      frame.request?.subtype === "initialize"
        ? catalogRequest
          ? "claude-catalog-initialize"
          : "claude-session-initialize"
        : frame.request?.subtype === "get_settings"
          ? catalogRequest
            ? "claude-catalog-settings-read"
            : "claude-session-settings-read"
          : "unexpected";
    this.#events.push(`effect:${operation}`);
    this.#responses.push(
      JSON.stringify({
        type: "control_response",
        response: {
          request_id: frame.request_id,
          subtype: "success",
          response:
            frame.request?.subtype === "get_settings"
              ? {
                  effective: { effortLevel: "high", ultracode: false },
                  sources: [
                    {
                      source: "flagSettings",
                      settings: { effortLevel: "high", ultracode: false },
                    },
                  ],
                  applied: {
                    model: "synthetic-model",
                    effort: "high",
                    advisor: null,
                    ultracode: false,
                  },
                }
              : { models: [] },
        },
      }),
    );
  }

  async receive(): Promise<string | null> {
    return this.#responses.shift() ?? null;
  }

  async stop(): Promise<void> {}
}

function codexOperation(method: string): ProviderOperationKind {
  if (method === "initialize") return "codex-initialize";
  if (method === "account/read") return "codex-account-read";
  if (method === "model/list") return "codex-model-list-page";
  throw new Error("unexpected Codex effect");
}
