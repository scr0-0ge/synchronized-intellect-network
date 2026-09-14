import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createWorkspaceManager,
  runGitCommand,
} from "../../src/coordinator/auto-iteration/workspace-manager.ts";

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
  await writeFile(join(repositoryPath, "shared.txt"), "baseline\n", "utf8");
  await git(repositoryPath, "add", "shared.txt");
  await git(repositoryPath, "commit", "-m", "baseline");
  return repositoryPath;
}

test("attempt workspace creation is durable and recovery verifies its real cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-ws-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const managedRoot = join(root, "managed");
  const baselineCommitSha = await git(repositoryPath, "rev-parse", "HEAD");
  const manager = createWorkspaceManager({ repositoryPath, managedRoot });

  const created = await manager.createAttemptWorkspace({
    attemptId: "attempt-1",
    branch: "attempt/one",
    baselineRef: "HEAD",
  });

  assert.equal(created.status, "ready");
  assert.equal(created.baselineCommitSha, baselineCommitSha);
  assert.equal(await git(created.path, "rev-parse", "--show-toplevel"), created.path);

  const recoveredManager = createWorkspaceManager({ repositoryPath, managedRoot });
  assert.equal(await recoveredManager.verifyWorkspaceCwd("attempt-1"), created.path);
  const persisted = JSON.parse(
    await readFile(join(managedRoot, "records", "attempt-1.json"), "utf8"),
  ) as { status: string; operations: Array<{ kind: string; outcome: string }> };
  assert.equal(persisted.status, "ready");
  assert.deepEqual(
    persisted.operations.map(({ kind, outcome }) => [kind, outcome]),
    [
      ["create", "started"],
      ["create", "succeeded"],
      ["verify-cwd", "succeeded"],
    ],
  );

  const reclaimed = await recoveredManager.reclaimWorkspace("attempt-1");
  assert.equal(reclaimed.status, "reclaimed");
});

test("two attempt worktrees keep cwd, working files, and indexes separate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-ws-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const manager = createWorkspaceManager({
    repositoryPath,
    managedRoot: join(root, "managed"),
  });
  const first = await manager.createAttemptWorkspace({
    attemptId: "attempt-a",
    branch: "attempt/a",
    baselineRef: "HEAD",
  });
  const second = await manager.createAttemptWorkspace({
    attemptId: "attempt-b",
    branch: "attempt/b",
    baselineRef: "HEAD",
  });

  await writeFile(join(first.path, "only-a.txt"), "a\n", "utf8");
  await git(first.path, "add", "only-a.txt");

  assert.match(await git(first.path, "status", "--short"), /^A  only-a\.txt$/u);
  assert.equal(await git(second.path, "status", "--short"), "");
  await assert.rejects(readFile(join(second.path, "only-a.txt"), "utf8"));
  assert.notEqual(await manager.verifyWorkspaceCwd("attempt-a"), second.path);

  await manager.reclaimWorkspace("attempt-a");
  await manager.reclaimWorkspace("attempt-b");
});

test("a failed worktree removal remains pending-reclaim until a later retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-ws-pending-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const managedRoot = join(root, "managed");
  const manager = createWorkspaceManager({ repositoryPath, managedRoot });
  await manager.createAttemptWorkspace({
    attemptId: "attempt-held",
    branch: "attempt/held",
    baselineRef: "HEAD",
  });

  const failingManager = createWorkspaceManager({
    repositoryPath,
    managedRoot,
    git: async (request) => {
      if (request.args[0] === "worktree" && request.args[1] === "remove") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "error: unable to remove worktree: EPERM",
        };
      }
      return runGitCommand(request);
    },
  });
  const pending = await failingManager.reclaimWorkspace("attempt-held");

  assert.equal(pending.status, "pending-reclaim");
  assert.match(pending.lastError ?? "", /EPERM/u);

  const recoveredManager = createWorkspaceManager({ repositoryPath, managedRoot });
  const reclaimed = await recoveredManager.reclaimWorkspace("attempt-held");
  assert.equal(reclaimed.status, "reclaimed");
});
