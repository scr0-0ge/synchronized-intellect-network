import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

import { createExecutionJobRunner } from "../../src/coordinator/auto-iteration/execution-job.ts";
import type { FrozenIntegrationCandidate } from "../../src/coordinator/auto-iteration/integration-candidate.ts";
import { createIntegrationCandidateBuilder } from "../../src/coordinator/auto-iteration/integration-candidate.ts";
import { createIntegrationRunner } from "../../src/coordinator/auto-iteration/integration-runner.ts";
import { createWorkspaceManager } from "../../src/coordinator/auto-iteration/workspace-manager.ts";

/**
 * The M3 integration runner against real git (temporary bare remote plus a
 * local clone): green path (artifact merged, fixed gates green, LOCAL target
 * branch carries the merge commit), merge-conflict, gate-failed with bounded
 * gate tails, target-moved, deferral, and replay of finished durable jobs.
 */

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Auto Iteration Test",
      GIT_AUTHOR_EMAIL: "auto-iteration@example.invalid",
      GIT_COMMITTER_NAME: "Auto Iteration Test",
      GIT_COMMITTER_EMAIL: "auto-iteration@example.invalid",
    },
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** A fake gate command committed at the baseline; the fixed `run-gate` recipe calls it. */
function fakePnpmBat(options: { readonly failingGate?: string } = {}): string {
  const failing = options.failingGate ?? "";
  return [
    "@echo off",
    `if /i not "%1"=="${failing}" (`,
    "echo %1 gate passed",
    "exit /b 0",
    ")",
    "for /l %%i in (1,1,260) do echo typecheck-output-line-%%i",
    "exit /b 1",
    "",
  ].join("\r\n");
}

interface Fixture {
  readonly root: string;
  readonly projectDirectory: string;
  readonly baselineCommitSha: string;
  readonly workspaceManager: ReturnType<typeof createWorkspaceManager>;
  readonly executionJobs: ReturnType<typeof createExecutionJobRunner>;
  buildCandidate(candidateId: string, artifactRef: string): Promise<FrozenIntegrationCandidate>;
}

async function createFixture(
  t: TestContext,
  prefix: string,
  bat: string,
): Promise<Fixture> {
  const scratchRoot =
    process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const remoteDirectory = join(root, "remote.git");
  const projectDirectory = join(root, "Project");
  await git(root, "init", "--bare", "--initial-branch=demo", remoteDirectory);
  await git(root, "clone", remoteDirectory, projectDirectory);
  await git(projectDirectory, "config", "user.name", "Auto Iteration Test");
  await git(
    projectDirectory,
    "config",
    "user.email",
    "auto-iteration@example.invalid",
  );
  await writeFile(join(projectDirectory, "baseline.txt"), "baseline\n", "utf8");
  await writeFile(join(projectDirectory, "pnpm.bat"), bat, "utf8");
  await git(projectDirectory, "add", "baseline.txt", "pnpm.bat");
  await git(projectDirectory, "commit", "-m", "test: baseline");
  await git(projectDirectory, "push", "-u", "origin", "demo");
  const baselineCommitSha = await git(projectDirectory, "rev-parse", "HEAD");

  const managedRoot = join(root, "managed");
  const workspaceManager = createWorkspaceManager({
    repositoryPath: projectDirectory,
    managedRoot,
  });
  const executionJobs = createExecutionJobRunner({
    recordsRoot: join(managedRoot, "jobs"),
  });
  const builder = createIntegrationCandidateBuilder({
    repositoryPath: projectDirectory,
    workspaceManager,
    jobs: executionJobs,
  });
  return {
    root,
    projectDirectory,
    baselineCommitSha,
    workspaceManager,
    executionJobs,
    async buildCandidate(candidateId, artifactRef) {
      const built = await builder.build({
        integrationCandidateId: candidateId,
        expectedTargetBaselineCommitSha: baselineCommitSha,
        orderedCommitShas: [artifactRef],
        gateDefinitionVersion: "issue-8-m3-v1",
        environment: "fixture",
        handoffs: [
          {
            workOrderId: "work-order-fixture",
            attemptId: "attempt-fixture",
            handoffId: "handoff-fixture",
          },
        ],
        reviewDecisionIds: ["review-fixture"],
        version: 1,
        inputVersion: 1,
      });
      if (built.status !== "ready") {
        assert.fail(`fixture candidate did not build: ${built.status}`);
      }
      return built.candidate;
    },
  };
}

/** A worker artifact commit on its own branch off the baseline. */
async function commitArtifact(
  fixture: Fixture,
  file: string,
  contents: string,
): Promise<string> {
  await git(fixture.projectDirectory, "switch", "-C", "work/feature");
  await writeFile(join(fixture.projectDirectory, file), contents, "utf8");
  await git(fixture.projectDirectory, "add", file);
  await git(fixture.projectDirectory, "commit", "-m", "feat: worker delivery");
  const sha = await git(fixture.projectDirectory, "rev-parse", "HEAD");
  await git(fixture.projectDirectory, "switch", "demo");
  return sha;
}

