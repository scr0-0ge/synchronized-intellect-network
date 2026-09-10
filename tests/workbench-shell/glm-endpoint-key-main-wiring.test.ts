import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production owns one userData-scoped envelope store file per subject, the safeStorage injection, the endpoint-key IPC bindings, and the store-first token resolver", async () => {
  const source = await readFile(
    new URL(
      "../../src/workbench-shell/electron/main.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    source,
    /import \{[\s\S]*safeStorage,[\s\S]*\} from "electron";/u,
  );
  assert.match(
    source,
    /import \{[\s\S]*EndpointSecretEnvelopeStore[\s\S]*\} from "\.\.\/endpoint-secret-envelope-store\.ts";/u,
  );
  assert.match(
    source,
    /import \{[\s\S]*createWorkbenchGlmEndpointKeySource,[\s\S]*endpointSecretEnvelopeStorePath,[\s\S]*GLM_ENDPOINT_KEY_SUBJECT,[\s\S]*type WorkbenchEndpointKeySource,[\s\S]*\} from "\.\.\/glm-endpoint-key\.ts";/u,
  );
  assert.match(
    source,
    /import \{[\s\S]*createWorkbenchKimiEndpointKeySource,[\s\S]*KIMI_ENDPOINT_KEY_SUBJECT,[\s\S]*\} from "\.\.\/kimi-endpoint-key\.ts";/u,
  );
  assert.match(
    source,
    /import \{[\s\S]*createWorkbenchDeepseekEndpointKeySource,[\s\S]*DEEPSEEK_ENDPOINT_KEY_SUBJECT,[\s\S]*\} from "\.\.\/deepseek-endpoint-key\.ts";/u,
  );
  assert.match(
    source,
    /import \{[\s\S]*installWorkbenchEndpointKeyIpc,[\s\S]*type WorkbenchEndpointKeyIpcBinding,[\s\S]*\} from "\.\/endpoint-key-ipc\.ts";/u,
  );
  // One shared store FILE, three subject-bound store instances.
  assert.match(
    source,
    /const glmEndpointSecretEnvelopeStore = new EndpointSecretEnvelopeStore\(\{\s+subject: GLM_ENDPOINT_KEY_SUBJECT,\s+safeStorage,\s+storePath: endpointSecretStorePath,\s+\}\);/u,
  );
  assert.match(
    source,
    /const kimiEndpointSecretEnvelopeStore = new EndpointSecretEnvelopeStore\(\{\s+subject: KIMI_ENDPOINT_KEY_SUBJECT,\s+safeStorage,\s+storePath: endpointSecretStorePath,\s+\}\);/u,
  );
  assert.match(
    source,
    /const deepseekEndpointSecretEnvelopeStore =\s*new EndpointSecretEnvelopeStore\(\{\s+subject: DEEPSEEK_ENDPOINT_KEY_SUBJECT,\s+safeStorage,\s+storePath: endpointSecretStorePath,\s+\}\);/u,
  );
  assert.match(
    source,
    /glmEndpointKeySource = createWorkbenchGlmEndpointKeySource\(\{\s+store: glmEndpointSecretEnvelopeStore,\s+environment: process\.env,\s+\}\);/u,
  );
  assert.match(
    source,
    /kimiEndpointKeySource = createWorkbenchKimiEndpointKeySource\(\{\s+store: kimiEndpointSecretEnvelopeStore,\s+environment: process\.env,\s+\}\);/u,
  );
  assert.match(
    source,
    /deepseekEndpointKeySource = createWorkbenchDeepseekEndpointKeySource\(\{\s+store: deepseekEndpointSecretEnvelopeStore,\s+environment: process\.env,\s+\}\);/u,
  );
  assert.match(
    source,
    /resolveGlmAuthToken: \(\) => glmEndpointKeySource\?\.resolve\(\),/u,
  );
  // Every static-key endpoint installs its parameterized key-IPC binding.
  for (const endpointId of ["glm-coding-plan", "kimi-code", "deepseek-api"]) {
    assert.match(
      source,
      new RegExp(
        `installWorkbenchEndpointKeyIpc\\(\\{\\s+ipcMain,\\s+window: createdWindow,\\s+endpointId: "${endpointId}",\\s+source: \\w+,\\s+\\}\\)`,
        "u",
      ),
    );
  }
  // Disposal is symmetric with installation (all bindings, then reset).
  // main-resync: the teardown moved into main's per-step isolated list
  // (binding-teardown.ts); the step still clears the slot before disposing
  // every binding, so a second run is a no-op.
  assert.match(
    source,
    /const closing = endpointKeyIpc;\s+endpointKeyIpc = \[\];\s+for \(const binding of closing\) binding\.dispose\(\);/u,
  );
});

test("the composition factory keeps env as the documented fallback and accepts the resolver", async () => {
  const source = await readFile(
    new URL(
      "../../src/workbench-shell/runtime-endpoint-composition.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    source,
    /readonly resolveGlmAuthToken\?: \(\) => string \| undefined;/u,
  );
  // Both GLM construction sites (adapter option and discovery definition)
  // forward the resolver, so no site can silently drop the store source.
  const forwardings = source.match(
    /resolveGlmAuthToken: options\.resolveGlmAuthToken,/gu,
  )?.length;
  assert.equal(forwardings, 2);
});
