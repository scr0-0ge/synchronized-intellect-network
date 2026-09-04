import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ElectronApplication, Page } from "playwright";

import {
  firstDomContentLoadedWindow,
  launchProductionElectron,
  productionElectronArguments,
} from "../harness/production-electron.ts";

import {
  LiveUserJourneyRunFailure,
  type CapturedJourneyTurn,
  type CapturedLiveChild,
  type DurableCommandObservation,
  type JourneyScenario,
  type LiveUserJourneyApplicationBoundary,
  type LiveUserJourneyFailureKind,
  type LiveUserJourneyTurnCapture,
  type UserJourneyEvidenceSeal,
  type UserJourneyObservation,
  type UserJourneyPreflightRunOptions,
  type UserJourneyRunOptions,
  type UserJourneyRuntime,
} from "./contracts.ts";
import {
  durableTargetMatchesPair,
  emitEvidenceSeal,
  exportUserJourneyEvidence,
  findOnlyProjectLedger,
  readDurableCommands,
  resolveEvidencePath,
} from "./evidence.ts";
import {
  addLiveFailure,
  captureLiveChild,
  closeOwnedApplication,
  createLiveFailureOutcome,
  deleteGuardedLiveTemporaryRoot,
  unreadableChildExitState,
  type LiveChildExitState,
} from "./lifecycle.ts";
import {
  assertLiveObservations,
  completeObservation,
} from "./observations.ts";
import {
  compactText,
  createTemporaryRoot,
  emitObservation,
  escapeRegularExpression,
  expectedRendererUrl,
  productionElectronComposition,
  scenariosFor,
  subscriptionOnlyEnvironment,
  terminalStatePattern,
} from "./shared.ts";

export async function runLiveUserJourney(
  runtime: UserJourneyRuntime,
  emit: (observation: UserJourneyObservation) => void = emitObservation,
  options: UserJourneyRunOptions = {},
): Promise<readonly UserJourneyObservation[]> {
  if (options.evidencePath === undefined) {
    throw new Error("live-user-journey-evidence-path-required");
  }
  const evidencePath = resolveEvidencePath(options.evidencePath);
  const temporaryRoot = await createTemporaryRoot();
  const failureKinds: LiveUserJourneyFailureKind[] = [];
  const projectDirectory = join(
    temporaryRoot,
    runtime === "codex" ? "Live Codex Project" : "Live Claude Project",
  );
  const userDataDirectory = join(temporaryRoot, "user-data");
  let application: LiveUserJourneyApplicationBoundary | undefined;
  let launchChild: CapturedLiveChild | undefined;
  let captured: readonly CapturedJourneyTurn[] = Object.freeze([]);
  let primaryJourneyCompleted = false;
  let finalChildState = unreadableChildExitState();
  let evidenceSeal: UserJourneyEvidenceSeal | undefined;
  try {
    options.onTemporaryRootCreated?.(temporaryRoot);
    await mkdir(projectDirectory);
    await mkdir(userDataDirectory);
    application = await (
      options.liveSystemBoundary?.launch({
        runtime,
        projectDirectory,
        userDataDirectory,
      }) ??
      launchProductionLiveApplication(
        runtime,
        projectDirectory,
        userDataDirectory,
      )
    );
    launchChild = captureLiveChild(application);
    captured = captureBoundaryTurns(await application.drive(), runtime);
    primaryJourneyCompleted = true;
  } catch {
    addLiveFailure(failureKinds, "primary-journey");
  }

  let deathProved = false;
  if (application !== undefined) {
    try {
      const closeOutcome = await closeOwnedApplication(application, launchChild);
      for (const failureKind of closeOutcome.failureKinds) {
        addLiveFailure(failureKinds, failureKind);
      }
      deathProved = closeOutcome.deathProved;
      finalChildState = closeOutcome;
    } catch {
      addLiveFailure(failureKinds, "graceful-close");
      addLiveFailure(failureKinds, "fallback-death-proof");
    }
  }

  let durable: readonly DurableCommandObservation[] | undefined;
  let observations: readonly UserJourneyObservation[] | undefined;
  if (primaryJourneyCompleted && deathProved) {
    try {
      const ledgerPath = await findOnlyProjectLedger(userDataDirectory);
      durable = readDurableCommands(ledgerPath);
      assert.equal(
        durable.length,
        2,
        "the isolated live Project must contain two commands",
      );
      observations = Object.freeze(
        captured.map((turn, index) =>
          completeObservation(
            turn,
            durable?.[index],
            durableTargetMatchesPair(durable ?? [], index),
            captured[0]?.sessionRowLabel === turn.sessionRowLabel,
            "production-renderer-live",
          ),
        ),
      );
    } catch {
      addLiveFailure(failureKinds, "ledger-read");
    }
  }

  let observationsValidated = false;
  if (observations !== undefined) {
    try {
      assertLiveObservations(observations, runtime);
      observationsValidated = true;
      for (const observation of observations) emit(observation);
    } catch {
      addLiveFailure(failureKinds, "primary-journey");
    }
  }

  if (observationsValidated && durable !== undefined) {
    try {
      await exportUserJourneyEvidence(
        {
          ...options,
          onEvidenceSealed: (seal) => {
            evidenceSeal = seal;
            if (options.onEvidenceSealed === undefined) {
              emitEvidenceSeal(seal);
            } else {
              options.onEvidenceSealed(seal);
            }
          },
        },
        temporaryRoot,
        observations ?? [],
        durable,
      );
    } catch {
      addLiveFailure(failureKinds, "evidence-export");
    }
  }

  if (failureKinds.length === 0 && deathProved) {
    try {
      await deleteGuardedLiveTemporaryRoot(
        temporaryRoot,
        options.liveSystemBoundary,
      );
    } catch {
      addLiveFailure(failureKinds, "root-cleanup");
    }
  }

  if (failureKinds.length > 0) {
    throw new LiveUserJourneyRunFailure(
      failureKinds,
      await createLiveFailureOutcome({
        runtime,
        failureKinds,
        temporaryRoot,
        evidencePath,
        evidenceSeal,
        launchChild,
        childState: finalChildState,
      }),
    );
  }
  assert.ok(observations !== undefined);
  return observations;
}

