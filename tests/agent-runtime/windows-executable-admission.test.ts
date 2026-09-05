import assert from "node:assert/strict";
import test from "node:test";
import { win32 } from "node:path";

import {
  admitLaunchTarget,
  admitNativeExecutable,
  classifyLaunchTargetName,
  resolveNpmGlobalLaunch,
  windowsRuntimeLookupNames,
  type AdmissionEntryInspection,
  type NpmGlobalCommandSpec,
  type WindowsAdmissionDependencies,
} from "../../src/agent-runtime/windows-executable-admission.ts";

const npmPrefix = String.raw`C:\fixture\AppData\Roaming\npm`;
const codexSpec: NpmGlobalCommandSpec = Object.freeze({
  command: "codex",
  packageName: "@openai/codex",
});
const claudeSpec: NpmGlobalCommandSpec = Object.freeze({
  command: "claude",
  packageName: "@anthropic-ai/claude-code",
});

class Checks {
  private count = 0;

  equal(actual: unknown, expected: unknown, message: string): void {
    this.count += 1;
    assert.deepEqual(actual, expected, message);
  }

  verify(expected: number): void {
    assert.equal(this.count, expected, "assertion count");
  }
}

/**
 * A fake that answers only what a test seeded. Anything unseeded throws a
 * PRIVATE_-prefixed error rather than returning a plausible default, so a test
 * that passes because the fake guessed correctly is impossible.
 */
class FakeAdmission implements WindowsAdmissionDependencies {
  readonly inspections = new Map<string, AdmissionEntryInspection>();
  readonly realPaths = new Map<string, string>();
  readonly files = new Map<string, string>();
  readonly pathLookups = new Map<string, readonly string[]>();
  lookupCalls = 0;

  async inspect(path: string): Promise<AdmissionEntryInspection> {
    return this.inspections.get(comparable(path)) ?? { kind: "missing" };
  }

  async resolveRealPath(path: string): Promise<string> {
    const resolved = this.realPaths.get(comparable(path));
    if (resolved === undefined) throw new Error("PRIVATE_FAKE_REALPATH_MISSING");
    return resolved;
  }

  async readTextFile(path: string): Promise<string | undefined> {
    return this.files.get(comparable(path));
  }

  async lookupOnPath(name: string): Promise<readonly string[]> {
    this.lookupCalls += 1;
    return this.pathLookups.get(name.toLocaleLowerCase("en-US")) ?? [];
  }

  addFile(path: string, options?: { readonly symbolicLink?: boolean }): void {
    this.inspections.set(comparable(path), {
      kind: "file",
      symbolicLink: options?.symbolicLink ?? false,
    });
    if (!this.realPaths.has(comparable(path))) this.realPaths.set(comparable(path), path);
  }

  addDirectory(path: string): void {
    this.inspections.set(comparable(path), { kind: "directory", symbolicLink: false });
    this.realPaths.set(comparable(path), path);
  }

