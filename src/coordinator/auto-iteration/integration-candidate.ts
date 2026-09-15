import type {
  HandoffIdempotencyKey,
  IntegrationCandidate,
} from "./contract.ts";
import type { ExecutionJobRunner } from "./execution-job.ts";
import {
  runGitCommand,
  type WorkspaceManager,
} from "./workspace-manager.ts";

export const INTEGRATION_TARGET_REF = "origin/demo";

export interface FrozenIntegrationCandidate extends IntegrationCandidate {
  /** Human-readable facts needed to reproduce the candidate's gate environment. */
  readonly environment: string;
  readonly constructionJobId: string;
  /** Tool-read commit that can be checked out to run gates for mergeTreeSha. */
  readonly mergeCommitSha: string;
  /** Retained until gates finish so they execute the exact candidate tree. */
  readonly workspaceId: string;
}

export type IntegrationCandidateBuildResult =
  | {
      readonly status: "ready";
      readonly candidate: FrozenIntegrationCandidate;
    }
  | {
      readonly status: "conflict";
      readonly integrationCandidateId: string;
      readonly baselineCommitSha: string;
      readonly orderedCommitShas: readonly string[];
      readonly gateDefinitionVersion: string;
      readonly environment: string;
      readonly conflictFiles: readonly string[];
      readonly mergeTreeSha: null;
      readonly constructionJobId: string;
    }
  | {
      readonly status: "invalidated";
      readonly integrationCandidateId: string;
      readonly reason: "target-baseline-changed";
      readonly expectedTargetBaselineCommitSha: string;
      readonly observedTargetBaselineCommitSha: string;
    };

export type IntegrationCandidateValidation =
  | { readonly status: "valid" }
  | {
      readonly status: "invalidated";
      readonly reason:
        | "target-baseline-changed"
        | "ordered-commits-changed"
        | "gate-definition-changed"
        | "environment-changed";
      readonly observedTargetBaselineCommitSha: string;
    };

