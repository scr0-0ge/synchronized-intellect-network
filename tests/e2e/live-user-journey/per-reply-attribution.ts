import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ElectronApplication, Page } from "playwright";

import {
  launchProductionElectron,
  productionElectronArguments,
} from "../harness/production-electron.ts";

import type {
  CapturedLiveChild,
  PerReplyAttributionLiveEvidence,
  PerReplyAttributionRuntimeProof,
  UserJourneyEvidenceSeal,
  UserJourneyRuntime,
} from "./contracts.ts";
import {
  finalWriteAndSealAttributionEvidence,
  findOnlyProjectLedger,
  readDurableCommands,
  resolveEvidencePath,
} from "./evidence.ts";
import {
  captureLiveChild,
  closeOwnedApplication,
} from "./lifecycle.ts";
import {
  assertInitialLiveProjectSurface,
  openProductionLivePage,
} from "./live-two-turn.ts";
import {
  compactText,
  createTemporaryRoot,
  escapeRegularExpression,
  productionElectronComposition,
  removeTemporaryRoot,
  subscriptionOnlyEnvironment,
  terminalStatePattern,
} from "./shared.ts";

export async function runLivePerReplyAttributionProof(
  evidencePathInput: string,
): Promise<Readonly<{
  evidence: PerReplyAttributionLiveEvidence;
  seal: UserJourneyEvidenceSeal;
}>> {
  const evidencePath = resolveEvidencePath(evidencePathInput);
  const runtimes: PerReplyAttributionRuntimeProof[] = [];
  for (const runtime of ["codex", "claude"] as const) {
    runtimes.push(await runRuntimePerReplyAttributionProof(runtime));
  }
  const evidence: PerReplyAttributionLiveEvidence = Object.freeze({
    schema: "per-reply-profile-attribution-live-proof-v1" as const,
    source: "production-renderer-live" as const,
    subscriptionAuthentication: "provider-owned-oauth" as const,
    runtimes: Object.freeze(runtimes),
    exactChildDeathsProved: true as const,
    isolatedRootsRemoved: true as const,
  });
  const seal = await finalWriteAndSealAttributionEvidence(evidencePath, evidence);
  console.log(`F98_LIVE_EVIDENCE ${JSON.stringify(seal)}`);
  return Object.freeze({ evidence, seal });
}

interface AttributionApplication {
  readonly application: ElectronApplication;
  readonly page: Page;
  readonly child: CapturedLiveChild;
}

interface AttributionProfile {
  readonly model: string;
  readonly workIntensity: string;
}

interface AttributionLabels {
  readonly models: readonly string[];
  readonly workIntensities: readonly string[];
}