function runnerFor(fixture: Fixture) {
  return createIntegrationRunner({
    workspaceManager: fixture.workspaceManager,
    jobs: fixture.executionJobs,
  });
}

function runInput(fixture: Fixture, candidate: FrozenIntegrationCandidate, gates: readonly string[]) {
  return {
    candidate,
    repositoryPath: fixture.projectDirectory,
    targetRef: "origin/demo",
    localTargetBranch: "demo",
    // The approved recipe set is nominal; the committed fake pnpm.bat decides the exit.
    gates: gates as Parameters<ReturnType<typeof createIntegrationRunner>["run"]>[0]["gates"],
  };
}

test("an all-green candidate merges to the local target branch with a recorded merge commit", async (t) => {
  const fixture = await createFixture(t, "integration-green-", fakePnpmBat());
  const artifactSha = await commitArtifact(fixture, "worker-delivery.txt", "delivered\n");
  const candidate = await fixture.buildCandidate("candidate-green", artifactSha);
  const result = await runnerFor(fixture).run(
    runInput(fixture, candidate, ["build", "typecheck", "test"]),
  );

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.outcome.status, "integrated");
  if (result.outcome.status !== "integrated") return;
  assert.equal(result.outcome.gates.length, 3);
  assert.ok(result.outcome.gates.every((gate) => gate.passed && gate.exitCode === 0));
  assert.deepEqual(
    result.outcome.gates.map((gate) => gate.gate),
    ["build", "typecheck", "test"],
  );
  for (const gate of result.outcome.gates) {
    assert.equal(gate.jobId, `integration-candidate-green-gate-${gate.gate}`);
    assert.match(gate.tail, /gate passed/u);
  }

  // The LOCAL target branch carries the merge commit and the reviewed tree.
  assert.equal(
    await git(fixture.projectDirectory, "rev-parse", "refs/heads/demo"),
    result.outcome.mergeCommitSha,
  );
  assert.equal(
    await gitOk(
      fixture.projectDirectory,
      "merge-base",
      "--is-ancestor",
      artifactSha,
      "refs/heads/demo",
    ),
    true,
    "the worker artifact must be reachable from the local target branch",
  );
  assert.equal(
    await git(fixture.projectDirectory, "rev-parse", "refs/heads/demo^{tree}"),
    candidate.mergeTreeSha,
    "the landed tree must be exactly the frozen candidate tree",
  );
  // The remote-tracking target never moved: nothing was pushed.
  assert.equal(
    await git(fixture.root, "--git-dir", join(fixture.root, "remote.git"), "rev-parse", "refs/heads/demo"),
    fixture.baselineCommitSha,
  );
});

test("a conflicting target movement blocks the candidate with a readable conflict list", async (t) => {
  const fixture = await createFixture(t, "integration-conflict-", fakePnpmBat());
  const artifactSha = await commitArtifact(fixture, "worker-delivery.txt", "delivered\n");
  const candidate = await fixture.buildCandidate("candidate-conflict", artifactSha);

  // The local target branch moves with a competing change to the same file.
  await writeFile(
    join(fixture.projectDirectory, "worker-delivery.txt"),
    "conflicting target change\n",
    "utf8",
  );
  await git(fixture.projectDirectory, "add", "worker-delivery.txt");
  await git(fixture.projectDirectory, "commit", "-m", "chore: target moves on");
  const movedSha = await git(fixture.projectDirectory, "rev-parse", "HEAD");

  const result = await runnerFor(fixture).run(
    runInput(fixture, candidate, ["build", "typecheck"]),
  );
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.outcome.status, "blocked: merge-conflict");
  if (result.outcome.status !== "blocked: merge-conflict") return;
  assert.deepEqual(result.outcome.conflictFiles, ["worker-delivery.txt"]);
  // Gates never ran and the target branch kept the moved commit.
  assert.equal(
    await fixture.executionJobs.read("integration-candidate-conflict-gate-build"),
    null,
  );
  assert.equal(
    await git(fixture.projectDirectory, "rev-parse", "refs/heads/demo"),
    movedSha,
  );
});