async function launchProductionLiveApplication(
  runtime: UserJourneyRuntime,
  projectDirectory: string,
  userDataDirectory: string,
): Promise<LiveUserJourneyApplicationBoundary> {
  const application = await launchProductionElectron(productionElectronComposition, {
    args: productionElectronArguments(
      productionElectronComposition,
      userDataDirectory,
    ),
    cwd: projectDirectory,
    env: subscriptionOnlyEnvironment(process.env),
    timeout: 15_000,
  });
  return Object.freeze({
    process: () => application.process(),
    close: () => application.close(),
    async drive(): Promise<readonly LiveUserJourneyTurnCapture[]> {
      const page = await openProductionLivePage(
        application,
        projectDirectory,
        userDataDirectory,
      );
      return Object.freeze(
        (await driveLiveRuntimeJourney(page, runtime)).map((turn) =>
          Object.freeze({
            name: turn.scenario.name,
            runtimeObserved: turn.runtimeObserved,
            accepted: turn.accepted,
            eventKinds: turn.eventKinds,
            terminalState: turn.terminalState,
            replyText: turn.replyText,
            agentSessionCount: turn.agentSessionCount,
            sessionRowLabel: turn.sessionRowLabel,
            modelLabel: turn.modelLabel,
            effortLabel: turn.effortLabel,
          }),
        ),
      );
    },
    async preflight(): Promise<
      Readonly<{ modelLabel: string; effortLabel: string }>
    > {
      const page = await openProductionLivePage(
        application,
        projectDirectory,
        userDataDirectory,
      );
      await assertInitialLiveProjectSurface(page);
      return await selectLiveProfile(page, runtime);
    },
  });
}

export async function openProductionLivePage(
  application: ElectronApplication,
  projectDirectory: string,
  userDataDirectory: string,
): Promise<Page> {
  const page = await firstDomContentLoadedWindow(application, 15_000);
  await assertProductionSurface(
    application,
    page,
    projectDirectory,
    userDataDirectory,
  );
  return page;
}

