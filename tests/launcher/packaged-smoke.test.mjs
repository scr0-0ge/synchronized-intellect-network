/**
 * The packaged executable is the only thing a stranger ever runs, and two of
 * its defects were found on a Release exe after every `electron .` launch had
 * passed: the brand assets resolved outside app.asar (w258), and the first-run
 * bootstrap Project kept copy written for a Project that can start Sessions
 * (w283). A development launch structurally cannot reach either -- its
 * application root is the repository and it never wires the bootstrap
 * adapter -- so no other test in this tree can stand in for this one.
 *
 * This guard does what w254, w258 and w270 each did by hand: build, run the
 * repository's own packaging command, start the packaged executable in an
 * isolated offscreen profile, and read the packaged-only facts back from the
 * live main process and the rendered page. It installs nothing, needs no CLI
 * on the machine (PATH is System32 alone and every home is redirected, so no
 * Claude or Codex executable is ever located), starts no inference, and never
 * clicks Install.
 *
 * Isolation is a space-free `--user-data-dir` plus redirected
 * APPDATA/LOCALAPPDATA/homes, with the exact `userData` read back before
 * anything is asserted on. Local scratch and package staging uses the supplied
 * lane root; CI can use its disposable runner temp root.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { _electron as electron } from 'playwright';

import {
  WORKBENCH_TRAY_ICON_SIZES,
  workbenchTrayIconPath,
} from '../../src/workbench-shell/electron/tray-icon.ts';
import { OFFSCREEN_PLACEMENT_ARGUMENT } from '../../src/workbench-shell/electron/window-placement.ts';
import {
  composerFeedbackCopy,
  pickerCopy,
} from '../../src/workbench-shell/renderer/copy/composer-copy.ts';
import { runtimeInstallCopy } from '../../src/workbench-shell/renderer/copy/runtime-lookup-copy.ts';
import { toolsCopy } from '../../src/workbench-shell/renderer/copy/settings-copy.ts';
import { stageCopy } from '../../src/workbench-shell/renderer/copy/stage-copy.ts';
import { captureProcessTree, waitForProcessTreeExit } from './process-tree.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';

/* Three Vite builds and @electron/packager copying a ~200 MB Electron plus the
   asar. 15 s on the machine this was written on; a hosted runner's cold disk and
   AV scanning make the same steps several times slower, and a runner whose
   pnpm install did not leave the Electron zip in @electron/get's cache also
   downloads 110 MB here. 8 minutes still separates "did the work" from "hung",
   and every step reports its own elapsed time so a slow machine and a stuck one
   read differently. */
const PACKAGE_TIMEOUT_MS = 480_000;
/* The start.bat smoke reaches its offscreen window inside 90 s on a hosted
   runner; the packaged exe has no build in front of it, so 120 s is generous. */
const LAUNCH_TIMEOUT_MS = 120_000;
const INTERACTION_TIMEOUT_MS = 30_000;
const QUIT_TIMEOUT_MS = 30_000;
const SMOKE_TIMEOUT_MS = 300_000;

const productName = 'Synchronized Intellect Network';
const applicationDirectory = path.join(
  repositoryRoot,
  'dist',
  'local-windows-package',
  `${productName}-win32-x64`,
);
const packagedExecutable = path.join(applicationDirectory, `${productName}.exe`);

/** Set by the packaging test; the smoke refuses to run against a stale exe. */
let packaged = null;

