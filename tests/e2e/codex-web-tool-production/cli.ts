import { runCodexWebToolProduction } from "./scenario.ts";

const liveOptInName = "UAW_F67_CODEX_WEB_TOOL_LIVE";

export async function runCodexWebToolProductionCli(): Promise<void> {
  if (process.env[liveOptInName] !== "1") {
    console.log(
      `CODEX_WEB_TOOL_PRODUCTION_FAILURE ${JSON.stringify({
        ok: false,
        category: "opt-in-required",
        rootRetained: false,
        diagnosticArtifact: { retained: false },
      })}`,
    );
    process.exitCode = 1;
    return;
  }
  const result = await runCodexWebToolProduction();
  if (!result.ok) {
    console.log(
      `CODEX_WEB_TOOL_PRODUCTION_FAILURE ${JSON.stringify(result)}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `CODEX_WEB_TOOL_PRODUCTION_PASS ${JSON.stringify({
      ok: true,
      bytes: result.seal.bytes,
      sha256: result.seal.sha256,
    })}`,
  );
}
