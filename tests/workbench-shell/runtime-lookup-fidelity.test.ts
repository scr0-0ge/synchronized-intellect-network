import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CLAUDE_RUNTIME_LOOKUP_SURFACE,
  CODEX_RUNTIME_LOOKUP_SURFACE,
  RUNTIME_LOOKUP_SURFACES,
  windowsRuntimeLookupNames,
  type RuntimeLookupLocation,
} from "../../src/agent-runtime/runtime-lookup-surface.ts";
import { copyLocaleDictionaries } from "../../src/workbench-shell/renderer/copy/runtime-lookup-copy.ts";
import { publicRuntimeEndpointDiscovery } from "../../src/workbench-shell/contract.ts";
import { directEndpointStatusRows } from "../../src/workbench-shell/renderer/view-model.ts";

// F196's lesson, one status row over: "No private error detail is exposed." and
// "No lookup path is exposed." are the same defect -- a failure that refuses to
// say what happened converts every future unknown into a guess.
//
// The repair carries its own hazard, and this file is the guard against it. A
// failure message that NAMES what was looked for is worse than a vague one if
// the names are wrong, because a user will act on it: they will conclude their
// install is somewhere the product never checks and go looking in the wrong
// place. So the wording is not allowed to drift away from the lookup. Every
// assertion below ties the words to the code that does the work.

const repositoryRoot = new URL("../../", import.meta.url);

async function source(relativePath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativePath, repositoryRoot)), "utf8");
}

test("every place a lookup asks has wording in both locales [14 assertions]", () => {
  let assertions = 0;
  for (const [runtime, surface] of Object.entries(RUNTIME_LOOKUP_SURFACES)) {
    for (const place of surface.places) {
      for (const locale of ["en", "zh-CN"] as const) {
        const labels =
          copyLocaleDictionaries[locale].runtimeLookupCopy.locationLabels;
        const label = (labels as Record<string, string | undefined>)[
          place.location
        ];
        assert.equal(
          typeof label === "string" && label.length > 0,
          true,
          `${runtime}/${place.location} has no ${locale} wording`,
        );
        assertions += 1;
      }
    }
  }
  // A place added to a surface with no wording must fail here, not render blank.
  // 3 Codex places + 4 Claude places, in two locales.
  assert.equal(assertions, 14);
});

test("the names the user is shown are the names the lookup actually asks for", () => {
  // The literal list is pinned FIRST and on purpose. Comparing the surface to
  // windowsRuntimeLookupNames alone is a tautology -- both sides move together,
  // so deleting a name would leave this test green while the product quietly
  // stopped looking for it. That is the c854aac failure exactly: a fixture that
  // was right by construction rather than by checking anything.
  assert.deepEqual(windowsRuntimeLookupNames("codex"), [
    "codex.exe",
    "codex.cmd",
    "codex.bat",
    "codex",
  ]);
  assert.deepEqual(windowsRuntimeLookupNames("claude"), [
    "claude.exe",
    "claude.cmd",
    "claude.bat",
    "claude",
  ]);

  for (const surface of [
    CODEX_RUNTIME_LOOKUP_SURFACE,
    CLAUDE_RUNTIME_LOOKUP_SURFACE,
  ]) {
    const pathPlace = surface.places.find((place) => place.location === "path");
    assert.ok(pathPlace, `${surface.command} must state what it asks PATH for`);
    assert.deepEqual(
      pathPlace.names,
      windowsRuntimeLookupNames(surface.command),
      `${surface.command}'s PATH names must come from the lookup itself`,
    );
    // The two single-file probes only ever ask for the .exe. Claiming the shim
    // names there would send a user to look for files that were never sought.
    for (const place of surface.places) {
      if (place.location === "path" || place.location === "npm-global-prefix") {
        continue;
      }
      assert.deepEqual(place.names, [`${surface.command}.exe`]);
    }
  }
});

test("the PATH lookup is asked with the bare name, or the text above is a lie", async () => {
  // Given an explicit extension where.exe does not consult PATHEXT, so a lookup
  // written as "claude.exe" cannot reach claude.cmd -- and the failure text
  // would then be claiming names that were never searched. Verified on this
  // machine: `where.exe npm.exe` exits 1 while `where.exe npm` returns both
  // `npm` and `npm.cmd`.
  const transport = await source(
    "src/agent-runtime/claude/process-transport.ts",
  );
  assert.match(
    transport,
    /lookupOnPathBounded\(CLAUDE_RUNTIME_LOOKUP_SURFACE\.command\)/u,
    "the Claude PATH lookup must ask for the bare command name",
  );
  assert.doesNotMatch(
    transport,
    /lookupOnPathBounded\("claude\.exe"\)/u,
    "an explicit extension cannot see the shims an npm install writes",
  );
});

test("only a not-located row carries a lookup, and it is the right one", () => {
  const rows = directEndpointStatusRows({
    phase: "ready",
    result: {
      ok: false,
      endpointDiscovery: publicRuntimeEndpointDiscovery([
        { endpointId: "codex-desktop", category: "runtime-not-located" },
        { endpointId: "claude-code-desktop", category: "catalog-ready" },
      ]),
    },
  } as unknown as Parameters<typeof directEndpointStatusRows>[0]);

  const codex = rows.find((row) => row.endpointId === "codex-desktop");
  const claude = rows.find((row) => row.endpointId === "claude-code-desktop");
  assert.equal(codex?.lookup, CODEX_RUNTIME_LOOKUP_SURFACE);
  assert.equal(codex?.runtime, "codex");
  // A row that was found has nothing to explain, so it offers no lookup and no
  // executable-path field.
  assert.equal(claude?.lookup, null);
  assert.equal(claude?.runtime, "claude");
});

test("no location wording expands a real path from this machine", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const labels =
      copyLocaleDictionaries[locale].runtimeLookupCopy.locationLabels;
    for (const [location, label] of Object.entries(labels)) {
      // Environment-variable tokens only. A resolved path would carry the
      // account name straight through the boundary path-redaction.ts guards.
      assert.doesNotMatch(
        label as string,
        /[A-Za-z]:\\/u,
        `${locale}/${location} must name a place, not a resolved path`,
      );
    }
  }
});

test("every location in the vocabulary is used by a surface", () => {
  const used = new Set<RuntimeLookupLocation>();
  for (const surface of Object.values(RUNTIME_LOOKUP_SURFACES)) {
    for (const place of surface.places) used.add(place.location);
  }
  const worded = new Set(
    Object.keys(copyLocaleDictionaries.en.runtimeLookupCopy.locationLabels),
  );
  // Wording with no place behind it is a sentence the product can never show
  // and can never be checked against reality.
  assert.deepEqual([...worded].sort(), [...used].sort());
});
