import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";

import {
  discoverCodexExecutable,
  type CodexExecutableDiscoveryDependencies,
  type CodexExecutableHandle,
  type DiscoveryEntryInspection,
} from "../../src/agent-runtime/codex/executable-discovery.ts";

const officialRoot = String.raw`C:\fixture\official-runtime`;
const pathRoot = String.raw`C:\fixture\path-runtime`;

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
  readonly heldPaths = new WeakMap<CodexExecutableHandle, string>();
  readonly held: CodexExecutableHandle[] = [];
  readonly inspectedPaths: string[] = [];
  pathCandidates: readonly string[] = [];
  pathOverflow = false;
  pathLookups = 0;
  rootEnumerations = 0;

  async lookupOnPath() {
    this.pathLookups += 1;
    return this.pathOverflow
      ? ({ kind: "overflow" } as const)
      : ({ kind: "candidates", values: this.pathCandidates } as const);
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

  holdExecutable(path: string): CodexExecutableHandle {
    const handle = Object.freeze({}) as CodexExecutableHandle;
    this.heldPaths.set(handle, path);
    this.held.push(handle);
    return handle;
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
  checks.equal(
    result.kind === "located" ? dependencies.heldPaths.get(result.executable) : undefined,
    candidate,
  );
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
  checks.equal(
    result.kind === "located" ? dependencies.heldPaths.get(result.executable) : undefined,
    candidate,
  );
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
  checks.equal(
    result.kind === "located" ? dependencies.heldPaths.get(result.executable) : undefined,
    resolved,
  );
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
