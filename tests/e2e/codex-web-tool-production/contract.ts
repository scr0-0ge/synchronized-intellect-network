import type { OfficialRuntimeTransportFactory } from "../../../src/agent-runtime/codex/transport.ts";

export const FIXED_CODEX_WEB_TOOL_INSTRUCTION =
  "Use web search to find the newest post currently listed at https://openai.com/news/. " +
  "Reply with exactly two lines: TITLE: <title> and URL: <url>. " +
  "Do not inspect, create, modify, move, or delete local files.";

export const defaultTimeoutMilliseconds = 180_000;

export type CodexWebToolProductionFailureCategory =
  | "evidence-exists"
  | "temporary-root"
  | "initial-view"
  | "profile-unavailable"
  | "durable-acceptance"
  | "terminal-outcome"
  | "approval-request"
  | "web-search-not-observed"
  | "turn-completion-not-observed"
  | "agent-message-invalid"
  | "project-mutation"
  | "transport-diagnostics"
  | "runtime-shutdown"
  | "backend-close"
  | "staging-residue"
  | "root-cleanup"
  | "evidence-write"
  | "unexpected";

export type ProtocolCounts = {
  itemStarted: number;
  itemCompleted: number;
  turnCompleted: number;
  approvalRequests: number;
  webSearchStarted: number;
  webSearchCompleted: number;
};

export type DiagnosticCounts = {
  directLaunchSucceeded: number;
  directLaunchFailed: number;
  stagingStarted: number;
  stagingSucceeded: number;
  stagingFailed: number;
  stagedLaunchSucceeded: number;
  stagedLaunchFailed: number;
  shutdownForced: number;
  cleanupSucceeded: number;
  cleanupFailed: number;
};

export type CodexWebToolProductionEvidence = Readonly<{
  schema: "codex-web-tool-production-v1";
  source: "production-codex-subscription";
  result: "passed";
  observations: Readonly<{
    durableAccepted: true;
    terminalCompleted: true;
    protocol: Readonly<ProtocolCounts>;
    finalAgentMessages: 1;
    title: string;
    url: string;
    projectManifestUnchanged: true;
  }>;
  lifecycle: Readonly<{
    transportsCreated: number;
    transportsStopped: number;
    transportsActive: 0;
    transportStopFailures: 0;
    backendClosed: true;
    observationDisposed: true;
    stagingNewResidue: 0;
    guardedRootRemoved: true;
  }>;
  transportDiagnostics: Readonly<DiagnosticCounts>;
}>;

export type CodexWebToolProductionRetainedDiagnostic = Readonly<{
  schema: "codex-web-tool-production-retained-v1";
  source: "production-codex-subscription";
  result: "final-pass-not-reopened";
  observations: CodexWebToolProductionEvidence["observations"];
  lifecycle: Readonly<{
    transportsCreated: number;
    transportsStopped: number;
    transportsActive: 0;
    transportStopFailures: 0;
    backendClosed: true;
    observationDisposed: true;
    stagingNewResidue: 0;
    guardedRootRemovalReady: true;
  }>;
  transportDiagnostics: Readonly<DiagnosticCounts>;
}>;

export type DiagnosticArtifactSeal =
  | Readonly<{ retained: false }>
  | Readonly<{ retained: true; bytes: number; sha256: string }>;

export type CodexWebToolProductionResult =
  | Readonly<{
      ok: true;
      evidence: CodexWebToolProductionEvidence;
      seal: Readonly<{ bytes: number; sha256: string }>;
    }>
  | Readonly<{
      ok: false;
      category: CodexWebToolProductionFailureCategory;
      rootRetained: boolean;
      diagnosticArtifact: DiagnosticArtifactSeal;
    }>;

export interface CodexWebToolProductionOptions {
  readonly createTransport?: OfficialRuntimeTransportFactory;
  readonly diagnosticFilePath?: string;
  readonly evidencePath?: string;
  readonly stagingParentDirectory?: string;
  readonly temporaryParentDirectory?: string;
  readonly timeoutMilliseconds?: number;
  readonly onTemporaryRootCreated?: (root: string) => void;
  readonly publishFinalEvidence?: (
    pendingPath: string,
    finalPath: string,
  ) => Promise<void>;
}

export class DriverFailure extends Error {
  readonly category: CodexWebToolProductionFailureCategory;

  constructor(category: CodexWebToolProductionFailureCategory) {
    super("Codex web-tool production validation failed.");
    this.name = "DriverFailure";
    this.category = category;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export function failureCategory(
  error: unknown,
): CodexWebToolProductionFailureCategory {
  return error instanceof DriverFailure ? error.category : "unexpected";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
