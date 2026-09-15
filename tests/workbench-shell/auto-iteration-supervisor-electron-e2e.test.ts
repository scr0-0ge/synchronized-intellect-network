import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { _electron as electron, type ElectronApplication } from "playwright";
import { build as viteBuild, type Plugin } from "vite";
import solid from "vite-plugin-solid";

import { createViteBrowserTestServer } from "../helpers/vite-server.ts";

const toPosix = (path: string): string => path.replaceAll("\\", "/");

const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;
const repositoryRoot = resolve(".");

/**
 * Isolated Electron + a fake, in-process, zero-real-inference adapter (the
 * same shape as `auto-iteration-main-wiring.test.ts`'s `ScriptedLoopAdapter`)
 * drives the real production backend, coordinator, MCP tool bridge, and
 * renderer (rail + composer + `/supervisor` + `AutoIterationPanel`) end to
 * end: `/supervisor` starts a host Session that appears in the rail; a
 * `submit_work_order` call reaches the same `AutoIterationMcpServer` a real
 * CLI bootstrap would reach (invoked directly, the same way M0's test and
 * w300b's own wiring test do, bypassing only the named-pipe transport w300b
 * already covers); the outbox drain starts a worker Session; a
 * `submit_handoff` call changes the work order's status in the panel.
 *
 * The main process is this test's own minimal harness, not the packaged
 * `electron/main.ts` -- that entry wires real CLI adapters with no fake
 * injection seam, and wiring its full multi-project/appearance/endpoint-key
 * startup surface here would dwarf the feature under test. This harness
 * still runs the real `backend.ts`, `project-view-ipc.ts`, `preload-bridge.ts`,
 * and every renderer module unmodified, via Node's own TypeScript stripping
 * (`--experimental-strip-types`; Electron 37 bundles Node 22.17, which needs
 * the flag explicitly -- confirmed by probe before writing this harness).
 */
