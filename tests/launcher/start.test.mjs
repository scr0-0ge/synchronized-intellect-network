/**
 * start.bat is the whole onboarding path for a stranger: they clone, they
 * double-click, and either the app opens or a message tells them exactly what
 * to do next. Nothing else in this repository is exercised by someone who has
 * not yet read a line of it, so nothing else is worth this much protection.
 *
 * Every test here runs the real batch file through `cmd /c` with a PATH built
 * from scratch, because "what is on PATH" is the only input that matters and
 * inheriting the machine's PATH would make every assertion accidental — pnpm
 * and corepack both exist on a developer machine, and the tests that require
 * their absence would pass for the wrong reason. The fixture cases stub pnpm,
 * corepack, Vite and Electron. One production smoke deliberately starts the
 * installed Electron offscreen; every other case uses no network, installs
 * nothing, and never starts the app.
 *
 * Two things deserve their own note.
 *
 * The failure paths end in `pause`, so every run feeds a newline on stdin. A
 * launcher that vanishes before a double-click user can read why is the defect
 * those messages exist to prevent, and a suite that could not tolerate the wait
 * would have pushed us into deleting them.
 *
 * The node-version cases use a REAL node whose reported version is rewritten by
 * a NODE_OPTIONS preload. A stub cannot stand in: the launcher deliberately
 * looks for `node.exe` and runs it, and only a genuine node answers. So the
 * shipped refusal is measured against an actual 22.4.9 and an actual 22.5.0
 * rather than against a mock of itself.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const launcherSource = path.join(repositoryRoot, 'start.bat');
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const nodeArchiveName = 'node-v24.20.0-win-x64.zip';
const nodeArchiveBytes = new Map();

/* The launcher spawns at most five short-lived stubs plus, on the provisioning
   paths, two powershell.exe starts and a 110 MB extraction. 30s covered all of
   that on the machine this suite was written on, and nowhere else: on a clean
   GitHub runner the one-PowerShell case took 23s and every two-PowerShell case
   was killed at the limit -- which surfaces as `status: null`, reading like a
   wrong answer rather than the timeout it is. The limit is here to separate
   "did the work" from "hung", which is what an unanswered corepack download
   prompt would look like, and 120s still does that with room for a slow
   machine. Every failure message now carries the status, the kill signal and
   the elapsed time, so the two can never be confused again. */
const LAUNCHER_TIMEOUT_MS = 120_000;
const PRODUCTION_START_TIMEOUT_MS = 90_000;

function batch(...lines) {
  return [...lines, ''].join('\r\n');
}

/** Move a file's modification time `offsetMs` away from now. */
function touch(file, offsetMs) {
  const when = new Date(Date.now() + offsetMs);
  fs.utimesSync(file, when, when);
}

/**
 * The two node_modules/.bin entries the launcher requires. Written under
 * `base`, so the same helper builds both the fixture's real node_modules and
 * the `prepared/` copy that a stubbed install materialises.
 */
function writeDependencyStubs(base) {
  const bin = path.join(base, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });

  // Paths inside the stub are relative to the stub, so the same bytes work
  // whether they were written into the fixture or copied there by an install.
  fs.writeFileSync(
    path.join(bin, 'vite.CMD'),
    batch(
      '@echo off',
      'echo %*>>"%~dp0\\..\\..\\vite-calls.txt"',
      'if defined FAIL_BUILD echo %*| %SystemRoot%\\System32\\findstr.exe /c:"%FAIL_BUILD%" >nul',
      'if defined FAIL_BUILD if not errorlevel 1 exit /b 23',
      'if defined SKIP_ARTIFACT echo %*| %SystemRoot%\\System32\\findstr.exe /c:"%SKIP_ARTIFACT%" >nul',
      'if defined SKIP_ARTIFACT if not errorlevel 1 exit /b 0',
      'echo %*| %SystemRoot%\\System32\\findstr.exe /c:"vite.main.config.ts" >nul',
      'if not errorlevel 1 goto write_main',
      'echo %*| %SystemRoot%\\System32\\findstr.exe /c:"vite.preload.config.ts" >nul',
      'if not errorlevel 1 goto write_preload',
      'echo %*| %SystemRoot%\\System32\\findstr.exe /c:"vite.renderer.config.ts" >nul',
      'if not errorlevel 1 goto write_renderer',
      'exit /b 99',
      ':write_main',
      'if not exist "%~dp0\\..\\..\\dist\\main" md "%~dp0\\..\\..\\dist\\main"',
      '>"%~dp0\\..\\..\\dist\\main\\main.js" echo fresh main',
      'exit /b 0',
      ':write_preload',
      'if not exist "%~dp0\\..\\..\\dist\\preload" md "%~dp0\\..\\..\\dist\\preload"',
      '>"%~dp0\\..\\..\\dist\\preload\\preload.cjs" echo fresh preload',
      'exit /b 0',
      ':write_renderer',
      'if not exist "%~dp0\\..\\..\\dist\\renderer" md "%~dp0\\..\\..\\dist\\renderer"',
      '>"%~dp0\\..\\..\\dist\\renderer\\index.html" echo fresh renderer',
      'exit /b 0',
    ),
  );

  fs.writeFileSync(
    path.join(bin, 'electron.CMD'),
    batch('@echo off', '>"%~dp0\\..\\..\\electron-args.txt" echo %*', 'exit /b 0'),
  );

  // pnpm writes this at the end of an install. The launcher compares its
  // timestamp against pnpm-lock.yaml to decide whether the tree has moved on,
  // so a fixture without it is a fixture that always reinstalls.
  fs.writeFileSync(path.join(base, 'node_modules', '.modules.yaml'), 'stub\n');
}

