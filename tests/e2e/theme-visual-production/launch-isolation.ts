import assert from "node:assert/strict";
import { resolve } from "node:path";

import type { ElectronApplication } from "playwright";

export async function inspectLaunchIsolation(
  application: ElectronApplication,
  project: string,
  userData: string,
): Promise<Readonly<{
  oneWindow: true;
  externalProjectCwd: true;
  isolatedUserData: true;
  developmentComposition: true;
}>> {
  const observed = await application.evaluate(({ app }) => ({
    cwd: process.cwd(),
    userData: app.getPath("userData"),
    packaged: app.isPackaged,
  }));
  assert.equal(samePath(observed.cwd, project), true);
  assert.equal(samePath(observed.userData, userData), true);
  assert.equal(observed.packaged, false);
  assert.equal(application.windows().length, 1);
  return Object.freeze({
    oneWindow: true,
    externalProjectCwd: true,
    isolatedUserData: true,
    developmentComposition: true,
  });
}

export function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLocaleLowerCase("en-US") === b.toLocaleLowerCase("en-US")
    : a === b;
}
