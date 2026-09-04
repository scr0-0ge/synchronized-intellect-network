import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodexWebToolProductionCli } from "./codex-web-tool-production/cli.ts";

export { FIXED_CODEX_WEB_TOOL_INSTRUCTION } from "./codex-web-tool-production/contract.ts";
export type {
  CodexWebToolProductionEvidence,
  CodexWebToolProductionFailureCategory,
  CodexWebToolProductionOptions,
  CodexWebToolProductionResult,
} from "./codex-web-tool-production/contract.ts";
export { readCodexWebToolProductionEvidence } from "./codex-web-tool-production/evidence.ts";
export { runCodexWebToolProduction } from "./codex-web-tool-production/scenario.ts";

function comparable(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    comparable(resolve(entry)) === comparable(fileURLToPath(import.meta.url))
  );
}

if (isExecutedDirectly()) await runCodexWebToolProductionCli();