test("isolated Electron drives /supervisor through the real rail, coordinator, and panel to a worker handoff", async () => {
  const scratch = spaceFreeScratchParent();
  process.env.TEMP = scratch;
  process.env.TMP = scratch;
  const runRoot = mkdtempSync(join(scratch, "w336-e2e-"));
  const applicationRoot = join(runRoot, "app");
  const project = join(runRoot, "project");
  const profileDirectory = join(runRoot, "profile");
  mkdirSync(applicationRoot);
  mkdirSync(project);
  // handleOutboxEntry now resolves a real workspace baseline for every
  // attempt, gitIntegration required or not (w337); the Project directory
  // must be a real repo with a resolvable commit or the outbox drain defers
  // the start-attempt forever and the worker Session never binds.
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Auto Iteration Supervisor E2E",
    GIT_AUTHOR_EMAIL: "auto-iteration-supervisor-e2e@example.invalid",
    GIT_COMMITTER_NAME: "Auto Iteration Supervisor E2E",
    GIT_COMMITTER_EMAIL: "auto-iteration-supervisor-e2e@example.invalid",
  };
  execFileSync("git", ["init", "--initial-branch=demo"], { cwd: project, windowsHide: true, env: gitEnv });
  writeFileSync(join(project, "baseline.txt"), "baseline\n", "utf8");
  execFileSync("git", ["add", "baseline.txt"], { cwd: project, windowsHide: true, env: gitEnv });
  execFileSync("git", ["commit", "-m", "test: baseline"], { cwd: project, windowsHide: true, env: gitEnv });
  const baselineCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, windowsHide: true, env: gitEnv })
    .toString("utf8")
    .trim();

  const probeUrl = "/__auto_iteration_supervisor_electron_probe";
  const moduleId = "/__auto_iteration_supervisor_electron_probe.tsx";
  const plugin: Plugin = {
    name: "auto-iteration-supervisor-electron-ui-probe",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== probeUrl) return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<main id="probe"></main><script type="module" src="${moduleId}"></script>`);
      });
    },
    resolveId(id) { if (id === moduleId) return id; },
    load(id) {
      if (id !== moduleId) return;
      return `
        import "/src/workbench-shell/renderer/styles.css";
        import "/src/workbench-shell/renderer/themes/theme-acrylic.css";
        import { mountWorkbench } from "/src/workbench-shell/renderer/mount.tsx";
        document.documentElement.setAttribute("data-skin", "acrylic");
        document.documentElement.setAttribute("data-glass", "full");
        const noOpWindowBridge = {
          observeState() { return () => {}; },
          minimize() {}, toggleMaximize() {}, close() {},
        };
        // The custom preload below exposes window.workbench asynchronously
        // (a top-level await inside an ESM preload module); poll rather than
        // assume it is present the instant this module starts.
        const waitForBridge = async () => {
          for (let attempt = 0; attempt < 500; attempt += 1) {
            if (window.workbench !== undefined) return window.workbench;
            await new Promise((resolveWait) => setTimeout(resolveWait, 20));
          }
          throw new Error("window.workbench never appeared");
        };
        const bridge = await waitForBridge();
        mountWorkbench(document.querySelector("#probe"), bridge, noOpWindowBridge);
      `;
    },
  };
  const server = await createViteBrowserTestServer({
    appType: "custom", configFile: false, logLevel: "silent",
    plugins: [plugin, solid()], root: repositoryRoot,
    server: { host: "127.0.0.1", port: 0 },
  });
  let application: ElectronApplication | undefined;
  try {
    // Electron's main process ignores NODE_OPTIONS for TypeScript stripping
    // (confirmed by probe: it works under ELECTRON_RUN_AS_NODE but not in
    // full app mode). Bundling both entries through Vite's own build API --
    // the exact toolchain vite.main.config.ts / vite.preload.config.ts use
    // for the real app -- sidesteps that and lets these entries import the
    // real backend.ts / project-view-ipc.ts / preload-bridge.ts unmodified.
    const preloadEntrySource = preloadEntrySource_(repositoryRoot);
    writeFileSync(join(applicationRoot, "preload-entry.ts"), preloadEntrySource, "utf8");
    await viteBuild({
      configFile: false, logLevel: "silent", root: applicationRoot,
      build: {
        outDir: applicationRoot, emptyOutDir: false, target: "node22",
        lib: { entry: join(applicationRoot, "preload-entry.ts"), formats: ["cjs"], fileName: () => "preload.cjs" },
        rollupOptions: { external: ["electron"] },
      },
    });

    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address !== null && typeof address === "object");
    const pageUrl = `http://127.0.0.1:${address.port}${probeUrl}`;

    const mainEntrySource = mainEntrySource_(repositoryRoot, project, pageUrl);
    writeFileSync(join(applicationRoot, "main-entry.ts"), mainEntrySource, "utf8");
    await viteBuild({
      configFile: false, logLevel: "silent", root: applicationRoot,
      build: {
        outDir: applicationRoot, emptyOutDir: false, target: "node22", ssr: true,
        rollupOptions: {
          external: ["electron"],
          input: join(applicationRoot, "main-entry.ts"),
          output: { entryFileNames: "main.js" },
        },
      },
    });
    writeFileSync(
      join(applicationRoot, "package.json"),
      JSON.stringify({ name: "w336-e2e", private: true, type: "module", main: "main.js" }),
      "utf8",
    );

    application = await electron.launch({
      executablePath: electronExecutable,
      args: [`--user-data-dir=${profileDirectory}`, applicationRoot],
      cwd: applicationRoot,
      env: isolatedEnvironment(runRoot),
      timeout: 30_000,
    });
    const page = await application.firstWindow({ timeout: 30_000 });
    const errors: string[] = [];
    const consoleLines: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
    application.process().stdout?.on("data", (chunk) => consoleLines.push(`[main:out] ${String(chunk).trim()}`));
    application.process().stderr?.on("data", (chunk) => consoleLines.push(`[main:err] ${String(chunk).trim()}`));
    const describeFailure = async (label: string): Promise<string> => [
      label,
      `pageErrors=${errors.join(" | ")}`,
      `console=${consoleLines.join(" | ")}`,
      `bodySnippet=${(await page.locator("body").innerText().catch(() => "unreadable")).slice(0, 400)}`,
    ].join("\n");

    // /supervisor: the composer's slash menu, driven by the real profile
    // auto-default resolved from the fake adapter's single-model catalog.
    const input = page.locator("#direct-input");
    try {
      await input.fill("/", { timeout: 20_000 });
    } catch (error) {
      throw new Error(await describeFailure(String(error)));
    }
    try {
      await page.waitForFunction(() => {
        const chip = document.querySelector(".chip-endpoint");
        const label = chip?.getAttribute("aria-label") ?? "";
        return label.length > 0 && !label.includes("Choose endpoint");
      }, { timeout: 15_000 });
    } catch (error) {
      throw new Error(await describeFailure(String(error)));
    }
    await page.getByRole("listbox", { name: "Composer presets" }).waitFor();
    await input.press("ArrowDown");
    await input.press("Enter");

    // Rail: the host-created supervisor Session appears as an ordinary row.
    try {
      await page.locator(".session-row").first().waitFor({ timeout: 20_000 });
    } catch (error) {
      throw new Error(await describeFailure(String(error)));
    }
    assert.equal(await page.locator(".session-row").count(), 1);
    assert.deepEqual(errors, []);

    // A fake MCP client submits a work order through the same
    // AutoIterationMcpServer a real CLI bootstrap would reach (w300b covers
    // the pipe transport itself; this proves the rest of the loop).
    const profile = { model: "gpt-5.6-sol", effortLevel: "ultra", executionMode: "single-agent", accessMode: "full-access" };
    const submitted = await page.evaluate(
      async (workOrder) => (window as any).__testControl.callTool({
        role: "supervisor",
        name: "submit_work_order",
        arguments: workOrder,
      }),
      {
        requestIdempotencyKey: "w336-e2e-submit-1",
        expectedVersion: 1,
        observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
        workOrder: {
          objective: "Summarize the fixture repository",
          acceptanceCriteria: ["summary mentions the fixture"],
          baselineCommitSha,
          territory: { writePaths: ["src/"], readOnlyPaths: ["docs/"] },
          responsibleRoleSlotId: "project-supervisor",
          completionCondition: { gitIntegration: "not-required" },
          workerSession: { endpointId: "codex-desktop", profile },
        },
      },
    );
    assert.equal(submitted?.kind, "work-order-submitted", JSON.stringify(submitted));
    const workOrderId = submitted.workOrder.workOrderId as string;
    const attemptId = submitted.attempt.attemptId as string;

    // Panel: the work order row appears, sourced from WorkbenchAutoIterationView.
    const panel = page.locator(".auto-iteration-panel");
    try {
      await panel.waitFor({ timeout: 15_000 });
    } catch (error) {
      throw new Error(await describeFailure(String(error)));
    }
    const workOrderRow = panel.locator(".auto-iteration-work-order-row", { hasText: workOrderId });
    await workOrderRow.waitFor({ timeout: 15_000 });

    // Worker Session: the outbox drain starts it through the same production
    // seam, and the panel's own "Worker Session" cell flips from unbound.
    try {
      await workOrderRow.filter({ hasText: "bound" }).waitFor({ timeout: 20_000 });
    } catch (error) {
      throw new Error(await describeFailure(
        `worker Session never bound in the panel; ${await workOrderRow.innerText().catch(() => "row unreadable")}`,
      ));
    }
    try {
      await page.waitForFunction(
        () => document.querySelectorAll(".session-row").length === 2,
        { timeout: 10_000 },
      );
    } catch (error) {
      throw new Error(await describeFailure(`the worker Session never appeared in the rail; ${String(error)}`));
    }

    const statusBeforeHandoff = await workOrderRow.locator(".auto-iteration-chip").first().innerText();

    // The fake worker delivers through the same tool wire.
    const handoff = await page.evaluate(
      async (payload) => (window as any).__testControl.callTool({
        role: "worker", workOrderId: payload.workOrderId,
        name: "submit_handoff",
        arguments: payload.arguments,
      }),
      {
        workOrderId,
        arguments: {
          requestIdempotencyKey: "w336-e2e-handoff-1",
          expectedVersion: 1,
          observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
          handoff: {
            idempotencyKey: { workOrderId, attemptId, handoffId: "w336-e2e-handoff-1" },
            body: "The fixture work is complete.",
            artifactIds: [],
          },
        },
      },
    );
    assert.equal(handoff?.kind, "handoff-submitted", JSON.stringify(handoff));
    assert.equal(handoff.receipt.level, "persisted");

    // Status changes in the panel after the handoff -- no page reload, the
    // same live project-view stream the rail uses.
    try {
      await panel.locator(".auto-iteration-work-order-row", { hasText: workOrderId })
        .locator(".auto-iteration-chip")
        .first()
        .filter({ hasNotText: statusBeforeHandoff })
        .waitFor({ timeout: 20_000 });
    } catch (error) {
      throw new Error(await describeFailure(
        `status did not change after handoff; row now: ${await workOrderRow.innerText().catch(() => "unreadable")}`,
      ));
    }
    const statusAfterHandoff = await workOrderRow.locator(".auto-iteration-chip").first().innerText();
    assert.notEqual(statusAfterHandoff, statusBeforeHandoff);
    assert.deepEqual(errors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await server.close();
    rmSync(runRoot, { recursive: true, force: true });
  }
});

