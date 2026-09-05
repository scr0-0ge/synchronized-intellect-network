import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";

import {
  discoverCodexExecutable,
  type CodexExecutableDiscoveryDependencies,
  type CodexExecutableDiscoveryResult,
  type CodexExecutableHandle,
  type DiscoveryEntryInspection,
} from "../../src/agent-runtime/codex/executable-discovery.ts";
import type {
  AdmissionEntryInspection,
  WindowsAdmissionDependencies,
  WindowsRuntimeLaunch,
} from "../../src/agent-runtime/windows-executable-admission.ts";

const officialRoot = String.raw`C:\fixture\official-runtime`;
const pathRoot = String.raw`C:\fixture\path-runtime`;
const configuredRoot = String.raw`C:\fixture\configured-runtime`;

class Checks {
  count = 0;

  equal(actual: unknown, expected: unknown): void {
    this.count += 1;
    assert.equal(actual, expected);
  }

  deepEqual(actual: unknown, expected: unknown): void {
    this.count += 1;
    assert.deepEqual(actual, expected);
  }

  verify(expected: number): void {
    assert.equal(this.count, expected);
  }
}

class FakeDiscoveryDependencies implements CodexExecutableDiscoveryDependencies {
  readonly platform = "win32" as const;
  readonly officialRoots = [officialRoot];
  readonly inspections = new Map<string, DiscoveryEntryInspection>();
  readonly realPaths = new Map<string, string>();
  readonly directoryEntries = new Map<string, readonly string[]>();
  readonly heldLaunches = new WeakMap<CodexExecutableHandle, WindowsRuntimeLaunch>();
  readonly held: CodexExecutableHandle[] = [];
  readonly inspectedPaths: string[] = [];
  pathCandidates: readonly string[] = [];
  pathOverflow = false;
  pathLookups = 0;
  rootEnumerations = 0;
  configured: string | undefined;
  npmPrefix: string | undefined;
  npmPrefixProbes = 0;

  // The shared admission gate reads through the same fixture maps as the
  // official-root scan, so one fixture describes the whole machine.
  readonly admission: WindowsAdmissionDependencies = {
    inspect: async (path: string): Promise<AdmissionEntryInspection> =>
      admissionInspection(await this.inspect(path)),
    resolveRealPath: (path: string) => this.resolveRealPath(path),
    readTextFile: async (path: string) => this.textFiles.get(path),
    lookupOnPath: async () => [],
  };

  readonly textFiles = new Map<string, string>();

  async lookupOnPath() {
    this.pathLookups += 1;
    return this.pathOverflow
      ? ({ kind: "overflow" } as const)
      : ({ kind: "candidates", values: this.pathCandidates } as const);
  }

  configuredExecutable(): string | undefined {
    return this.configured;
  }

  npmGlobalPrefix(): string | undefined {
    this.npmPrefixProbes += 1;
    return this.npmPrefix;
  }

  async inspect(path: string): Promise<DiscoveryEntryInspection> {
    this.inspectedPaths.push(path);
    return this.inspections.get(path) ?? { kind: "missing" };
  }

  async resolveRealPath(path: string): Promise<string> {
    const resolved = this.realPaths.get(path);
    if (resolved === undefined) throw new Error("PRIVATE_FAKE_REALPATH_MISSING");
    return resolved;
  }

  async readDirectory(root: string): Promise<
    | { readonly kind: "entries"; readonly names: readonly string[] }
    | { readonly kind: "missing" | "unavailable" | "overflow" }
  > {
    this.rootEnumerations += 1;
    const names = this.directoryEntries.get(root);
    return names === undefined
      ? ({ kind: "missing" } as const)
      : ({ kind: "entries", names } as const);
  }

  holdExecutable(launch: WindowsRuntimeLaunch): CodexExecutableHandle {
    const handle = Object.freeze({}) as CodexExecutableHandle;
    this.heldLaunches.set(handle, launch);
    this.held.push(handle);
    return handle;
  }

  /** The executable a located result would spawn, read back through the handle. */
  heldExecutable(result: CodexExecutableDiscoveryResult): string | undefined {
    if (result.kind !== "located") return undefined;
    return this.heldLaunches.get(result.executable)?.executable;
  }

  addOfficialRoot(entries: readonly string[]): void {
    this.inspections.set(officialRoot, directory());
    this.realPaths.set(officialRoot, officialRoot);
    this.directoryEntries.set(officialRoot, entries);
  }

  addFile(path: string, resolvedPath = path): void {
    this.inspections.set(path, file());
    this.realPaths.set(path, resolvedPath);
  }
}

test("discovery matrix: PATH hit resolves once and never consults an official root [7 assertions]", async () => {
  const checks = new Checks();
  const dependencies = new FakeDiscoveryDependencies();
  const candidate = win32.join(pathRoot, "codex.exe");
  dependencies.pathCandidates = [candidate];
  dependencies.inspections.set(pathRoot, directory());
  dependencies.realPaths.set(pathRoot, pathRoot);
  dependencies.addFile(candidate);

  const result = await discoverCodexExecutable(dependencies);

  checks.equal(result.kind, "located");
  checks.equal(dependencies.pathLookups, 1);
  checks.equal(dependencies.rootEnumerations, 0);
  checks.equal(dependencies.held.length, 1);
  checks.equal(dependencies.heldExecutable(result), candidate);
  checks.equal(JSON.stringify(result).includes(candidate), false);
  checks.deepEqual(Object.keys(result.kind === "located" ? result.executable : {}), []);
  checks.verify(7);
});

