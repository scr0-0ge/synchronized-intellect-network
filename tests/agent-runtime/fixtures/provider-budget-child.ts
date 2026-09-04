import { writeFile } from "node:fs/promises";

import {
  ProviderRequestBudgetError,
  openProviderRequestBudget,
  type ProviderOperationKind,
} from "../../../src/agent-runtime/provider-request-budget.ts";
import { PROVIDER_ATTEMPT_BUILD_MARKER } from "../../../src/workbench-shell/provider-attempt-plan.ts";

const [mode, locator, operation, effectPath] = process.argv.slice(2);
if (
  (mode !== "effect" && mode !== "crash" && mode !== "transport-failure") ||
  locator === undefined ||
  operation === undefined
) {
  process.exitCode = 3;
} else {
  const budget = openProviderRequestBudget({
    locator,
    expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
  });
  try {
    await budget.claim(operation as ProviderOperationKind);
    if (mode === "effect") {
      if (effectPath === undefined) throw new Error("missing-effect-path");
      await writeFile(effectPath, "inert-provider-effect\n", {
        encoding: "utf8",
        flag: "wx",
      });
    } else if (mode === "crash") {
      throw new Error("simulated-crash-after-claim");
    } else {
      throw new Error("simulated-transport-failure-after-claim");
    }
  } catch (error) {
    if (mode === "effect") {
      process.exitCode = error instanceof ProviderRequestBudgetError
        ? {
            "budget-exhausted": 2,
            "allocation-uncertain": 4,
            "ledger-invalid": 5,
            "build-marker-mismatch": 6,
            "unknown-operation": 7,
          }[error.category]
        : 8;
    }
    else throw error;
  }
}
