import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import type { WorkbenchHostedProjectResult } from "../../src/workbench-shell/contract.ts";
import {
  beginProjectSelection,
  completeProjectSelection,
  enterNewAgentSessionMode,
  initialRendererState,
  replaceProjectResult,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import {
  secondSessionVisualFixture,
  visualFixture,
} from "./visual-harness/fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

type ProjectBridgeDeadline = (
  bridgeCall: Promise<"bridge-result">,
  deadlineResult: () => "bridge-result" | "unavailable",
) => Promise<"bridge-result" | "unavailable">;

function success(view: typeof visualFixture): WorkbenchHostedProjectResult {
  return Object.freeze({ ok: true as const, view });
}

test("a project view that arrives after the switch deadline becomes the selected Project", async () => {
  const initial = replaceProjectResult(
    initialRendererState,
    success(visualFixture),
  );
  const inNewSessionMode = enterNewAgentSessionMode(initial);
  assert.equal(inNewSessionMode.newSession.phase, "active");

  const attempt = beginProjectSelection(inNewSessionMode, 1);
  assert.notEqual(attempt.request, null);
  const timedOut = completeProjectSelection(attempt.state, {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    },
  });
  assert.equal(timedOut.projectSwitch.phase, "error");

  const lateView = Object.freeze({
    ...secondSessionVisualFixture,
    observation: Object.freeze({ cursor: 19, live: true as const }),
    commands: Object.freeze(
      secondSessionVisualFixture.commands.map((command, index) =>
        index === 0
          ? Object.freeze({ ...command, key: "command-7", label: "Late session" })
          : command,
      ),
    ),
    initialSelectionKey: "command-7",
  });
  const recovered = replaceProjectResult(timedOut, success(lateView));

  assert.equal(recovered.projectSwitch.phase, "idle");
  assert.equal(recovered.selectedKey, "command-7");
  assert.equal(recovered.newSession.phase, "inactive");
  assert.equal(recovered.profile.phase, "idle");
  assert.equal(await projectScopeEpochAfter(timedOut, recovered), 1);
});

test("a wedged Project bridge call resolves through the unavailable path", async () => {
  let result: "bridge-result" | "unavailable" | undefined;
  await withProjectBridgeDeadline(async (withDeadline) => {
    result = await withDeadline(
      new Promise<"bridge-result">(() => undefined),
      () => "unavailable",
    );
  });
  assert.equal(result, "unavailable");
});

async function withProjectBridgeDeadline(
  assertion: (withDeadline: ProjectBridgeDeadline) => Promise<void> | void,
): Promise<void> {
  const exposeDeadline: Plugin = {
    name: "w3-expose-project-bridge-deadline",
    enforce: "pre",
    transform(source, id) {
      if (
        !id
          .replaceAll("\\", "/")
          .endsWith("/src/workbench-shell/renderer/mount.tsx")
      ) {
        return;
      }
      const deadlineDeclaration =
        "const PROJECT_BRIDGE_DEADLINE_MILLISECONDS = 120_000;";
      assert.ok(
        source.includes(deadlineDeclaration),
        "the production bridge deadline remains an explicit bounded wait",
      );
      return `${source.replace(
        deadlineDeclaration,
        "const PROJECT_BRIDGE_DEADLINE_MILLISECONDS = 5;",
      )}\nexport { withProjectBridgeDeadline };`;
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeDeadline, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const module = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/mount.tsx",
    )) as { withProjectBridgeDeadline: ProjectBridgeDeadline };
    await assertion(module.withProjectBridgeDeadline);
  } finally {
    await server.close();
  }
}

async function projectScopeEpochAfter(
  previous: typeof initialRendererState,
  next: typeof initialRendererState,
): Promise<number> {
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const module = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/project-rail.tsx",
    )) as {
      nextProjectScopeEpoch: (
        epoch: number,
        previous: typeof initialRendererState,
        next: typeof initialRendererState,
      ) => number;
    };
    return module.nextProjectScopeEpoch(0, previous, next);
  } finally {
    await server.close();
  }
}