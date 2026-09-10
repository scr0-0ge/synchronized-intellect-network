// Lane w108 — read-only latency measurement of the shipped product.
//
// Isolation, launch, safety assertion and the offscreen precondition are
// borrowed from the w82/w89/w102 walkthroughs already on demo. Every
// conversation here is produced by a local fake: no provider turn is started
// and the owner's store is never opened.
//
// It changes no product code. It only launches `dist/`, drives the real
// surfaces, and times them.
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { _electron } from "playwright";

import { createWorkbenchCoordinator } from "../../src/coordinator/index.ts";

const label = process.env.W108_LABEL ?? "run";
const evidenceDirectory = resolve("test-results/w141", label);
const electronExecutable = createRequire(import.meta.url)("electron");
const repositoryRoot = resolve(".");
const profileParent = process.env.APPDATA;
if (profileParent === undefined) throw new Error("APPDATA is required on Windows");

const root = join(profileParent, "uaw-w141");
const paths = {
  root,
  home: join(root, "h"),
  appData: join(root, "h", "AppData", "Roaming"),
  localAppData: join(root, "h", "AppData", "Local"),
  temp: join(root, "t"),
  userData: join(root, "h", "AppData", "Roaming", "p"),
  runtime: join(root, "r"),
  projects: join(root, "projects"),
};
const dataDirectory = join(paths.userData, "workbench-project-host");
const ledgerDirectory = join(dataDirectory, "project-ledgers");

const longTurns = Number(process.env.W108_LONG_TURNS ?? 60);
const eventsPerTurn = Number(process.env.W108_EVENTS_PER_TURN ?? 24);
const launchSamples = Number(process.env.W108_LAUNCH_SAMPLES ?? 5);
const interactionSamples = Number(process.env.W108_INTERACTION_SAMPLES ?? 7);

const profile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});
const resumeIdentity = Object.freeze({
  schemaVersion: 1,
  endpointId: "codex-desktop",
  nativeProfile: profile,
});
const runtimeContext = Object.freeze({ endpointId: "codex-desktop" });
const longSessionLabel =
  longTurns > 1 ? `Long — ${longTurns} turn conversation` : "Long — session 1";
const shortSessionLabel =
  longTurns > 1 ? "Long — short session" : "Long — session 2";

const projectRecords = [record(1, "Long"), record(2, "Small")];
const result = {
  label,
  baseline: process.env.W108_BASELINE ?? "unknown",
  concurrentLanes: process.env.W108_LANES ?? "unrecorded",
  liveProviderTurns: 0,
  configuration: { longTurns, eventsPerTurn, launchSamples, interactionSamples },
  safety: [],
  fixture: {},
  measurements: {},
};

