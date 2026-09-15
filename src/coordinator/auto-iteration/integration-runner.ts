import type {
  IntegrationCandidate,
  IntegrationGateRecord,
  IntegrationOutcome,
} from "./contract.ts";
import type { ApprovedGate, ExecutionJobRecord, ExecutionJobRunner } from "./execution-job.ts";
import { runGitCommand, type WorkspaceManager } from "./workspace-manager.ts";

/**
 * Product-run integration of one frozen candidate (issue #8 M3, first cut):
 * a fresh worktree on the target branch merges the candidate's frozen merge
 * commit, the fixed gates run on that tree, the target is re-checked against
 * the candidate's frozen baseline, and only an all-green run merges to the
 * LOCAL target branch. Nothing here pushes a remote; publishing is the next
 * cut. Every step replays its durable execution-job record, so an interrupted
 * run resumes without re-executing finished work, and a terminal outcome is
 * never recomputed.
 */

export interface IntegrationRunInput {
  readonly candidate: IntegrationCandidate;
  /** The Project's repository (its main worktree owns the local target branch). */
  readonly repositoryPath: string;
  /** Remote-tracking target ref the candidate was frozen against (e.g. "origin/demo"). */
  readonly targetRef: string;
  /** Local branch the all-green merge lands on (e.g. "demo"). */
  readonly localTargetBranch: string;
  /** Resolved fixed gate plan for the candidate's gateDefinitionVersion. */
  readonly gates: readonly ApprovedGate[];
}

export type IntegrationRunResult =
  | { readonly status: "completed"; readonly outcome: IntegrationOutcome }
  | { readonly status: "deferred"; readonly reason: string };

export interface IntegrationRunner {
  run(input: IntegrationRunInput): Promise<IntegrationRunResult>;
}