test("discovery matrix: PATH miss plus one valid official candidate resolves opaquely [8 assertions]", async () => {
  const checks = new Checks();
  const dependencies = new FakeDiscoveryDependencies();
  const leaf = "0123456789abcdef";
  const candidate = win32.join(officialRoot, leaf, "codex.exe");
  dependencies.addOfficialRoot([leaf]);
  dependencies.addFile(candidate);

  const result = await discoverCodexExecutable(dependencies);

  checks.equal(result.kind, "located");
  checks.equal(dependencies.pathLookups, 1);
  checks.equal(dependencies.rootEnumerations, 1);
  checks.equal(dependencies.held.length, 1);
  checks.equal(dependencies.heldExecutable(result), candidate);
  checks.equal(JSON.stringify(result).includes(candidate), false);
  checks.equal(JSON.stringify(result).includes(officialRoot), false);
  checks.deepEqual(Object.keys(result.kind === "located" ? result.executable : {}), []);
  checks.verify(8);
});

test("discovery matrix: no PATH or official candidate is a fixed not-located result [5 assertions]", async () => {
  const checks = new Checks();
  const dependencies = new FakeDiscoveryDependencies();
  dependencies.addOfficialRoot([]);

  const result = await discoverCodexExecutable(dependencies);

  checks.deepEqual(result, { kind: "not-located" });
  checks.equal(dependencies.pathLookups, 1);
  checks.equal(dependencies.rootEnumerations, 1);
  checks.equal(dependencies.held.length, 0);
  checks.equal(JSON.stringify(result).includes(officialRoot), false);
  checks.verify(5);
});

test("discovery matrix: two distinct official candidates are inspected ordinally and fail closed as ambiguous [6 assertions]", async () => {
  const checks = new Checks();
  const dependencies = new FakeDiscoveryDependencies();
  const leaves = ["1111111111111111", "2222222222222222"];
  dependencies.addOfficialRoot([...leaves].reverse());
  for (const leaf of leaves) {
    dependencies.addFile(win32.join(officialRoot, leaf, "codex.exe"));
  }

  const result = await discoverCodexExecutable(dependencies);

  checks.deepEqual(result, { kind: "ambiguous" });
  checks.equal(dependencies.pathLookups, 1);
  checks.equal(dependencies.rootEnumerations, 1);
  checks.equal(dependencies.held.length, 0);
  checks.equal(JSON.stringify(result).includes(officialRoot), false);
  checks.deepEqual(
    dependencies.inspectedPaths.filter((path) => path.endsWith("codex.exe")),
    [
      win32.join(officialRoot, "codex.exe"),
      ...leaves.map((leaf) => win32.join(officialRoot, leaf, "codex.exe")),
    ],
  );
  checks.verify(6);
});

test("discovery matrix: two candidates resolving to one real file deduplicate [6 assertions]", async () => {
  const checks = new Checks();
  const dependencies = new FakeDiscoveryDependencies();
  const leaves = ["3333333333333333", "4444444444444444"];
  const resolved = win32.join(officialRoot, "resolved", "codex.exe");
  dependencies.addOfficialRoot(leaves);
  for (const leaf of leaves) {
    dependencies.addFile(win32.join(officialRoot, leaf, "codex.exe"), resolved);
  }

  const result = await discoverCodexExecutable(dependencies);

  checks.equal(result.kind, "located");
  checks.equal(dependencies.pathLookups, 1);
  checks.equal(dependencies.rootEnumerations, 1);
  checks.equal(dependencies.held.length, 1);
  checks.equal(dependencies.heldExecutable(result), resolved);
  checks.equal(JSON.stringify(result).includes(resolved), false);
  checks.verify(6);
});

test("discovery matrix: directories, links, reparse points, and root escapes are rejected [12 assertions]", async () => {
  const checks = new Checks();
  const variants: readonly {
    readonly inspection: DiscoveryEntryInspection;
    readonly resolvedPath?: string;
  }[] = [
    { inspection: directory() },
    { inspection: file({ symbolicLink: true }) },
    { inspection: file({ reparsePoint: true }) },
    {
      inspection: file(),
      resolvedPath: String.raw`C:\fixture\outside\codex.exe`,
    },
  ];

  for (const [index, variant] of variants.entries()) {
    const dependencies = new FakeDiscoveryDependencies();
    const leaf = `${String(index + 5).repeat(16)}`;
    const candidate = win32.join(officialRoot, leaf, "codex.exe");
    dependencies.addOfficialRoot([leaf]);
    dependencies.inspections.set(candidate, variant.inspection);
    dependencies.realPaths.set(candidate, variant.resolvedPath ?? candidate);

    const result = await discoverCodexExecutable(dependencies);

    checks.deepEqual(result, { kind: "not-located" });
    checks.equal(dependencies.held.length, 0);
    checks.equal(dependencies.rootEnumerations, 1);
  }
  checks.verify(12);
});

