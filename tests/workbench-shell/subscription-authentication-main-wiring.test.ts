import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Electron main shares one durable auth-generation authority across Project host and two fixed provider actions", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    source.match(/createWorkLedgerAuthGenerationModule\s*\(\s*\{/gu)?.length,
    1,
  );
  assert.match(
    source,
    /const authGeneration\s*=\s*createWorkLedgerAuthGenerationModule\s*\(\{\s*dataDirectory:\s*projectHostDataDirectory,?\s*\}\)/u,
  );
  assert.match(
    source,
    /createWorkbenchProjectHost\(\{[\s\S]*?adapter:\s*runtimeAdapter,[\s\S]*?authGeneration,[\s\S]*?\}\)/u,
  );
  assert.match(
    source,
    /createProductionRuntimeEndpointAdapter\(\{\s*authGeneration,\s*providerRequestBudget,/u,
  );
  assert.match(
    source,
    /createWorkLedgerSubscriptionAuthenticationMutationAuthority\(\{\s*authGeneration,[\s\S]*?endpointSelections:\s*new Map/u,
  );
  assert.equal(
    source.match(/createOfficialCodexSubscriptionAuthenticationProvider\(\s*undefined,\s*providerRequestBudget,?\s*\)/gu)
      ?.length,
    1,
  );
  assert.equal(
    source.match(/createOfficialClaudeSubscriptionAuthenticationProvider\(\s*undefined,\s*providerRequestBudget,?\s*\)/gu)
      ?.length,
    1,
  );
  assert.equal(
    source.match(/createSubscriptionAuthenticationService\s*\(\s*\{/gu)?.length,
    1,
  );
  assert.match(
    source,
    /const subscriptionAuthenticationActionService\s*=\s*createSubscriptionAuthenticationService\(\{[\s\S]*?providers:\s*Object\.freeze\(\[[\s\S]*?createOfficialCodexSubscriptionAuthenticationProvider\(\s*undefined,\s*providerRequestBudget,[\s\S]*?createOfficialClaudeSubscriptionAuthenticationProvider\(\s*undefined,\s*providerRequestBudget,[\s\S]*?timeoutMilliseconds:\s*600_000,[\s\S]*?inspectionTimeoutMilliseconds:\s*10_000,[\s\S]*?\}\)/u,
  );
  assert.match(
    source,
    /createWorkbenchSubscriptionAuthenticationCoordinator\(\{[\s\S]*?endpointId:\s*"codex-desktop"[\s\S]*?endpointId:\s*"claude-code-desktop"[\s\S]*?authentication:\s*subscriptionAuthenticationActionService,[\s\S]*?mutations:\s*createWorkLedgerSubscriptionAuthenticationMutationAuthority/u,
  );
  assert.match(
    source,
    /WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS\.codex[\s\S]*?"codex-desktop"[\s\S]*?WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS\.claude[\s\S]*?"claude-code-desktop"/u,
  );
  assert.match(
    source,
    /subscriptionAuthenticationIpc\s*=\s*installWorkbenchSubscriptionAuthenticationActionIpc\(\{\s*ipcMain,\s*window:\s*createdWindow,\s*source:\s*subscriptionAuthenticationService,\s*\}\)/u,
  );
  assert.match(
    source,
    /subscriptionAuthenticationShutdown\s*=\s*closingSubscriptionAuthenticationIpc\?\.dispose\(\)[\s\S]*await subscriptionAuthenticationShutdown/u,
  );
  assert.doesNotMatch(
    source,
    /installWorkbenchSubscriptionAuthenticationIpc\s*\(/u,
  );
  assert.doesNotMatch(
    source,
    /createWorkbenchSubscriptionAuthenticationProviderAdapter/u,
  );
  assert.doesNotMatch(
    source,
    /subscriptionAuthentication[\s\S]{0,180}(?:--bare|API_KEY|token|shell:\s*true)/iu,
  );
});
