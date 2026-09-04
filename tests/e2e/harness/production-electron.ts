import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";

import { OFFSCREEN_PLACEMENT_ARGUMENT } from "../../../src/workbench-shell/electron/window-placement.ts";

export interface ProductionElectronComposition {
  readonly repositoryRoot: string;
  readonly electronExecutable: string;
  readonly rendererUrl: string;
}

export interface ProductionElectronLaunchOptions {
  readonly args: string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeout: number;
}

export function resolveProductionElectronComposition(
  entryModuleUrl: string,
): ProductionElectronComposition {
  const repositoryRoot = resolve(fileURLToPath(new URL("../..", entryModuleUrl)));
  return Object.freeze({
    repositoryRoot,
    electronExecutable: createRequire(entryModuleUrl)("electron") as string,
    rendererUrl: pathToFileURL(
      join(repositoryRoot, "dist", "renderer", "index.html"),
    ).toString(),
  });
}

/*
 * Every production launch from a test or an agent goes through here, and every
 * one of them lands on the owner's machine. Issue 161: they carry the offscreen
 * placement switch by default, which the product honours only because the same
 * argument list carries an isolated --user-data-dir. A launch the owner starts
 * himself has neither switch and is unaffected.
 */
export function productionElectronArguments(
  composition: ProductionElectronComposition,
  userDataDirectory: string,
  additionalArguments?: readonly string[],
): string[] {
  return [
    composition.repositoryRoot,
    `--user-data-dir=${userDataDirectory}`,
    OFFSCREEN_PLACEMENT_ARGUMENT,
    ...(additionalArguments ?? []),
  ];
}

export function launchProductionElectron(
  composition: ProductionElectronComposition,
  options: ProductionElectronLaunchOptions,
): Promise<ElectronApplication> {
  // One line per launch (issue 161 item 4), so a run leaves a readable trail of
  // what it opened instead of a blur of windows.
  console.log(
    `production electron launch: ${options.args
      .filter((argument) => argument.startsWith("--"))
      .join(" ")} cwd=${options.cwd}`,
  );
  return electron.launch({
    executablePath: composition.electronExecutable,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
  });
}

export async function firstDomContentLoadedWindow(
  application: ElectronApplication,
  timeout: number,
): Promise<Page> {
  const page = await application.firstWindow({ timeout });
  await page.waitForLoadState("domcontentloaded");
  return page;
}
