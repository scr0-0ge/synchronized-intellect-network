import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("one preflighted attempt locator and governor reach parent discovery and Electron main before effects", async () => {
  const [mainSource, e2eSource] = await Promise.all([
    readFile(
      new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../e2e/electron-e2e.ts", import.meta.url), "utf8"),
  ]);

  const mainBudgetLoad = mainSource.indexOf(
    "loadProviderRequestBudgetForElectronMain({",
  );
  const mainRuntimeComposition = mainSource.indexOf(
    "createProductionRuntimeEndpointAdapter({",
  );
  const mainAuthenticationProviders = mainSource.indexOf(
    "createOfficialCodexSubscriptionAuthenticationProvider(",
  );
  assert.ok(mainBudgetLoad >= 0);
  assert.ok(mainBudgetLoad < mainRuntimeComposition);
  assert.ok(mainBudgetLoad < mainAuthenticationProviders);
  assert.match(
    mainSource,
    /createProductionRuntimeEndpointAdapter\(\{\s*authGeneration,\s*providerRequestBudget,/u,
  );
  assert.match(
    mainSource,
    /createOfficialCodexSubscriptionAuthenticationProvider\(\s*undefined,\s*providerRequestBudget/u,
  );
  assert.match(
    mainSource,
    /createOfficialClaudeSubscriptionAuthenticationProvider\(\s*undefined,\s*providerRequestBudget/u,
  );

  const preflight = e2eSource.indexOf('"provider-attempt-preflight"');
  const temporaryRoot = e2eSource.indexOf('"temporary-root-creation"', preflight);
  const firstHeadless = e2eSource.indexOf('"codex-catalog-read"', temporaryRoot);
  const verification = e2eSource.indexOf(
    '"provider-attempt-verification"',
    firstHeadless,
  );
  const independentBoundary = e2eSource.indexOf(
    'completeDefaultProviderRound("independent-headless")',
    firstHeadless,
  );
  const item4Composition = e2eSource.indexOf(
    '"item-4-composition"',
    independentBoundary,
  );
  const item4Boundary = e2eSource.indexOf(
    'completeDefaultProviderRound("item-4-lazy-picker")',
    item4Composition,
  );
  assert.ok(preflight >= 0);
  assert.ok(preflight < temporaryRoot);
  assert.ok(temporaryRoot < firstHeadless);
  assert.ok(firstHeadless < independentBoundary);
  assert.ok(independentBoundary < item4Composition);
  assert.ok(item4Composition < item4Boundary);
  assert.ok(item4Boundary < verification);
  assert.match(
    e2eSource,
    /new CodexAdapter\([\s\S]*?providerBudget\)/u,
  );
  assert.match(
    e2eSource,
    /new ClaudeAdapter\([\s\S]*?undefined,\s*providerBudget\)/u,
  );
  assert.match(
    e2eSource,
    /--\$\{PROVIDER_ATTEMPT_LOCATOR_SWITCH\}=\$\{providerAttemptLocator\}/u,
  );
  assert.match(
    e2eSource,
    /modelListRequests < 1 \|\|\s*modelListRequests > 2/u,
  );

  const positiveComposition = e2eSource.indexOf(
    "async function observePositiveComposition(",
  );
  const continuationLoad = e2eSource.indexOf(
    "const profileProjection = await inspectRenderedProfileProjection(",
    positiveComposition,
  );
  const continuationBoundary = e2eSource.indexOf(
    'completeDefaultProviderRound("positive-continuation-composition")',
    positiveComposition,
  );
  const newSessionTrigger = e2eSource.indexOf(
    '"positive-composer-focus"',
    continuationBoundary,
  );
  const newSessionBoundary = e2eSource.indexOf(
    '"positive-new-session-explicit-refresh"',
    newSessionTrigger,
  );
  assert.ok(positiveComposition >= 0);
  assert.ok(continuationLoad >= 0);
  assert.ok(continuationLoad < continuationBoundary);
  assert.ok(continuationBoundary < newSessionTrigger);
  assert.ok(newSessionTrigger < newSessionBoundary);
  assert.match(
    e2eSource,
    /const continuationProfileReadyText =\s*"Latest turn profile selected for the next turn\.";/u,
  );
  assert.match(
    e2eSource,
    /const controlNotes = document\.querySelectorAll\(\s*"\.composer \.control-note",?\s*\);[\s\S]*?controlNotes\.length === 1[\s\S]*?controlNotes\[0\]\?\.textContent\?\.trim\(\) === expected/u,
  );
  assert.doesNotMatch(e2eSource, /includes\("apply to the next turn"\)/u);

  const seedStart = e2eSource.indexOf("async function seedProjectedSessions(");
  const seedEnd = e2eSource.indexOf(
    "async function waitForSeededTerminal(",
    seedStart,
  );
  assert.ok(seedStart >= 0 && seedEnd > seedStart);
  const seedSource = e2eSource.slice(seedStart, seedEnd);
  assert.match(
    seedSource,
    /runtimeResumeIdentity:\s*\{\s*schemaVersion: 1,\s*endpointId: "codex-desktop",\s*nativeProfile: fixture\.profile,\s*\}/u,
  );
  assert.match(
    seedSource,
    /\},\s*\{\s*endpointId: "codex-desktop",?\s*\}\s*\);/u,
  );
});

test("the independent Codex catalog read refuses a third model/list page before it reaches the wire", async () => {
  const e2eSource = await readFile(
    new URL("../e2e/electron-e2e.ts", import.meta.url),
    "utf8",
  );

  const ceilingConstant = e2eSource.indexOf(
    "const headlessCodexModelListPageCeiling = 2;",
  );
  const codexCatalogReader = e2eSource.indexOf(
    "async function readHeadlessCodexCatalog(",
  );
  const presendRefusal = e2eSource.indexOf(
    '"E2E_CATALOG_PAGINATION_CEILING_REACHED"',
    codexCatalogReader,
  );
  const codexDelegatedSend = e2eSource.indexOf(
    "await delegate.send(line);",
    codexCatalogReader,
  );
  const postHocCheck = e2eSource.indexOf(
    "modelListRequests > 2",
    codexCatalogReader,
  );
  assert.ok(ceilingConstant >= 0);
  assert.ok(ceilingConstant < codexCatalogReader);
  assert.ok(presendRefusal > codexCatalogReader);
  // The refusal must precede the delegated write, so the third page is never
  // billed to the owner's provider allowance; the post-hoc assertion below it
  // stays as the backstop rather than the limiter.
  assert.ok(presendRefusal < codexDelegatedSend);
  assert.ok(codexDelegatedSend < postHocCheck);
  assert.match(
    e2eSource,
    /method === "model\/list" &&[\s\S]{0,240}headlessCodexModelListPageCeiling/u,
  );
  // "the vendor paginated further than expected" is a different fact from "this
  // catalog came from a stub", so the ceiling never borrows the stub code.
  assert.ok(
    !e2eSource
      .slice(presendRefusal - 400, presendRefusal)
      .includes("E2E_FAKE_OR_STUB_DETECTED"),
  );

  // The Claude catalog read needs no page ceiling: its transport wrapper
  // already refuses every outbound frame that is not the single initialize
  // control request, and it refuses before the delegated write.
  const claudeCatalogReader = e2eSource.indexOf(
    "async function readHeadlessClaudeCatalog(",
  );
  const claudeFrameGuard = e2eSource.indexOf(
    "Claude catalog inspection attempted a non-initialize outbound frame",
    claudeCatalogReader,
  );
  const claudeDelegatedSend = e2eSource.indexOf(
    "await delegate.send(line);",
    claudeCatalogReader,
  );
  assert.ok(claudeCatalogReader > codexCatalogReader);
  assert.ok(claudeFrameGuard > claudeCatalogReader);
  assert.ok(claudeFrameGuard < claudeDelegatedSend);
});
