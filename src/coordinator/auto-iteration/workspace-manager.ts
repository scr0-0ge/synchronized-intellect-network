import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export type ManagedWorkspaceStatus =
  | "creating"
  | "ready"
  | "reclaiming"
  | "pending-reclaim"
  | "reclaimed"
  | "create-failed";

export interface WorkspaceOperationRecord {
  readonly kind: "create" | "verify-cwd" | "reclaim";
  readonly outcome: "started" | "succeeded" | "failed";
  readonly at: string;
  readonly detail?: string;
}

export interface ManagedWorkspaceRecord {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly attemptId: string | null;
  readonly candidateId: string | null;
  readonly path: string;
  readonly branch: string | null;
  readonly baselineCommitSha: string;
  readonly status: ManagedWorkspaceStatus;
  readonly lastError: string | null;
  readonly operations: readonly WorkspaceOperationRecord[];
}

export interface GitCommandRequest {
  readonly cwd: string;
  readonly args: readonly string[];
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitCommandRunner = (
  request: GitCommandRequest,
) => Promise<GitCommandResult>;

export async function runGitCommand(
  request: GitCommandRequest,
): Promise<GitCommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn("git", [...request.args], {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resolveResult({ exitCode: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once("close", (code) => {
      resolveResult({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

export interface WorkspaceManager {
  createAttemptWorkspace(input: {
    readonly attemptId: string;
    readonly branch: string;
    readonly baselineRef: string;
  }): Promise<ManagedWorkspaceRecord>;
  createCandidateWorkspace(input: {
    readonly candidateId: string;
    readonly baselineRef: string;
  }): Promise<ManagedWorkspaceRecord>;
  /**
   * Managed worktree for integrating one candidate into its target branch;
   * lives at `<managedRoot>/integrations/<candidateId>` under the same root as
   * attempt workspaces, on its own `branch` starting at `startRef`.
   */
  createIntegrationWorkspace(input: {
    readonly candidateId: string;
    readonly branch: string;
    readonly startRef: string;
  }): Promise<ManagedWorkspaceRecord>;
  verifyWorkspaceCwd(workspaceId: string): Promise<string>;
  reclaimWorkspace(workspaceId: string): Promise<ManagedWorkspaceRecord>;
  readWorkspace(workspaceId: string): Promise<ManagedWorkspaceRecord | null>;
}

interface MutableWorkspaceRecord {
  schemaVersion: 1;
  workspaceId: string;
  attemptId: string | null;
  candidateId: string | null;
  path: string;
  branch: string | null;
  baselineCommitSha: string;
  status: ManagedWorkspaceStatus;
  lastError: string | null;
  operations: WorkspaceOperationRecord[];
}

function requireIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`${label} must use letters, digits, dot, underscore, or dash`);
  }
}

function errorDetail(result: GitCommandResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`).slice(
    0,
    4096,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => resolve(value).replaceAll("/", "\\").toLowerCase();
  return normalize(left) === normalize(right);
}

export function createWorkspaceManager(options: {
  readonly repositoryPath: string;
  readonly managedRoot: string;
  readonly git?: GitCommandRunner;
}): WorkspaceManager {
  const git = options.git ?? runGitCommand;
  let initialized:
    | Promise<{ repositoryPath: string; managedRoot: string; recordsRoot: string }>
    | undefined;

  const initialize = () => {
    initialized ??= (async () => {
      const repositoryProbe = await git({
        cwd: options.repositoryPath,
        args: ["rev-parse", "--show-toplevel"],
      });
      if (repositoryProbe.exitCode !== 0) {
        throw new Error(`managed repository is not a git worktree: ${errorDetail(repositoryProbe)}`);
      }
      const repositoryPath = repositoryProbe.stdout.trim();
      await mkdir(options.managedRoot, { recursive: true });
      const managedRoot = await realpath(options.managedRoot);
      const recordsRoot = join(managedRoot, "records");
      await mkdir(join(managedRoot, "workspaces"), { recursive: true });
      await mkdir(recordsRoot, { recursive: true });
      return { repositoryPath, managedRoot, recordsRoot };
    })();
    return initialized;
  };

  async function recordPath(workspaceId: string): Promise<string> {
    requireIdentifier(workspaceId, "workspaceId");
    return join((await initialize()).recordsRoot, `${workspaceId}.json`);
  }

  async function persist(record: MutableWorkspaceRecord): Promise<void> {
    const path = await recordPath(record.workspaceId);
    const pendingPath = `${path}.writing`;
    await writeFile(
      pendingPath,
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(pendingPath, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          attempt >= 10 ||
          (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
        ) {
          throw error;
        }
        await new Promise<void>((resolveRetry) =>
          setTimeout(resolveRetry, 20 * (attempt + 1)),
        );
      }
    }
  }

  async function loadWorkspace(
    workspaceId: string,
  ): Promise<MutableWorkspaceRecord | null> {
    const path = await recordPath(workspaceId);
    try {
      return JSON.parse(await readFile(path, "utf8")) as MutableWorkspaceRecord;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  async function resolveCommit(reference: string): Promise<string> {
    const { repositoryPath } = await initialize();
    const result = await git({
      cwd: repositoryPath,
      args: ["rev-parse", "--verify", `${reference}^{commit}`],
    });
    if (result.exitCode !== 0) {
      throw new Error(`cannot resolve workspace baseline: ${errorDetail(result)}`);
    }
    return result.stdout.trim();
  }

  async function createWorkspace(input: {
    readonly workspaceId: string;
    readonly attemptId: string | null;
    readonly candidateId: string | null;
    readonly branch: string | null;
    readonly baselineRef: string;
    readonly subdirectory?: string;
    readonly pathName?: string;
  }): Promise<ManagedWorkspaceRecord> {
    requireIdentifier(input.workspaceId, "workspaceId");
    const roots = await initialize();
    if (await loadWorkspace(input.workspaceId)) {
      throw new Error(`workspace already has a durable record: ${input.workspaceId}`);
    }
    if (input.branch !== null) {
      const branchCheck = await git({
        cwd: roots.repositoryPath,
        args: ["check-ref-format", "--branch", input.branch],
      });
      if (branchCheck.exitCode !== 0) {
        throw new Error(`invalid workspace branch: ${errorDetail(branchCheck)}`);
      }
    }
    const baselineCommitSha = await resolveCommit(input.baselineRef);
    const subdirectory = input.subdirectory ?? "workspaces";
    const workspacePath = join(
      roots.managedRoot,
      subdirectory,
      input.pathName ?? input.workspaceId,
    );
    await mkdir(join(roots.managedRoot, subdirectory), { recursive: true });
    const now = new Date().toISOString();
    const record: MutableWorkspaceRecord = {
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      attemptId: input.attemptId,
      candidateId: input.candidateId,
      path: workspacePath,
      branch: input.branch,
      baselineCommitSha,
      status: "creating",
      lastError: null,
      operations: [{ kind: "create", outcome: "started", at: now }],
    };
    await persist(record);

    const addArguments =
      input.branch === null
        ? ["worktree", "add", "--detach", workspacePath, baselineCommitSha]
        : ["worktree", "add", "-b", input.branch, workspacePath, baselineCommitSha];
    const added = await git({ cwd: roots.repositoryPath, args: addArguments });
    if (added.exitCode !== 0) {
      record.status = (await exists(workspacePath)) ? "pending-reclaim" : "create-failed";
      record.lastError = errorDetail(added);
      record.operations.push({
        kind: "create",
        outcome: "failed",
        at: new Date().toISOString(),
        detail: record.lastError,
      });
      await persist(record);
      throw new Error(`git worktree add failed: ${record.lastError}`);
    }

    const cwdProbe = await git({
      cwd: workspacePath,
      args: ["rev-parse", "--show-toplevel"],
    });
    if (cwdProbe.exitCode !== 0 || !samePath(cwdProbe.stdout.trim(), workspacePath)) {
      record.status = "pending-reclaim";
      record.lastError =
        cwdProbe.exitCode === 0
          ? `worktree resolved to unexpected cwd: ${cwdProbe.stdout.trim()}`
          : errorDetail(cwdProbe);
      record.operations.push({
        kind: "create",
        outcome: "failed",
        at: new Date().toISOString(),
        detail: record.lastError,
      });
      await persist(record);
      throw new Error(record.lastError);
    }

    record.path = cwdProbe.stdout.trim();
    record.status = "ready";
    record.operations.push({
      kind: "create",
      outcome: "succeeded",
      at: new Date().toISOString(),
    });
    await persist(record);
    return structuredClone(record);
  }

  return {
    createAttemptWorkspace(input) {
      return createWorkspace({
        workspaceId: input.attemptId,
        attemptId: input.attemptId,
        candidateId: null,
        branch: input.branch,
        baselineRef: input.baselineRef,
      });
    },

    createCandidateWorkspace(input) {
      return createWorkspace({
        workspaceId: input.candidateId,
        attemptId: null,
        candidateId: input.candidateId,
        branch: null,
        baselineRef: input.baselineRef,
      });
    },

    createIntegrationWorkspace(input) {
      return createWorkspace({
        workspaceId: `integration-${input.candidateId}`,
        attemptId: null,
        candidateId: input.candidateId,
        branch: input.branch,
        baselineRef: input.startRef,
        subdirectory: "integrations",
        pathName: input.candidateId,
      });
    },

    async verifyWorkspaceCwd(workspaceId) {
      const record = await loadWorkspace(workspaceId);
      if (!record || record.status !== "ready") {
        throw new Error(`workspace is not ready: ${workspaceId}`);
      }
      const result = await git({
        cwd: record.path,
        args: ["rev-parse", "--show-toplevel"],
      });
      const branchResult =
        record.branch === null
          ? null
          : await git({
              cwd: record.path,
              args: ["symbolic-ref", "--short", "HEAD"],
            });
      if (
        result.exitCode !== 0 ||
        !samePath(result.stdout.trim(), record.path) ||
        (branchResult !== null &&
          (branchResult.exitCode !== 0 || branchResult.stdout.trim() !== record.branch))
      ) {
        const detail =
          result.exitCode !== 0
            ? errorDetail(result)
            : branchResult !== null && branchResult.exitCode !== 0
              ? errorDetail(branchResult)
              : "recorded workspace identity does not match its actual git cwd/branch";
        record.operations.push({
          kind: "verify-cwd",
          outcome: "failed",
          at: new Date().toISOString(),
          detail,
        });
        record.lastError = detail;
        await persist(record);
        throw new Error(detail);
      }
      record.operations.push({
        kind: "verify-cwd",
        outcome: "succeeded",
        at: new Date().toISOString(),
      });
      record.lastError = null;
      await persist(record);
      return record.path;
    },

    async reclaimWorkspace(workspaceId) {
      const roots = await initialize();
      const record = await loadWorkspace(workspaceId);
      if (!record) throw new Error(`unknown workspace: ${workspaceId}`);
      if (record.status === "reclaimed") return structuredClone(record);
      record.status = "reclaiming";
      record.operations.push({
        kind: "reclaim",
        outcome: "started",
        at: new Date().toISOString(),
      });
      await persist(record);

      let removalFailure: GitCommandResult | null = null;
      if (await exists(record.path)) {
        const removal = await git({
          cwd: roots.repositoryPath,
          args: ["worktree", "remove", "--force", record.path],
        });
        if (removal.exitCode !== 0) removalFailure = removal;
      }
      const prune = await git({
        cwd: roots.repositoryPath,
        args: ["worktree", "prune"],
      });
      const residue = await exists(record.path);
      if (removalFailure || prune.exitCode !== 0 || residue) {
        const detail = removalFailure
          ? errorDetail(removalFailure)
          : prune.exitCode !== 0
            ? errorDetail(prune)
            : "workspace path still exists after git worktree remove";
        record.status = "pending-reclaim";
        record.lastError = detail;
        record.operations.push({
          kind: "reclaim",
          outcome: "failed",
          at: new Date().toISOString(),
          detail,
        });
      } else {
        record.status = "reclaimed";
        record.lastError = null;
        record.operations.push({
          kind: "reclaim",
          outcome: "succeeded",
          at: new Date().toISOString(),
        });
      }
      await persist(record);
      return structuredClone(record);
    },

    async readWorkspace(workspaceId) {
      const record = await loadWorkspace(workspaceId);
      return record === null ? null : structuredClone(record);
    },
  };
}
