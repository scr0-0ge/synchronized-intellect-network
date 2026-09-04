import assert from "node:assert/strict";
import { win32 } from "node:path";

import {
  discoverCodexExecutable,
  type CodexExecutableDiscoveryDependencies,
  type CodexExecutableHandle,
  type DiscoveryEntryInspection,
} from "../../src/agent-runtime/codex/executable-discovery.ts";

const permittedRoot = String.raw`R:\fixed\official-runtime`;
const leaf = "abcdef0123456789";
const executable = win32.join(permittedRoot, leaf, "codex.exe");
const scrubbedRuntimePathEntries = Object.freeze([]);
let pathLookups = 0;
let rootEnumerations = 0;
let heldExecutables = 0;
let assertions = 0;

const inspections = new Map<string, DiscoveryEntryInspection>([
  [
    permittedRoot,
    {
      kind: "directory",
      symbolicLink: false,
      reparsePoint: false,
    },
  ],
  [
    executable,
    {
      kind: "file",
      symbolicLink: false,
      reparsePoint: false,
    },
  ],
]);

const dependencies: CodexExecutableDiscoveryDependencies = {
  platform: "win32",
  officialRoots: [permittedRoot],
  async lookupOnPath() {
    pathLookups += 1;
    return { kind: "candidates", values: scrubbedRuntimePathEntries };
  },
  async inspect(path) {
    return inspections.get(path) ?? { kind: "missing" };
  },
  async resolveRealPath(path) {
    return path;
  },
  async readDirectory() {
    rootEnumerations += 1;
    return { kind: "entries", names: [leaf] };
  },
  holdExecutable(_path) {
    heldExecutables += 1;
    return Object.freeze({}) as CodexExecutableHandle;
  },
};

const result = await discoverCodexExecutable(dependencies);
checkEqual(scrubbedRuntimePathEntries.length, 0);
checkEqual(result.kind, "located");
checkEqual(pathLookups, 1);
checkEqual(rootEnumerations, 1);
checkEqual(heldExecutables, 1);
checkEqual(result.kind === "located" ? Object.keys(result.executable).length : -1, 0);
checkEqual(JSON.stringify(result).includes(permittedRoot), false);
checkEqual(JSON.stringify(result).includes(executable), false);
checkEqual(JSON.stringify(result).includes("PRIVATE_NATIVE_ERROR"), false);

process.stdout.write(
  `${JSON.stringify({
    assertions,
    discovery: "located",
    environmentRuntimeEntries: scrubbedRuntimePathEntries.length,
    handleFields: result.kind === "located" ? Object.keys(result.executable).length : -1,
    pathLookups,
    rootEnumerations,
    spawnAttempts: 0,
    stagingAttempts: 0,
  })}\n`,
);

function checkEqual(actual: unknown, expected: unknown): void {
  assertions += 1;
  assert.equal(actual, expected);
}