export function createIntegrationRunner(options: {
  readonly workspaceManager: WorkspaceManager;
  readonly jobs: ExecutionJobRunner;
}): IntegrationRunner {
  const { workspaceManager, jobs } = options;

  async function resolveCommit(repositoryPath: string, reference: string): Promise<string | null> {
    return resolveObject(repositoryPath, `${reference}^{commit}`);
  }

  async function resolveObject(repositoryPath: string, reference: string): Promise<string | null> {
    const result = await runGitCommand({
      cwd: repositoryPath,
      args: ["rev-parse", "--verify", "--quiet", reference],
    });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async function readTargetState(input: IntegrationRunInput) {
    const branch = await runGitCommand({
      cwd: input.repositoryPath,
      args: ["symbolic-ref", "--short", "-q", "HEAD"],
    });
    const status = await runGitCommand({
      cwd: input.repositoryPath,
      args: ["status", "--porcelain"],
    });
    return {
      targetRefCommitSha: await resolveCommit(input.repositoryPath, input.targetRef),
      localBranchCommitSha: await resolveCommit(
        input.repositoryPath,
        `refs/heads/${input.localTargetBranch}`,
      ),
      projectBranch: branch.exitCode === 0 ? branch.stdout.trim() : null,
      projectClean: status.exitCode === 0 && status.stdout.trim().length === 0,
    };
  }

  /** Replays a finished durable job; throws on a record that is not this candidate's. */
  async function readOrRun(
    request: Parameters<ExecutionJobRunner["run"]>[0],
  ): Promise<ExecutionJobRecord> {
    const existing = await jobs.read(request.jobId);
    if (existing !== null) {
      if (
        existing.recipe !== request.recipe ||
        existing.inputVersion !== request.inputVersion
      ) {
        throw new Error(`integration job does not match the candidate: ${request.jobId}`);
      }
      return existing;
    }
    return jobs.run(request);
  }

  function gateTail(job: ExecutionJobRecord): string {
    const lines = job.log.tail.split(/\r?\n/u);
    while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
    return lines.slice(-200).join("\n");
  }

  function gateRecord(gate: string, job: ExecutionJobRecord): IntegrationGateRecord {
    return {
      gate,
      jobId: job.jobId,
      exitCode: job.exit?.code ?? null,
      passed: job.status === "succeeded",
      tail: gateTail(job),
    };
  }

  /** All gate records when every gate job already succeeded; null otherwise. */
  async function replayedGateRecords(
    input: IntegrationRunInput,
  ): Promise<IntegrationGateRecord[] | null> {
    const records: IntegrationGateRecord[] = [];
    for (const gate of input.gates) {
      const job = await jobs.read(`integration-${input.candidate.integrationCandidateId}-gate-${gate}`);
      if (job === null || job.status !== "succeeded") return null;
      records.push(gateRecord(gate, job));
    }
    return records;
  }

  return {
    async run(input) {
      const candidateId = input.candidate.integrationCandidateId;
      for (const gate of input.gates) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(gate)) {
          return {
            status: "deferred",
            reason: `gate name is not job-id safe: ${gate}`,
          };
        }
      }

      const entry = await readTargetState(input);
      // The final merge executes in the Project's own worktree, so its branch
      // and cleanliness are entry preconditions: gates must not run when the
      // result could not land anyway.
      if (entry.localBranchCommitSha === null) {
        return {
          status: "deferred",
          reason: `local target branch does not exist: ${input.localTargetBranch}`,
        };
      }
      if (entry.projectBranch !== input.localTargetBranch || !entry.projectClean) {
        return {
          status: "deferred",
          reason: `project worktree is not clean on ${input.localTargetBranch} (branch: ${entry.projectBranch ?? "detached"}, clean: ${entry.projectClean})`,
        };
      }

      const baseline = input.candidate.baselineCommitSha;
      const entryMoved =
        (entry.targetRefCommitSha !== null && entry.targetRefCommitSha !== baseline) ||
        entry.localBranchCommitSha !== baseline;

      // The integration worktree starts at the local target's CURRENT head so
      // a moved target surfaces its merge conflicts readably instead of
      // silently merging onto the frozen baseline.
      const workspaceId = `integration-${candidateId}`;
      let workspace = await workspaceManager.readWorkspace(workspaceId);
      if (workspace === null) {
        workspace = await workspaceManager.createIntegrationWorkspace({
          candidateId,
          branch: `workbench/integration/${candidateId}`,
          startRef: entry.localBranchCommitSha,
        });
      }
      if (workspace.status !== "ready") {
        return {
          status: "deferred",
          reason: `integration workspace is not ready: ${workspaceId} (${workspace.status})`,
        };
      }
      const workingDirectory = await workspaceManager.verifyWorkspaceCwd(workspaceId);

      const mergeJob = await readOrRun({
        jobId: `integration-${candidateId}-merge`,
        recipe: "build-candidate",
        inputVersion: input.candidate.version,
        workingDirectory,
        orderedCommitShas: [input.candidate.mergeCommitSha],
      });
      if (mergeJob.output?.kind === "candidate-conflict") {
        return {
          status: "completed",
          outcome: {
            status: "blocked: merge-conflict",
            conflictFiles: [...mergeJob.output.conflictFiles],
          },
        };
      }
      if (mergeJob.status !== "succeeded" || mergeJob.output?.kind !== "candidate-built") {
        return {
          status: "deferred",
          reason: `integration merge failed: ${mergeJob.lastError ?? mergeJob.status}`,
        };
      }
      const integrationHeadCommitSha = mergeJob.output.commitSha;

      if (entryMoved) {
        // A moved target first gets its merge attempted above so a conflict
        // stays readable. Before blocking, one recovery case is provable from
        // durable records alone: a previous pass already landed this exact
        // integration (crash between the final merge and the outcome record).
        const finalJob = await jobs.read(`integration-${candidateId}-final-merge`);
        if (finalJob?.output?.kind === "candidate-built") {
          const landed = await resolveCommit(
            input.repositoryPath,
            `refs/heads/${input.localTargetBranch}`,
          );
          if (landed !== null && landed === finalJob.output.commitSha) {
            const replayedGates = await replayedGateRecords(input);
            if (replayedGates !== null) {
              return {
                status: "completed",
                outcome: {
                  status: "integrated",
                  mergeCommitSha: landed,
                  gates: replayedGates,
                },
              };
            }
          }
        }
        return {
          status: "completed",
          outcome: {
            status: "blocked: target-moved",
            expectedBaselineCommitSha: baseline,
            observedTargetRefCommitSha: entry.targetRefCommitSha,
            observedLocalBranchCommitSha: entry.localBranchCommitSha,
          },
        };
      }

      const gateRecords: IntegrationGateRecord[] = [];
      for (const gate of input.gates) {
        const gateJob = await readOrRun({
          jobId: `integration-${candidateId}-gate-${gate}`,
          recipe: "run-gate",
          inputVersion: input.candidate.version,
          workingDirectory,
          gate,
        });
        gateRecords.push(gateRecord(gate, gateJob));
        if (gateJob.status !== "succeeded") {
          return {
            status: "completed",
            outcome: { status: "blocked: gate-failed", gates: [...gateRecords] },
          };
        }
      }

      // Target re-check immediately before touching the local target branch.
      const recheck = await readTargetState(input);
      if (
        (recheck.targetRefCommitSha !== null && recheck.targetRefCommitSha !== baseline) ||
        recheck.localBranchCommitSha !== baseline
      ) {
        return {
          status: "completed",
          outcome: {
            status: "blocked: target-moved",
            expectedBaselineCommitSha: baseline,
            observedTargetRefCommitSha: recheck.targetRefCommitSha,
            observedLocalBranchCommitSha: recheck.localBranchCommitSha,
          },
        };
      }

      const integrationTree = await resolveObject(
        workingDirectory,
        `${integrationHeadCommitSha}^{tree}`,
      );
      const frozenTree = await resolveObject(
        input.repositoryPath,
        `${input.candidate.mergeCommitSha}^{tree}`,
      );
      if (
        integrationTree === null ||
        frozenTree === null ||
        integrationTree !== frozenTree
      ) {
        return {
          status: "deferred",
          reason: `integration tree diverges from the frozen candidate tree: ${integrationTree} vs ${frozenTree}`,
        };
      }

      if (
        recheck.projectBranch !== input.localTargetBranch ||
        !recheck.projectClean
      ) {
        return {
          status: "deferred",
          reason: `project worktree is not clean on ${input.localTargetBranch} at final merge (branch: ${recheck.projectBranch ?? "detached"}, clean: ${recheck.projectClean})`,
        };
      }

      const finalMerge = await readOrRun({
        jobId: `integration-${candidateId}-final-merge`,
        recipe: "build-candidate",
        inputVersion: input.candidate.version,
        workingDirectory: input.repositoryPath,
        orderedCommitShas: [integrationHeadCommitSha],
      });
      if (finalMerge.output?.kind === "candidate-conflict") {
        return {
          status: "deferred",
          reason: `final target merge conflicted unexpectedly: ${finalMerge.output.conflictFiles.join(", ")}`,
        };
      }
      if (finalMerge.status !== "succeeded" || finalMerge.output?.kind !== "candidate-built") {
        return {
          status: "deferred",
          reason: `final target merge failed: ${finalMerge.lastError ?? finalMerge.status}`,
        };
      }
      const landedCommitSha = await resolveCommit(
        input.repositoryPath,
        `refs/heads/${input.localTargetBranch}`,
      );
      if (landedCommitSha !== finalMerge.output.commitSha) {
        return {
          status: "deferred",
          reason: `local target branch did not land the merge commit: ${landedCommitSha} vs ${finalMerge.output.commitSha}`,
        };
      }
      return {
        status: "completed",
        outcome: {
          status: "integrated",
          mergeCommitSha: landedCommitSha,
          gates: [...gateRecords],
        },
      };
    },
  };
}
