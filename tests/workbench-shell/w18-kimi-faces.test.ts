import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  KIMI_ENDPOINT_ENV_CONTRACT,
} from "../../src/agent-runtime/claude/kimi-catalog.ts";
import { KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT } from "../../src/agent-runtime/codex/endpoint-env-factory.ts";
import {
  ENDPOINT_MODELS_LIST_FACES,
  fetchEndpointModelsList,
  KIMI_PLATFORM_CN_MODELS_LIST_URL,
  type EndpointModelsListFaceId,
} from "../../src/workbench-shell/endpoint-models-list.ts";

const FAKE_KIMI_CODE_TOKEN = "FAKE-KIMI-CODE-TOKEN";

test("production freshness never sends the Kimi Code token to a Platform models face", async () => {
  const mainSource = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );
  const crossedFace =
    /Object\.freeze\(\{\s*endpointId: "kimi-code" as const,\s*face: "([^"]+)" as const,[\s\S]*?resolveToken: \(\) => initializedKimiKeySource\?\.resolve\(\),\s*\}\)/u.exec(
      mainSource,
    )?.[1];

  if (crossedFace !== undefined) {
    let requestUrl: string | undefined;
    let requestAuthorization: string | undefined;
    const outcome = await fetchEndpointModelsList({
      face: crossedFace as EndpointModelsListFaceId,
      authToken: FAKE_KIMI_CODE_TOKEN,
      fetch: ((input, init) => {
        requestUrl = String(input);
        requestAuthorization = new Headers(init?.headers).get("authorization") ?? undefined;
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      }) as typeof fetch,
    });
    assert.deepEqual(outcome, { outcome: "success", models: [] });
    assert.equal(requestAuthorization, `Bearer ${FAKE_KIMI_CODE_TOKEN}`);
    assert.fail(`Kimi Code freshness sent its Bearer token to ${requestUrl}`);
  }

  assert.match(
    mainSource,
    /catalogAugmentation: \(endpointId\) =>\s*endpointId === "kimi-code"\s*\? \[\]\s*: endpointCatalogFreshnessService\?\.augmentedModels\(\s*endpointId as "glm-coding-plan" \| "deepseek-api",\s*\) \?\? \[\],/u,
    "legacy Kimi Code freshness enrollments must not re-enter the runtime catalog",
  );
});

test("the two Kimi products retain separate verified endpoint contracts", () => {
  assert.deepEqual(KIMI_ENDPOINT_ENV_CONTRACT, {
    baseUrlEnvVar: "KIMI_CODE_ANTHROPIC_BASE_URL",
    authTokenEnvVar: "KIMI_CODE_ANTHROPIC_AUTH_TOKEN",
    modelEnvVar: "KIMI_CODE_ANTHROPIC_MODEL",
    defaultBaseUrl: "https://api.kimi.com/coding/",
  });
  assert.deepEqual(KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT, {
    apiKeyEnvVar: "KIMI_PLATFORM_API_KEY",
    baseUrlEnvVar: "KIMI_PLATFORM_BASE_URL",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
  });
  assert.equal(
    KIMI_PLATFORM_CN_MODELS_LIST_URL,
    "https://api.moonshot.cn/v1/models",
  );
  assert.equal(
    Object.values(ENDPOINT_MODELS_LIST_FACES).some(
      (face) => new URL(face.defaultBaseUrl).hostname === "api.kimi.com",
    ),
    false,
    "Kimi Code has no verified zero-inference models-list face",
  );
});