await mkdir(evidenceDirectory, { recursive: true });
await removeRootWithRetry();
let application;
try {
  await materializeDirectories();
  await prepareFakeRuntime();
  result.fixture.long = await seedProject(projectRecords[0], longTurns);
  result.fixture.small = await seedProject(projectRecords[1], 1, 2);
  for (const entry of projectRecords) addUpdateIndexes(entry.ledgerPath);
  await writeRegistry(projectRecords, projectRecords[0].recordKey);

  // ---- 1. Launch to usable -------------------------------------------------
  result.measurements.launch = [];
  for (let sample = 0; sample < launchSamples; sample += 1) {
    const before = Date.now();
    application = await launchProduct(`launch-${sample + 1}`);
    const windowShown = Date.now();
    const page = application.page;
    await page.waitForFunction(
      () => document.querySelectorAll(".proj.is-open .session-row").length > 0,
      undefined,
      { timeout: 90_000 },
    );
    const railReady = Date.now();
    const navigation = await page.evaluate(() => {
      const entry = performance.getEntriesByType("navigation")[0];
      return entry === undefined
        ? null
        : {
            responseEnd: entry.responseEnd,
            domContentLoaded: entry.domContentLoadedEventEnd,
            loadEnd: entry.loadEventEnd,
            now: performance.now(),
          };
    });
    result.measurements.launch.push({
      sample: sample + 1,
      spawnToFirstWindowMilliseconds: windowShown - before,
      spawnToRailReadyMilliseconds: railReady - before,
      rendererNavigation: navigation,
    });
    if (sample + 1 < launchSamples) {
      await shutdown(application);
      application = undefined;
    }
  }
  const page = application.page;
  await suppressNativeNotifications(application.app);

  // ---- 2. Open a Session ---------------------------------------------------
  const sessionLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".proj.is-open .session-row .sr-title"))
      .map((node) => node.textContent ?? "")
      .filter((text) => text.length > 0),
  );
  result.fixture.railLabels = sessionLabels;
  result.measurements.openSession = {
    longConversation: await repeatInteraction(page, interactionSamples, {
      before: { clickSessionRow: shortSessionLabel },
      click: { sessionRow: longSessionLabel },
      until: { transcriptContains: "LOCAL-W108-Long-TURN-" },
    }),
    shortConversation: await repeatInteraction(page, interactionSamples, {
      before: { clickSessionRow: longSessionLabel },
      click: { sessionRow: shortSessionLabel },
      until: { transcriptContains: "LOCAL-W108-Long-EXTRA-0" },
    }),
  };

  // ---- 3. Switch Project ---------------------------------------------------
  result.measurements.switchProject = {
    longToSmall: await repeatInteraction(page, interactionSamples, {
      before: { clickProject: "Long" },
      click: { project: "Small" },
      until: { selectedProject: "Small" },
    }),
    smallToLong: await repeatInteraction(page, interactionSamples, {
      before: { clickProject: "Small" },
      click: { project: "Long" },
      until: { selectedProject: "Long" },
    }),
  };

  // ---- 4. Open Settings ----------------------------------------------------
  await clickProject(page, "Long");
  await clickSessionRow(page, longSessionLabel);
  result.measurements.openSettings = await repeatInteraction(
    page,
    interactionSamples,
    {
      before: { closeSettings: true },
      click: { settings: true },
      until: { settingsVisible: true },
    },
  );
  result.measurements.closeSettings = await repeatInteraction(
    page,
    interactionSamples,
    {
      before: { openSettings: true },
      click: { closeSettings: true },
      until: { settingsHidden: true },
    },
  );

  // ---- 5. Scroll a long conversation --------------------------------------
  await closeSettingsIfOpen(page);
  await clickSessionRow(page, longSessionLabel);
  result.measurements.scroll = {
    long: await measureScroll(page),
  };
  await clickSessionRow(page, shortSessionLabel);
  result.measurements.scroll.short = await measureScroll(page);

  // ---- 6. Send a message ---------------------------------------------------
  result.measurements.send = {};
  await clickProject(page, "Small");
  await clickSessionRow(page, "Small — session 1");
  result.measurements.send.shortConversation = await measureSend(page, "small");
  await clickProject(page, "Long");
  await clickSessionRow(page, longSessionLabel);
  result.measurements.send.longConversation = await measureSend(page, "long");

  result.measurements.domScale = await page.evaluate(() => ({
    documentNodes: document.querySelectorAll("*").length,
    transcriptNodes:
      document.querySelector(".transcript")?.querySelectorAll("*").length ?? 0,
    transcriptScrollHeight:
      document.querySelector(".transcript")?.scrollHeight ?? 0,
  }));
} finally {
  await shutdown(application);
  await writeFile(
    join(evidenceDirectory, "latency.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  ).catch(() => undefined);
  if (process.env.W108_KEEP_ROOT !== "1") {
    await removeRootWithRetry().catch((error) =>
      console.error("W108_CLEANUP_FAILED", error),
    );
  }
}
console.log(summarize(result));

// --------------------------------------------------------------------------
// Interaction timing. The whole measurement runs inside the page so a frame
// boundary, not a CDP round trip, bounds the resolution. `firstChange` is when
// the surface first moves at all ("looks like it reacted"); `settled` is when
// the destination state is actually there.
// --------------------------------------------------------------------------

async function repeatInteraction(page, samples, plan) {
  const observations = [];
  let retries = 0;
  for (let sample = 0; sample < samples + 1; sample += 1) {
    await applyPrelude(page, plan.before);
    // A non-current Project's disclosure control is `disabled` while any other
    // action is pending, and a click on a disabled button is simply dropped.
    // Waiting for it here keeps that gate out of the measured window; it is
    // reported separately.
    await waitForEnabledTarget(page, plan.click);
    const observation = await timeInteraction(page, plan.click, plan.until);
    // The first pass is warm-up: it pays the one-time raster and code paths
    // the owner only meets once per launch.
    if (sample === 0) continue;
    if (observation.reached !== true && retries < 3) {
      retries += 1;
      sample -= 1;
      continue;
    }
    observations.push(observation);
  }
  return { ...summarizeSamples(observations), retries };
}

async function waitForEnabledTarget(page, click) {
  await page
    .waitForFunction(
      (plan) => {
        const target =
          plan.sessionRow !== undefined
            ? Array.from(document.querySelectorAll(".proj .session-row")).find(
                (row) =>
                  row.querySelector(".sr-title")?.textContent === plan.sessionRow,
              )
            : plan.project !== undefined
              ? Array.from(document.querySelectorAll(".proj"))
                  .find(
                    (node) =>
                      node.querySelector(".proj-name")?.textContent ===
                      plan.project,
                  )
                  ?.querySelector(".project-switch-trigger")
              : plan.settings === true
                ? document.querySelector(".settings-rail-button")
                : document.querySelector("main.settings button");
        return target !== undefined && target !== null && !target.disabled;
      },
      click,
      { timeout: 30_000 },
    )
    .catch(() => undefined);
}

async function applyPrelude(page, before) {
  if (before === undefined) return;
  if (before.clickSessionRow !== undefined) {
    await clickSessionRow(page, before.clickSessionRow);
  }
  if (before.clickProject !== undefined) await clickProject(page, before.clickProject);
  if (before.openSettings === true) await openSettings(page);
  if (before.closeSettings === true) await closeSettingsIfOpen(page);
}

async function timeInteraction(page, click, until) {
  return page.evaluate(
    async ({ click: clickPlan, until: untilPlan }) => {
      const findSessionRow = (text) =>
        Array.from(document.querySelectorAll(".proj .session-row")).find(
          (row) => row.querySelector(".sr-title")?.textContent === text,
        );
      const findProjectToggle = (text) =>
        Array.from(document.querySelectorAll(".proj"))
          .find((node) => node.querySelector(".proj-name")?.textContent === text)
          ?.querySelector(".project-switch-trigger");
      const transcriptTurns = () =>
        document.querySelectorAll(".transcript article").length;
      const done = () => {
        // The transcript renders a window, not the whole conversation, so the
        // completion signal is "the newest turn of the target Session is on
        // screen", not an article count.
        if (untilPlan.transcriptContains !== undefined) {
          return (
            document
              .querySelector(".transcript")
              ?.textContent?.includes(untilPlan.transcriptContains) === true
          );
        }
        if (untilPlan.selectedProject !== undefined) {
          return (
            document.querySelector(".proj.is-open .proj-name")?.textContent ===
              untilPlan.selectedProject &&
            document.querySelectorAll(".proj.is-open .session-row").length > 0
          );
        }
        if (untilPlan.settingsVisible === true) {
          return document.querySelector("main.settings") !== null;
        }
        if (untilPlan.settingsHidden === true) {
          return document.querySelector("main.settings") === null;
        }
        return false;
      };
      if (
        clickPlan.project !== undefined &&
        document.querySelector(".proj.is-open .proj-name")?.textContent ===
          clickPlan.project
      ) {
        return { error: `already-current:${clickPlan.project}` };
      }
      const target =
        clickPlan.sessionRow !== undefined
          ? findSessionRow(clickPlan.sessionRow)
          : clickPlan.project !== undefined
            ? findProjectToggle(clickPlan.project)
            : clickPlan.settings === true
              ? document.querySelector(".settings-rail-button")
              : document.querySelector("main.settings button");
      if (target === undefined || target === null) {
        return { error: `target-missing:${JSON.stringify(clickPlan)}` };
      }
      let firstChange = null;
      const observer = new MutationObserver(() => {
        firstChange ??= performance.now();
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      const started = performance.now();
      target.click();
      const deadline = started + 20_000;
      while (!done() && performance.now() < deadline) {
        await new Promise((wake) => requestAnimationFrame(wake));
      }
      const settled = performance.now();
      // Two frames so the paint that satisfies `done` has been committed.
      await new Promise((wake) =>
        requestAnimationFrame(() => requestAnimationFrame(wake)),
      );
      const painted = performance.now();
      observer.disconnect();
      const reached = done();
      return {
        firstChangeMilliseconds:
          firstChange === null ? null : round(firstChange - started),
        settledMilliseconds: round(settled - started),
        paintedMilliseconds: round(painted - started),
        reached,
        ...(reached
          ? {}
          : {
              diagnosis: {
                selectedProject:
                  document.querySelector(".proj.is-open .proj-name")
                    ?.textContent ?? null,
                openRows: document.querySelectorAll(
                  ".proj.is-open .session-row",
                ).length,
                transcriptTurns: transcriptTurns(),
                transcriptHead:
                  document.querySelector(".transcript")?.textContent?.slice(0, 200) ??
                  null,
                settingsPresent:
                  document.querySelector("main.settings") !== null,
                feedback: Array.from(
                  document.querySelectorAll("[role='alert'], [role='status']"),
                )
                  .map((node) => node.textContent?.trim())
                  .filter(Boolean),
              },
            }),
      };
      function round(value) {
        return Math.round(value * 10) / 10;
      }
    },
    { click, until },
  );
}

async function measureScroll(page) {
  return page.evaluate(async () => {
    const transcript = document.querySelector(".transcript");
    if (transcript === null) return { error: "no-transcript" };
    transcript.scrollTop = 0;
    await new Promise((wake) => requestAnimationFrame(wake));
    const frames = [];
    const step = Math.max(
      120,
      Math.floor(transcript.scrollHeight / 90),
    );
    let previous = performance.now();
    for (let index = 0; index < 90; index += 1) {
      transcript.scrollTop = Math.min(
        transcript.scrollTop + step,
        transcript.scrollHeight,
      );
      await new Promise((wake) => requestAnimationFrame(wake));
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
    }
    const sorted = [...frames].sort((left, right) => left - right);
    const at = (fraction) =>
      Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] * 10) /
      10;
    return {
      scrollHeight: transcript.scrollHeight,
      frames: frames.length,
      medianMilliseconds: at(0.5),
      p95Milliseconds: at(0.95),
      maxMilliseconds: Math.round(sorted.at(-1) * 10) / 10,
      over16_7: frames.filter((frame) => frame > 16.7).length,
      over50: frames.filter((frame) => frame > 50).length,
    };
  });
}

// Sending is measured on a NEW Agent Session started through the same IPC the
// composer's Send button calls (`submitDirectInput`), not through the button
// itself: in this fixture the composer's own chips never auto-complete a
// selection from a hand-written catalog, so the button stays disabled. The
// measured path is therefore preload -> IPC -> coordinator -> live view ->
// IPC -> render, i.e. everything except the composer's local click handling.
// A NEW Session in the long Project still pays the full Project read cost,
// because a snapshot spans every command in the Project, not just the Session.
async function measureSend(page, tag) {
  const observations = [];
  let selection;
  for (let sample = 0; sample < 3; sample += 1) {
    // A snapshot key is single-use, so the catalog is re-read per submission.
    selection = await loadLocalRuntimeProfile(page);
    if (selection.request === undefined) {
      observations.push({ error: "no-catalog-selection", selection });
      continue;
    }
    const message = `LOCAL-W108-${tag.toUpperCase()}-SEND-${sample + 1}`;
    const observation = await page.evaluate(
      async ({ message: text, request }) => {
        // The rail row is the surface the owner actually watches: the new
        // Session appears there labelled by what he typed, then its status
        // moves to Completed when the reply lands.
        const row = () =>
          Array.from(
            document.querySelectorAll(".proj.is-open .session-row"),
          ).find(
            (candidate) =>
              candidate.querySelector(".sr-title")?.textContent === text,
          );
        const rowStatus = () =>
          row()?.querySelector(".st")?.getAttribute("aria-label") ?? null;
        let firstChange = null;
        const observer = new MutationObserver(() => {
          firstChange ??= performance.now();
        });
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const started = performance.now();
        const accepted = await window.workbench.submitDirectInput({
          kind: "start",
          input: text,
          ...request,
        });
        const acknowledgedAt = performance.now();
        const echoed = await waitFor(() => row() !== undefined, started + 30_000);
        const echoedAt = performance.now();
        const replied = await waitFor(
          () => rowStatus() === "Completed",
          started + 60_000,
        );
        const repliedAt = performance.now();
        observer.disconnect();
        return {
          submissionStatus: accepted?.ok === true ? accepted.status : JSON.stringify(accepted),
          firstChangeMilliseconds:
            firstChange === null ? null : round(firstChange - started),
          acknowledgedMilliseconds: round(acknowledgedAt - started),
          ownTurnVisibleMilliseconds: round(echoedAt - started),
          replyVisibleMilliseconds: round(repliedAt - started),
          echoed,
          replied,
          finalRowStatus: rowStatus(),
        };
        function round(value) {
          return Math.round(value * 10) / 10;
        }
        async function waitFor(predicate, deadline) {
          while (performance.now() < deadline) {
            if (predicate()) return true;
            await new Promise((wake) => requestAnimationFrame(wake));
          }
          return false;
        }
      },
      { message, request: selection.request },
    );
    observations.push(observation);
    await page.waitForTimeout(400);
  }
  return { selectionDetail: selection, observations };
}

function summarizeSamples(observations) {
  const numbers = (key) =>
    observations
      .map((observation) => observation[key])
      .filter((value) => typeof value === "number");
  const stat = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return {
      samples: sorted.length,
      median:
        Math.round(
          (sorted.length % 2 === 0
            ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
            : sorted[(sorted.length - 1) / 2]) * 10,
        ) / 10,
      min: sorted[0],
      max: sorted.at(-1),
    };
  };
  return {
    firstChange: stat(numbers("firstChangeMilliseconds")),
    settled: stat(numbers("settledMilliseconds")),
    painted: stat(numbers("paintedMilliseconds")),
    reachedAll: observations.every((observation) => observation.reached === true),
    raw: observations,
  };
}

function summarize(observations) {
  const line = (name, value) =>
    value === null || value === undefined
      ? `${name}: n/a`
      : `${name}: median ${value.median} ms (min ${value.min}, max ${value.max})`;
  const parts = [`\n=== w108 ${observations.label} ===`];
  const launches = observations.measurements.launch ?? [];
  if (launches.length > 0) {
    const rail = launches.map((entry) => entry.spawnToRailReadyMilliseconds);
    parts.push(
      `launch to rail ready: ${rail.join(", ")} ms (n=${rail.length})`,
    );
  }
  for (const [group, value] of Object.entries(observations.measurements)) {
    if (group === "launch" || value === null || typeof value !== "object") continue;
    if (value.settled !== undefined) {
      parts.push(`${group} — ${line("settled", value.settled)}`);
      parts.push(`${group} — ${line("firstChange", value.firstChange)}`);
      continue;
    }
    for (const [name, inner] of Object.entries(value)) {
      if (inner === null || typeof inner !== "object") continue;
      if (inner.settled !== undefined) {
        parts.push(`${group}.${name} — ${line("settled", inner.settled)}`);
        parts.push(`${group}.${name} — ${line("firstChange", inner.firstChange)}`);
      } else {
        parts.push(`${group}.${name} — ${JSON.stringify(inner)}`);
      }
    }
  }
  return parts.join("\n");
}

// --------------------------------------------------------------------------
// Fixture, isolation and launch.
// --------------------------------------------------------------------------

function record(ordinal, name) {
  const suffix = String(ordinal).padStart(12, "0");
  return {
    name,
    directory: join(root, "projects", name),
    recordKey: `project-record-v1-00000000-0000-4000-8000-${suffix}`,
    ledgerSlot: `project-ledger-v1-00000000-0000-4000-8000-${suffix}`,
    ledgerPath: join(
      ledgerDirectory,
      `project-ledger-v1-00000000-0000-4000-8000-${suffix}.sqlite`,
    ),
  };
}

async function materializeDirectories() {
  for (const directory of [
    paths.home,
    paths.appData,
    paths.localAppData,
    paths.temp,
    paths.userData,
    paths.runtime,
    paths.projects,
    dataDirectory,
    ledgerDirectory,
    ...projectRecords.map((entry) => entry.directory),
  ]) {
    await mkdir(directory, { recursive: true });
  }
}

// A function declaration, not a class: the seeding call sites run in the
// top-level await above this point, where a `class` binding is still in its
// temporal dead zone.
function createOfflineSeedAdapter() {
  const binding = (reference) => ({
    profile,
    opaqueSessionReference: reference,
    async send() {},
    async *events() {
      yield { kind: "session-started" };
      yield { kind: "turn-started" };
      yield { kind: "item-started", itemType: "agent-message" };
      for (let index = 0; index < eventsPerTurn; index += 1) {
        yield {
          kind: "agent-message",
          text: `w108 seeded reply chunk ${index} ${"x".repeat(400)}`,
        };
      }
      yield { kind: "item-completed", itemType: "agent-message" };
      yield { kind: "turn-completed", status: "completed" };
    },
  });
  return {
    async inspect() {
      return {
        runtime: "codex",
        models: [{ id: profile.model, effortLevels: ["ultra"] }],
        executionModes: ["single-agent"],
        accessModes: ["full-access"],
      };
    },
    async start() {
      return binding("w108-offline-thread");
    },
    async resume(request) {
      return binding(request.opaqueSessionReference);
    },
  };
}

async function seedProject(entry, turns, extraSessions = 1) {
  const channel = await createWorkbenchCoordinator({
    databasePath: entry.ledgerPath,
    adapter: createOfflineSeedAdapter(),
  }).openProject(entry.directory);
  const seeded = [];
  try {
    let sessionId;
    for (let turn = 1; turn <= turns; turn += 1) {
      const command =
        turn === 1
          ? startCommand(`${entry.name}-main`, `LOCAL-W108-${entry.name}-TURN-1`)
          : continueCommand(
              `${entry.name}-main-${turn}`,
              sessionId,
              `LOCAL-W108-${entry.name}-TURN-${turn}`,
            );
      const terminal = await runCommand(channel, command, entry.ledgerPath);
      sessionId ??= terminal.session.sessionId;
    }
    await channel.mutateSessionMetadata({
      sessionId,
      operation: {
        kind: "rename",
        displayName:
          turns > 1 ? `${entry.name} — ${turns} turn conversation` : `${entry.name} — session 1`,
      },
    });
    seeded.push({ displayName: `main`, turns });
    for (let extra = 0; extra < extraSessions; extra += 1) {
      const terminal = await runCommand(
        channel,
        startCommand(
          `${entry.name}-extra-${extra}`,
          `LOCAL-W108-${entry.name}-EXTRA-${extra}`,
        ),
        entry.ledgerPath,
      );
      await channel.mutateSessionMetadata({
        sessionId: terminal.session.sessionId,
        operation: {
          kind: "rename",
          displayName:
            turns > 1
              ? `${entry.name} — short session`
              : `${entry.name} — session ${extra + 2}`,
        },
      });
      seeded.push({ displayName: `extra-${extra}`, turns: 1 });
    }
    const snapshot = await channel.snapshot();
    return { project: entry.name, seeded, commands: snapshot.commands.length };
  } finally {
    await channel.close();
  }
}

function startCommand(key, input) {
  return {
    kind: "direct",
    commandKind: "start",
    idempotencyKey: `w108-${key}`,
    runtime: "codex",
    catalogRevision: "w108-local-fake-catalog",
    preferences: { global: profile },
    profile,
    runtimeResumeIdentity: resumeIdentity,
    input,
  };
}

function continueCommand(key, targetSessionId, input) {
  return {
    kind: "direct",
    commandKind: "continue",
    idempotencyKey: `w108-${key}`,
    runtime: "codex",
    targetSessionId,
    profile,
    runtimeResumeIdentity: resumeIdentity,
    input,
  };
}

// Terminal detection reads the ledger directly. Polling `channel.snapshot()`
// would make seeding pay the very O(whole Project) read this lane is measuring,
// which turns a three-minute fixture into a twenty-minute one.
async function runCommand(channel, command, ledgerPath) {
  const receipt = await channel.act(command, runtimeContext);
  for (let attempt = 0; attempt < 20_000; attempt += 1) {
    const row = readCommandRow(ledgerPath, receipt.commandId);
    if (row?.status === "completed") {
      return { status: row.status, session: { sessionId: row.target_session_id } };
    }
    if (row !== undefined && ["failed", "recovery-required"].includes(row.status)) {
      throw new Error(`offline seed did not complete: ${row.status}`);
    }
    await new Promise((wake) => setTimeout(wake, 2));
  }
  throw new Error("offline seed timed out");
}

function readCommandRow(ledgerPath, commandId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const database = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      return database
        .prepare(
          "SELECT status, target_session_id FROM commands WHERE command_id = ?",
        )
        .get(commandId);
    } catch (error) {
      if (!/busy|locked/iu.test(String(error?.message))) throw error;
    } finally {
      database.close();
    }
  }
  throw new Error("ledger stayed busy");
}

