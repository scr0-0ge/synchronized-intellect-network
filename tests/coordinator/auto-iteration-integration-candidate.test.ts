import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createExecutionJobRunner } from "../../src/coordinator/auto-iteration/execution-job.ts";
import {
  createIntegrationCandidateBuilder,
  revalidateIntegrationCandidate,
} from "../../src/coordinator/auto-iteration/integration-candidate.ts";
import { createWorkspaceManager } from "../../src/coordinator/auto-iteration/workspace-manager.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function createRepository(root: string): Promise<{
  repositoryPath: string;
  baselineCommitSha: string;
}> {
  const remotePath = join(root, "remote.git");
  const repositoryPath = join(root, "repository");
  await git(root, "init", "--bare", remotePath);
  await git(root, "init", "-b", "demo", repositoryPath);
  await git(repositoryPath, "config", "user.name", "Fixture User");
  await git(repositoryPath, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(repositoryPath, "shared.txt"), "baseline\n", "utf8");
  await git(repositoryPath, "add", "shared.txt");
  await git(repositoryPath, "commit", "-m", "baseline");
  await git(repositoryPath, "remote", "add", "origin", remotePath);
  await git(repositoryPath, "push", "-u", "origin", "demo");
  return {
    repositoryPath,
    baselineCommitSha: await git(repositoryPath, "rev-parse", "origin/demo"),
  };
}

async function commitOnBranch(
  repositoryPath: string,
  branch: string,
  file: string,
  contents: string,
): Promise<string> {
  await git(repositoryPath, "switch", "-C", branch, "origin/demo");
  await writeFile(join(repositoryPath, file), contents, "utf8");
  await git(repositoryPath, "add", file);
  await git(repositoryPath, "commit", "-m", branch);
  return git(repositoryPath, "rev-parse", "HEAD");
}

test("a candidate binds the merge tree and invalidates when origin/demo moves", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-candidate-move-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repositoryPath, baselineCommitSha } = await createRepository(root);
  const firstCommit = await commitOnBranch(
    repositoryPath,
    "worker/a",
    "worker-a.txt",
    "a\n",
  );
  const secondCommit = await commitOnBranch(
    repositoryPath,
    "worker/b",
    "worker-b.txt",
    "b\n",
  );
  await git(repositoryPath, "switch", "demo");
  const managedRoot = join(root, "managed");
  const workspaceManager = createWorkspaceManager({ repositoryPath, managedRoot });
  const runner = createExecutionJobRunner({ recordsRoot: join(root, "jobs") });
  const builder = createIntegrationCandidateBuilder({
    repositoryPath,
    workspaceManager,
    jobs: runner,
  });

  const result = await builder.build({
    integrationCandidateId: "candidate-1",
    expectedTargetBaselineCommitSha: baselineCommitSha,
    orderedCommitShas: [firstCommit, secondCommit],
    gateDefinitionVersion: "uaw-gates-v1",
    environment: "Windows fixture; repository-local git config",
    handoffs: [],
    reviewDecisionIds: [],
    version: 1,
    inputVersion: 11,
  });

  assert.equal(result.status, "ready");
  if (result.status !== "ready") assert.fail("candidate did not build");
  assert.deepEqual(result.candidate.orderedCommitShas, [firstCommit, secondCommit]);
  assert.match(result.candidate.mergeTreeSha, /^[0-9a-f]{40}$/u);
  assert.equal(result.candidate.environment, "Windows fixture; repository-local git config");
  const candidateWorkspace = await workspaceManager.readWorkspace("candidate-1");
  assert.equal(candidateWorkspace?.status, "ready");
  assert.equal(
    await git(candidateWorkspace?.path ?? "", "rev-parse", "HEAD^{tree}"),
    result.candidate.mergeTreeSha,
  );
  assert.equal(
    await git(candidateWorkspace?.path ?? "", "rev-parse", "HEAD^{commit}"),
    result.candidate.mergeCommitSha,
  );

  await git(repositoryPath, "switch", "worker/a");
  await writeFile(join(repositoryPath, "worker-a-more.txt"), "more a\n", "utf8");
  await git(repositoryPath, "add", "worker-a-more.txt");
  await git(repositoryPath, "commit", "-m", "augment worker artifact");
  const augmentedCommit = await git(repositoryPath, "rev-parse", "HEAD");
  const augmentedValidation = await revalidateIntegrationCandidate({
    repositoryPath,
    candidate: result.candidate,
    orderedCommitShas: [firstCommit, secondCommit, augmentedCommit],
    gateDefinitionVersion: "uaw-gates-v1",
  });
  assert.equal(augmentedValidation.status, "invalidated");
  if (augmentedValidation.status !== "invalidated") {
    assert.fail("augmented worker commits kept an old candidate valid");
  }
  assert.equal(augmentedValidation.reason, "ordered-commits-changed");

  await git(repositoryPath, "switch", "demo");

  await writeFile(join(repositoryPath, "target-moved.txt"), "new target\n", "utf8");
  await git(repositoryPath, "add", "target-moved.txt");
  await git(repositoryPath, "commit", "-m", "move target");
  await git(repositoryPath, "push", "origin", "demo");
  await git(repositoryPath, "fetch", "origin", "demo");

  const validation = await revalidateIntegrationCandidate({
    repositoryPath,
    candidate: result.candidate,
    orderedCommitShas: [firstCommit, secondCommit],
    gateDefinitionVersion: "uaw-gates-v1",
  });
  assert.equal(validation.status, "invalidated");
  if (validation.status !== "invalidated") assert.fail("candidate stayed valid");
  assert.equal(validation.reason, "target-baseline-changed");
  assert.notEqual(validation.observedTargetBaselineCommitSha, baselineCommitSha);
  await workspaceManager.reclaimWorkspace("candidate-1");
});

test("a conflicting ordered commit set reports files and never becomes a ready candidate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-candidate-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repositoryPath, baselineCommitSha } = await createRepository(root);
  const firstCommit = await commitOnBranch(
    repositoryPath,
    "worker/left",
    "shared.txt",
    "left\n",
  );
  const secondCommit = await commitOnBranch(
    repositoryPath,
    "worker/right",
    "shared.txt",
    "right\n",
  );
  await git(repositoryPath, "switch", "demo");
  const managedRoot = join(root, "managed");
  const workspaceManager = createWorkspaceManager({ repositoryPath, managedRoot });
  const runner = createExecutionJobRunner({ recordsRoot: join(root, "jobs") });
  const builder = createIntegrationCandidateBuilder({
    repositoryPath,
    workspaceManager,
    jobs: runner,
  });

  const result = await builder.build({
    integrationCandidateId: "candidate-conflict",
    expectedTargetBaselineCommitSha: baselineCommitSha,
    orderedCommitShas: [firstCommit, secondCommit],
    gateDefinitionVersion: "uaw-gates-v1",
    environment: "Windows fixture",
    handoffs: [],
    reviewDecisionIds: [],
    version: 1,
    inputVersion: 4,
  });

  assert.equal(result.status, "conflict");
  if (result.status !== "conflict") assert.fail("conflict was not reported");
  assert.deepEqual(result.conflictFiles, ["shared.txt"]);
  assert.equal(result.mergeTreeSha, null);
  const workspace = await workspaceManager.readWorkspace("candidate-conflict");
  assert.equal(workspace?.status, "reclaimed");
});
