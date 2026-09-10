import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PROVIDER_ATTEMPT_BUILD_MARKER,
  detectProviderAttemptBuildMarker,
} from "../../src/workbench-shell/provider-attempt-plan.ts";

test("the built Electron main carries exactly the current source request-budget marker", async (t) => {
  const repositoryRoot = resolve(import.meta.dirname, "..", "..");
  const bundledMainPath = join(repositoryRoot, "dist", "main", "main.js");
  let bundledMain: string;

  try {
    bundledMain = await readFile(bundledMainPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip(
        "dist/main/main.js is missing. This guard verifies the generated Electron main bundle carries the current request-budget marker. Run .\\pnpm.bat build:main to generate the required build artifact.",
      );
      return;
    }

    throw error;
  }

  assert.equal(
    detectProviderAttemptBuildMarker(bundledMain),
    PROVIDER_ATTEMPT_BUILD_MARKER,
  );
});