function runStep(label, executable, args, timeoutMs, environment) {
  const started = performance.now();
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
    ...(environment === undefined ? {} : { env: environment }),
  });
  return {
    label,
    elapsedMs: Math.round(performance.now() - started),
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Prefer the explicitly supplied lane root, then the runner root, then the
 * operating system temporary directory. `--user-data-dir` must remain one
 * Electron argument all the way to the packaged executable, so a path with
 * spaces is converted to its Windows short spelling before the existing
 * space-free assertion and directory creation.
 */
function smokeScratchParent() {
  const configuredParent = process.env.UAW_LANE_SCRATCH || process.env.RUNNER_TEMP || os.tmpdir();
  const parent = /\s/u.test(configuredParent)
    ? shortWindowsPath(configuredParent)
    : configuredParent;
  assert.ok(parent !== undefined && parent.length > 0, 'packaged smoke scratch root is not configured');
  assert.doesNotMatch(parent, /\s/u, `packaged smoke scratch root contains spaces: ${parent}`);
  fs.mkdirSync(parent, { recursive: true });
  // Preserve the spelling that was checked above: Windows may expand an 8.3
  // path to its long form when resolving a real path, reintroducing spaces.
  return parent;
}

function shortWindowsPath(parent) {
  const result = spawnSync(
    process.env.ComSpec ?? path.join(systemRoot, 'System32', 'cmd.exe'),
    ['/d', '/s', '/c', `for %I in ("${parent}") do @echo %~sI`],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, `could not derive Windows short path for packaged smoke scratch root: ${parent}`);
  return (result.stdout ?? '').trim();
}

function packagingEnvironment() {
  const temporaryDirectory = smokeScratchParent();
  return {
    ...process.env,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
  };
}

function describeStep(step) {
  return (
    `${step.label}: status=${String(step.status)} signal=${step.signal ?? 'none'} ` +
    `elapsed=${String(step.elapsedMs)}ms` +
    (step.error === undefined ? '' : ` error=${step.error.message}`)
  );
}

function assertStepSucceeded(step) {
  assert.equal(
    step.status,
    0,
    `${describeStep(step)}\n--- stdout ---\n${step.stdout}\n--- stderr ---\n${step.stderr}`,
  );
}

test(
  'the packaging command produces the Windows executable with app.asar',
  { timeout: PACKAGE_TIMEOUT_MS },
  (t) => {
    // Exercise the public packaging entry point rather than reproducing its
    // current expansion. The committed wrapper is needed on this workstation;
    // CI installs pnpm before the shard and invokes its PATH command.
    const packageManager = process.env.GITHUB_ACTIONS === 'true' ? 'pnpm' : '.\\pnpm.bat';
    const packageStep = runStep(
      `${packageManager} workbench:package:windows`,
      process.env.ComSpec ?? path.join(systemRoot, 'System32', 'cmd.exe'),
      ['/d', '/s', '/c', `${packageManager} workbench:package:windows`],
      PACKAGE_TIMEOUT_MS,
      packagingEnvironment(),
    );
    t.diagnostic(describeStep(packageStep));
    assertStepSucceeded(packageStep);
    assert.match(packageStep.stdout, /local Windows x64 package ready \(\d+ staged files\)/u);

    assert.ok(fs.existsSync(packagedExecutable), `missing ${packagedExecutable}`);
    const asar = path.join(applicationDirectory, 'resources', 'app.asar');
    assert.ok(fs.existsSync(asar), `missing ${asar}`);
    t.diagnostic(`packaging total: elapsed=${String(packageStep.elapsedMs)}ms limit=${String(PACKAGE_TIMEOUT_MS)}ms`);
    packaged = Object.freeze({ executable: packagedExecutable, totalMs: packageStep.elapsedMs });
  },
);

/**
 * A fresh, space-free scratch root, laid out like an empty Windows user
 * profile. The isolated profile is passed explicitly to Electron; APPDATA and
 * LOCALAPPDATA redirect the remaining process reads. Electron's `appData`
 * known folder itself is diagnostic only -- it is not an isolation mechanism.
 * Removed after the smoke; an EPERM from a handle Windows has not released
 * yet is reported, not failed on, exactly as the start.bat smoke does.
 */
function createScratch(t) {
  const parent = smokeScratchParent();
  const scratch = path.join(
    parent,
    `uaw-packaged-smoke-${String(process.pid)}-${Date.now().toString(36)}`,
  );
  const layout = scratchLayout(scratch);
  for (const directory of [
    layout.profile,
    layout.local,
    layout.temp,
    layout.codex,
    layout.claude,
    layout.projects,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  t.after(() => {
    try {
      fs.rmSync(scratch, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
      if (code === 'EPERM') {
        t.diagnostic(`packaged smoke cleanup could not remove path="${scratch}" code=${code}`);
        return;
      }
      throw error;
    }
  });
  return layout;
}

function scratchLayout(scratch) {
  const home = path.join(scratch, 'home');
  const roaming = path.join(home, 'AppData', 'Roaming');
  return Object.freeze({
    scratch,
    home,
    roaming,
    local: path.join(home, 'AppData', 'Local'),
    profile: path.join(roaming, 'profile'),
    temp: path.join(scratch, 'temp'),
    codex: path.join(scratch, 'codex'),
    claude: path.join(scratch, 'claude'),
    projects: path.join(scratch, 'projects'),
  });
}

/**
 * The child environment: everything the test process has except the locations
 * a first run reads and every provider credential, then the redirected
 * locations. PATH is System32 alone -- a stranger's machine has no node, no
 * pnpm and no CLI, and the packaged exe must start without any of them.
 */
function isolatedEnvironment(layout) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !/^(PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|CODEX_HOME|CLAUDE_CONFIG_DIR)$/iu.test(key) &&
      !/(ANTHROPIC|CLAUDE|CODEX|OPENAI|GLM|KIMI|MOONSHOT|DEEPSEEK|ZHIPU|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PASSWORD|SECRET|TOKEN)/iu.test(key)
    ) {
      environment[key] = value;
    }
  }
  Object.assign(environment, {
    PATH: `${path.join(systemRoot, 'System32')};${systemRoot}`,
    HOME: layout.home,
    USERPROFILE: layout.home,
    HOMEDRIVE: path.parse(layout.home).root.slice(0, 2),
    HOMEPATH: layout.home.slice(2),
    APPDATA: layout.roaming,
    LOCALAPPDATA: layout.local,
    TEMP: layout.temp,
    TMP: layout.temp,
    TMPDIR: layout.temp,
    CODEX_HOME: layout.codex,
    CLAUDE_CONFIG_DIR: layout.claude,
  });
  return environment;
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function intersectsDisplay(bounds, display) {
  return (
    bounds.x < display.x + display.width &&
    bounds.x + bounds.width > display.x &&
    bounds.y < display.y + display.height &&
    bounds.y + bounds.height > display.y
  );
}

/** The eight tray rasters, relative to the brand directory, named by the product's own rule. */
const trayRelativePaths = ['dark', 'light'].flatMap((variant) =>
  WORKBENCH_TRAY_ICON_SIZES.map((size) => workbenchTrayIconPath('tray', variant, size)),
);

test(
  'the packaged executable starts isolated and offscreen with its brand assets, tray, honest bootstrap copy and Tools card',
  { timeout: SMOKE_TIMEOUT_MS },
  async (t) => {
    assert.notEqual(packaged, null, 'the packaging test did not produce an executable; not starting a stale one');
    const layout = createScratch(t);
    const { profile } = layout;
    const environment = isolatedEnvironment(layout);
    let stdout = '';
    let stderr = '';
    const transcript = () => `--- exe stdout ---\n${stdout}\n--- exe stderr ---\n${stderr}`;

    const launchStarted = performance.now();
    const application = await electron.launch({
      executablePath: packaged.executable,
      args: [`--user-data-dir=${profile}`, OFFSCREEN_PLACEMENT_ARGUMENT],
      cwd: layout.projects,
      env: environment,
      timeout: LAUNCH_TIMEOUT_MS,
    });
    const rootPid = application.process().pid;
    application.process().stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    application.process().stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    let quit = 'not attempted';
    let remaining = [];
    try {
      const page = await application.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
      await page.waitForLoadState('domcontentloaded');
      page.setDefaultTimeout(INTERACTION_TIMEOUT_MS);
      const card = page.locator('.empty-project-card');
      // The empty-Project card only renders once the main process has served
      // the project view, which it does after the tray has been created, so
      // everything the main-process probe reads below is settled by now.
      await card.locator('h1').waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      t.diagnostic(
        `packaged start: first window and empty-Project card in ${String(Math.round(performance.now() - launchStarted))}ms limit=${String(LAUNCH_TIMEOUT_MS)}ms`,
      );

      const runtime = await application.evaluate(
        ({ app, BrowserWindow, screen, nativeImage, Tray }, trayPaths) => {
          const nodePath = process.getBuiltinModule('node:path');
          const nodeFs = process.getBuiltinModule('node:fs');
          const v8 = process.getBuiltinModule('node:v8');
          // The same derivation main.ts uses for the window icon and the tray
          // rasters: the application root (app.asar for a packaged exe) plus
          // assets/brand.
          const appPath = app.getAppPath();
          const brandAssetsDirectory = nodePath.join(appPath, 'assets', 'brand');
          const describeImage = (file) => ({
            path: file,
            exists: nodeFs.existsSync(file),
            empty: nativeImage.createFromPath(file).isEmpty(),
          });
          return {
            pid: process.pid,
            packaged: app.isPackaged,
            appPath,
            userData: app.getPath('userData'),
            appData: app.getPath('appData'),
            windows: BrowserWindow.getAllWindows().map((window) => ({
              bounds: window.getBounds(),
              focusable: window.isFocusable(),
              focused: window.isFocused(),
              visible: window.isVisible(),
              title: window.getTitle(),
            })),
            displays: screen.getAllDisplays().map((display) => display.bounds),
            windowIcon: describeImage(nodePath.join(brandAssetsDirectory, 'sin.ico')),
            trayImages: trayPaths.map((relative) =>
              describeImage(nodePath.join(brandAssetsDirectory, relative)),
            ),
            // Electron exposes a native/wrapper pair per tray, so the signal is
            // zero versus non-zero, not the count (w258).
            trayObjectCount: v8.queryObjects(Tray, { format: 'count' }),
          };
        },
        trayRelativePaths,
      );
      const runtimeText = JSON.stringify(runtime, null, 2);

      // Safety before anything else: the exact isolated profile and no window
      // anywhere the owner can see or focus. Failing here stops the smoke
      // before it touches the page.
      assert.ok(samePath(runtime.userData, profile), `userData is not the isolated profile\n${runtimeText}`);
      assert.equal(runtime.windows.length, 1, `expected exactly one window\n${runtimeText}\n${transcript()}`);
      for (const window of runtime.windows) {
        assert.equal(window.focusable, false, `an offscreen window must not be focusable\n${runtimeText}`);
        assert.equal(window.focused, false, `an offscreen window must not hold focus\n${runtimeText}`);
        assert.equal(window.visible, true, `the window must be shown (offscreen), not hidden\n${runtimeText}`);
        assert.ok(
          runtime.displays.length > 0 &&
            runtime.displays.every((display) => !intersectsDisplay(window.bounds, display)),
          `the window intersects a display\n${runtimeText}`,
        );
      }

      await t.test('the main process is packaged, rooted at app.asar, and resolved its brand assets and tray', () => {
        assert.equal(runtime.packaged, true, runtimeText);
        assert.equal(path.basename(runtime.appPath), 'app.asar', runtimeText);
        assert.equal(runtime.windows[0].title, productName, runtimeText);
        assert.ok(
          runtime.windowIcon.exists && !runtime.windowIcon.empty,
          `window icon missing or unreadable inside app.asar\n${runtimeText}`,
        );
        assert.equal(runtime.trayImages.length, 8, runtimeText);
        assert.ok(
          runtime.trayImages.every((image) => image.exists && !image.empty),
          `tray rasters missing or unreadable inside app.asar\n${runtimeText}`,
        );
        assert.ok(
          typeof runtime.trayObjectCount === 'number' && runtime.trayObjectCount > 0,
          `no live Tray object: the product's own tray creation failed\n${runtimeText}\n${transcript()}`,
        );
      });

      await t.test('the first-run bootstrap Project shows the honest copy once its catalog resolves', async () => {
        const title = card.locator('h1');
        const body = card.locator(':scope > p').first();
        const note = card.locator('p.control-note');
        t.diagnostic(`bootstrap card before the picker: title=${JSON.stringify(await title.textContent())}`);
        // The catalog is read when the endpoint picker opens; that read is the
        // uniform not-inspected shape only the bootstrap adapter produces, and
        // it swaps the empty-Project copy for the bootstrap copy (w283).
        const picker = page.locator('button#direct-runtime-endpoint');
        await picker.click();
        const popover = page.locator('#direct-profile-popover.popover-endpoint');
        await popover.waitFor();
        const started = performance.now();
        // Wait for the swap, then assert on the text itself so a miss reports
        // what the page actually says rather than a bare timeout.
        await title
          .filter({ hasText: stageCopy.bootstrapProjectTitle })
          .waitFor()
          .catch(() => undefined);
        t.diagnostic(`bootstrap copy settled ${String(Math.round(performance.now() - started))}ms after the picker opened`);
        assert.equal(await title.textContent(), stageCopy.bootstrapProjectTitle);
        assert.equal(await body.textContent(), stageCopy.bootstrapProjectBody);
        const noteText = await note.textContent();
        assert.equal(noteText, composerFeedbackCopy.bootstrapProjectUnavailable);
        assert.doesNotMatch(noteText, /try again/iu);
        assert.equal(await popover.locator('.picker-note').textContent(), pickerCopy.noSessionsHereNote);
        await page.keyboard.press('Escape');
        await popover.waitFor({ state: 'detached' });
      });

      await t.test('Settings carries the Tools card with a one-click install for each CLI', async () => {
        await page.locator('.settings-rail-button').click();
        const tools = page.locator('section.tools-settings');
        await tools.waitFor();
        assert.equal(await page.locator('#tools-title').textContent(), toolsCopy.heading);
        for (const [runtime, name, action] of [
          ['claude', toolsCopy.claudeName, runtimeInstallCopy.installActionClaude],
          ['codex', toolsCopy.codexName, runtimeInstallCopy.installActionCodex],
        ]) {
          const row = tools.locator(`#tool-${runtime}`);
          await row.waitFor();
          assert.equal(await row.locator('.ph-name').textContent(), name);
          const install = row.locator('.runtime-install button');
          assert.equal(await install.count(), 1, `${runtime}: expected one install button`);
          assert.equal(await install.textContent(), action);
          assert.equal(await install.isDisabled(), false, `${runtime}: install button is disabled`);
          // Never clicked: that would download a CLI.
        }
      });
    } finally {
      // Quit through the product (its graceful exit is part of what a
      // stranger gets), wait for the whole tree, and only then stop by pid --
      // never by name: eight lanes share this machine.
      const processTree = captureProcessTree(rootPid, t, 'packaged smoke');
      const quitStarted = performance.now();
      quit = await Promise.race([
        application.close().then(
          () => 'closed',
          (error) => `close rejected: ${error instanceof Error ? error.message : String(error)}`,
        ),
        new Promise((resolve) => {
          setTimeout(() => resolve('timeout'), QUIT_TIMEOUT_MS).unref();
        }),
      ]);
      t.diagnostic(
        `packaged quit: ${quit} in ${String(Math.round(performance.now() - quitStarted))}ms limit=${String(QUIT_TIMEOUT_MS)}ms`,
      );
      // What the exe said, green runs included, so a warning that starts
      // appearing on some machine is visible without a failure to unpack.
      t.diagnostic(
        `packaged exe stderr: ${stderr.trim().length === 0 ? 'empty' : JSON.stringify(stderr.trim().slice(0, 400))}`,
      );
      remaining = await waitForProcessTreeExit(t, processTree, 'packaged smoke');
      if (remaining.length > 0) {
        const stopped = spawnSync(
          path.join(systemRoot, 'System32', 'taskkill.exe'),
          ['/pid', String(rootPid), '/t', '/f'],
          { encoding: 'utf8', windowsHide: true },
        );
        t.diagnostic(
          `packaged smoke taskkill: status=${String(stopped.status)} ${`${stopped.stdout}\n${stopped.stderr}`.trim()}`,
        );
        remaining = await waitForProcessTreeExit(t, processTree, 'packaged smoke');
      }
    }
    assert.equal(quit, 'closed', `the packaged executable did not exit on quit\n${transcript()}`);
    assert.deepEqual(remaining, [], `process tree still alive after quit: ${remaining.join(',')}`);
  },
);