function captureBoundaryTurns(
  turns: readonly LiveUserJourneyTurnCapture[],
  runtime: UserJourneyRuntime,
): readonly CapturedJourneyTurn[] {
  const scenarios = scenariosFor(runtime);
  assert.equal(turns.length, scenarios.length);
  return Object.freeze(
    turns.map((turn, index) => {
      const scenario = scenarios[index];
      assert.ok(scenario);
      assert.equal(turn.name, scenario.name);
      return Object.freeze({
        scenario,
        runtimeObserved: turn.runtimeObserved,
        accepted: turn.accepted,
        eventKinds: Object.freeze([...turn.eventKinds]),
        terminalState: turn.terminalState,
        replyText: turn.replyText,
        agentSessionCount: turn.agentSessionCount,
        sessionRowLabel: turn.sessionRowLabel,
        modelLabel: turn.modelLabel,
        effortLabel: turn.effortLabel,
      });
    }),
  );
}

export async function runLiveUserJourneyPreflight(
  runtime: UserJourneyRuntime,
  options: UserJourneyPreflightRunOptions = {},
): Promise<Readonly<{ modelLabel: string; effortLabel: string }>> {
  const temporaryRoot = await createTemporaryRoot();
  const failureKinds: LiveUserJourneyFailureKind[] = [];
  const projectDirectory = join(
    temporaryRoot,
    runtime === "codex" ? "Live Codex Project" : "Live Claude Project",
  );
  const userDataDirectory = join(temporaryRoot, "user-data");
  let application: LiveUserJourneyApplicationBoundary | undefined;
  let launchChild: CapturedLiveChild | undefined;
  let profile: Readonly<{ modelLabel: string; effortLabel: string }> | undefined;
  let finalChildState = unreadableChildExitState();
  try {
    options.onTemporaryRootCreated?.(temporaryRoot);
    await mkdir(projectDirectory);
    await mkdir(userDataDirectory);
    application = await (
      options.liveSystemBoundary?.launch({
        runtime,
        projectDirectory,
        userDataDirectory,
      }) ??
      launchProductionLiveApplication(
        runtime,
        projectDirectory,
        userDataDirectory,
      )
    );
    launchChild = captureLiveChild(application);
    if (application.preflight === undefined) {
      throw new Error("live-user-journey-preflight-boundary-missing");
    }
    profile = await application.preflight();
  } catch {
    addLiveFailure(failureKinds, "primary-journey");
  }

  let deathProved = false;
  if (application !== undefined) {
    try {
      const closeOutcome = await closeOwnedApplication(application, launchChild);
      for (const failureKind of closeOutcome.failureKinds) {
        addLiveFailure(failureKinds, failureKind);
      }
      deathProved = closeOutcome.deathProved;
      finalChildState = closeOutcome;
    } catch {
      addLiveFailure(failureKinds, "graceful-close");
      addLiveFailure(failureKinds, "fallback-death-proof");
    }
  }

  if (failureKinds.length === 0 && deathProved) {
    try {
      await deleteGuardedLiveTemporaryRoot(
        temporaryRoot,
        options.liveSystemBoundary,
      );
    } catch {
      addLiveFailure(failureKinds, "root-cleanup");
    }
  }

  if (failureKinds.length > 0) {
    throw new LiveUserJourneyRunFailure(
      failureKinds,
      await createLiveFailureOutcome({
        runtime,
        failureKinds,
        temporaryRoot,
        evidencePath: null,
        evidenceSeal: undefined,
        launchChild,
        childState: finalChildState,
      }),
    );
  }
  assert.ok(profile !== undefined);
  return profile;
}

async function driveLiveRuntimeJourney(
  page: Page,
  runtime: UserJourneyRuntime,
): Promise<readonly CapturedJourneyTurn[]> {
  await assertInitialLiveProjectSurface(page);
  const profile = await selectLiveProfile(page, runtime);
  const [startScenario, continueScenario] = scenariosFor(runtime);
  const startTurn = await submitAndCaptureLiveTurn(
    page,
    startScenario,
    0,
    profile,
  );
  const continueTurn = await submitAndCaptureLiveTurn(
    page,
    continueScenario,
    1,
    profile,
  );
  return Object.freeze([startTurn, continueTurn]);
}

export async function assertInitialLiveProjectSurface(page: Page): Promise<void> {
  const navigation = page.getByRole("navigation", {
    name: "Projects and Agent Sessions",
  });
  await navigation.waitFor({ state: "visible", timeout: 15_000 });
  const projectButton = navigation.getByRole("button", {
    name: /(?:Expand|Collapse) Live (?:Codex|Claude) Project Agent Sessions/u,
  });
  await projectButton.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await projectButton.getAttribute("aria-current"), "page");
  assert.equal(await navigation.locator(".session-row").count(), 0);
  console.log(
    `LIVE_USER_JOURNEY_STEP ${JSON.stringify({ step: "project-selected", agentSessionCount: 0 })}`,
  );
}

