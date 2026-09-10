import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { resolveProductionElectronComposition } from "../harness/production-electron.ts";

import {
  journeyScenarios,
  type JourneyScenario,
  type UserJourneyObservation,
  type UserJourneyRuntime,
} from "./contracts.ts";

export const productionElectronComposition = resolveProductionElectronComposition(
  new URL("../live-user-journey.ts", import.meta.url).href,
);
export const expectedRendererUrl = productionElectronComposition.rendererUrl;
export const temporaryRootPattern = /^uaw-live-user-journey-[A-Za-z0-9_-]+$/u;
export const terminalStatePattern = /^(?:completed|failed|outcome unknown)$/iu;

export function subscriptionOnlyEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const key of Object.keys(environment)) {
    if (
      /(?:^|_)(?:API_KEY|AUTH_TOKEN|BEARER_TOKEN|ACCESS_TOKEN)$/iu.test(key) ||
      /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX).*?(?:KEY|TOKEN)$/iu.test(key) ||
      /^UAW_E2E_/u.test(key)
    ) {
      delete environment[key];
    }
  }
  return environment;
}

export async function createTemporaryRoot(): Promise<string> {
  // tmpdir() may be a junction spelling; keep that traversal out of the
  // asynchronous directory creation at the start of each run.
  const physicalTemporaryDirectory = realpathSync(resolve(tmpdir()));
  const root = await mkdtemp(
    join(physicalTemporaryDirectory, "uaw-live-user-journey-"),
  );
  await assertSafeTemporaryRoot(root);
  return root;
}

export async function removeTemporaryRoot(root: string): Promise<void> {
  await assertSafeTemporaryRoot(root);
  await rm(root, { recursive: true, force: false });
}

export async function assertSafeTemporaryRoot(root: string): Promise<void> {
  const lexical = resolve(root);
  const lexicalTemporaryDirectory = resolve(tmpdir());
  assert.match(basename(lexical), temporaryRootPattern);
  const status = await lstat(lexical);
  assert.equal(status.isDirectory(), true);
  assert.equal(status.isSymbolicLink(), false);
  const physical = await realpath(lexical);
  const physicalTemporaryDirectory = await realpath(lexicalTemporaryDirectory);
  assert.equal(
    dirname(physical).toLocaleLowerCase("en-US"),
    physicalTemporaryDirectory.toLocaleLowerCase("en-US"),
  );
  assert.equal(
    basename(physical).toLocaleLowerCase("en-US"),
    basename(lexical).toLocaleLowerCase("en-US"),
  );
}

export function scenariosFor(
  runtime: UserJourneyRuntime,
): readonly [JourneyScenario, JourneyScenario] {
  const scenarios = journeyScenarios.filter((scenario) => scenario.runtime === runtime);
  assert.equal(scenarios.length, 2);
  return scenarios as unknown as readonly [JourneyScenario, JourneyScenario];
}

export function selectedTestDoubleRuntimes(
  selected: readonly UserJourneyRuntime[] | undefined,
): readonly UserJourneyRuntime[] {
  const runtimes: UserJourneyRuntime[] =
    selected === undefined ? ["codex", "claude"] : [...selected];
  if (
    runtimes.length === 0 ||
    runtimes.length > 2 ||
    new Set(runtimes).size !== runtimes.length ||
    runtimes.some((runtime) => runtime !== "codex" && runtime !== "claude") ||
    (runtimes.length === 2 &&
      (runtimes[0] !== "codex" || runtimes[1] !== "claude"))
  ) {
    throw new Error("journey-test-double-runtimes-invalid");
  }
  return Object.freeze(runtimes);
}

export function replyForPrompt(prompt: string): string {
  const scenario = journeyScenarios.find((candidate) => candidate.prompt === prompt);
  if (scenario === undefined) throw new Error("journey-prompt-unexpected");
  return scenario.expectedReply;
}

export function normalizeRuntime(value: string): UserJourneyRuntime | "missing" {
  const normalized = value.toLocaleLowerCase("en-US");
  return normalized === "codex" || normalized === "claude"
    ? normalized
    : "missing";
}

export function safeReplySummary(reply: string): string {
  return `safe-summary(nonEmpty=${reply.length > 0},utf8Bytes=${Buffer.byteLength(
    reply,
    "utf8",
  )},sha256=${createHash("sha256").update(reply, "utf8").digest("hex")})`;
}

export function emitObservation(observation: UserJourneyObservation): void {
  console.log(`LIVE_USER_JOURNEY_OBSERVATION ${JSON.stringify(observation)}`);
}

export function compactText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolveWait, rejectWait) => {
    const timer = setTimeout(() => rejectWait(new Error(message)), milliseconds);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolveWait(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectWait(error);
      },
    );
  });
}
