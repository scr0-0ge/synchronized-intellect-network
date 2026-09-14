import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import { createWorkbenchCoordinator } from "../../src/coordinator/index.ts";
import { WORKBENCH_RUNTIME_ENDPOINT_IDS } from "../../src/workbench-shell/runtime-endpoint-identity.ts";
import {
  createWorkbenchAppearancePreferenceStore,
  defaultWorkbenchAppearancePreference,
} from "../../src/workbench-shell/appearance-preference-store.ts";
import {
  firstDomContentLoadedWindow,
  launchProductionElectron,
  productionElectronArguments,
  resolveProductionElectronComposition,
} from "./harness/production-electron.ts";

/**
 * w257 (owner acceptance criterion): in a real, offscreen, isolated
 * production Electron process, the composer's context circle shows for a
 * GLM session and a Claude session, clicking it opens a popover (not a
 * hover-only tooltip), and the popover renders both in dark and light tone.
 *
 * No live CLI subprocess and no real inference round: both sessions are
 * seeded through the real coordinator (`createWorkbenchCoordinator` +
 * `channel.act`, the same durable path `electron-e2e.ts`'s profile-projection
 * fixture already proves) with a fixture `ResumableAgentRuntimeAdapter` that
 * yields a hardcoded `turn-completed` event carrying a context window --
 * exercising the real renderer/coordinator/IPC path end to end, not the
 * claude/session.ts wire parser (that path is covered by the real-shaped
 * fixtures in tests/agent-runtime/*.test.ts). The popover's "Usage & resets"
 * lines are seeded the same way settings-usage-glm-persistence.ts seeds the
 * Settings card: writing straight to the real appearance-preference store
 * through the same functions production code calls.
 */

const productionElectron = resolveProductionElectronComposition(import.meta.url);
const routineRootPrefix = "workbench-w257-context-popover-";

const glmProfile: SessionProfile = {
  model: "glm-5.3[1m]",
  effortLevel: "default",
  executionMode: "single-agent",
  accessMode: "full-access",
};
const claudeProfile: SessionProfile = {
  model: "claude-sonnet-5",
  effortLevel: "default",
  executionMode: "single-agent",
  accessMode: "full-access",
};

class ContextFixtureAdapter implements ResumableAgentRuntimeAdapter {
  async inspect(): Promise<RuntimeCatalog> {
    return {
      runtime: "fixture",
      models: [
        { id: glmProfile.model, effortLevels: [glmProfile.effortLevel] },
        { id: claudeProfile.model, effortLevels: [claudeProfile.effortLevel] },
      ],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    return this.binding(request.profile);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    return this.binding(request.profile);
  }

  private binding(profile: SessionProfile): ResumableRuntimeBinding {
    return {
      profile: structuredClone(profile),
      opaqueSessionReference: `w257-fixture-${profile.model}`,
      async send(_input: RuntimeInput): Promise<void> {},
      effectiveProfile(): SessionProfile | undefined {
        return structuredClone(profile);
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "agent-message", text: "w257 fixture turn completed." };
        yield {
          kind: "turn-completed",
          status: "completed",
          context:
            profile.model === glmProfile.model
              ? { basis: "active-context" as const, usedTokens: 620_000, windowTokens: 1_000_000 }
              : { basis: "active-context" as const, usedTokens: 62_400, windowTokens: 200_000 },
        };
      },
    };
  }
}