  addManifest(packageDirectory: string, manifest: unknown): void {
    this.addDirectory(packageDirectory);
    this.files.set(
      comparable(win32.join(packageDirectory, "package.json")),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }
}

function comparable(path: string): string {
  return path.toLocaleLowerCase("en-US");
}

function packageDirectory(prefix: string, packageName: string): string {
  return win32.join(prefix, "node_modules", ...packageName.split("/"));
}

/** An npm global install of a package whose bin entry is a JavaScript file. */
function npmGlobalJavaScriptInstall(spec: NpmGlobalCommandSpec): {
  readonly dependencies: FakeAdmission;
  readonly entry: string;
  readonly interpreter: string;
} {
  const dependencies = new FakeAdmission();
  const packageRoot = packageDirectory(npmPrefix, spec.packageName);
  const entry = win32.join(packageRoot, "bin", `${spec.command}.js`);
  const interpreter = win32.join(npmPrefix, "node.exe");
  dependencies.addManifest(packageRoot, {
    name: spec.packageName,
    bin: { [spec.command]: `bin/${spec.command}.js` },
  });
  dependencies.addFile(entry);
  dependencies.addFile(interpreter);
  // The shims npm actually writes. None of them is ever launched.
  for (const shim of [`${spec.command}.cmd`, `${spec.command}.ps1`, spec.command]) {
    dependencies.addFile(win32.join(npmPrefix, shim));
  }
  return { dependencies, entry, interpreter };
}

// ---------------------------------------------------------------------------
// F26 / rule 1. admitNativeExecutable is the only gate on anything that becomes
// argv[0]. It was extended to report a REASON; this row proves that not one
// shape it used to refuse is admitted now. Every entry below is a shape the
// npm-global fix made newly REACHABLE -- a .cmd, a .ps1, an extensionless shim,
// a script -- plus the classic evasions.
// ---------------------------------------------------------------------------
test("admitNativeExecutable still fails closed on every shape that is not a real .exe [16 assertions]", async () => {
  const checks = new Checks();
  const dependencies = new FakeAdmission();

  const shimDirectory = npmPrefix;
  dependencies.addFile(win32.join(shimDirectory, "claude.cmd"));
  dependencies.addFile(win32.join(shimDirectory, "claude.ps1"));
  dependencies.addFile(win32.join(shimDirectory, "claude.bat"));
  dependencies.addFile(win32.join(shimDirectory, "claude"));
  dependencies.addFile(win32.join(shimDirectory, "cli.js"));
  dependencies.addFile(win32.join(shimDirectory, "claude.exe.txt"));
  dependencies.addFile(win32.join(shimDirectory, "linked.exe"), { symbolicLink: true });
  dependencies.addDirectory(win32.join(shimDirectory, "directory.exe"));
  // A junction whose NAME ends .exe but whose real target does not.
  const disguised = win32.join(shimDirectory, "disguised.exe");
  dependencies.addFile(disguised);
  dependencies.realPaths.set(comparable(disguised), win32.join(shimDirectory, "real.cmd"));

  const rows: readonly (readonly [string, string])[] = [
    [win32.join(shimDirectory, "claude.cmd"), "not-a-native-executable-name"],
    [win32.join(shimDirectory, "claude.ps1"), "not-a-native-executable-name"],
    [win32.join(shimDirectory, "claude.bat"), "not-a-native-executable-name"],
    [win32.join(shimDirectory, "claude"), "not-a-native-executable-name"],
    [win32.join(shimDirectory, "cli.js"), "not-a-native-executable-name"],
    [win32.join(shimDirectory, "claude.exe.txt"), "not-a-native-executable-name"],
    [win32.join(shimDirectory, "linked.exe"), "symbolic-link"],
    [win32.join(shimDirectory, "directory.exe"), "not-a-regular-file"],
    [disguised, "resolved-away-from-a-native-executable"],
    [win32.join(shimDirectory, "absent.exe"), "missing"],
    [String.raw`claude.exe`, "not-absolute"],
    [String.raw`..\claude.exe`, "not-absolute"],
    [`${String.raw`C:\fixture\cl`}\u0000${String.raw`aude.exe`}`, "control-character"],
    ["   ", "blank"],
    [`C:\\fixture\\${"a".repeat(5_000)}.exe`, "too-long"],
  ];

  for (const [candidate, reason] of rows) {
    checks.equal(
      await admitNativeExecutable(candidate, dependencies),
      { kind: "rejected", reason },
      `${candidate} must be refused as ${reason}`,
    );
  }

  // The one shape that IS admitted, so the row above cannot be passing because
  // the function refuses everything.
  const genuine = win32.join(shimDirectory, "genuine.exe");
  dependencies.addFile(genuine);
  checks.equal(
    await admitNativeExecutable(genuine, dependencies),
    { kind: "admitted", path: genuine },
    "a real .exe is still admitted",
  );

  checks.verify(16);
});

test("a lookup names exactly what a PATHEXT lookup can return, bare name last", () => {
  // .ps1 is absent on purpose: it is not in the default PATHEXT, so a PATH
  // lookup cannot return it, and naming it would make the failure text lie.
  assert.deepEqual(windowsRuntimeLookupNames("codex"), [
    "codex.exe",
    "codex.cmd",
    "codex.bat",
    "codex",
  ]);
  // The classifier is what keeps a shim out of argv[0].
  assert.equal(classifyLaunchTargetName(String.raw`C:\p\codex.exe`), "native");
  assert.equal(classifyLaunchTargetName(String.raw`C:\p\codex.cmd`), "shim");
  assert.equal(classifyLaunchTargetName(String.raw`C:\p\codex.ps1`), "shim");
  assert.equal(classifyLaunchTargetName(String.raw`C:\p\codex.bat`), "shim");
  assert.equal(classifyLaunchTargetName(String.raw`C:\p\codex`), "shim");
  assert.equal(classifyLaunchTargetName(String.raw`C:\p\codex.js`), "unsupported");
});

test("an npm global install with a JavaScript entry point launches through node, never through a shell", async () => {
  const { dependencies, entry, interpreter } = npmGlobalJavaScriptInstall(claudeSpec);

  assert.deepEqual(await resolveNpmGlobalLaunch(npmPrefix, claudeSpec, dependencies), {
    kind: "admitted",
    launch: { executable: interpreter, prefixArguments: [entry] },
  });

  // The same answer arrives through the shim a user would actually point at,
  // and the shim itself is never the executable.
  const viaShim = await admitLaunchTarget(
    win32.join(npmPrefix, "claude.cmd"),
    claudeSpec,
    dependencies,
  );
  assert.deepEqual(viaShim, {
    kind: "admitted",
    launch: { executable: interpreter, prefixArguments: [entry] },
  });
  assert.equal(
    JSON.stringify(viaShim).toLocaleLowerCase("en-US").includes(".cmd"),
    false,
    "no shim path may survive into a launch plan",
  );
});

test("an npm global install whose bin entry is a native binary launches it directly", async () => {
  const dependencies = new FakeAdmission();
  const packageRoot = packageDirectory(npmPrefix, codexSpec.packageName);
  const binary = win32.join(packageRoot, "vendor", "x64", "codex.exe");
  dependencies.addManifest(packageRoot, { bin: { codex: "vendor/x64/codex.exe" } });
  dependencies.addFile(binary);

  assert.deepEqual(await resolveNpmGlobalLaunch(npmPrefix, codexSpec, dependencies), {
    kind: "admitted",
    launch: { executable: binary, prefixArguments: [] },
  });
});

test("a package manifest cannot point the launch out of its own package", async () => {
  const dependencies = new FakeAdmission();
  const packageRoot = packageDirectory(npmPrefix, codexSpec.packageName);
  dependencies.addManifest(packageRoot, { bin: { codex: "../../../../evil.exe" } });
  dependencies.addFile(String.raw`C:\fixture\AppData\evil.exe`);

  assert.deepEqual(await resolveNpmGlobalLaunch(npmPrefix, codexSpec, dependencies), {
    kind: "rejected",
    reason: "entry-escapes-its-package",
  });

  // An absolute bin entry is not describing the package's own contents.
  const absolute = new FakeAdmission();
  absolute.addManifest(packageRoot, { bin: { codex: String.raw`C:\Windows\System32\cmd.exe` } });
  assert.deepEqual(await resolveNpmGlobalLaunch(npmPrefix, codexSpec, absolute), {
    kind: "rejected",
    reason: "package-manifest-declares-no-entry",
  });
});

test("the interpreter is the node the shim itself would have run", async () => {
  const { dependencies, entry } = npmGlobalJavaScriptInstall(claudeSpec);
  const beside = win32.join(npmPrefix, "node.exe");
  const onPath = String.raw`C:\Program Files\nodejs\node.exe`;
  dependencies.pathLookups.set("node.exe", [onPath]);
  dependencies.addFile(onPath);

  assert.deepEqual(await resolveNpmGlobalLaunch(npmPrefix, claudeSpec, dependencies), {
    kind: "admitted",
    launch: { executable: beside, prefixArguments: [entry] },
  });
  assert.equal(dependencies.lookupCalls, 0, "node beside the shim is preferred");

  // With no node beside the shim, PATH answers -- which is what npm's own shim does.
  dependencies.inspections.delete(comparable(beside));
  assert.deepEqual(await resolveNpmGlobalLaunch(npmPrefix, claudeSpec, dependencies), {
    kind: "admitted",
    launch: { executable: onPath, prefixArguments: [entry] },
  });
  assert.equal(dependencies.lookupCalls, 1);
});

test("a JavaScript entry point with no node anywhere is refused by name, not launched", async () => {
  const { dependencies } = npmGlobalJavaScriptInstall(claudeSpec);
  dependencies.inspections.delete(comparable(win32.join(npmPrefix, "node.exe")));

  assert.deepEqual(await resolveNpmGlobalLaunch(npmPrefix, claudeSpec, dependencies), {
    kind: "rejected",
    reason: "node-interpreter-not-located",
  });
});

test("a user-supplied path is refused with a reason rather than repaired", async () => {
  const dependencies = new FakeAdmission();
  const directory = win32.join(npmPrefix, "claude.cmd");
  dependencies.addDirectory(directory);

  // A directory named like a shim is not an install.
  assert.deepEqual(await admitLaunchTarget(directory, claudeSpec, dependencies), {
    kind: "rejected",
    reason: "not-a-regular-file",
  });
  // A shim with no package beside it names the reason it failed.
  const orphan = new FakeAdmission();
  orphan.addFile(win32.join(npmPrefix, "claude.cmd"));
  assert.deepEqual(
    await admitLaunchTarget(win32.join(npmPrefix, "claude.cmd"), claudeSpec, orphan),
    { kind: "rejected", reason: "package-manifest-unreadable" },
  );
  // Relative input never reaches the filesystem at all.
  assert.deepEqual(
    await admitLaunchTarget(String.raw`.\claude.cmd`, claudeSpec, orphan),
    { kind: "rejected", reason: "not-absolute" },
  );
  assert.deepEqual(await admitLaunchTarget("", claudeSpec, orphan), {
    kind: "rejected",
    reason: "blank",
  });
});
