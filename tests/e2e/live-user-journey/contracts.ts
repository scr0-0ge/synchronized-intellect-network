export const expectedJourneyEventKinds = Object.freeze([
  "session-started",
  "turn-started",
  "item-started",
  "item-completed",
  "agent-message",
  "turn-completed",
] as const);

export type UserJourneyRuntime = "codex" | "claude";
export type UserJourneyName =
  | "codex-start-english"
  | "codex-continue-chinese"
  | "claude-start-english"
  | "claude-continue-chinese";

export interface UserJourneyObservation {
  readonly schema: "live-user-journey-observation-v1";
  readonly name: UserJourneyName;
  readonly source: "test-double" | "production-renderer-live";
  readonly runtime: UserJourneyRuntime;
  readonly runtimeObserved: UserJourneyRuntime | "missing";
  readonly language: "english" | "chinese";
  readonly prompt: string;
  readonly commandKind: "start" | "continue";
  readonly durableCommandKind: "start" | "continue" | "missing";
  readonly accepted: boolean;
  readonly eventCount: number;
  readonly eventKinds: readonly string[];
  readonly terminalState: string;
  readonly replySummary: string;
  readonly replyMatchesExpected: boolean;
  readonly agentSessionCount: number;
  readonly sameTargetSession: boolean;
  readonly sameAgentSessionRow: boolean;
  readonly modelLabel: string;
  readonly effortLabel: string;
}

export interface UserJourneyEvidenceSeal {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type LiveUserJourneyFailureKind =
  | "primary-journey"
  | "graceful-close"
  | "fallback-death-proof"
  | "ledger-read"
  | "evidence-export"
  | "root-cleanup";

export interface LiveUserJourneyFailureOutcome {
  readonly schema: "live-user-journey-failure-outcome-v1";
  readonly runtime: UserJourneyRuntime;
  readonly failureKinds: readonly LiveUserJourneyFailureKind[];
  readonly rootDisposition: "retained" | "missing" | "unproved";
  readonly retainedRoot: string | null;
  readonly evidencePath: string | null;
  readonly evidenceSeal: UserJourneyEvidenceSeal | null;
  readonly child: Readonly<{
    capturedPid: number | null;
    state: "not-captured" | "running" | "exited" | "unreadable";
    deathProved: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }>;
}

export class LiveUserJourneyRunFailure extends AggregateError {
  readonly code = "live-user-journey-run-failed";
  readonly failureKinds: readonly LiveUserJourneyFailureKind[];
  readonly outcome: LiveUserJourneyFailureOutcome;

