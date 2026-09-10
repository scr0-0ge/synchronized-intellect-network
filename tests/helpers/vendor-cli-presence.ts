// Whether a vendor CLI is installed is a property of the MACHINE, and for one
// endpoint it changes the answer.
//
// The claude-api endpoint deliberately has no static catalog: the real Claude
// CLI catalog IS its catalog. So `inspect` locates the executable before it
// ever looks at the key, and an endpoint with no key reports
// `authentication-required` on a machine that has a Claude CLI and
// `runtime-not-located` on a machine that does not. The owner's machine has
// one; a clean CI runner has none. That is how a public suite measured at
// 2204/2204 green locally went red on three jobs the first time it ran
// somewhere with nothing installed.
//
// `claudeApiEnvironment: {}` already turns the endpoint's credentials into an
// injected input. This does the same for the other machine fact, using
// discovery's own escape hatch -- the executable path a user enters in
// Settings, which outranks every probe -- pointed at the node running the
// test, a real native executable on every machine that can run this suite.
//
// Nothing is ever spawned through it. For every caller here the endpoint key
// is absent, and `resolveClaudeProcessEnvironment` rejects that before the
// launch: located-then-unauthenticated is the whole point.

import { setConfiguredRuntimeExecutable } from "../../src/agent-runtime/configured-executable.ts";

/**
 * Make Claude runtime discovery succeed for the rest of this test-file
 * process. Process isolation (`--test-isolation=process`) is the boundary, as
 * it is for every other process-wide fixture in this directory.
 */
export function locateClaudeRuntimeForThisTestFile(): void {
  setConfiguredRuntimeExecutable("claude", process.execPath);
}