async function seedProject(
  projectDirectory: string,
  userDataDirectory: string,
): Promise<void> {
  const canonicalProject = await realpath(projectDirectory);
  const dataDirectory = join(userDataDirectory, "workbench-project-host");
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  const recordKey = "project-record-v1-00000000-0000-4000-8000-000000000257";
  const ledgerSlot = "project-ledger-v1-00000000-0000-4000-8000-000000000258";
  await mkdir(ledgerDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 2,
      selectedRecordKey: recordKey,
      records: [{ recordKey, canonicalDirectory: canonicalProject, ledgerSlot }],
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  const channel = await createWorkbenchCoordinator({
    databasePath: join(ledgerDirectory, `${ledgerSlot}.sqlite`),
    adapter: new ContextFixtureAdapter(),
    // GLM is an api-key endpoint, not one of the two default subscription
    // endpoints; the real Workbench shell always injects this full roster.
    endpointIds: WORKBENCH_RUNTIME_ENDPOINT_IDS,
  }).openProject(canonicalProject);
  try {
    const fixtures = [
      {
        idempotencyKey: "w257-glm-fixture",
        endpointId: "glm-coding-plan" as const,
        profile: glmProfile,
        projection: {
          kind: "recorded" as const,
          runtimeFamilyLabel: "GLM",
          endpointLabel: "GLM Coding Plan",
          modelLabel: "GLM 5.3",
          workIntensityControlLabel: { label: null, provenance: "not-recorded" as const },
          workIntensityLabel: "Default",
          executionModeLabel: "Single agent",
          accessModeLabel: "Full access",
        },
      },
      {
        idempotencyKey: "w257-claude-fixture",
        endpointId: "claude-code-desktop" as const,
        profile: claudeProfile,
        projection: {
          kind: "recorded" as const,
          runtimeFamilyLabel: "Claude",
          endpointLabel: "Subscription",
          modelLabel: "Sonnet 5",
          workIntensityControlLabel: { label: null, provenance: "not-recorded" as const },
          workIntensityLabel: "Default",
          executionModeLabel: "Single agent",
          accessModeLabel: "Full access",
        },
      },
    ];
    for (const fixture of fixtures) {
      const receipt = await channel.act(
        {
          kind: "direct",
          commandKind: "start",
          idempotencyKey: fixture.idempotencyKey,
          // The coordinator's durable command shape only ever carries the
          // literal "codex" here regardless of the actual endpoint -- the
          // real identity flows through `runtimeResumeIdentity.endpointId`
          // and `requestedProfileProjection.runtimeFamilyLabel` below.
          runtime: "codex" as const,
          catalogRevision: "w257-fixture-catalog-v1",
          preferences: { global: fixture.profile },
          profile: fixture.profile,
          runtimeResumeIdentity: {
            schemaVersion: 1,
            endpointId: fixture.endpointId,
            nativeProfile: fixture.profile,
          },
          requestedProfileProjection: fixture.projection,
          input: "Render the w257 context-popover fixture.",
        },
        { endpointId: fixture.endpointId },
      );
      await withTimeout(
        waitForSeededTerminal(channel, receipt.commandId),
        5_000,
        `w257-fixture-terminal-timeout(${fixture.idempotencyKey})`,
      );
    }
  } finally {
    await channel.close();
  }
}

async function waitForSeededTerminal(
  channel: Awaited<ReturnType<ReturnType<typeof createWorkbenchCoordinator>["openProject"]>>,
  commandId: string,
): Promise<void> {
  while (true) {
    const command = (await channel.snapshot()).commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (command?.status === "completed") return;
    if (command?.status === "failed" || command?.status === "recovery-required") {
      throw new Error(`w257-fixture-failed:${command.status}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
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

async function captureRingAndPopover(
  page: import("playwright").Page,
  runtimeFamilyLabel: "GLM" | "Claude",
  screenshotPath: string,
): Promise<string> {
  const projectTree = page.locator('.rail[aria-label="Projects and Agent Sessions"]');
  await projectTree.waitFor({ state: "visible", timeout: 15_000 });
  const sessionRows = projectTree.locator(".proj-sessions > .session-row-shell > .session-row");
  await sessionRows.first().waitFor({ state: "visible", timeout: 15_000 });
  const target = sessionRows.filter({ hasText: runtimeFamilyLabel === "GLM" ? "GLM 5.3" : "Sonnet 5" }).first();
  await target.click();
  const ring = page.locator(".stage .ctx-ring");
  await ring.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await ring.getAttribute("aria-haspopup"), "dialog");
  assert.equal(await ring.getAttribute("aria-expanded"), "false");
  await ring.click();
  const popover = page.locator(".popover-context");
  await popover.waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(await ring.getAttribute("aria-expanded"), "true");
  const popoverText = (await popover.innerText()).trim();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  // Escape must close it (same lifecycle contract as the model/endpoint popovers).
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden", timeout: 5_000 });
  assert.equal(await ring.getAttribute("aria-expanded"), "false");
  return popoverText;
}

async function main(): Promise<void> {
  let step = "initialization";
  let root = "";
  const liveApplications: { close(): Promise<unknown> }[] = [];
  try {
    step = "isolated-root";
    const base = await realpath(tmpdir());
    root = await mkdtemp(join(base, routineRootPrefix));
    const userData = join(root, "user-data");
    const projectDirectory = join(root, "project");
    const paths = {
      isolatedHome: join(root, "home"),
      isolatedAppData: join(root, "app-data"),
      isolatedLocalAppData: join(root, "local-app-data"),
      isolatedPath: join(root, "empty-path"),
      isolatedTemp: join(root, "temp"),
    };
    await Promise.all(
      [userData, projectDirectory, ...Object.values(paths)].map((path) => mkdir(path, { recursive: true })),
    );
    const env = isolatedEnvironment(paths);

    step = "seed-project";
    await seedProject(projectDirectory, userData);

    step = "seed-usage-observations";
    const preferenceFilePath = join(userData, "workbench-appearance-preferences-v1.json");
    const seedStore = createWorkbenchAppearancePreferenceStore({ filePath: preferenceFilePath });
    const now = Date.now();
    await seedStore.saveClaudeSubscriptionUsage({
      five_hour: { utilization: 0.23, resetsAt: Math.floor(now / 1000) + 3 * 60 * 60 },
      seven_day: { utilization: 0.66, resetsAt: Math.floor(now / 1000) + 3 * 24 * 60 * 60 },
      observedAt: now,
    });
    await seedStore.close();

    step = "first-launch-dark";
    const first = await launchProductionElectron(productionElectron, {
      args: productionElectronArguments(productionElectron, userData),
      cwd: root,
      env,
      timeout: 20_000,
    });
    liveApplications.push(first);
    const firstPage = await firstDomContentLoadedWindow(first, 15_000);
    firstPage.on("console", (message) => console.log(`[renderer console] ${message.type()}: ${message.text()}`));
    firstPage.on("pageerror", (error) => console.log(`[renderer pageerror] ${error.message}`));
    try {
      await firstPage.getByRole("button", { name: "Settings", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    } catch (error) {
      console.log(`[debug body] ${(await firstPage.locator("body").innerText().catch(() => "<unreadable>")).slice(0, 2000)}`);
      throw error;
    }

    step = "first-launch/glm-popover-dark";
    const glmDarkText = await captureRingAndPopover(
      firstPage,
      "GLM",
      join(productionElectron.repositoryRoot, "dist", "w257-context-popover-glm-dark.png"),
    );
    assert.match(glmDarkText, /620K \/ 1M/u);
    assert.match(glmDarkText, /62%/u);

    step = "first-launch/claude-popover-dark";
    const claudeDarkText = await captureRingAndPopover(
      firstPage,
      "Claude",
      join(productionElectron.repositoryRoot, "dist", "w257-context-popover-claude-dark.png"),
    );
    assert.match(claudeDarkText, /62\.4K \/ 200K/u);
    assert.match(claudeDarkText, /31%/u);
    assert.match(claudeDarkText, /5-hour window/u);
    assert.match(claudeDarkText, /23%/u);
    assert.match(claudeDarkText, /7-day window/u);
    assert.match(claudeDarkText, /66%/u);

    step = "first-close";
    await first.close();
    liveApplications.pop();

    step = "seed-light-tone";
    const toneStore = createWorkbenchAppearancePreferenceStore({ filePath: preferenceFilePath });
    await toneStore.save({ ...defaultWorkbenchAppearancePreference, tone: "light" });
    await toneStore.close();

    step = "second-launch-light";
    const second = await launchProductionElectron(productionElectron, {
      args: productionElectronArguments(productionElectron, userData),
      cwd: root,
      env,
      timeout: 20_000,
    });
    liveApplications.push(second);
    const secondPage = await firstDomContentLoadedWindow(second, 15_000);
    await secondPage.getByRole("button", { name: "Settings", exact: true }).waitFor({ state: "visible", timeout: 15_000 });

    step = "second-launch/claude-popover-light";
    const claudeLightText = await captureRingAndPopover(
      secondPage,
      "Claude",
      join(productionElectron.repositoryRoot, "dist", "w257-context-popover-claude-light.png"),
    );
    assert.equal(claudeLightText, claudeDarkText, "same seeded observation renders identical text regardless of tone");

    step = "second-close";
    await second.close();
    liveApplications.pop();

    console.log(`W257_CONTEXT_POPOVER_E2E ${JSON.stringify({
      proof: "w257-context-circle-popover-v1",
      glmDarkText,
      claudeDarkText,
      claudeLightText,
      screenshots: [
        "dist/w257-context-popover-glm-dark.png",
        "dist/w257-context-popover-claude-dark.png",
        "dist/w257-context-popover-claude-light.png",
      ],
    })}`);
  } catch (error) {
    for (const application of liveApplications) await application.close().catch(() => undefined);
    console.log(`W257_CONTEXT_POPOVER_E2E_FAILURE ${JSON.stringify({
      step,
      message: error instanceof Error ? error.message : String(error),
      category: (error as { category?: unknown } | undefined)?.category,
    })}`);
    process.exitCode = 1;
    return;
  } finally {
    if (root.length > 0) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