  constructor(
    failureKinds: readonly LiveUserJourneyFailureKind[],
    outcome: LiveUserJourneyFailureOutcome,
  ) {
    const immutableKinds = Object.freeze([...failureKinds]);
    super(
      immutableKinds.map(
        (kind) => new Error(`live-user-journey-${kind}-failed`),
      ),
      "live-user-journey-run-failed",
    );
    this.name = "LiveUserJourneyRunFailure";
    this.failureKinds = immutableKinds;
    this.outcome = outcome;
  }
}

export interface LiveUserJourneyChildProcessBoundary {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(
    event: "exit",
    listener: (
      exitCode: number | null,
      signalCode: NodeJS.Signals | null,
    ) => void,
  ): unknown;
  off(
    event: "exit",
    listener: (
      exitCode: number | null,
      signalCode: NodeJS.Signals | null,
    ) => void,
  ): unknown;
}

export interface LiveUserJourneyTurnCapture {
  readonly name: UserJourneyName;
  readonly runtimeObserved: UserJourneyRuntime | "missing";
  readonly accepted: boolean;
  readonly eventKinds: readonly string[];
  readonly terminalState: string;
  readonly replyText: string;
  readonly agentSessionCount: number;
  readonly sessionRowLabel: string;
  readonly modelLabel: string;
  readonly effortLabel: string;
}

export interface LiveUserJourneyApplicationBoundary {
  process(): LiveUserJourneyChildProcessBoundary;
  close(): Promise<void>;
  drive(): Promise<readonly LiveUserJourneyTurnCapture[]>;
  preflight?(): Promise<Readonly<{ modelLabel: string; effortLabel: string }>>;
}

export interface LiveUserJourneySystemBoundary {
  launch(input: Readonly<{
    runtime: UserJourneyRuntime;
    projectDirectory: string;
    userDataDirectory: string;
  }>): Promise<LiveUserJourneyApplicationBoundary>;
  deleteGuardedTemporaryRoot?(root: string): Promise<void>;
}

export interface UserJourneyRunOptions {
  readonly evidencePath?: string;
  readonly onTemporaryRootCreated?: (root: string) => void;
  readonly onEvidenceSealed?: (seal: UserJourneyEvidenceSeal) => void;
  readonly liveSystemBoundary?: LiveUserJourneySystemBoundary;
}

export interface UserJourneyPreflightRunOptions {
  readonly onTemporaryRootCreated?: (root: string) => void;
  readonly liveSystemBoundary?: LiveUserJourneySystemBoundary;
}

export interface PerReplyAttributionRuntimeProof {
  readonly runtime: UserJourneyRuntime;
  readonly liveTurns: 4;
  readonly relaunchedAfterTurns: 3;
  readonly resumedAfterRelaunch: true;
  readonly repliesMatched: true;
  readonly oneAgentSessionRow: true;
  readonly oneDurableTarget: true;
  readonly durableCommands: 4;
  readonly profileA: Readonly<{ model: string; workIntensity: string }>;
  readonly profileB: Readonly<{ model: string; workIntensity: string }>;
  readonly beforeRelaunch: Readonly<{
    models: readonly string[];
    workIntensities: readonly string[];
  }>;
  readonly afterRelaunch: Readonly<{
    models: readonly string[];
    workIntensities: readonly string[];
  }>;
  readonly afterResume: Readonly<{
    models: readonly string[];
    workIntensities: readonly string[];
  }>;
}

export interface PerReplyAttributionLiveEvidence {
  readonly schema: "per-reply-profile-attribution-live-proof-v1";
  readonly source: "production-renderer-live";
  readonly subscriptionAuthentication: "provider-owned-oauth";
  readonly runtimes: readonly PerReplyAttributionRuntimeProof[];
  readonly exactChildDeathsProved: true;
  readonly isolatedRootsRemoved: true;
}

export interface TestDoubleUserJourneyRunOptions extends UserJourneyRunOptions {
  readonly runtimes?: readonly UserJourneyRuntime[];
}

export interface SanitizedUserJourneyObservation {
  readonly schema: "live-user-journey-sanitized-observation-v1";
  readonly name: UserJourneyName;
  readonly source: "test-double" | "production-renderer-live";
  readonly runtime: UserJourneyRuntime;
  readonly runtimeObserved: UserJourneyRuntime;
  readonly language: "english" | "chinese";
  readonly commandKind: "start" | "continue";
  readonly durableCommandKind: "start" | "continue";
  readonly accepted: true;
  readonly eventCount: number;
  readonly eventKinds: readonly string[];
  readonly terminalState: "completed";
  readonly replySummary: string;
  readonly replyMatchesExpected: true;
  readonly agentSessionCount: number;
  readonly sameTargetSession: true;
  readonly sameAgentSessionRow: true;
}

export interface UserJourneyDurableEvidenceRow {
  readonly schema: "live-user-journey-durable-row-v1";
  readonly name: UserJourneyName;
  readonly runtime: UserJourneyRuntime;
  readonly sequence: 1 | 2;
  readonly commandKind: "start" | "continue";
  readonly status: "completed";
  readonly acceptedCursor: number;
  readonly targetSession: "codex-session-1" | "claude-session-1";
}

export interface UserJourneyEvidenceArtifact {
  readonly schema: "live-user-journey-evidence-v1";
  readonly source: "test-double" | "production-renderer-live";
  readonly observations: readonly SanitizedUserJourneyObservation[];
  readonly durableRows: readonly UserJourneyDurableEvidenceRow[];
}

export interface JourneyScenario {
  readonly name: UserJourneyName;
  readonly runtime: UserJourneyRuntime;
  readonly language: "english" | "chinese";
  readonly commandKind: "start" | "continue";
  readonly prompt: string;
  readonly expectedReply: string;
}

export interface CapturedJourneyTurn {
  readonly scenario: JourneyScenario;
  readonly runtimeObserved: UserJourneyRuntime | "missing";
  readonly accepted: boolean;
  readonly eventKinds: readonly string[];
  readonly terminalState: string;
  readonly replyText: string;
  readonly agentSessionCount: number;
  readonly sessionRowLabel: string;
  readonly modelLabel: string;
  readonly effortLabel: string;
}

export interface DurableCommandObservation {
  readonly commandKind: "start" | "continue" | "missing";
  readonly status: string;
  readonly acceptedCursor: number;
  readonly targetSessionId: string | null;
}

export interface CapturedLiveChild {
  readonly process: LiveUserJourneyChildProcessBoundary;
  readonly pid: number | undefined;
}

export const journeyScenarios: readonly JourneyScenario[] = Object.freeze([
  Object.freeze({
    name: "codex-start-english" as const,
    runtime: "codex" as const,
    language: "english" as const,
    commandKind: "start" as const,
    prompt: "Reply exactly: UAW_CODEX_START_OK",
    expectedReply: "UAW_CODEX_START_OK",
  }),
  Object.freeze({
    name: "codex-continue-chinese" as const,
    runtime: "codex" as const,
    language: "chinese" as const,
    commandKind: "continue" as const,
    prompt: "只回复：UAW_CODEX_CONTINUE_OK",
    expectedReply: "UAW_CODEX_CONTINUE_OK",
  }),
  Object.freeze({
    name: "claude-start-english" as const,
    runtime: "claude" as const,
    language: "english" as const,
    commandKind: "start" as const,
    prompt: "Reply exactly: UAW_CLAUDE_EN_OK",
    expectedReply: "UAW_CLAUDE_EN_OK",
  }),
  Object.freeze({
    name: "claude-continue-chinese" as const,
    runtime: "claude" as const,
    language: "chinese" as const,
    commandKind: "continue" as const,
    prompt: "只回复：UAW_CLAUDE_ZH_OK",
    expectedReply: "UAW_CLAUDE_ZH_OK",
  }),
]);