async function runRuntimePerReplyAttributionProof(
  runtime: UserJourneyRuntime,
): Promise<PerReplyAttributionRuntimeProof> {
  const temporaryRoot = await createTemporaryRoot();
  const projectDirectory = join(
    temporaryRoot,
    runtime === "codex" ? "Live Codex Project" : "Live Claude Project",
  );
  const userDataDirectory = join(temporaryRoot, "user-data");
  let active: AttributionApplication | undefined;
  let success = false;
  try {
    await mkdir(projectDirectory);
    await mkdir(userDataDirectory);
    active = await launchAttributionApplication(
      projectDirectory,
      userDataDirectory,
    );
    await assertInitialLiveProjectSurface(active.page);
    await selectLiveEndpoint(active.page, runtime);
    const [firstModel, secondModel] = attributionModelPair(runtime);
    const profileA = await selectAttributionProfile(
      active.page,
      firstModel,
      0,
    );
    const expectedProfiles: AttributionProfile[] = [profileA];
    await submitAttributionTurn(active.page, runtime, 0, true, expectedProfiles);

    const profileB = await selectAttributionProfile(
      active.page,
      secondModel,
      2,
    );
    expectedProfiles.push(profileB);
    await submitAttributionTurn(active.page, runtime, 1, false, expectedProfiles);

    const profileAAgain = await selectAttributionProfile(
      active.page,
      firstModel,
      0,
    );
    assert.deepEqual(profileAAgain, profileA);
    expectedProfiles.push(profileAAgain);
    await submitAttributionTurn(active.page, runtime, 2, false, expectedProfiles);
    const beforeRelaunch = await assertAttributionHistory(
      active.page,
      runtime,
      expectedProfiles,
    );
    console.log(
      `F98_LIVE_STEP ${JSON.stringify({ runtime, step: "three-turn-history-settled" })}`,
    );

    await closeAttributionApplication(active);
    active = undefined;

    active = await launchAttributionApplication(
      projectDirectory,
      userDataDirectory,
    );
    await waitForAttributionHistory(active.page, 3);
    const afterRelaunch = await assertAttributionHistory(
      active.page,
      runtime,
      expectedProfiles,
    );
    assert.deepEqual(afterRelaunch, beforeRelaunch);
    await assertAttributionReplies(active.page, runtime, 3);
    console.log(
      `F98_LIVE_STEP ${JSON.stringify({ runtime, step: "relaunch-history-confirmed" })}`,
    );

    const profileBAfterRelaunch = await selectAttributionProfile(
      active.page,
      secondModel,
      2,
    );
    assert.deepEqual(profileBAfterRelaunch, profileB);
    expectedProfiles.push(profileBAfterRelaunch);
    await submitAttributionTurn(active.page, runtime, 3, false, expectedProfiles);
    const afterResume = await assertAttributionHistory(
      active.page,
      runtime,
      expectedProfiles,
    );
    await assertAttributionReplies(active.page, runtime, 4);
    assert.deepEqual(afterResume.models.slice(0, 3), afterRelaunch.models);
    assert.deepEqual(
      afterResume.workIntensities.slice(0, 3),
      afterRelaunch.workIntensities,
    );
    console.log(
      `F98_LIVE_STEP ${JSON.stringify({ runtime, step: "post-relaunch-resume-confirmed" })}`,
    );

    await closeAttributionApplication(active);
    active = undefined;
    const ledgerPath = await findOnlyProjectLedger(userDataDirectory);
    const durable = readDurableCommands(ledgerPath);
    assert.equal(durable.length, 4);
    assert.equal(durable.every((row) => row.status === "completed"), true);
    const durableTargets = new Set(
      durable.map((row) => row.targetSessionId).filter((value) => value !== null),
    );
    assert.equal(durableTargets.size, 1);
    assert.equal(durable.every((row) => row.targetSessionId !== null), true);

    const proof: PerReplyAttributionRuntimeProof = Object.freeze({
      runtime,
      liveTurns: 4 as const,
      relaunchedAfterTurns: 3 as const,
      resumedAfterRelaunch: true as const,
      repliesMatched: true as const,
      oneAgentSessionRow: true as const,
      oneDurableTarget: true as const,
      durableCommands: 4 as const,
      profileA: Object.freeze(profileA),
      profileB: Object.freeze(profileB),
      beforeRelaunch,
      afterRelaunch,
      afterResume,
    });
    success = true;
    return proof;
  } finally {
    if (active !== undefined) {
      try {
        await closeAttributionApplication(active);
      } catch {
        // The exact root is retained below when the primary proof did not settle.
      }
    }
    if (success) await removeTemporaryRoot(temporaryRoot);
    else {
      console.log(
        `F98_LIVE_RETAINED_ROOT ${JSON.stringify({ runtime, root: temporaryRoot })}`,
      );
    }
  }
}

async function launchAttributionApplication(
  projectDirectory: string,
  userDataDirectory: string,
): Promise<AttributionApplication> {
  const application = await launchProductionElectron(productionElectronComposition, {
    args: productionElectronArguments(
      productionElectronComposition,
      userDataDirectory,
    ),
    cwd: projectDirectory,
    env: subscriptionOnlyEnvironment(process.env),
    timeout: 15_000,
  });
  const boundary = Object.freeze({
    process: () => application.process(),
    close: () => application.close(),
  });
  const child = captureLiveChild(boundary);
  try {
    const page = await openProductionLivePage(
      application,
      projectDirectory,
      userDataDirectory,
    );
    return Object.freeze({ application, page, child });
  } catch (error) {
    await closeOwnedApplication(boundary, child);
    throw error;
  }
}

