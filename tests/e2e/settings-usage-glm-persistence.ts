import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  firstDomContentLoadedWindow,
  launchProductionElectron,
  productionElectronArguments,
  resolveProductionElectronComposition,
} from "./harness/production-electron.ts";
import { createWorkbenchAppearancePreferenceStore } from "../../src/workbench-shell/appearance-preference-store.ts";
import { createProductionGlmRuntimeAdapter } from "../../src/workbench-shell/runtime-endpoint-composition.ts";
import { QuotaReplayTransport, quotaFrames, quotaProfile } from "../agent-runtime/fixtures/claude-quota-replay.ts";
import type { WorkbenchUsageObservation } from "../../src/workbench-shell/contract.ts";

/**
 * w234 follow-up (owner acceptance criterion): in a real, offscreen, isolated
 * production Electron process, the Settings "Usage & resets" card's GLM row
 * shows a reset time, and it survives an app restart.
 *
 * This does not drive a live turn inside the launched Electron process --
 * there is no precedent anywhere in this suite for faking a real CLI
 * subprocess's wire protocol under a real Electron main process (checked;
 * every existing provider-session test either fakes at the adapter/transport
 * seam with no real process, or is a genuine live test requiring real
 * credentials). Building that novel low-level protocol harness blind, with
 * no way to visually debug a live window from this shell, was judged
 * disproportionate to what it would additionally prove.
 *
 * Instead: the GLM observation is produced by the exact same real production
 * path already proven offline in runtime-endpoint-composition-usage.test.ts
 * (createProductionGlmRuntimeAdapter + the real 429-text parser in
 * claude/session.ts, replaying the real captured wire fixture), then written
 * to the isolated user-data-dir's preference file through the same real
 * store function (saveUsageObservation) production code calls -- before
 * Electron ever launches, the same way this file's sibling
 * settings-appearance-persistence.ts pre-seeds a project registry. What a
 * real Electron window is used for here is exactly what a fake CLI process
 * could not additionally prove: that the real IPC channel, the real preload
 * bridge, and the real renderer bundle (not SSR) read and render that
 * persisted observation correctly, and that it survives an actual app
 * restart.
 */

const productionElectron = resolveProductionElectronComposition(import.meta.url);
const routineRootPrefix = "workbench-usage-glm-";