function preloadEntrySource_(repoRoot: string): string {
  const bridgePath = toPosix(join(repoRoot, "src/workbench-shell/preload-bridge.ts"));
  return `import { contextBridge, ipcRenderer } from "electron";
import { createWorkbenchPreloadBridge } from ${JSON.stringify(bridgePath)};
const bridge = createWorkbenchPreloadBridge(ipcRenderer);
contextBridge.exposeInMainWorld("workbench", bridge);
contextBridge.exposeInMainWorld("__testControl", {
  callTool: (request) => ipcRenderer.invoke("test:call-tool", request),
});
`;
}

function mainEntrySource_(repoRoot: string, projectDirectory: string, pageUrl: string): string {
  const backendPath = toPosix(join(repoRoot, "src/workbench-shell/backend.ts"));
  const ipcPath = toPosix(join(repoRoot, "src/workbench-shell/electron/project-view-ipc.ts"));
  return `import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { createWorkbenchBackend } from ${JSON.stringify(backendPath)};
import { installWorkbenchProjectViewIpc } from ${JSON.stringify(ipcPath)};
app.on("window-all-closed", () => {});

const PROJECT_ID = "project-selection:33333333-3333-4333-8333-333333333333";
const turnEvents = [
  { kind: "session-started" },
  { kind: "turn-started" },
  { kind: "agent-message", text: "FIXTURE_TURN_BODY" },
  { kind: "turn-completed", status: "completed" },
];
class ScriptedBinding {
  constructor(profile, opaqueSessionReference) {
    this.profile = profile;
    this.opaqueSessionReference = opaqueSessionReference;
  }
  async send() {}
  async *events() { for (const event of turnEvents) yield structuredClone(event); }
}
class ScriptedLoopAdapter {
  constructor() { this.starts = 0; }
  async inspect() {
    return {
      runtime: "codex",
      models: [{ id: "gpt-5.6-sol", effortLevels: ["ultra"] }],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }
  async start(request) {
    this.starts += 1;
    return new ScriptedBinding(request.profile, "native-start-" + this.starts);
  }
  async resume(request) { return new ScriptedBinding(request.profile, request.opaqueSessionReference); }
}

const backend = await createWorkbenchBackend({
  projectDirectory: ${JSON.stringify(projectDirectory)},
  databasePath: ${JSON.stringify(join(projectDirectory, "..", "project.sqlite"))},
  preferencePath: ${JSON.stringify(join(projectDirectory, "..", "profile.json"))},
  adapter: new ScriptedLoopAdapter(),
});

const source = {
  observeProject(listener) {
    return backend.observeProject((result) => {
      if (!result.ok) { listener(result); return; }
      listener({
        ok: true,
        view: {
          ...result.view,
          // sanitizeHostedView requires the selected option's label to equal
          // view.project.label (the directory basename); it is not a free label.
          projectSelection: {
            projects: [{ label: result.view.project.label, availability: "available", selected: true, selectionKey: PROJECT_ID }],
          },
        },
      });
    });
  },
  async registerTrustedProject() {
    return { ok: true, status: "selected", message: "Project was opened." };
  },
  async selectProject() {
    return { ok: true, status: "selected", message: "Project was opened." };
  },
  loadDirectSessionProfile: (request) => backend.loadDirectSessionProfile(request),
  useDirectSessionProfileAsDefault: (request) => backend.useDirectSessionProfileAsDefault(request),
  submitDirectInput: (request) => backend.submitDirectInput(request),
  startAutoIterationSupervisor(request) {
    const { projectId, ...selection } = request;
    return backend.startAutoIterationSupervisor(selection);
  },
};

let toolCallId = 0;
ipcMain.handle("test:call-tool", async (_event, request) => {
  const service = backend.autoIteration;
  if (service === undefined) throw new Error("auto-iteration service is unavailable");
  const overview = service.authority.readAutoIterationOverview();
  let sessionId;
  if (request.role === "supervisor") {
    sessionId = overview.supervisor?.sessionId;
  } else {
    const order = overview.workOrders.find((candidate) => candidate.workOrderId === request.workOrderId);
    sessionId = order?.workerSessionId ?? undefined;
  }
  if (sessionId === undefined) throw new Error("no " + request.role + " Session is bound yet");
  const server = service.mcpServerForSession(sessionId);
  const response = await server.handle({
    jsonrpc: "2.0",
    id: ++toolCallId,
    method: "tools/call",
    params: { name: request.name, arguments: request.arguments },
  });
  if (response === null || !("result" in response)) {
    throw new Error(request.name + " failed: " + JSON.stringify(response && response.error));
  }
  const text = response.result?.content?.[0]?.text;
  return text === undefined ? response.result : JSON.parse(text);
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  installWorkbenchProjectViewIpc({ ipcMain, window, source });
  await window.loadURL(${JSON.stringify(pageUrl)});
}).catch((error) => {
  console.error("[w336-e2e-harness] startup failed", error);
});`;
}