/**
 * A repository fixture: the real start.bat, the vite configs it names, a
 * lockfile, and a `dist` pre-populated with stale content so the
 * delete-then-verify discipline has something to fail on.
 *
 * `prepared/node_modules` is always present. It is what a stubbed install
 * copies into place, which is how an install test can prove the launcher
 * carried on into a build that could not have run a moment earlier.
 */
function createFixture(t, { installed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sin-start-test-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  fs.copyFileSync(launcherSource, path.join(root, 'start.bat'));
  for (const config of ['main', 'preload', 'renderer']) {
    fs.writeFileSync(path.join(root, `vite.${config}.config.ts`), '// stub\n');
  }
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
  fs.mkdirSync(path.join(root, 'temp'), { recursive: true });

  for (const [directory, file] of [
    ['main', 'main.js'],
    ['preload', 'preload.cjs'],
    ['renderer', 'index.html'],
  ]) {
    fs.mkdirSync(path.join(root, 'dist', directory), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', directory, file), 'stale\n');
  }

  writeDependencyStubs(path.join(root, 'prepared'));
  if (installed) {
    writeDependencyStubs(root);
    // An installed fixture is an up-to-date one. Filesystem timestamp
    // resolution is coarse enough that "written second" is not reliably
    // "newer", so the marker is dated an hour ahead of the lockfile on purpose.
    touch(path.join(root, 'node_modules', '.modules.yaml'), 3_600_000);
  }

  // Whatever runs the install — pnpm from PATH or pnpm through corepack —
  // ends up here, so both package-manager stubs behave identically and the
  // tests below select the behaviour with one environment variable.
  fs.writeFileSync(
    path.join(root, 'install-stub.cmd'),
    batch(
      '@echo off',
      `>"${path.join(root, 'install-ran.txt')}" echo installed`,
      'if defined INSTALL_FAILS exit /b 7',
      'if defined INSTALL_WRITES_NOTHING exit /b 0',
      `xcopy "${path.join(root, 'prepared', 'node_modules')}" "${path.join(root, 'node_modules')}\\" /e /i /y /q >nul`,
      'exit /b 0',
    ),
  );

  return root;
}

/** A PATH directory holding exactly the tools a given test wants present. */
function createPathDirectory(root, { node = true, pnpm = false, corepack = false } = {}) {
  const directory = path.join(root, 'fake-path');
  fs.mkdirSync(directory, { recursive: true });

  if (node) fs.copyFileSync(process.execPath, path.join(directory, 'node.exe'));

  if (pnpm) {
    fs.writeFileSync(
      path.join(directory, 'pnpm.cmd'),
      batch(
        '@echo off',
        `>>"${path.join(root, 'pnpm-calls.txt')}" echo %*`,
        `call "${path.join(root, 'install-stub.cmd')}"`,
        'exit /b %ERRORLEVEL%',
      ),
    );
  }

  if (corepack) {
    fs.writeFileSync(
      path.join(directory, 'corepack.cmd'),
      batch(
        '@echo off',
        `>>"${path.join(root, 'corepack-calls.txt')}" echo %*`,
        `>>"${path.join(root, 'corepack-prompt.txt')}" echo COREPACK_ENABLE_DOWNLOAD_PROMPT=[%COREPACK_ENABLE_DOWNLOAD_PROMPT%]`,
        `call "${path.join(root, 'install-stub.cmd')}"`,
        'exit /b %ERRORLEVEL%',
      ),
    );
  }

  return directory;
}

/** A NODE_OPTIONS preload that makes a real node report `version` instead. */
function pretendNodeVersion(root, version) {
  const preload = path.join(root, `pretend-node-${version}.cjs`);
  fs.writeFileSync(
    preload,
    `if (process.execPath.replaceAll('\\\\', '/').toLowerCase().includes('/fake-path/')) {\n` +
      '  Object.defineProperty(process, "versions", {\n' +
      `    value: Object.freeze({ ...process.versions, node: ${JSON.stringify(version)} }),\n` +
      '    configurable: true,\n' +
      '  });\n' +
      '}\n',
  );
  return { NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"` };
}

/**
 * Make the exact archive shape published by nodejs.org, plus the corresponding
 * SHASUMS256.txt beside it. start.bat copies these local files instead of using
 * the network when SIN_NODE_ZIP_SOURCE is set.
 */
function createNodeArchive(root, { contents = 'node' } = {}) {
  const source = path.join(root, 'node-download-source');
  const packageRoot = path.join(source, 'package', 'node-v24.20.0-win-x64');
  fs.mkdirSync(source, { recursive: true });
  const archive = path.join(source, nodeArchiveName);

  if (contents === 'not-a-zip') {
    fs.writeFileSync(archive, 'this has a valid checksum but is not a zip\n');
  } else if (nodeArchiveBytes.has(contents)) {
    fs.writeFileSync(archive, nodeArchiveBytes.get(contents));
  } else {
    fs.mkdirSync(packageRoot, { recursive: true });
    if (contents === 'node') {
      fs.copyFileSync(process.execPath, path.join(packageRoot, 'node.exe'));
      fs.writeFileSync(
        path.join(packageRoot, 'corepack.cmd'),
        batch(
          '@echo off',
          '>>"%CD%\\corepack-calls.txt" echo %*',
          '>>"%CD%\\corepack-prompt.txt" echo COREPACK_ENABLE_DOWNLOAD_PROMPT=[%COREPACK_ENABLE_DOWNLOAD_PROMPT%]',
          'call "%CD%\\install-stub.cmd"',
          'exit /b %ERRORLEVEL%',
        ),
      );
    } else if (contents === 'broken-node') {
      fs.writeFileSync(path.join(packageRoot, 'node.exe'), 'not an executable\n');
    }

    const zipped = spawnSync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
          '[System.IO.Compression.ZipFile]::CreateFromDirectory(' +
          '$env:SIN_TEST_PACKAGE, $env:SIN_TEST_ARCHIVE, ' +
          '[System.IO.Compression.CompressionLevel]::Optimal, $true)',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          SIN_TEST_PACKAGE: path.join(source, 'package', 'node-v24.20.0-win-x64'),
          SIN_TEST_ARCHIVE: archive,
        },
        windowsHide: true,
      },
    );
    assert.equal(zipped.status, 0, output(zipped));
    nodeArchiveBytes.set(contents, fs.readFileSync(archive));
  }

  const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(path.join(source, 'SHASUMS256.txt'), `${digest}  ${nodeArchiveName}\n`);
  return archive;
}