async function closeAttributionApplication(
  launched: AttributionApplication,
): Promise<void> {
  const boundary = Object.freeze({
    process: () => launched.application.process(),
    close: () => launched.application.close(),
  });
  const outcome = await closeOwnedApplication(boundary, launched.child);
  assert.deepEqual(outcome.failureKinds, []);
  assert.equal(outcome.deathProved, true);
}

function attributionModelPair(
  runtime: UserJourneyRuntime,
): readonly [string, string] {
  return runtime === "codex"
    ? ["GPT-5.6-Sol", "GPT-5.6-Terra"]
    : ["Fable 5", "Opus 5"];
}

async function selectLiveEndpoint(
  page: Page,
  runtime: UserJourneyRuntime,
): Promise<void> {
  const endpointButton = page.getByRole("button", { name: /^Endpoint:/u });
  await endpointButton.waitFor({ state: "visible", timeout: 10_000 });
  await endpointButton.click();
  const endpointList = page.getByRole("listbox", { name: "Endpoint options" });
  await endpointList.waitFor({ state: "visible", timeout: 30_000 });
  const runtimeLabel = runtime === "codex" ? "Codex" : "Claude";
  const options = endpointList.locator(".opt.opt-endpoint");
  const texts = (await options.allTextContents()).map(compactText);
  const matches = texts.flatMap((text, index) =>
    text.includes(runtimeLabel) ? [index] : [],
  );
  assert.equal(matches.length, 1);
  const option = options.nth(matches[0]!);
  assert.notEqual(await option.getAttribute("aria-disabled"), "true");
  await option.click();
  await page
    .getByRole("button", { name: new RegExp(`^Endpoint: ${runtimeLabel}$`, "u") })
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function selectAttributionProfile(
  page: Page,
  desiredModel: string,
  intensityIndex: number,
): Promise<AttributionProfile> {
  const modelButton = page.locator("#direct-model");
  await modelButton.waitFor({ state: "visible", timeout: 30_000 });
  const currentModel = compactText(
    (await modelButton.locator(".chip-val").textContent()) ?? "",
  );
  if (currentModel !== desiredModel) {
    await modelButton.click();
    const modelList = page.getByRole("listbox", { name: "Model options" });
    await modelList.waitFor({ state: "visible", timeout: 10_000 });
    const options = modelList.locator(".opt");
    const texts = (await options.allTextContents()).map(compactText);
    const matches = texts.flatMap((text, index) =>
      text === desiredModel ? [index] : [],
    );
    assert.equal(matches.length, 1, `${desiredModel} must be one exact option`);
    await options.nth(matches[0]!).click();
  }
  await page
    .getByRole("button", {
      name: new RegExp(`^Model: ${escapeRegularExpression(desiredModel)}$`, "u"),
    })
    .waitFor({ state: "visible", timeout: 10_000 });

  const intensityButton = page.locator("#direct-work-intensity");
  await intensityButton.waitFor({ state: "visible", timeout: 10_000 });
  await intensityButton.click();
  const range = page.getByRole("slider", { name: "Work Intensity" });
  await range.waitFor({ state: "visible", timeout: 10_000 });
  const maximum = Number(await range.getAttribute("max"));
  assert.ok(Number.isSafeInteger(maximum) && intensityIndex <= maximum);
  await range.fill(String(intensityIndex));
  const expectedValue = String(intensityIndex);
  await page.waitForFunction(
    ({ selector, expected }) =>
      (document.querySelector(selector) as HTMLInputElement | null)?.value === expected,
    { selector: '.islider-range[aria-label="Work Intensity"]', expected: expectedValue },
  );
  const workIntensity = compactText((await range.getAttribute("aria-valuetext")) ?? "");
  assert.ok(workIntensity.length > 0 && workIntensity !== "—");
  await intensityButton.click();
  await page.getByRole("slider", { name: "Work Intensity" }).waitFor({
    state: "detached",
    timeout: 10_000,
  });
  assert.equal(
    compactText((await modelButton.locator(".chip-val").textContent()) ?? ""),
    desiredModel,
  );
  assert.equal(
    compactText((await intensityButton.locator(".chip-val").textContent()) ?? ""),
    workIntensity,
  );
  return Object.freeze({ model: desiredModel, workIntensity });
}

async function submitAttributionTurn(
  page: Page,
  runtime: UserJourneyRuntime,
  turnIndex: number,
  start: boolean,
  expectedProfiles: readonly AttributionProfile[],
): Promise<void> {
  const marker = `UAW_F98_${runtime.toLocaleUpperCase("en-US")}_${turnIndex + 1}`;
  const input = page.locator("#direct-input");
  await input.fill(`Reply exactly: ${marker}`);
  const submit = page.getByRole("button", { name: start ? /^Start\b/u : /^Send\b/u });
  await submit.waitFor({ state: "visible", timeout: 10_000 });
  await submit.click({ timeout: 30_000 });
  await page
    .locator("#direct-input-feedback")
    .filter({ hasText: /durably accepted/iu })
    .waitFor({ state: "visible", timeout: 15_000 });
  const agentTurn = page.locator(".turn:not(.turn-user)").nth(turnIndex);
  await agentTurn.waitFor({ state: "visible", timeout: 15_000 });
  await agentTurn
    .locator(".turn-state")
    .filter({ hasText: terminalStatePattern })
    .waitFor({ state: "visible", timeout: 180_000 });
  assert.equal(
    compactText((await agentTurn.locator(".turn-state").textContent()) ?? "")
      .toLocaleLowerCase("en-US"),
    "completed",
  );
  assert.equal(
    compactText((await agentTurn.locator(".turn-body.prose").innerText()) ?? ""),
    marker,
  );
  await assertAttributionHistory(page, runtime, expectedProfiles);
  console.log(
    `F98_LIVE_STEP ${JSON.stringify({ runtime, step: "turn-completed", turn: turnIndex + 1 })}`,
  );
}

async function waitForAttributionHistory(page: Page, count: number): Promise<void> {
  const last = page.locator(".turn:not(.turn-user)").nth(count - 1);
  await last.waitFor({ state: "visible", timeout: 30_000 });
  await last.locator(".turn-state").filter({ hasText: /^completed$/iu }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

async function assertAttributionHistory(
  page: Page,
  runtime: UserJourneyRuntime,
  expectedProfiles: readonly AttributionProfile[],
): Promise<AttributionLabels> {
  const turns = page.locator(".turn:not(.turn-user)");
  assert.equal(await turns.count(), expectedProfiles.length);
  const models = Object.freeze(
    (await turns.locator(".turn-model").allTextContents()).map(compactText),
  );
  const workIntensities = Object.freeze(
    (await turns.locator(".turn-intensity").allTextContents()).map((value) =>
      compactText(value).replace(/^·\s*/u, ""),
    ),
  );
  assert.deepEqual(models, expectedProfiles.map((profile) => profile.model));
  assert.deepEqual(
    workIntensities,
    expectedProfiles.map((profile) => profile.workIntensity),
  );
  const runtimeLabel = runtime === "codex" ? "Codex" : "Claude";
  assert.deepEqual(
    (await turns.locator(".turn-actor").allTextContents()).map(compactText),
    expectedProfiles.map(() => runtimeLabel),
  );
  const sessionRows = page
    .getByRole("navigation", { name: "Projects and Agent Sessions" })
    .locator(".session-row");
  assert.equal(await sessionRows.count(), 1);
  return Object.freeze({ models, workIntensities });
}

async function assertAttributionReplies(
  page: Page,
  runtime: UserJourneyRuntime,
  count: number,
): Promise<void> {
  const replies = await page.locator(".turn:not(.turn-user) .turn-body.prose").allInnerTexts();
  assert.deepEqual(
    replies.map(compactText),
    Array.from(
      { length: count },
      (_value, index) => `UAW_F98_${runtime.toLocaleUpperCase("en-US")}_${index + 1}`,
    ),
  );
}