async function realGlmObservation(): Promise<WorkbenchUsageObservation> {
  let observation: WorkbenchUsageObservation | undefined;
  const adapter = createProductionGlmRuntimeAdapter({
    environment: {},
    claudePermissionHandling: { readPermissionMode: async () => "manual" },
    createSessionTransport: async () => new QuotaReplayTransport(quotaFrames),
    resolveStaticCatalogAugmentation: () => [{ id: quotaProfile.model, effortLevels: [quotaProfile.effortLevel] }],
    observeUsage: value => { observation = value; },
  });
  const binding = await adapter.start({ projectDirectory: "offline-project", profile: quotaProfile });
  await binding.send({ text: "offline initial input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  assert.equal(events.at(-1)?.kind, "turn-paused", "fixture must reach the GLM exhaustion-message branch");
  assert.ok(observation !== undefined, "the real GLM 429-text branch must have fired observeUsage");
  return observation;
}

function isolatedEnvironment(paths: {
  readonly isolatedHome: string;
  readonly isolatedAppData: string;
  readonly isolatedLocalAppData: string;
  readonly isolatedPath: string;
  readonly isolatedTemp: string;
}): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  for (const key of Object.keys(environment)) {
    if ([
      "path", "home", "userprofile", "homedrive", "homepath", "appdata", "localappdata",
      "temp", "tmp", "tmpdir", "electron_run_as_node", "node_options", "node_path",
    ].includes(key.toLocaleLowerCase("en-US"))) delete environment[key];
  }
  environment.PATH = paths.isolatedPath;
  environment.HOME = paths.isolatedHome;
  environment.USERPROFILE = paths.isolatedHome;
  environment.APPDATA = paths.isolatedAppData;
  environment.LOCALAPPDATA = paths.isolatedLocalAppData;
  environment.TEMP = paths.isolatedTemp;
  environment.TMP = paths.isolatedTemp;
  environment.TMPDIR = paths.isolatedTemp;
  return environment;
}

async function main(): Promise<void> {
  let step = "initialization";
  let root = "";
  const liveApplications: { close(): Promise<unknown> }[] = [];
  try {
    step = "isolated-root";
    const base = await realpath(resolve(tmpdir()));
    root = await mkdtemp(join(base, routineRootPrefix));
    const userData = join(root, "user-data");
    const paths = {
      isolatedHome: join(root, "home"),
      isolatedAppData: join(root, "app-data"),
      isolatedLocalAppData: join(root, "local-app-data"),
      isolatedPath: join(root, "empty-path"),
      isolatedTemp: join(root, "temp"),
    };
    await Promise.all([userData, ...Object.values(paths)].map(path => mkdir(path, { recursive: true })));
    const env = isolatedEnvironment(paths);

    step = "compute-real-glm-observation";
    const glmObservation = await realGlmObservation();

    step = "seed-preference-store";
    const preferenceFilePath = join(userData, "workbench-appearance-preferences-v1.json");
    const seedStore = createWorkbenchAppearancePreferenceStore({ filePath: preferenceFilePath });
    await seedStore.saveUsageObservation(glmObservation);
    assert.deepEqual(await seedStore.readUsageObservations(), { glm: glmObservation });
    await seedStore.close();

    const expectedDate = new Intl.DateTimeFormat("en", {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    }).format(glmObservation.windows[0]!.resetsAt);

    step = "first-launch";
    const first = await launchProductionElectron(productionElectron, {
      args: productionElectronArguments(productionElectron, userData),
      cwd: root,
      env,
      timeout: 20_000,
    });
    liveApplications.push(first);
    const firstPage = await firstDomContentLoadedWindow(first, 15_000);
    await firstPage.getByRole("button", { name: "Settings", exact: true }).waitFor({ state: "visible", timeout: 15_000 });

    step = "first-launch/open-settings";
    await firstPage.getByRole("button", { name: "Settings", exact: true }).click();
    await firstPage.locator("main.settings").waitFor({ state: "visible", timeout: 15_000 });

    step = "first-launch/usage-card";
    await firstPage.locator("#usage-title").waitFor({ state: "visible", timeout: 15_000 });
    const firstUsageText = (await firstPage.locator("section:has(#usage-title)").innerText()).replace(/\s+/gu, " ");
    assert.match(firstUsageText, /GLM/u);
    assert.match(firstUsageText, /Quota window: Resets at/u);
    assert.ok(firstUsageText.includes(expectedDate), `expected "${expectedDate}" in: ${firstUsageText}`);
    assert.doesNotMatch(firstUsageText.split("GLM")[1]!.split(/Codex|Claude|DeepSeek|Kimi/u)[0]!, /%/u, "GLM row must not show a percentage");
    assert.match(firstUsageText, /Codex[\s\S]*This provider's CLI does not report usage/u);

    step = "first-close";
    await first.close();
    liveApplications.pop();

    step = "restart-preserves-store";
    assert.deepEqual(
      JSON.parse(await readFile(preferenceFilePath, "utf8")).usageObservations,
      { glm: glmObservation },
    );

    step = "second-launch";
    const second = await launchProductionElectron(productionElectron, {
      args: productionElectronArguments(productionElectron, userData),
      cwd: root,
      env,
      timeout: 20_000,
    });
    liveApplications.push(second);
    const secondPage = await firstDomContentLoadedWindow(second, 15_000);
    await secondPage.getByRole("button", { name: "Settings", exact: true }).waitFor({ state: "visible", timeout: 15_000 });

    step = "second-launch/open-settings";
    await secondPage.getByRole("button", { name: "Settings", exact: true }).click();
    await secondPage.locator("main.settings").waitFor({ state: "visible", timeout: 15_000 });

    step = "second-launch/usage-card-survives-restart";
    await secondPage.locator("#usage-title").waitFor({ state: "visible", timeout: 15_000 });
    const secondUsageText = (await secondPage.locator("section:has(#usage-title)").innerText()).replace(/\s+/gu, " ");
    assert.equal(secondUsageText, firstUsageText, "the same observation, read from disk, renders identically after restart");

    step = "second-close";
    await second.close();
    liveApplications.pop();

    console.log(`SETTINGS_USAGE_GLM_PERSISTENCE_E2E ${JSON.stringify({
      proof: "settings-usage-glm-persistence-v1",
      glmEndpointKey: glmObservation.endpointKey,
      glmWindowLabel: glmObservation.windows[0]!.label,
      expectedDate,
      firstLaunchUsageText: firstUsageText,
      restartTextIdentical: true,
    })}`);
  } catch (error) {
    for (const application of liveApplications) await application.close().catch(() => undefined);
    console.log(`SETTINGS_USAGE_GLM_PERSISTENCE_E2E_FAILURE ${JSON.stringify({
      step, message: error instanceof Error ? error.message : String(error),
    })}`);
    process.exitCode = 1;
    return;
  } finally {
    if (root.length > 0) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