async function selectLiveProfile(
  page: Page,
  runtime: UserJourneyRuntime,
): Promise<Readonly<{ modelLabel: string; effortLabel: string }>> {
  const endpointButton = page.getByRole("button", { name: /^Endpoint:/u });
  await endpointButton.waitFor({ state: "visible", timeout: 10_000 });
  console.log(
    `LIVE_USER_JOURNEY_STEP ${JSON.stringify({ runtime, step: "endpoint-control-visible" })}`,
  );
  await endpointButton.click();
  const endpointList = page.getByRole("listbox", { name: "Endpoint options" });
  await endpointList.waitFor({ state: "visible", timeout: 30_000 });
  const runtimeLabel = runtime === "codex" ? "Codex" : "Claude";
  const endpointOptions = endpointList.locator(".opt.opt-endpoint");
  const endpointOption = endpointOptions.filter({ hasText: runtimeLabel });
  console.log(
    `LIVE_USER_JOURNEY_STEP ${JSON.stringify({
      runtime,
      step: "endpoint-options-ready",
      optionCount: await endpointOptions.count(),
      matchingOptions: await endpointOption.count(),
    })}`,
  );
  assert.equal(await endpointOption.count(), 1, `${runtimeLabel} endpoint must be unique`);
  assert.notEqual(await endpointOption.getAttribute("aria-disabled"), "true");
  await endpointOption.click();
  await page
    .getByRole("button", { name: new RegExp(`^Endpoint: ${runtimeLabel}$`, "u") })
    .waitFor({ state: "visible", timeout: 10_000 });
  console.log(
    `LIVE_USER_JOURNEY_STEP ${JSON.stringify({ runtime, step: "endpoint-selected" })}`,
  );

  const desiredModel = runtime === "codex" ? "GPT-5.6-Sol" : "Sonnet 5";
  const modelButton = page.getByRole("button", { name: /^Model:/u });
  await modelButton.waitFor({ state: "visible", timeout: 10_000 });
  const selectedModel = compactText(
    (await modelButton.locator(".chip-val").textContent()) ?? "",
  );
  if (selectedModel !== desiredModel) {
    await modelButton.click();
    const modelList = page.getByRole("listbox", { name: "Model options" });
    await modelList.waitFor({ state: "visible", timeout: 10_000 });
    const modelOption = modelList.locator(".opt").filter({ hasText: desiredModel });
    assert.equal(await modelOption.count(), 1, `${desiredModel} must be unique`);
    await modelOption.click();
  }
  await page
    .getByRole("button", {
      name: new RegExp(`^Model: ${escapeRegularExpression(desiredModel)}$`, "u"),
    })
    .waitFor({ state: "visible", timeout: 10_000 });
  const effortLabel = compactText(
    (await page.locator(".composer .chip-intensity .chip-val").textContent()) ?? "",
  );
  assert.ok(effortLabel.length > 0 && effortLabel !== "—");
  console.log(
    `LIVE_USER_JOURNEY_STEP ${JSON.stringify({
      runtime,
      step: "profile-selected",
      modelLabel: desiredModel,
      effortLabel,
    })}`,
  );
  return Object.freeze({ modelLabel: desiredModel, effortLabel });
}