function spaceFreeScratchParent(): string {
  const configured = resolve(process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir());
  mkdirSync(configured, { recursive: true });
  if (!/\s/u.test(configured)) return configured;
  // windowsVerbatimArguments keeps the inner quotes intact: letting Node quote
  // the argument escapes them as \", which cmd does not understand and the
  // for-set splits at the first space.
  const result = spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", `for %I in ("${configured}") do @echo %~sI`],
    { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
  );
  assert.equal(result.status, 0, `could not derive a short path for ${configured}`);
  const short = (result.stdout ?? "").trim();
  assert.doesNotMatch(short, /\s/u, `short path still contains spaces: ${short}`);
  mkdirSync(short, { recursive: true });
  return short;
}

function isolatedEnvironment(root: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/(ANTHROPIC|CLAUDE|CODEX|OPENAI|GLM|KIMI|MOONSHOT|DEEPSEEK|ZHIPU|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PASSWORD|SECRET|TOKEN)$/iu.test(key)) environment[key] = value;
  }
  const home = join(root, "home");
  for (const directory of [home, join(home, "appdata"), join(home, "local"), join(home, "temp")]) mkdirSync(directory, { recursive: true });
  return {
    ...environment,
    HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "local"), TEMP: join(home, "temp"), TMP: join(home, "temp"),
    TMPDIR: join(home, "temp"),
    NODE_OPTIONS: "--experimental-strip-types",
  };
}
