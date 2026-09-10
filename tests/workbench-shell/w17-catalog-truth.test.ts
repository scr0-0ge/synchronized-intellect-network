import assert from "node:assert/strict";
import test from "node:test";

import type { ClaudeCatalogTransport } from "../../src/agent-runtime/claude/transport.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import { createEndpointCatalogFreshnessService } from "../../src/workbench-shell/endpoint-catalog-freshness.ts";
import { createProductionGlmRuntimeAdapter } from "../../src/workbench-shell/runtime-endpoint-composition.ts";

const enrolledModel = Object.freeze({
  id: "glm-6",
  effortLevels: Object.freeze(["default"]),
});

test("an enrolled model reaches the Claude static-catalog start validation", async () => {
  const transport = new InitializationTransport();
  const adapter = createProductionGlmRuntimeAdapter({
    configDirectory: "C:\\UAW-W17",
    createSessionTransport: async () => transport,
    resolveStaticCatalogAugmentation: () => [enrolledModel],
  });

  let failure: unknown;
  try {
    const binding = await adapter.start({
      projectDirectory: "project-directory",
      profile: {
        model: enrolledModel.id,
        effortLevel: "default",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    });
    assert.equal(binding.profile.model, enrolledModel.id);
  } catch (error) {
    failure = error;
  }

  assert.equal(
    failure instanceof RuntimeAdapterError ? failure.category : failure,
    undefined,
  );
});

test("a failed enrollment write is not reported as fresh or newly available", async () => {
  const service = createEndpointCatalogFreshnessService({
    endpoints: [
      {
        endpointId: "kimi-code",
        face: "kimi-platform",
        staticCatalogModelIds: ["kimi-for-coding"],
        resolveToken: () => "FAKE-KIMI-TOKEN",
      },
    ],
    readFile: () => {
      const error: NodeJS.ErrnoException = new Error("store unavailable");
      error.code = "EACCES";
      throw error;
    },
    writeFile: () => {
      throw new Error("PRIVATE_WRITE_DETAIL");
    },
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "kimi-new" }] }), {
          status: 200,
        }),
      )) as typeof fetch,
  });

  const report = (await service.refresh())[0]!;
  assert.equal(report.status, "silent-failure");
  assert.deepEqual(report.newModels, []);
  assert.deepEqual(report.enrolledModels, []);
  assert.deepEqual(service.enrolledModelIds("kimi-code"), []);
});

class InitializationTransport implements ClaudeCatalogTransport {
  readonly #lines: string[] = [];

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type !== "control_request") return;
    const request = message.request as Record<string, unknown>;
    if (request.subtype === "initialize") {
      this.#lines.push(
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {
              models: [
                {
                  value: "claude-opus-5[1m]",
                  resolvedModel: "claude-opus-5[1m]",
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
            response: {
              effective: { effortLevel: null, ultracode: false },
              sources: [
                {
                  source: "flagSettings",
                  settings: { effortLevel: null, ultracode: false },
                },
              ],
              applied: {
                model: enrolledModel.id,
                effort: null,
                advisor: null,
                ultracode: false,
              },
            },
          },
        }),
      );
    }
  }

  async receive(): Promise<string | null> {
    return this.#lines.shift() ?? null;
  }

  async stop(): Promise<void> {}
}