async function submitAndCaptureLiveTurn(
  page: Page,
  scenario: JourneyScenario,
  turnIndex: number,
  profile: Readonly<{ modelLabel: string; effortLabel: string }>,
): Promise<CapturedJourneyTurn> {
  const expectedButton = scenario.commandKind === "start" ? /^Start\b/u : /^Send\b/u;
  const submit = page.getByRole("button", { name: expectedButton });
  await submit.waitFor({ state: "visible", timeout: 10_000 });
  if (scenario.commandKind === "continue") {
    const kicker = page.locator(".target-bar .tb-kicker");
    await kicker.filter({ hasText: /^Continues$/u }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
  }
  const input = page.locator("#direct-input");
  await input.fill(scenario.prompt);
  assert.equal(await input.inputValue(), scenario.prompt);
  assert.equal(await submit.isDisabled(), false);
  await submit.click();

  const acceptedFeedback = page
    .locator("#direct-input-feedback")
    .filter({ hasText: /durably accepted/iu });
  await acceptedFeedback.waitFor({ state: "visible", timeout: 15_000 });
  console.log(
    `LIVE_USER_JOURNEY_ACCEPTANCE ${JSON.stringify({
      name: scenario.name,
      commandKind: scenario.commandKind,
      accepted: true,
    })}`,
  );

  const userTurn = page.locator(".turn.turn-user").nth(turnIndex);
  await userTurn.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(
    compactText((await userTurn.locator(".user-message-text").textContent()) ?? ""),
    scenario.prompt,
  );
  const agentTurn = page.locator(".turn:not(.turn-user)").nth(turnIndex);
  await agentTurn.waitFor({ state: "visible", timeout: 15_000 });
  await agentTurn
    .locator(".turn-state")
    .filter({ hasText: terminalStatePattern })
    .waitFor({ state: "visible", timeout: 180_000 });

  const renderedTerminalState = compactText(
    (await agentTurn.locator(".turn-state").textContent()) ?? "missing",
  ).toLocaleLowerCase("en-US");
  const terminalState =
    renderedTerminalState === "outcome unknown"
      ? "recovery-required"
      : renderedTerminalState;
  const runtimeText = compactText(
    (await agentTurn.locator(".turn-actor").textContent()) ?? "",
  ).toLocaleLowerCase("en-US");
  const runtimeObserved: UserJourneyRuntime | "missing" =
    runtimeText === "codex"
      ? "codex"
      : runtimeText === "claude"
        ? "claude"
        : "missing";
  const disclosure = agentTurn.getByRole("button", { name: /^\d+ events?\b/u });
  await disclosure.waitFor({ state: "visible", timeout: 5_000 });
  if ((await disclosure.getAttribute("aria-expanded")) !== "true") {
    await disclosure.click();
  }
  const eventList = agentTurn.getByRole("list", {
    name: "Normalized durable events for turn",
  });
  await eventList.waitFor({ state: "visible", timeout: 5_000 });
  const eventKinds = Object.freeze(
    (await eventList.locator(".ev-kind").allTextContents()).map(compactText),
  );
  const replyText = compactText(
    (await agentTurn.locator(".turn-body.prose").innerText()) ?? "",
  );
  const sessionRows = page
    .getByRole("navigation", { name: "Projects and Agent Sessions" })
    .locator(".session-row");
  const agentSessionCount = await sessionRows.count();
  const sessionRowLabel =
    agentSessionCount === 1
      ? compactText((await sessionRows.first().getAttribute("aria-label")) ?? "")
      : "missing-or-ambiguous";
  assert.match(sessionRowLabel, new RegExp(`\\b${scenario.runtime}\\b`, "iu"));
  console.log(
    `LIVE_USER_JOURNEY_TERMINAL ${JSON.stringify({
      name: scenario.name,
      runtimeObserved,
      eventCount: eventKinds.length,
      terminalState,
      replyMatchesExpected: replyText === scenario.expectedReply,
      agentSessionCount,
    })}`,
  );
  return Object.freeze({
    scenario,
    runtimeObserved,
    accepted: true,
    eventKinds,
    terminalState,
    replyText,
    agentSessionCount,
    sessionRowLabel,
    modelLabel: profile.modelLabel,
    effortLabel: profile.effortLabel,
  });
}

async function assertProductionSurface(
  application: ElectronApplication,
  page: Page,
  projectDirectory: string,
  userDataDirectory: string,
): Promise<void> {
  assert.equal(page.url(), expectedRendererUrl);
  const state = await application.evaluate(({ app }) => ({
    cwd: process.cwd(),
    userData: app.getPath("userData"),
    packaged: app.isPackaged,
  }));
  assert.equal(application.windows().length, 1);
  assert.equal(resolve(state.cwd).toLocaleLowerCase("en-US"),
    resolve(projectDirectory).toLocaleLowerCase("en-US"));
  assert.equal(resolve(state.userData).toLocaleLowerCase("en-US"),
    resolve(userDataDirectory).toLocaleLowerCase("en-US"));
  assert.equal(state.packaged, false);
}