/** A NODE_OPTIONS preload that makes a real node exit before it answers. */
function pretendNodeIsBroken(root) {
  const preload = path.join(root, 'pretend-node-broken.cjs');
  fs.writeFileSync(preload, 'process.exit(3);\n');
  return { NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"` };
}

function runLauncher(root, pathDirectory, { args = [], env = {} } = {}) {
  // Invoked by absolute path, never by bare name: cmd searches the current
  // directory only when NoDefaultCurrentDirectoryInExePath is unset, and it IS
  // set on machines this suite has to pass on.
  const started = performance.now();
  const result = spawnSync('cmd.exe', ['/d', '/c', path.join(root, 'start.bat'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      SystemRoot: systemRoot,
      windir: systemRoot,
      TEMP: path.join(root, 'temp'),
      TMP: path.join(root, 'temp'),
      LOCALAPPDATA: path.join(root, 'local-app-data'),
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      // The fake directory, and System32 for the findstr the vite stub uses.
      // Nothing else on the machine is reachable from inside the launcher.
      PATH: `${pathDirectory};${path.join(systemRoot, 'System32')}`,
      // A qualified PATH node must never consult this deliberately absent
      // source. Provisioning tests replace it with a local archive.
      SIN_NODE_ZIP_SOURCE: path.join(root, 'download-must-not-run.zip'),
      ...env,
    },
    input: '\r\n',
    timeout: LAUNCHER_TIMEOUT_MS,
    windowsHide: true,
  });
  result.elapsedMs = Math.round(performance.now() - started);
  return result;
}

/* A launcher killed at the limit reports `status: null`, and a bare
   `null !== 0` names neither the limit nor the signal. Every assertion in
   this file passes this string as its failure message, so the how travels
   with the what. */
function output(result) {
  const how =
    result.elapsedMs === undefined
      ? ''
      : `\n[launcher: status=${result.status} signal=${result.signal ?? 'none'} ` +
        `elapsed=${result.elapsedMs}ms limit=${LAUNCHER_TIMEOUT_MS}ms]`;
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}${how}`;
}

/* Provisioning is the only part of the launcher whose cost is a property of
   the machine rather than of the launcher: two powershell.exe starts and an
   extraction. Report it on every run, green included, so "it got slower" and
   "it started hanging" are told apart by a number instead of by a limit. */
function reportLauncherCost(t, result, label) {
  t.diagnostic(
    `${label === undefined ? 'launcher' : `launcher (${label})`}: ` +
      `status=${result.status} signal=${result.signal ?? 'none'} ` +
      `elapsed=${result.elapsedMs}ms limit=${LAUNCHER_TIMEOUT_MS}ms`,
  );
}

function readIfPresent(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

async function observeProductionStart(t) {
  const scratch = path.join(
    path.parse(repositoryRoot).root,
    `uaw-start-smoke-${String(process.pid)}-${Date.now().toString(36)}`,
  );
  const profile = path.join(scratch, 'profile');
  const fakeHome = path.join(scratch, 'home');
  const fakePath = path.join(scratch, 'path');
  for (const directory of [
    profile,
    fakeHome,
    fakePath,
    path.join(scratch, 'roaming'),
    path.join(scratch, 'local'),
    path.join(scratch, 'temp'),
    path.join(scratch, 'codex'),
    path.join(scratch, 'claude'),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  t.after(() =>
    fs.rmSync(scratch, {
      force: true,
      recursive: true,
      maxRetries: 20,
      retryDelay: 100,
    }),
  );

  // start.bat only needs to locate pnpm before it sees the current, complete
  // node_modules. If it unexpectedly attempts an install, make that a loud
  // failure rather than reaching a machine-global package manager.
  fs.writeFileSync(path.join(fakePath, 'pnpm.cmd'), batch('@echo off', 'exit /b 97'));

  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !/^(PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)$/iu.test(key) &&
      !/(ANTHROPIC|CLAUDE|CODEX|OPENAI|GLM|KIMI|MOONSHOT|DEEPSEEK|ZHIPU|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PASSWORD|SECRET|TOKEN)/iu.test(key)
    ) {
      environment[key] = value;
    }
  }
  Object.assign(environment, {
    PATH: `${path.dirname(process.execPath)};${fakePath};${path.join(systemRoot, 'System32')}`,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    HOMEDRIVE: path.parse(fakeHome).root.slice(0, 2),
    HOMEPATH: fakeHome.slice(2),
    APPDATA: path.join(scratch, 'roaming'),
    LOCALAPPDATA: path.join(scratch, 'local'),
    TEMP: path.join(scratch, 'temp'),
    TMP: path.join(scratch, 'temp'),
    TMPDIR: path.join(scratch, 'temp'),
    CODEX_HOME: path.join(scratch, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'),
    // Electron inherits this from some Node-hosted shells. The public launcher
    // must still start Electron as an app rather than as its embedded Node.
    ELECTRON_RUN_AS_NODE: '1',
  });

  const child = spawn(
    'cmd.exe',
    [
      '/d',
      '/c',
      launcherSource,
      `--user-data-dir=${profile}`,
      '--window-placement=offscreen',
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdin.end('\r\n');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdout = '';
  let stderr = '';
  let ready = false;
  let markReady;
  const readySignal = new Promise((resolve) => {
    markReady = resolve;
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!ready && /\[window-placement\] surface=main-window;offscreen@/u.test(stdout)) {
      ready = true;
      markReady({ kind: 'ready' });
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closeSignal = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ kind: 'exit', code, signal }));
  });
  const timeoutSignal = new Promise((resolve) => {
    setTimeout(() => resolve({ kind: 'timeout' }), PRODUCTION_START_TIMEOUT_MS).unref();
  });

  let outcome;
  try {
    outcome = await Promise.race([readySignal, closeSignal, timeoutSignal]);
    assert.notEqual(
      outcome.kind,
      'timeout',
      `production start did not reach the offscreen window in ${String(PRODUCTION_START_TIMEOUT_MS)}ms\n${stdout}\n${stderr}`,
    );
    if (outcome.kind === 'exit') {
      assert.notEqual(outcome.code, 1, `${stdout}\n${stderr}`);
      assert.fail(
        `production Electron exited before its offscreen main window (code=${String(outcome.code)} signal=${String(outcome.signal)})\n${stdout}\n${stderr}`,
      );
    }
    assert.doesNotMatch(stderr, /cjsPreparseModuleExports|TypeError: Cannot read properties of undefined \(reading 'exports'\)/u);
    assert.match(stdout, /build ok/u);
    assert.match(stdout, /\[window-placement\] surface=main-window;offscreen@/u);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = spawnSync(
        path.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/pid', String(child.pid), '/t', '/f'],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
      await closeSignal;
    }
  }

  return { stdout, stderr, outcome };
}

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test('a stranger with node and pnpm gets a fresh build and a started app', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });

  const result = runLauncher(root, pathDirectory);
  const text = output(result);

  assert.equal(result.status, 0, text);
  assert.match(text, /build ok/i);
  assert.match(text, /starting the app/i);

  assert.deepEqual(
    fs.readFileSync(path.join(root, 'vite-calls.txt'), 'utf8').trim().split(/\r?\n/),
    [
      'build --config vite.main.config.ts',
      'build --config vite.preload.config.ts',
      'build --config vite.renderer.config.ts',
    ],
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'dist', 'main', 'main.js'), 'utf8').trim(),
    'fresh main',
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'dist', 'preload', 'preload.cjs'), 'utf8').trim(),
    'fresh preload',
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'dist', 'renderer', 'index.html'), 'utf8').trim(),
    'fresh renderer',
  );

  // node_modules was already there, so no install ran.
  assert.equal(readIfPresent(path.join(root, 'install-ran.txt')), null, text);
  assert.ok(fs.existsSync(path.join(root, 'electron-args.txt')), text);
  assert.equal(
    fs.existsSync(path.join(root, 'local-app-data', 'synchronized-intellect-network', 'runtime', 'node')),
    false,
    'a qualified PATH node must not create or download a private runtime',
  );
});

test('the real electron . launch survives an inherited ELECTRON_RUN_AS_NODE and reaches its offscreen window', async (t) => {
  const observation = await observeProductionStart(t);
  assert.equal(observation.outcome.kind, 'ready', `${observation.stdout}\n${observation.stderr}`);
});

test('every argument reaches the app, so --user-data-dir keeps a throwaway profile', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });

  const result = runLauncher(root, pathDirectory, {
    args: ['--user-data-dir=C:\\sin-throwaway-profile'],
  });

  assert.equal(result.status, 0, output(result));
  assert.match(
    fs.readFileSync(path.join(root, 'electron-args.txt'), 'utf8'),
    /--user-data-dir=C:\\sin-throwaway-profile/,
  );
});

test("the app's exit code is the launcher's exit code", (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });
  fs.writeFileSync(
    path.join(root, 'node_modules', '.bin', 'electron.CMD'),
    batch('@echo off', 'exit /b 42'),
  );

  const result = runLauncher(root, pathDirectory);
  assert.equal(result.status, 42, output(result));
  assert.match(output(result), /exit code 42/i);
});

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------

test('a checkout with no node_modules installs from the lockfile, then builds', (t) => {
  const root = createFixture(t, { installed: false });
  const pathDirectory = createPathDirectory(root, { pnpm: true });

  const result = runLauncher(root, pathDirectory);
  const text = output(result);

  assert.equal(result.status, 0, text);
  assert.match(text, /installing dependencies from pnpm-lock\.yaml/i);
  assert.equal(fs.readFileSync(path.join(root, 'install-ran.txt'), 'utf8').trim(), 'installed');
  assert.match(
    fs.readFileSync(path.join(root, 'pnpm-calls.txt'), 'utf8'),
    /install --frozen-lockfile/,
  );
  assert.ok(fs.existsSync(path.join(root, 'electron-args.txt')), text);
});

test('a lockfile that has moved ahead of node_modules triggers a reinstall', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });
  // What `git pull` does: the lockfile becomes newer than the install marker.
  touch(path.join(root, 'pnpm-lock.yaml'), 7_200_000);

  const result = runLauncher(root, pathDirectory);
  const text = output(result);

  assert.equal(result.status, 0, text);
  assert.match(text, /installing dependencies from pnpm-lock\.yaml/i);
  assert.equal(fs.readFileSync(path.join(root, 'install-ran.txt'), 'utf8').trim(), 'installed');
  assert.ok(fs.existsSync(path.join(root, 'electron-args.txt')), text);
});

test('a node_modules with no pnpm install marker is reinstalled rather than trusted', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });
  // What an `npm install` in this directory leaves behind: the binaries are
  // there, pnpm's own marker is not.
  fs.rmSync(path.join(root, 'node_modules', '.modules.yaml'));

  const result = runLauncher(root, pathDirectory);
  const text = output(result);

  assert.equal(result.status, 0, text);
  assert.equal(fs.readFileSync(path.join(root, 'install-ran.txt'), 'utf8').trim(), 'installed');
});

test('a failed install stops before the build and names the command it ran', (t) => {
  const root = createFixture(t, { installed: false });
  const pathDirectory = createPathDirectory(root, { pnpm: true });

  const result = runLauncher(root, pathDirectory, { env: { INSTALL_FAILS: '1' } });
  const text = output(result);

  assert.equal(result.status, 1, text);
  assert.match(text, /Installing dependencies failed/i);
  assert.match(text, /pnpm install --frozen-lockfile/i);
  assert.match(text, /pnpm-lock\.yaml/i);
  assert.equal(readIfPresent(path.join(root, 'vite-calls.txt')), null, text);
  assert.equal(readIfPresent(path.join(root, 'electron-args.txt')), null, text);
});

test('an install that exits 0 without producing node_modules is not treated as success', (t) => {
  const root = createFixture(t, { installed: false });
  const pathDirectory = createPathDirectory(root, { pnpm: true });

  const result = runLauncher(root, pathDirectory, { env: { INSTALL_WRITES_NOTHING: '1' } });
  const text = output(result);

  assert.equal(result.status, 1, text);
  assert.match(text, /node_modules is incomplete/i);
  assert.match(text, /vite\.CMD/i);
  assert.equal(readIfPresent(path.join(root, 'electron-args.txt')), null, text);
});

// ---------------------------------------------------------------------------
// pnpm, and the corepack path that stands in for it
// ---------------------------------------------------------------------------

test('with no pnpm on PATH the pinned pnpm runs through corepack, installing nothing globally', (t) => {
  const root = createFixture(t, { installed: false });
  const pathDirectory = createPathDirectory(root, { pnpm: false, corepack: true });

  const result = runLauncher(root, pathDirectory);
  const text = output(result);

  assert.equal(result.status, 0, text);
  assert.match(text, /corepack/i);
  assert.match(text, /nothing installed globally/i);

  // The ONLY corepack call is the one that runs pnpm for this project: no
  // `corepack enable`, no global install, nothing left on the machine.
  assert.deepEqual(
    fs.readFileSync(path.join(root, 'corepack-calls.txt'), 'utf8').trim().split(/\r?\n/),
    ['pnpm@11.20.0 install --frozen-lockfile'],
  );

  // corepack's first download asks an interactive y/n question unless this is
  // set, and an unanswered question in a double-clicked window is a silent hang.
  assert.match(
    fs.readFileSync(path.join(root, 'corepack-prompt.txt'), 'utf8'),
    /COREPACK_ENABLE_DOWNLOAD_PROMPT=\[0\]/,
  );
});

test('pnpm on PATH is preferred over corepack', (t) => {
  const root = createFixture(t, { installed: false });
  const pathDirectory = createPathDirectory(root, { pnpm: true, corepack: true });

  const result = runLauncher(root, pathDirectory);
  const text = output(result);

  assert.equal(result.status, 0, text);
  assert.ok(fs.existsSync(path.join(root, 'pnpm-calls.txt')), text);
  assert.equal(readIfPresent(path.join(root, 'corepack-calls.txt')), null, text);
});

test('no pnpm and no corepack names both, and where to get pnpm', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: false, corepack: false });

  const result = runLauncher(root, pathDirectory);
  const text = output(result);

  assert.equal(result.status, 1, text);
  assert.match(text, /Could not find pnpm/i);
  assert.match(text, /pnpm\.cmd, pnpm\.exe, pnpm\.bat on your PATH/i);
  assert.match(text, /corepack\.cmd on your PATH/i);
  assert.match(text, /https:\/\/pnpm\.io\/installation/i);
  assert.equal(readIfPresent(path.join(root, 'electron-args.txt')), null, text);
});

// ---------------------------------------------------------------------------
// node
// ---------------------------------------------------------------------------

test('no node on PATH provisions the private LTS runtime, then builds and starts', (t) => {
  const root = createFixture(t, { installed: false });
  const pathDirectory = createPathDirectory(root, { node: false, pnpm: false, corepack: false });
  const archive = createNodeArchive(root);

  const result = runLauncher(root, pathDirectory, { env: { SIN_NODE_ZIP_SOURCE: archive } });
  const text = output(result);
  reportLauncherCost(t, result);

  assert.equal(result.status, 0, text);
  assert.match(text, /node was not found on PATH/i);
  assert.match(text, /private Node 24\.20\.0 LTS/i);
  assert.match(text, /checksum verified/i);
  assert.match(text, /corepack/i);
  assert.match(text, /installing dependencies from pnpm-lock\.yaml/i);
  assert.match(text, /build ok/i);
  assert.ok(
    fs.existsSync(
      path.join(
        root,
        'local-app-data',
        'synchronized-intellect-network',
        'runtime',
        'node',
        'bin',
        'node.exe',
      ),
    ),
    text,
  );
  assert.equal(fs.readFileSync(path.join(root, 'install-ran.txt'), 'utf8').trim(), 'installed');
  assert.match(
    fs.readFileSync(path.join(root, 'corepack-calls.txt'), 'utf8'),
    /pnpm@11\.20\.0 install --frozen-lockfile/,
  );
  assert.ok(fs.existsSync(path.join(root, 'electron-args.txt')), text);
});

test('a node.exe that cannot report a version is refused, not guessed at', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });

  const result = runLauncher(root, pathDirectory, { env: pretendNodeIsBroken(root) });
  const text = output(result);

  assert.equal(result.status, 1, text);
  assert.match(text, /could not tell me its version/i);
  assert.match(text, /https:\/\/nodejs\.org/i);
  assert.equal(readIfPresent(path.join(root, 'electron-args.txt')), null, text);
});

test('a node older than 22.5 is left untouched while the private LTS runtime is used', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });
  const archive = createNodeArchive(root);

  const result = runLauncher(root, pathDirectory, {
    env: { ...pretendNodeVersion(root, '22.4.9'), SIN_NODE_ZIP_SOURCE: archive },
  });
  const text = output(result);
  reportLauncherCost(t, result);

  assert.equal(result.status, 0, text);
  assert.match(text, /node 22\.4\.9 on PATH is too old/i);
  assert.match(text, /node:sqlite/i);
  assert.match(text, /using private Node 24\.20\.0 LTS/i);
  assert.ok(fs.existsSync(path.join(pathDirectory, 'node.exe')), text);
  assert.ok(fs.existsSync(path.join(root, 'electron-args.txt')), text);
});

test('an older major also falls back to the private LTS runtime', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });
  const archive = createNodeArchive(root);

  const result = runLauncher(root, pathDirectory, {
    env: { ...pretendNodeVersion(root, '20.19.0'), SIN_NODE_ZIP_SOURCE: archive },
  });
  const text = output(result);
  reportLauncherCost(t, result);

  assert.equal(result.status, 0, text);
  assert.match(text, /node 20\.19\.0 on PATH is too old/i);
  assert.ok(fs.existsSync(path.join(root, 'electron-args.txt')), text);
});

test('a validated private runtime is reused without touching the download source', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { node: false, pnpm: true });
  const archive = createNodeArchive(root);

  const first = runLauncher(root, pathDirectory, { env: { SIN_NODE_ZIP_SOURCE: archive } });
  assert.equal(first.status, 0, output(first));

  fs.rmSync(path.dirname(archive), { force: true, recursive: true });
  fs.rmSync(path.join(root, 'electron-args.txt'));
  const second = runLauncher(root, pathDirectory, { env: { SIN_NODE_ZIP_SOURCE: archive } });

  reportLauncherCost(t, first, 'first');
  reportLauncherCost(t, second, 'second');
  assert.equal(second.status, 0, output(second));
  assert.match(output(second), /cached private Node/i);
  assert.ok(fs.existsSync(path.join(root, 'electron-args.txt')), output(second));
});

test('a checksum mismatch is refused before the downloaded node can execute', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { node: false, pnpm: true });
  const archive = createNodeArchive(root);
  const executionMarker = path.join(root, 'downloaded-node-executed.txt');
  const markerPreload = path.join(root, 'mark-node-execution.cjs');
  fs.writeFileSync(
    markerPreload,
    `require('node:fs').writeFileSync(${JSON.stringify(executionMarker)}, 'executed\\n');\n`,
  );
  fs.writeFileSync(path.join(path.dirname(archive), 'SHASUMS256.txt'), `${'0'.repeat(64)}  ${nodeArchiveName}\n`);

  const result = runLauncher(root, pathDirectory, {
    env: {
      NODE_OPTIONS: `--require "${markerPreload.replaceAll('\\', '/')}"`,
      SIN_NODE_ZIP_SOURCE: archive,
    },
  });
  const text = output(result);

  assert.equal(result.status, 1, text);
  assert.match(text, /SHA-256 checksum did not match/i);
  assert.match(text, /https:\/\/nodejs\.org\/dist\/v24\.20\.0\/SHASUMS256\.txt/i);
  assert.equal(readIfPresent(executionMarker), null, 'the unverified node.exe was executed');
  assert.equal(readIfPresent(path.join(root, 'electron-args.txt')), null, text);
});

test('a missing download source explains the failed fetch and official destination', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { node: false, pnpm: true });

  const result = runLauncher(root, pathDirectory);
  const text = output(result);

  assert.equal(result.status, 1, text);
  assert.match(text, /Node zip could not be downloaded or copied/i);
  assert.match(text, /https:\/\/nodejs\.org\/dist\/v24\.20\.0\/node-v24\.20\.0-win-x64\.zip/i);
  assert.equal(readIfPresent(path.join(root, 'electron-args.txt')), null, text);
});

test('a verified file that is not a zip reports extraction failure', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { node: false, pnpm: true });
  const archive = createNodeArchive(root, { contents: 'not-a-zip' });

  const result = runLauncher(root, pathDirectory, { env: { SIN_NODE_ZIP_SOURCE: archive } });
  const text = output(result);
  reportLauncherCost(t, result);

  assert.equal(result.status, 1, text);
  assert.match(text, /verified Node zip could not be extracted into the private cache/i);
  assert.equal(readIfPresent(path.join(root, 'electron-args.txt')), null, text);
});

test('an archive that has no working node is refused after extraction', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { node: false, pnpm: true });
  const archive = createNodeArchive(root, { contents: 'broken-node' });

  const result = runLauncher(root, pathDirectory, { env: { SIN_NODE_ZIP_SOURCE: archive } });
  const text = output(result);
  reportLauncherCost(t, result);

  assert.equal(result.status, 1, text);
  assert.match(text, /archive did not contain a working node\.exe/i);
  assert.match(text, /private cache/i);
  assert.equal(readIfPresent(path.join(root, 'electron-args.txt')), null, text);
});

test('22.5.0 is accepted: the boundary is inclusive', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });

  const result = runLauncher(root, pathDirectory, { env: pretendNodeVersion(root, '22.5.0') });
  const text = output(result);

  assert.equal(result.status, 0, text);
  assert.match(text, /node\s+22\.5\.0/i);
  assert.ok(fs.existsSync(path.join(root, 'electron-args.txt')), text);
});

test('a newer major is accepted', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });

  const result = runLauncher(root, pathDirectory, { env: pretendNodeVersion(root, '25.0.0') });

  assert.equal(result.status, 0, output(result));
  assert.ok(fs.existsSync(path.join(root, 'electron-args.txt')), output(result));
});

// ---------------------------------------------------------------------------
// the build discipline borrowed from the private launcher
// ---------------------------------------------------------------------------

for (const stage of ['main', 'preload', 'renderer']) {
  test(`a stale dist cannot hide a failed ${stage} build`, (t) => {
    const root = createFixture(t);
    const pathDirectory = createPathDirectory(root, { pnpm: true });

    const result = runLauncher(root, pathDirectory, {
      env: { FAIL_BUILD: `vite.${stage}.config.ts` },
    });
    const text = output(result);

    assert.equal(result.status, 1, text);
    assert.match(text, new RegExp(`${stage} bundle failed to build`, 'i'));
    assert.equal(readIfPresent(path.join(root, 'electron-args.txt')), null, text);
  });

  test(`a zero-exit ${stage} build that writes nothing is caught`, (t) => {
    const root = createFixture(t);
    const pathDirectory = createPathDirectory(root, { pnpm: true });

    const result = runLauncher(root, pathDirectory, {
      env: { SKIP_ARTIFACT: `vite.${stage}.config.ts` },
    });
    const text = output(result);

    assert.equal(result.status, 1, text);
    assert.match(text, new RegExp(`${stage} build exited 0 but wrote no`, 'i'));
    assert.equal(readIfPresent(path.join(root, 'electron-args.txt')), null, text);
  });
}

test('a node or pnpm sitting in the repository root cannot shadow the ones on PATH', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });
  fs.writeFileSync(
    path.join(root, 'node.cmd'),
    batch('@echo off', `>"${path.join(root, 'shadow-node.txt')}" echo shadowed`, 'exit /b 0'),
  );
  fs.writeFileSync(
    path.join(root, 'pnpm.cmd'),
    batch('@echo off', `>"${path.join(root, 'shadow-pnpm.txt')}" echo shadowed`, 'exit /b 0'),
  );

  const result = runLauncher(root, pathDirectory);
  const text = output(result);

  assert.equal(result.status, 0, text);
  assert.equal(readIfPresent(path.join(root, 'shadow-node.txt')), null, text);
  assert.equal(readIfPresent(path.join(root, 'shadow-pnpm.txt')), null, text);
});

// ---------------------------------------------------------------------------
// the promises the file itself makes
// ---------------------------------------------------------------------------

test('the launcher installs nothing globally and changes no machine setting', () => {
  const source = fs.readFileSync(launcherSource, 'utf8');

  for (const forbidden of [
    /install\s+-g\b/i,
    /--global\b/i,
    /\bsetx\b/i,
    /\breg(\.exe)?\s+add\b/i,
    /corepack\s+enable\b/i,
    /npm\s+i(nstall)?\s+.*-g\b/i,
  ]) {
    assert.equal(forbidden.test(source), false, `start.bat must never do this: ${String(forbidden)}`);
  }

  // NoDefaultCurrentDirectoryInExePath is set for this process and its
  // children only. `setx`, which would write it into the user's environment
  // permanently, is forbidden above; this pins that the safe form is the one
  // actually used.
  assert.match(source, /set "NoDefaultCurrentDirectoryInExePath=1"/);
});

test('every failure path waits for the reader before the window closes', () => {
  const lines = fs.readFileSync(launcherSource, 'utf8').split(/\r?\n/);

  const failureExits = [];
  lines.forEach((line, index) => {
    if (line.trim() === 'exit /b 1') failureExits.push(index);
  });
  assert.ok(failureExits.length >= 5, `expected several failure exits, found ${failureExits.length}`);
  for (const index of failureExits) {
    const preceding = lines.slice(Math.max(0, index - 3), index).map((line) => line.trim());
    assert.ok(
      preceding.includes('pause'),
      `the failure exit at line ${String(index + 1)} does not pause first:\n${preceding.join('\n')}`,
    );
  }
});

test('a crashing app leaves its window open too', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });
  fs.writeFileSync(
    path.join(root, 'node_modules', '.bin', 'electron.CMD'),
    batch('@echo off', 'echo THE APP SAID SOMETHING 1>&2', 'exit /b 9'),
  );

  const result = runLauncher(root, pathDirectory);
  const text = output(result);

  assert.equal(result.status, 9, text);
  assert.match(text, /exit code 9/i);
  // `pause` writes its own prompt, and reaching it is the whole assertion: a
  // double-clicked window that closes on a crash shows the reader nothing. The
  // prompt is localised AND written in the console code page rather than UTF-8,
  // so matching its words would pin this suite to one Windows display language.
  // The trailing ". . . " is the part every localisation keeps.
  assert.match(text, /\. \. \. /u, "the launcher did not pause after the app crashed");
  // And the source says so plainly, independent of any console encoding.
  assert.match(
    fs.readFileSync(launcherSource, "utf8"),
    /if not "%APPEXIT%"=="0" pause/u,
  );
});

test('a clean exit does not make the reader press a key', (t) => {
  const root = createFixture(t);
  const pathDirectory = createPathDirectory(root, { pnpm: true });

  const result = runLauncher(root, pathDirectory);
  const text = output(result);

  assert.equal(result.status, 0, text);
  assert.doesNotMatch(text, /\. \. \. /u, "a successful run must not stop for a keypress");
});

test('the repository folder is entered in a way a network path survives', () => {
  const source = fs.readFileSync(launcherSource, 'utf8');

  // `cd /d` cannot enter a UNC path: it prints one line, sets ERRORLEVEL and
  // leaves the shell in C:\Windows, where every relative path in this file
  // would then resolve. That failure is silent, which is why it is pinned here
  // rather than left to a reviewer to notice.
  assert.equal(/^cd \/d /mu.test(source), false, 'cd /d cannot enter a UNC path');
  assert.match(source, /pushd "%~dp0"/u);
  assert.match(source, /pushd "%~dp0"\r?\nif errorlevel 1 goto nodirectory/u);
  assert.match(source, /:nodirectory/u);
});

test('the launcher is CRLF throughout, as a batch file must be', () => {
  const text = fs.readFileSync(launcherSource).toString('latin1');
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  assert.ok(crlf > 100, `expected a CRLF file, counted ${String(crlf)}`);
  assert.equal(bareLf, 0, 'a bare LF in a batch file breaks goto on some hosts');
});

test('the launcher carries the product name a person sees', () => {
  const source = fs.readFileSync(launcherSource, 'utf8');
  assert.match(source, /title Synchronized Intellect Network/);
  assert.equal(/Unified Agent Workbench/.test(source), false);
});
