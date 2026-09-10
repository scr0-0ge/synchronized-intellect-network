import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createHistoricalRecoveryLibrary, platformOwnerOnlyStorage } from "../../src/workbench-shell/history-recovery.ts";
import { readHistoricalRecoveryInventory } from "../../src/workbench-shell/history-recovery-private-reader.ts";
import { createProductionHistoryRecoverySourceDiscovery } from "../../src/workbench-shell/electron/history-recovery-source-discovery.ts";
import { startProjectHostAfterRecoveryPreparation } from "../../src/workbench-shell/electron/startup.ts";
import { createTestDirectory, registerTestClosable } from "../helpers/test-lifecycle.ts";
import { createSyntheticStore, directoryManifest, syntheticLedgerSlot } from "./fixtures/synthetic-history-recovery-fixtures.ts";

const execFileAsync = promisify(execFile);
const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const successfulOwnerOnlyStorage = Object.freeze({
  async establish() {},
  async verify() { return true; },
});

test("Windows private-reader disposable copies inherit only the protected intake user's ACL", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await createTestDirectory(t, join(realpathSync(tmpdir()), "acl56-reader-"));
  const storage = platformOwnerOnlyStorage();
  await storage.establish(root, "directory");
  assert.equal(await storage.verify(root, "directory"), true);
  const source = await createSyntheticStore(join(root, "capture", "raw"), 2);
  const before = await directoryManifest(source.root);
  let observed = false;
  const inventory = await readHistoricalRecoveryInventory(source.root, {
    deadline: Date.now() + 30_000,
    disposableParent: root,
    now() {
      if (!observed) {
        const reader = readdirSync(root).find((name) => name.startsWith("reader-"));
        if (reader && existsSync(join(root, reader, "copy", "project-ledgers", `${syntheticLedgerSlot}.sqlite`))) {
          const output = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
            $ErrorActionPreference = 'Stop'
            $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            $items = @((Get-Item -LiteralPath $env:UAW_ACL_TEST_ROOT)) + @(Get-ChildItem -LiteralPath $env:UAW_ACL_TEST_ROOT -Recurse -Force)
            $records = @(foreach ($item in $items) {
              $acl = $item.GetAccessControl()
              $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
              if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid -or $rules[0].FileSystemRights -ne 'FullControl' -or $rules[0].AccessControlType -ne 'Allow') { throw 'disposable-not-owner-only' }
              [pscustomobject]@{ path = $item.FullName; sddl = $acl.Sddl }
            })
            ConvertTo-Json -InputObject $records -Compress
          `], { windowsHide: true, encoding: "utf8", env: { ...process.env, UAW_ACL_TEST_ROOT: join(root, reader) } });
          t.diagnostic(output.trim());
          observed = true;
        }
      }
      return Date.now();
    },
  });
  assert.equal(observed, true, "inspect the actual disposable bytes while the private reader is using them");
  assert.equal(inventory.counts.sessions, 1);
  assert.deepEqual(await directoryManifest(source.root), before);
  assert.deepEqual(readdirSync(root), ["capture"]);
});

test("Windows ACL readback rejects other-user grants, missing objects and wrong kinds and establish repairs grants", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await createTestDirectory(t, join(realpathSync(tmpdir()), "acl56-tamper-"));
  const path = join(root, "用户's [ACL] & test");
  await mkdir(path);
  const storage = platformOwnerOnlyStorage();
  assert.equal(await storage.verify(path, "directory"), false);
  await storage.establish(path, "directory");
  assert.equal(await storage.verify(path, "directory"), true);
  const file = join(path, "synthetic.txt");
  await writeFile(file, "synthetic bytes only");
  await storage.establish(file, "file");
  assert.equal(await storage.verify(file, "file"), true);
  for (const [target, kind] of [[path, "directory"], [file, "file"]] as const) {
    await execFileAsync("icacls.exe", [target, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
    assert.equal(await storage.verify(target, kind), false);
    await storage.establish(target, kind);
    assert.equal(await storage.verify(target, kind), true);
  }
  assert.equal(await storage.verify(path, "file"), false);
  await assert.rejects(storage.establish(file, "directory"));
  assert.equal(await storage.verify(join(root, "missing"), "file"), false);
  await assert.rejects(storage.establish(join(root, "missing"), "file"));
});

test("owner-only postconditions do not pay a PowerShell start each", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await createTestDirectory(t, join(realpathSync(tmpdir()), "acl127-reuse-"));
  const storage = platformOwnerOnlyStorage();
  // One start is unavoidable, and it is not what this measures.
  await storage.establish(root, "directory");
  const before = performance.now();
  for (let index = 0; index < 20; index += 1) {
    assert.equal(await storage.verify(root, "directory"), true);
  }
  const elapsed = performance.now() - before;
  t.diagnostic(`20 owner-only read-backs in ${Math.round(elapsed)} ms`);
  // A single powershell.exe start measured 418-833 ms on this machine, so a
  // process per assertion cannot come in under eight seconds. Reading one
  // descriptor twenty times is milliseconds of real work; the budget is loose
  // enough for a loaded machine and still far below a start per call. A launch
  // asks for 42 of these, which is where the black screen came from.
  assert.equal(elapsed < 4_000, true, `20 read-backs took ${Math.round(elapsed)} ms`);
});

for (const failure of ["establish", "verify"] as const) {
  test(`owner-only ${failure} failure stops discovery and reports the protection failure without private details`, async (t) => {
    const root = await createTestDirectory(t, join(realpathSync(tmpdir()), "acl56-failure-"));
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
    let discoveries = 0;
    const library = createHistoricalRecoveryLibrary({
      dataDirectory: join(root, "recovery"),
      sourceDiscovery: { async discover() { discoveries += 1; return []; } },
      exportChooser: { async choose() { throw new Error("must not run"); } },
      ownerOnlyStorage: {
        async establish() { if (failure === "establish") throw new Error("private native error"); },
        async verify() { return false; },
      },
    });
    registerTestClosable(t, library);
    assert.deepEqual(await library.prepareLaunch(), { status: "unavailable", sourceCount: 0, captureAttempts: 0 });
    assert.equal(discoveries, 0);
    assert.deepEqual(warnings, [["Historical recovery could not establish or verify owner-only storage protection; the affected recovery operation was stopped."]]);
  });
}

test("Windows production discovery captures current and stranded stores before startup", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await createTestDirectory(t, join(realpathSync(tmpdir()), "acl56-"));
  const currentUserDataDirectory = join(root, "synchronized-intellect-network");
  const current = await createSyntheticStore(join(currentUserDataDirectory, "workbench-project-host"), 2);
  const historical = await createSyntheticStore(join(root, "Electron", "workbench-project-host"), 2);
  const before = await Promise.all([directoryManifest(current.root), directoryManifest(historical.root)]);
  const discovery = createProductionHistoryRecoverySourceDiscovery({
    appDataDirectory: root,
    currentUserDataDirectory,
  });
  const dataDirectory = join(root, "recovery");
  let discoveries = 0;
  const events: string[] = [];
  const library = createHistoricalRecoveryLibrary({
    dataDirectory,
    sourceDiscovery: {
      async discover() {
        discoveries += 1;
        events.push("discover");
        return discovery.discover();
      },
    },
    exportChooser: { async choose() { throw new Error("chooser must not run"); } },
    ownerOnlyStorage: successfulOwnerOnlyStorage,
  });
  registerTestClosable(t, library);
  const preparation = await library.prepareLaunch();
  t.diagnostic(JSON.stringify({ preparation, discoveries }));
  assert.deepEqual(preparation, { status: "ready", sourceCount: 2, captureAttempts: 2 });
  await startProjectHostAfterRecoveryPreparation({
    prepareRecovery: () => library.prepareLaunch(),
    shutdownStarted: () => false,
    async startProjectHost() { events.push("start"); },
  });
  assert.deepEqual(events, ["discover", "start"]);
  const snapshot = await library.execute({}, { version: 1, requestKey: "windows-acl-snapshot" });
  assert.ok("kind" in snapshot);
  assert.equal(snapshot.kind, "snapshot");
  assert.equal(snapshot.status, "ready");
  assert.ok("snapshot" in snapshot && snapshot.snapshot !== null);
  const sources = snapshot.snapshot.sources.map(({ role, state, action, counts }) => ({ role, state, action, counts }));
  t.diagnostic(JSON.stringify({ sources }));
  assert.deepEqual(sources, [
    { role: "current", state: "current", action: "none", counts: { projects: 1, sessions: 1, commands: 2, updates: 4 } },
    { role: "historical", state: "available", action: "preserve", counts: { projects: 1, sessions: 1, commands: 2, updates: 4 } },
  ]);

  assert.deepEqual(await Promise.all([directoryManifest(current.root), directoryManifest(historical.root)]), before);
  assert.equal(discoveries, 1);
});

test("Windows production ACL protection permits discovery of a stranded synthetic store before startup", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await createTestDirectory(t, join(realpathSync(tmpdir()), "acl56-production-"));
  const currentUserDataDirectory = join(root, "synchronized-intellect-network");
  const historical = await createSyntheticStore(join(root, "Electron", "workbench-project-host"), 2);
  const before = await directoryManifest(historical.root);
  const discovery = createProductionHistoryRecoverySourceDiscovery({
    appDataDirectory: root,
    currentUserDataDirectory,
  });
  const dataDirectory = join(root, "recovery");
  let discoveries = 0;
  const events: string[] = [];
  const library = createHistoricalRecoveryLibrary({
    dataDirectory,
    sourceDiscovery: {
      async discover() {
        discoveries += 1;
        events.push("discover");
        return discovery.discover();
      },
    },
    exportChooser: { async choose() { throw new Error("chooser must not run"); } },
  });
  registerTestClosable(t, library);
  const preparation = await library.prepareLaunch();
  t.diagnostic(JSON.stringify({ preparation, discoveries }));
  assert.deepEqual(preparation, { status: "ready", sourceCount: 1, captureAttempts: 1 });
  await startProjectHostAfterRecoveryPreparation({
    prepareRecovery: () => library.prepareLaunch(),
    shutdownStarted: () => false,
    async startProjectHost() { events.push("start"); },
  });
  assert.deepEqual(events, ["discover", "start"]);
  const snapshot = await library.execute({}, { version: 1, requestKey: "windows-acl-snapshot" });
  assert.ok("kind" in snapshot);
  assert.equal(snapshot.kind, "snapshot");
  assert.equal(snapshot.status, "ready");
  assert.ok("snapshot" in snapshot && snapshot.snapshot !== null);
  const sources = snapshot.snapshot.sources.map(({ role, state, action, counts }) => ({ role, state, action, counts }));
  t.diagnostic(JSON.stringify({ sources }));
  assert.deepEqual(sources, [
    { role: "historical", state: "available", action: "preserve", counts: { projects: 1, sessions: 1, commands: 2, updates: 4 } },
  ]);

  // Independently inspect the OS descriptor, not the implementation's boolean.
  const { stdout } = await execFileAsync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $items = @((Get-Item -LiteralPath $env:UAW_ACL_TEST_ROOT)) + @(Get-ChildItem -LiteralPath $env:UAW_ACL_TEST_ROOT -Recurse -Force)
    $records = @(foreach ($item in $items) {
      $acl = $item.GetAccessControl()
      [pscustomobject]@{
        path = $item.FullName; directory = $item.PSIsContainer
        owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        protected = $acl.AreAccessRulesProtected
        rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
          [pscustomobject]@{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited; inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }
        })
      }
    })
    @{ sid = $sid; records = $records } | ConvertTo-Json -Depth 6 -Compress
  `], { windowsHide: true, env: { ...process.env, UAW_ACL_TEST_ROOT: dataDirectory } });
  const acl = JSON.parse(stdout);
  assert.ok(acl.records.length > 10);
  for (const record of acl.records) {
    assert.equal(record.owner, acl.sid, record.path);
    assert.equal(record.protected, true, record.path);
    assert.deepEqual(record.rules, [{ sid: acl.sid, rights: 2032127, type: "Allow", inherited: false, inheritance: record.directory ? 3 : 0, propagation: 0 }], record.path);
  }
  t.diagnostic(stdout.trim());
  for (const path of [dataDirectory, join(dataDirectory, "history-recovery-secret-v1.bin")]) {
    const readback = await execFileAsync("icacls.exe", [path], { windowsHide: true });
    t.diagnostic(readback.stdout.trim());
  }
  assert.deepEqual(await directoryManifest(historical.root), before);
  assert.equal(discoveries, 1);
});
