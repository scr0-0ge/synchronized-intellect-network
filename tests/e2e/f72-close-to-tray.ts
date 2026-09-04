import {
  runHeldActiveScenario as runHeldActiveScenarioImplementation,
} from "./f72-close-to-tray/held-active.ts";
import {
  runIdleScenario as runIdleScenarioImplementation,
} from "./f72-close-to-tray/idle.ts";

type F72Scenario = "idle" | "held-active";

function readScenario(arguments_: readonly string[]): F72Scenario {
  if (arguments_.length === 0) return "idle";
  if (arguments_.length === 1 && arguments_[0] === "--scenario=held-active") {
    return "held-active";
  }
  throw new Error("f72-scenario-invalid");
}

async function runIdleScenario(): Promise<void> {
  await runIdleScenarioImplementation();
}

async function runHeldActiveScenario(): Promise<void> {
  await runHeldActiveScenarioImplementation();
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return `f72-aggregate-failure: ${error.errors
      .map(safeFailureMessage)
      .join("; ")}`;
  }
  if (!(error instanceof Error)) return "f72-non-error-failure";
  if (/^f72-[a-z0-9-]+$/u.test(error.message)) return error.message;
  return error.name === "AssertionError"
    ? "f72-assertion-failed"
    : "f72-internal-failure";
}

async function main(): Promise<void> {
  const scenario = readScenario(process.argv.slice(2));
  if (scenario === "held-active") await runHeldActiveScenario();
  else await runIdleScenario();
}

void main().catch((error: unknown) => {
  console.error(safeFailureMessage(error));
  process.exitCode = 1;
});