async function resolveCommit(repositoryPath: string, reference: string): Promise<string> {
  const result = await runGitCommand({
    cwd: repositoryPath,
    args: ["rev-parse", "--verify", `${reference}^{commit}`],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `cannot resolve integration commit ${reference}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

async function observedTargetBaseline(repositoryPath: string): Promise<string> {
  return resolveCommit(repositoryPath, INTEGRATION_TARGET_REF);
}

function sameOrderedCommits(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function createIntegrationCandidateBuilder(options: {
  readonly repositoryPath: string;
  readonly workspaceManager: WorkspaceManager;
  readonly jobs: ExecutionJobRunner;
}): {
  build(input: {
    readonly integrationCandidateId: string;
    readonly expectedTargetBaselineCommitSha: string;
    readonly orderedCommitShas: readonly string[];
    readonly gateDefinitionVersion: string;
    readonly environment: string;
    readonly handoffs: readonly HandoffIdempotencyKey[];
    readonly reviewDecisionIds: readonly string[];
    readonly version: number;
    readonly inputVersion: number;
  }): Promise<IntegrationCandidateBuildResult>;
} {
  return {
    async build(input) {
      const expectedBaseline = await resolveCommit(
        options.repositoryPath,
        input.expectedTargetBaselineCommitSha,
      );
      let targetBaseline = await observedTargetBaseline(options.repositoryPath);
      if (targetBaseline !== expectedBaseline) {
        return {
          status: "invalidated",
          integrationCandidateId: input.integrationCandidateId,
          reason: "target-baseline-changed",
          expectedTargetBaselineCommitSha: expectedBaseline,
          observedTargetBaselineCommitSha: targetBaseline,
        };
      }
      const orderedCommitShas: string[] = [];
      for (const commitSha of input.orderedCommitShas) {
        orderedCommitShas.push(await resolveCommit(options.repositoryPath, commitSha));
      }

      const recordedWorkspace = await options.workspaceManager.readWorkspace(
        input.integrationCandidateId,
      );
      const workspace =
        recordedWorkspace ??
        await options.workspaceManager.createCandidateWorkspace({
          candidateId: input.integrationCandidateId,
          baselineRef: expectedBaseline,
        });
      if (
        workspace.candidateId !== input.integrationCandidateId ||
        workspace.baselineCommitSha !== expectedBaseline ||
        workspace.status !== "ready"
      ) {
        throw new Error("candidate workspace does not match the requested candidate");
      }
      await options.workspaceManager.verifyWorkspaceCwd(workspace.workspaceId);
      const constructionJobId = `${input.integrationCandidateId}-build`;
      let job;
      try {
        job = await options.jobs.read(constructionJobId);
        if (job === null) {
          job = await options.jobs.run({
            jobId: constructionJobId,
            recipe: "build-candidate",
            inputVersion: input.inputVersion,
            workingDirectory: workspace.path,
            orderedCommitShas,
          });
        } else if (
          job.recipe !== "build-candidate" ||
          job.inputVersion !== input.inputVersion
        ) {
          throw new Error("candidate construction job does not match the requested candidate");
        }
      } catch (error) {
        await options.workspaceManager.reclaimWorkspace(input.integrationCandidateId);
        throw error;
      }

      if (job.output?.kind === "candidate-conflict") {
        await options.workspaceManager.reclaimWorkspace(input.integrationCandidateId);
        return {
          status: "conflict",
          integrationCandidateId: input.integrationCandidateId,
          baselineCommitSha: expectedBaseline,
          orderedCommitShas,
          gateDefinitionVersion: input.gateDefinitionVersion,
          environment: input.environment,
          conflictFiles: job.output.conflictFiles,
          mergeTreeSha: null,
          constructionJobId,
        };
      }
      if (job.status !== "succeeded" || job.output?.kind !== "candidate-built") {
        await options.workspaceManager.reclaimWorkspace(input.integrationCandidateId);
        throw new Error(`candidate construction failed: ${job.lastError ?? job.status}`);
      }

      // The target may move while merges run, so check again before returning a gateable identity.
      targetBaseline = await observedTargetBaseline(options.repositoryPath);
      if (targetBaseline !== expectedBaseline) {
        await options.workspaceManager.reclaimWorkspace(input.integrationCandidateId);
        return {
          status: "invalidated",
          integrationCandidateId: input.integrationCandidateId,
          reason: "target-baseline-changed",
          expectedTargetBaselineCommitSha: expectedBaseline,
          observedTargetBaselineCommitSha: targetBaseline,
        };
      }

      return {
        status: "ready",
        candidate: {
          integrationCandidateId: input.integrationCandidateId,
          baselineCommitSha: expectedBaseline,
          orderedCommitShas,
          mergeTreeSha: job.output.mergeTreeSha,
          gateDefinitionVersion: input.gateDefinitionVersion,
          environment: input.environment,
          constructionJobId,
          mergeCommitSha: job.output.commitSha,
          workspaceId: input.integrationCandidateId,
          handoffs: structuredClone(input.handoffs),
          reviewDecisionIds: [...input.reviewDecisionIds],
          version: input.version,
        },
      };
    },
  };
}

export async function revalidateIntegrationCandidate(input: {
  readonly repositoryPath: string;
  readonly candidate: FrozenIntegrationCandidate;
  readonly orderedCommitShas: readonly string[];
  readonly gateDefinitionVersion: string;
  readonly environment?: string;
}): Promise<IntegrationCandidateValidation> {
  const observedBaseline = await observedTargetBaseline(input.repositoryPath);
  if (observedBaseline !== input.candidate.baselineCommitSha) {
    return {
      status: "invalidated",
      reason: "target-baseline-changed",
      observedTargetBaselineCommitSha: observedBaseline,
    };
  }
  const orderedCommitShas: string[] = [];
  for (const commitSha of input.orderedCommitShas) {
    orderedCommitShas.push(await resolveCommit(input.repositoryPath, commitSha));
  }
  if (!sameOrderedCommits(orderedCommitShas, input.candidate.orderedCommitShas)) {
    return {
      status: "invalidated",
      reason: "ordered-commits-changed",
      observedTargetBaselineCommitSha: observedBaseline,
    };
  }
  if (input.gateDefinitionVersion !== input.candidate.gateDefinitionVersion) {
    return {
      status: "invalidated",
      reason: "gate-definition-changed",
      observedTargetBaselineCommitSha: observedBaseline,
    };
  }
  if (input.environment !== undefined && input.environment !== input.candidate.environment) {
    return {
      status: "invalidated",
      reason: "environment-changed",
      observedTargetBaselineCommitSha: observedBaseline,
    };
  }
  return { status: "valid" };
}
