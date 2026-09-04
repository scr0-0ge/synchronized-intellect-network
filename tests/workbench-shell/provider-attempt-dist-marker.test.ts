import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PROVIDER_ATTEMPT_BUILD_MARKER,
  detectProviderAttemptBuildMarker,
} from "../../src/workbench-shell/provider-attempt-plan.ts";

test("the built Electron main carries exactly the current source request-budget marker", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "..", "..");
  const bundledMain = await readFile(
    join(repositoryRoot, "dist", "main", "main.js"),
    "utf8",
  );
  assert.equal(
    detectProviderAttemptBuildMarker(bundledMain),
    PROVIDER_ATTEMPT_BUILD_MARKER,
  );
});