test("a red gate blocks the candidate with the failing gate and its last 200 lines", async (t) => {
  const fixture = await createFixture(
    t,
    "integration-gate-red-",
    fakePnpmBat({ failingGate: "typecheck" }),
  );
  const artifactSha = await commitArtifact(fixture, "worker-delivery.txt", "delivered\n");
  const candidate = await fixture.buildCandidate("candidate-red", artifactSha);
  const result = await runnerFor(fixture).run(
    runInput(fixture, candidate, ["build", "typecheck", "test"]),
  );

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.outcome.status, "blocked: gate-failed");
  if (result.outcome.status !== "blocked: gate-failed") return;
  assert.equal(result.outcome.gates.length, 2, "gates stop at the first failure");
  assert.equal(result.outcome.gates[0]!.gate, "build");
  assert.equal(result.outcome.gates[0]!.passed, true);
  assert.equal(result.outcome.gates[1]!.gate, "typecheck");
  assert.equal(result.outcome.gates[1]!.passed, false);
  assert.equal(result.outcome.gates[1]!.exitCode, 1);
  const tailLines = result.outcome.gates[1]!.tail.split("\n");
  assert.equal(tailLines.length, 200, "the persisted tail is bounded to 200 lines");
  assert.match(tailLines[tailLines.length - 1]!, /typecheck-output-line-260/u);
  assert.equal(
    tailLines.some((line) => line.includes("typecheck-output-line-60")),
    false,
    "older lines are dropped from the tail",
  );
  // The target branch never moved and the test gate never ran.
  assert.equal(
    await fixture.executionJobs.read("integration-candidate-red-gate-test"),
    null,
  );
  assert.equal(
    await git(fixture.projectDirectory, "rev-parse", "refs/heads/demo"),
    fixture.baselineCommitSha,
  );
});

test("a non-conflicting target movement blocks the candidate as target-moved", async (t) => {
  const fixture = await createFixture(t, "integration-moved-", fakePnpmBat());
  const artifactSha = await commitArtifact(fixture, "worker-delivery.txt", "delivered\n");
  const candidate = await fixture.buildCandidate("candidate-moved", artifactSha);

  await writeFile(
    join(fixture.projectDirectory, "unrelated-target-change.txt"),
    "moved\n",
    "utf8",
  );
  await git(fixture.projectDirectory, "add", "unrelated-target-change.txt");
  await git(fixture.projectDirectory, "commit", "-m", "chore: target moves on");
  await git(fixture.projectDirectory, "push", "origin", "demo");
  const movedSha = await git(fixture.projectDirectory, "rev-parse", "HEAD");

  const result = await runnerFor(fixture).run(
    runInput(fixture, candidate, ["build", "typecheck"]),
  );
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.outcome.status, "blocked: target-moved");
  if (result.outcome.status !== "blocked: target-moved") return;
  assert.equal(result.outcome.expectedBaselineCommitSha, fixture.baselineCommitSha);
  assert.equal(result.outcome.observedLocalBranchCommitSha, movedSha);
  assert.equal(result.outcome.observedTargetRefCommitSha, movedSha);
  assert.equal(
    await fixture.executionJobs.read("integration-candidate-moved-gate-build"),
    null,
    "gates never run for a moved target",
  );
  assert.equal(
    await git(fixture.projectDirectory, "rev-parse", "refs/heads/demo"),
    movedSha,
    "the moved target branch is left untouched",
  );
});

test("a dirty project worktree defers the integration instead of blocking it", async (t) => {
  const fixture = await createFixture(t, "integration-deferred-", fakePnpmBat());
  const artifactSha = await commitArtifact(fixture, "worker-delivery.txt", "delivered\n");
  const candidate = await fixture.buildCandidate("candidate-deferred", artifactSha);

  await writeFile(
    join(fixture.projectDirectory, "uncommitted.txt"),
    "owner is typing\n",
    "utf8",
  );
  const result = await runnerFor(fixture).run(
    runInput(fixture, candidate, ["build", "typecheck"]),
  );
  assert.equal(result.status, "deferred");
  if (result.status !== "deferred") return;
  assert.match(result.reason, /not clean/u);
  assert.equal(
    await fixture.workspaceManager.readWorkspace("integration-candidate-deferred"),
    null,
    "a deferred run must not leave an integration workspace behind",
  );
});

test("a replayed green run reuses its durable jobs and returns the same outcome", async (t) => {
  const fixture = await createFixture(t, "integration-replay-", fakePnpmBat());
  const artifactSha = await commitArtifact(fixture, "worker-delivery.txt", "delivered\n");
  const candidate = await fixture.buildCandidate("candidate-replay", artifactSha);
  const runner = runnerFor(fixture);
  const first = await runner.run(runInput(fixture, candidate, ["build", "typecheck"]));
  assert.equal(first.status, "completed");

  const jobsRoot = join(fixture.root, "managed", "jobs");
  const recordsBefore = (await readdir(jobsRoot)).filter((name) => name.endsWith(".json")).sort();
  const second = await runner.run(runInput(fixture, candidate, ["build", "typecheck"]));
  assert.deepEqual(second, first, "the replay recomputes nothing");
  const recordsAfter = (await readdir(jobsRoot)).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(recordsAfter, recordsBefore, "no new durable job records on replay");
});