async function writeRegistry(records, selectedRecordKey) {
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: records.length,
      nextProjectOrdinal: records.length + 1,
      selectedRecordKey,
      records: records.map((entry) => ({
        recordKey: entry.recordKey,
        canonicalDirectory: entry.directory,
        ledgerSlot: entry.ledgerSlot,
      })),
    })}\n`,
  );
}

function addUpdateIndexes(ledgerPath) {
  const database = new DatabaseSync(ledgerPath);
  try {
    database.exec(`
      CREATE INDEX IF NOT EXISTS updates_command_kind_cursor
        ON updates(command_id, kind, cursor);
      CREATE INDEX IF NOT EXISTS updates_project_session_kind
        ON updates(project_id, session_id, kind);
    `);
  } finally {
    database.close();
  }
}

async function prepareFakeRuntime() {
  await copyFile(process.execPath, join(paths.runtime, "codex.exe"));
  await writeFile(join(paths.root, "app-server"), fakeRuntimeSource());
}

function fakeRuntimeSource() {
  return String.raw`"use strict";
const readline = require("node:readline");
const threadId = "w108-live-thread";
let turn = 0;
function emit(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function respond(message, value) { emit({jsonrpc:"2.0", id:message.id, result:value}); }
const reader = readline.createInterface({input: process.stdin});
reader.on("line", (line) => {
  if (line.trim().length === 0) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  switch (message.method) {
    case "initialize": respond(message, {server:"w108-local-fake"}); return;
    case "initialized": return;
    case "account/read": respond(message, {account:{type:"chatgpt"},requiresOpenaiAuth:true}); return;
    case "model/list": respond(message, {data:[{id:"gpt-5.6-sol",model:"gpt-5.6-sol",displayName:"GPT-5.6-Sol",supportedReasoningEfforts:[{reasoningEffort:"ultra",description:"Ultra"}]}],nextCursor:null}); return;
    case "thread/start":
    case "thread/resume":
      respond(message, {thread:{id:threadId},model:"gpt-5.6-sol",reasoningEffort:"ultra",approvalPolicy:"never",sandbox:{type:"dangerFullAccess"}});
      emit({jsonrpc:"2.0",method:"thread/started",params:{thread:{id:threadId}}});
      return;
    case "turn/start": {
      turn += 1;
      const turnId = "w108-turn-" + turn;
      const itemId = "w108-item-" + turn;
      respond(message, {turn:{id:turnId,status:"inProgress"}});
      emit({jsonrpc:"2.0",method:"turn/started",params:{threadId,turn:{id:turnId,status:"inProgress"}}});
      emit({jsonrpc:"2.0",method:"item/started",params:{threadId,turnId,item:{id:itemId,type:"agentMessage"}}});
      emit({jsonrpc:"2.0",method:"item/completed",params:{threadId,turnId,item:{id:itemId,type:"agentMessage",text:"w108 local fake reply " + turn}}});
      emit({jsonrpc:"2.0",method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed"}}});
      return;
    }
    default: return;
  }
});
`;
}

async function launchProduct(launchLabel) {
  const logPath = join(evidenceDirectory, `${launchLabel}-electron.log`);
  await writeFile(logPath, "");
  // Every main-process line is stamped with milliseconds since spawn. The gap
  // between spawn and `[window-placement]` is the whole pre-window startup:
  // there is no earlier surface to attribute it against.
  const spawnedAt = Date.now();
  const stamp = (bytes) =>
    void appendFile(
      logPath,
      String(bytes)
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
        .map(
          (line) =>
            `+${String(Date.now() - spawnedAt).padStart(6)}ms ${line}\n`,
        )
        .join(""),
    );
  const app = await _electron.launch({
    executablePath: electronExecutable,
    args: [
      repositoryRoot,
      `--user-data-dir=${paths.userData}`,
      "--window-placement=offscreen",
    ],
    cwd: paths.root,
    env: sanitizedEnvironment(),
    timeout: 120_000,
  });
  app.process().stdout?.on("data", stamp);
  app.process().stderr?.on("data", stamp);
  const page = await app.firstWindow({ timeout: 120_000 });
  await page.waitForLoadState("domcontentloaded");
  page.setDefaultTimeout(60_000);
  const safety = await app.evaluate(
    ({ app: electronApp, BrowserWindow, screen }, name) => ({
      launch: name,
      userData: electronApp.getPath("userData"),
      appData: electronApp.getPath("appData"),
      home: electronApp.getPath("home"),
      windows: BrowserWindow.getAllWindows().map((window) => ({
        bounds: window.getBounds(),
        focusable: window.isFocusable(),
        focused: window.isFocused(),
        visible: window.isVisible(),
      })),
      displays: screen.getAllDisplays().map((display) => display.bounds),
    }),
    launchLabel,
  );
  const unsafe =
    safety.userData.toLocaleLowerCase("en-US") !==
      paths.userData.toLocaleLowerCase("en-US") ||
    safety.windows.some(
      (window) =>
        window.focusable ||
        window.focused ||
        safety.displays.some((display) =>
          rectanglesIntersect(window.bounds, display),
        ),
    );
  if (unsafe) {
    await app.close();
    throw new Error(`isolated offscreen precondition failed: ${JSON.stringify(safety)}`);
  }
  result.safety.push(safety);
  return { app, page };
}

function sanitizedEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      !/^(PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)$/iu.test(key) &&
      !/(ANTHROPIC|CLAUDE|CODEX|OPENAI|GLM|KIMI|MOONSHOT|DEEPSEEK|ZHIPU|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PASSWORD|SECRET|TOKEN)$/iu.test(key)
    ) {
      environment[key] = value;
    }
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  Object.assign(environment, {
    PATH: `${paths.runtime};${join(systemRoot, "System32")}`,
    HOME: paths.home,
    USERPROFILE: paths.home,
    HOMEDRIVE: parse(paths.home).root.slice(0, 2),
    HOMEPATH: paths.home.slice(2),
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
    CODEX_HOME: join(paths.root, "codex-home"),
    CLAUDE_CONFIG_DIR: join(paths.root, "claude-home"),
  });
  return environment;
}

async function suppressNativeNotifications(app) {
  await app.evaluate(({ Notification }) => {
    globalThis.__w108Notifications = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function () {
      globalThis.__w108Notifications.push(this);
    };
  });
}

async function loadLocalRuntimeProfile(page) {
  return page.evaluate(async () => {
    const loaded = await window.workbench.loadDirectSessionProfile({
      kind: "catalog-default",
    });
    if (!loaded.ok) return { error: JSON.stringify(loaded) };
    const endpoint = loaded.profile.endpoints.find(
      (candidate) => candidate.endpointId === "codex-desktop",
    );
    const model = endpoint?.models[0];
    return {
      snapshotKey: loaded.profile.snapshotKey,
      endpointKey: endpoint?.key,
      modelKey: model?.key,
      request:
        endpoint === undefined || model === undefined
          ? undefined
          : {
              snapshotKey: loaded.profile.snapshotKey,
              endpointKey: endpoint.key,
              modelKey: model.key,
              workIntensityKey: model.workIntensities[0]?.key,
              executionModeKey: endpoint.executionModes[0]?.key,
              accessModeKey: endpoint.accessModes[0]?.key,
            },
    };
  });
}

async function clickSessionRow(page, text) {
  await page.evaluate((label_) => {
    const row = Array.from(document.querySelectorAll(".proj .session-row")).find(
      (candidate) => candidate.querySelector(".sr-title")?.textContent === label_,
    );
    row?.click();
  }, text);
  await page.waitForFunction(
    (label_) =>
      document.querySelector(
        ".proj.is-open .session-row[aria-current='true'] .sr-title",
      )?.textContent === label_,
    text,
    { timeout: 60_000 },
  );
}

async function clickProject(page, name) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const settled = await page.evaluate((label_) => {
      const current = document.querySelector(".proj.is-open");
      const selected =
        current?.querySelector(".proj-name")?.textContent === label_;
      const expanded =
        selected && current.querySelectorAll(".session-row").length > 0;
      if (expanded) return true;
      if (selected) {
        current?.querySelector(".proj-toggle")?.click();
      } else {
        Array.from(document.querySelectorAll(".proj"))
          .find(
            (node) => node.querySelector(".proj-name")?.textContent === label_,
          )
          ?.querySelector(".project-switch-trigger")
          ?.click();
      }
      return false;
    }, name);
    if (settled) return;
    await page
      .waitForFunction(
        (label_) =>
          document.querySelector(".proj.is-open .proj-name")?.textContent ===
            label_ &&
          document.querySelectorAll(".proj.is-open .session-row").length > 0,
        name,
        { timeout: 30_000 },
      )
      .catch(() => undefined);
  }
  await page.waitForFunction(
    (label_) =>
      document.querySelector(".proj.is-open .proj-name")?.textContent === label_ &&
      document.querySelectorAll(".proj.is-open .session-row").length > 0,
    name,
    { timeout: 30_000 },
  );
}

async function openSettings(page) {
  await page.evaluate(() => {
    if (document.querySelector("main.settings") === null) {
      document.querySelector(".settings-rail-button")?.click();
    }
  });
  await page.waitForFunction(
    () => document.querySelector("main.settings") !== null,
    undefined,
    { timeout: 60_000 },
  );
}

async function closeSettingsIfOpen(page) {
  await page.evaluate(() => {
    const settings = document.querySelector("main.settings");
    if (settings !== null) settings.querySelector("button")?.click();
  });
  await page.waitForFunction(
    () => document.querySelector("main.settings") === null,
    undefined,
    { timeout: 60_000 },
  );
}

// `app.close()` has been observed to return while the Electron processes stay
// alive and keep the isolated root locked, which then wedges cleanup. Kill the
// tree once close has had its chance.
async function shutdown(instance) {
  if (instance === undefined) return;
  const process_ = instance.app.process();
  await Promise.race([
    instance.app.close().catch(() => undefined),
    new Promise((wake) => setTimeout(wake, 20_000)),
  ]);
  try {
    if (process_.exitCode === null && process_.pid !== undefined) {
      const { execFileSync } = await import("node:child_process");
      execFileSync("taskkill", ["/PID", String(process_.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    }
  } catch {
    // Already gone.
  }
  await new Promise((wake) => setTimeout(wake, 750));
}

async function removeRootWithRetry() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      await new Promise((wake) => setTimeout(wake, 250));
    }
  }
  throw lastError;
}

function rectanglesIntersect(left, right) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

void readFile;