test("discovery matrix: bounded enumeration overflow fails closed without resolving a candidate [4 assertions]", async () => {
  const checks = new Checks();
  const dependencies = new FakeDiscoveryDependencies();
  dependencies.inspections.set(officialRoot, directory());
  dependencies.realPaths.set(officialRoot, officialRoot);
  dependencies.readDirectory = async () => {
    dependencies.rootEnumerations += 1;
    return { kind: "overflow" } as const;
  };

  const result = await discoverCodexExecutable(dependencies);

  checks.deepEqual(result, { kind: "ambiguous" });
  checks.equal(dependencies.held.length, 0);
  checks.equal(dependencies.pathLookups, 1);
  checks.equal(dependencies.rootEnumerations, 1);
  checks.verify(4);
});

test("discovery matrix: a configured executable outranks every place discovery would look [6 assertions]", async () => {
  const checks = new Checks();
  const dependencies = new FakeDiscoveryDependencies();
  const configured = win32.join(configuredRoot, "codex.exe");
  const onPath = win32.join(pathRoot, "codex.exe");
  dependencies.configured = configured;
  dependencies.pathCandidates = [onPath];
  dependencies.addFile(configured);
  dependencies.addFile(onPath);
  dependencies.addOfficialRoot([]);

  const result = await discoverCodexExecutable(dependencies);

  // The answer to a lookup that already failed the user once is not outranked
  // by anything the product would have guessed.
  checks.equal(result.kind, "located");
  checks.equal(dependencies.heldExecutable(result), configured);
  checks.equal(dependencies.pathLookups, 0);
  checks.equal(dependencies.npmPrefixProbes, 0);
  checks.equal(dependencies.rootEnumerations, 0);
  checks.equal(JSON.stringify(result).includes(configured), false);
  checks.verify(6);
});

test("discovery matrix: a configured executable that no longer admits falls through rather than failing [4 assertions]", async () => {
  const checks = new Checks();
  const dependencies = new FakeDiscoveryDependencies();
  const onPath = win32.join(pathRoot, "codex.exe");
  // The install moved; the stored answer names a file that is not there any
  // more. Failing on the user's own stale input would strand them on it.
  dependencies.configured = win32.join(configuredRoot, "moved-away", "codex.exe");
  dependencies.pathCandidates = [onPath];
  dependencies.addFile(onPath);
  dependencies.addOfficialRoot([]);

  const result = await discoverCodexExecutable(dependencies);

  checks.equal(result.kind, "located");
  checks.equal(dependencies.heldExecutable(result), onPath);
  checks.equal(dependencies.pathLookups, 1);
  checks.equal(dependencies.rootEnumerations, 0);
  checks.verify(4);
});

test("discovery matrix: the npm global prefix is probed after PATH and before the official root [6 assertions]", async () => {
  const checks = new Checks();
  const dependencies = new FakeDiscoveryDependencies();
  const prefix = String.raw`C:\fixture\npm-prefix`;
  const packageDirectory = win32.join(prefix, "node_modules", "@openai", "codex");
  const entry = win32.join(packageDirectory, "vendor", "codex.exe");
  dependencies.npmPrefix = prefix;
  dependencies.textFiles.set(
    win32.join(packageDirectory, "package.json"),
    JSON.stringify({ bin: { codex: "vendor/codex.exe" } }),
  );
  dependencies.realPaths.set(packageDirectory, packageDirectory);
  dependencies.addFile(entry);
  // An official root is present and would answer; the npm prefix must be asked
  // first, because an Electron app launched from Explorer inherits the PATH
  // from login and this is the only route left to an npm global install.
  const leaf = "6666666666666666";
  dependencies.addOfficialRoot([leaf]);
  dependencies.addFile(win32.join(officialRoot, leaf, "codex.exe"));

  const result = await discoverCodexExecutable(dependencies);

  checks.equal(result.kind, "located");
  checks.equal(dependencies.heldExecutable(result), entry);
  checks.equal(dependencies.pathLookups, 1);
  checks.equal(dependencies.npmPrefixProbes, 1);
  checks.equal(dependencies.rootEnumerations, 0);
  checks.equal(JSON.stringify(result).includes(entry), false);
  checks.verify(6);
});

/** The same fixture entry, described for the shared admission gate. */
function admissionInspection(
  value: DiscoveryEntryInspection,
): AdmissionEntryInspection {
  if (value.kind === "file" || value.kind === "directory" || value.kind === "other") {
    return { kind: value.kind, symbolicLink: value.symbolicLink };
  }
  return { kind: value.kind };
}

function file(
  overrides: {
    readonly symbolicLink?: boolean;
    readonly reparsePoint?: boolean;
  } = {},
): DiscoveryEntryInspection {
  return {
    kind: "file",
    symbolicLink: false,
    reparsePoint: false,
    ...overrides,
  };
}

function directory(): DiscoveryEntryInspection {
  return {
    kind: "directory",
    symbolicLink: false,
    reparsePoint: false,
  };
}
