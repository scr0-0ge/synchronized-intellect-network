import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hostedProjectView } from "./w26-hosted-project-view.ts";

import type { WorkbenchHostedProjectResult } from "../../src/workbench-shell/contract.ts";
import { createWorkbenchProjectHost } from "../../src/workbench-shell/project-host.ts";
import {
  createTestDirectory,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";

test("the host publishes an exact empty registry both immediately and after restart", async (t) => {
  const root = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-w26-empty-registry-"),
  );
  const projectDirectory = join(root, "Only Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(projectDirectory);

  const host = await createWorkbenchProjectHost({
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
  });
  registerTestClosable(t, host);
  const initial = await observeFirst(host);
  if (!initial.ok) assert.fail("Expected the fallback Project.");
  const selectionKey = hostedProjectView(initial).projectSelection.projects[0]!.selectionKey;
  const emptyObservation = observeFirstWithoutView(host);

  assert.deepEqual(await host.removeProject({ selectionKey }), {
    status: "removed",
  });
  assert.deepEqual(await emptyObservation, { ok: true, empty: true });
  await host.close();

  const restarted = await createWorkbenchProjectHost({
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
  });
  registerTestClosable(t, restarted);
  assert.deepEqual(await observeFirst(restarted), { ok: true, empty: true });
});

function observeFirst(
  host: Awaited<ReturnType<typeof createWorkbenchProjectHost>>,
): Promise<WorkbenchHostedProjectResult> {
  return new Promise((resolve) => {
    const dispose = host.observeProject((result) => {
      dispose();
      resolve(result);
    });
  });
}

function observeFirstWithoutView(
  host: Awaited<ReturnType<typeof createWorkbenchProjectHost>>,
): Promise<WorkbenchHostedProjectResult> {
  return new Promise((resolve) => {
    const dispose = host.observeProject((result) => {
      if ("view" in result) return;
      dispose();
      resolve(result);
    });
  });
}
