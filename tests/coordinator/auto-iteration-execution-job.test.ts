import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createExecutionJobRunner } from "../../src/coordinator/auto-iteration/execution-job.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function createRepository(root: string): Promise<string> {
  const repositoryPath = join(root, "repository");
  await git(root, "init", "-b", "demo", repositoryPath);
  await git(repositoryPath, "config", "user.name", "Fixture User");
  await git(repositoryPath, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(repositoryPath, "artifact.txt"), "baseline\n", "utf8");
  await git(repositoryPath, "add", "artifact.txt");
  await git(repositoryPath, "commit", "-m", "baseline");
  return repositoryPath;
}

test("capture-artifact commits the workspace and reads the artifact SHA from git", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-job-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  await writeFile(join(repositoryPath, "artifact.txt"), "worker result\n", "utf8");
  const runner = createExecutionJobRunner({ recordsRoot: join(root, "jobs") });

  const job = await runner.run({
    jobId: "capture-1",
    recipe: "capture-artifact",
    inputVersion: 7,
    workingDirectory: repositoryPath,
    commitMessage: "capture worker result",
  });

  assert.equal(job.status, "succeeded", JSON.stringify(job));
  assert.equal(job.inputVersion, 7);
  assert.equal(job.output?.kind, "captured-artifact");
  if (job.output?.kind !== "captured-artifact") assert.fail("missing artifact");
  assert.equal(job.output.commitSha, await git(repositoryPath, "rev-parse", "HEAD"));
  assert.equal(job.output.commitSha.length, 40);
  assert.ok(job.processes.every(({ pid }) => Number.isInteger(pid) && pid > 0));
  assert.equal(job.exit?.code, 0);

  const persisted = JSON.parse(
    await readFile(join(root, "jobs", "capture-1.json"), "utf8"),
  ) as { output: { commitSha: string } };
  assert.equal(persisted.output.commitSha, job.output.commitSha);

  const gitState = await runner.run({
    jobId: "git-state-1",
    recipe: "read-git-state",
    inputVersion: 8,
    workingDirectory: repositoryPath,
  });
  assert.equal(gitState.status, "succeeded");
  assert.equal(gitState.output?.kind, "git-state");
  if (gitState.output?.kind !== "git-state") assert.fail("missing git state");
  assert.equal(gitState.output.commitSha, job.output.commitSha);
});

test("run-gate accepts only the fixed gate set and stores a bounded head/tail log", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-job-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  await writeFile(
    join(repositoryPath, "pnpm.bat"),
    "@echo off\r\npowershell -NoProfile -Command \"Write-Output ('HEAD-' + ('x' * 24000) + '-TAIL')\"\r\n",
    "utf8",
  );
  const runner = createExecutionJobRunner({
    recordsRoot: join(root, "jobs"),
    logEdgeBytes: 1024,
  });

  const job = await runner.run({
    jobId: "gate-1",
    recipe: "run-gate",
    inputVersion: 3,
    workingDirectory: repositoryPath,
    gate: "typecheck",
  });

  assert.equal(job.status, "succeeded", JSON.stringify(job));
  assert.equal(job.log.truncated, true);
  assert.match(job.log.head, /^HEAD-/u);
  assert.match(job.log.tail, /-TAIL\r?\n$/u);
  const storedLog = await readFile(job.log.path);
  assert.ok(storedLog.byteLength <= 2_200);
  await assert.rejects(
    runner.run({
      jobId: "gate-invalid",
      recipe: "run-gate",
      inputVersion: 3,
      workingDirectory: repositoryPath,
      gate: "publish" as never,
    }),
    /unsupported gate/u,
  );
  await assert.rejects(
    runner.run({
      jobId: "recipe-invalid",
      recipe: "arbitrary-shell",
      inputVersion: 3,
      workingDirectory: repositoryPath,
    } as never),
    /unsupported execution recipe/u,
  );
});

test("an active fixed job can be interrupted by its recorded process id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-job-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  await writeFile(
    join(repositoryPath, "pnpm.bat"),
    "@echo off\r\nping 127.0.0.1 -n 30 >nul\r\n",
    "utf8",
  );
  const runner = createExecutionJobRunner({ recordsRoot: join(root, "jobs") });
  const running = runner.run({
    jobId: "gate-stop",
    recipe: "run-gate",
    inputVersion: 1,
    workingDirectory: repositoryPath,
    gate: "test",
  });

  for (let index = 0; index < 100; index += 1) {
    const record = await runner.read("gate-stop");
    if (record?.status === "running" && record.processes.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await runner.interrupt("gate-stop"), true);
  const job = await running;

  assert.equal(job.status, "interrupted");
  assert.ok(job.processes[0]?.pid);
  assert.notEqual(job.exit?.code, 0);
});
