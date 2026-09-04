import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ElectronApplication } from "playwright";

import { expectedCode, seedProductionHistory } from "./f169-packaged-copy/fixture.ts";
import {
  closeOwnedApplication,
  type ApplicationCleanupOutcome,
  removeOwnedTemporaryRoot,
  restoreClipboard,
  throwCleanupFailures,
} from "./f169-packaged-copy/lifecycle.ts";
import {
  type ClipboardRestoreState,
  inspectPackagedCopy,
  sha256,
} from "./f169-packaged-copy/scenario.ts";
import { productionEnvironment } from "./harness/production-environment.ts";
import {
  firstDomContentLoadedWindow,
  launchProductionElectron,
  productionElectronArguments,
  resolveProductionElectronComposition,
} from "./harness/production-electron.ts";

const productionElectron = resolveProductionElectronComposition(import.meta.url);
const { rendererUrl: expectedRendererUrl } = productionElectron;

export async function runF169PackagedCopy(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(resolve(tmpdir()), "workbench-f169-"));
  let application: ElectronApplication | undefined;
  let ownedMainProcess: ChildProcess | undefined;
  let ownedMainPid: number | undefined;
  const clipboardRestoreState: ClipboardRestoreState = {
    originalClipboardText: undefined,
    clipboardWasPrimed: false,
  };
  let applicationCleanup: ApplicationCleanupOutcome | undefined;
  let isolatedRootRemoved = false;
  let primaryFailure: { readonly error: unknown } | undefined;
  let summary: Record<string, unknown> | undefined;

  try {
    const projectDirectory = join(temporaryRoot, "seeded-project");
    const userDataDirectory = join(temporaryRoot, "isolated-user-data");
    await mkdir(projectDirectory);
    await mkdir(userDataDirectory);
    await seedProductionHistory(projectDirectory, userDataDirectory);

    application = await launchProductionElectron(productionElectron, {
      args: productionElectronArguments(productionElectron, userDataDirectory),
      cwd: projectDirectory,
      env: productionEnvironment(process.env),
      timeout: 15_000,
    });
    ownedMainProcess = application.process();
    ownedMainPid = ownedMainProcess.pid;
    const page = await firstDomContentLoadedWindow(application, 15_000);
    summary = await inspectPackagedCopy(
      application,
      page,
      expectedRendererUrl,
      clipboardRestoreState,
    );
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (
      application !== undefined &&
      clipboardRestoreState.clipboardWasPrimed &&
      clipboardRestoreState.originalClipboardText !== undefined
    ) {
      try {
        await restoreClipboard(
          application,
          clipboardRestoreState.originalClipboardText,
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      applicationCleanup = await closeOwnedApplication(
        application,
        ownedMainProcess,
        ownedMainPid,
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (
      primaryFailure === undefined &&
      cleanupFailures.length === 0 &&
      applicationCleanup?.exactChildDeathProved === true
    ) {
      try {
        await removeOwnedTemporaryRoot(temporaryRoot);
        isolatedRootRemoved = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    } else if (primaryFailure !== undefined && cleanupFailures.length === 0) {
      try {
        await removeOwnedTemporaryRoot(temporaryRoot);
        isolatedRootRemoved = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    throwCleanupFailures(primaryFailure, cleanupFailures);
  }

  assert.notEqual(summary, undefined);
  const completedCleanup = applicationCleanup;
  if (completedCleanup === undefined) {
    assert.fail("application-cleanup-outcome-missing");
  }
  assert.equal(completedCleanup.exactChildDeathProved, true);
  assert.equal(isolatedRootRemoved, true);
  console.log(
    `F169_PACKAGED_COPY_PASS expectedBytes=${Buffer.byteLength(expectedCode, "utf8")} expectedSha256=${sha256(expectedCode)}`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void runF169PackagedCopy().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
