import { randomUUID } from "node:crypto";
import type { ProjectSnapshotChanges } from "../coordinator/types.ts";
import { basename, resolve } from "node:path";
import { types as nodeUtilTypes } from "node:util";

import type {
  NormalizedRuntimeEvent,
  RuntimeProgressActivity,
  RuntimeToolActivity,
  SessionProfile,
} from "../agent-runtime/index.ts";
import type {
  ProjectChannel,
  ProjectCommandSummary,
  ProjectCommandFailureCategory,
  ProjectCommandStatus,
  ProjectInterruptCapability,
  ProjectSteerCapability,
  ProjectRuntimeResumeIdentityMapping,
  ProjectSnapshot,
  ProjectUpdate,
  EffectiveSessionProfileProjection,
  RequestedSessionProfileProjection,
} from "../coordinator/index.ts";
import { normalizeSessionDisplayName } from "../session-metadata.ts";
import type { ProjectCommandRecovery } from "../coordinator/types.ts";
import { redactFilesystemPaths } from "./path-redaction.ts";
import { sanitizeWorkbenchContinuationStop, sanitizeWorkbenchContinuationProgress } from "./result-sanitizer.ts";
import type { WorkbenchContinuationStop, WorkbenchContinuationProgress } from "./contract.ts";
import {
  cloneEffectiveSessionProfileProjection,
  cloneRequestedSessionProfileProjection,
  unknownEffectiveSessionProfileProjection,
} from "../coordinator/profile-projection.ts";
import {
  isWorkbenchRuntimeFailureCategory,
  isValidWorkbenchDirectInput,
  publicProjectFailure,
  type WorkbenchCommandView,
  type WorkbenchInterruptControl,
  type WorkbenchSteerControl,
  type WorkbenchProjectListener,
  type WorkbenchProjectResult,
  type WorkbenchProjectView,
  type WorkbenchSessionContextUsage,
  type WorkbenchSessionProfileProjection,
  type WorkbenchTimelineEvent,
  type WorkbenchTurnView,
  type WorkbenchToolActivity,
} from "./contract.ts";

const statuses: readonly ProjectCommandStatus[] = [
  "accepted",
  "in-flight",
  "completed",
  "quota-paused",
  "failed",
  "recovery-required",
];
const failureCategories: readonly ProjectCommandFailureCategory[] = [
  "interrupted",
  "profile-resolution-failed",
  "runtime-failed",
  "quota-expired",
];
const runtimeProgressActivities: readonly RuntimeProgressActivity[] = [
  "thinking",
  "tool",
  "retrying",
  "rate-limited",
  "status",
];

type ProjectTimelineEvent =
  | NormalizedRuntimeEvent
  | { readonly kind: "user-message"; readonly text: string };

type ObservationState = {
  disposed: boolean;
  emittedCursor?: number;
  snapshot?: ProjectSnapshot;
  view?: WorkbenchProjectView;
  listener?: WorkbenchProjectListener;
  iterator?: AsyncIterator<ProjectUpdate>;
  completion: Promise<void>;
  cancellation: Promise<void>;
  completionDone: boolean;
  cancellationDone: boolean;
  awaitClose: boolean;
  dispose: () => void;
};

export interface WorkbenchLiveView {
  observe(listener: WorkbenchProjectListener): () => void;
  /** Trusted product state, projected only on the last command of an open Session. */
  reportContinuationStop(commandId: string, stop: WorkbenchContinuationStop): void;
  /** Trusted product state, projected only while the reported command is running. */
  reportContinuationProgress(commandId: string, progress: WorkbenchContinuationProgress): void;
  /** Reprojects a same-cursor snapshot after a trusted Session mutation. */
  refreshAfterSessionMutation(): Promise<void>;
  resolveSessionRemoval(removalKey: string):
    | {
        readonly sessionId: string;
      }
    | undefined;
  resolveSessionMetadata(metadataKey: string):
    | {
        readonly sessionId: string;
      }
    | undefined;
  resolveInterrupt(interruptKey: string):
    | {
        readonly commandId: string;
    }
    | undefined;
  resolveSteer(steerKey: string):
    | {
        readonly commandId: string;
      }
    | undefined;
  resolveContinuationSelection(selectionKey: string):
    | {
        readonly targetSessionId: string;
        readonly profile: SessionProfile;
      }
    | undefined;
  /** Reads backend-only native mappings behind the same snapshot-scoped capability. */
  resolveContinuationRuntimeResumeIdentities(
    selectionKey: string,
  ): Promise<readonly ProjectRuntimeResumeIdentityMapping[] | undefined>;
  resolveContinuationProfile(
    selectionKey: string,
    requestedProfile: SessionProfile,
  ): Promise<
    | {
        readonly targetSessionId: string;
        readonly profile: SessionProfile;
      }
    | undefined
  >;
  resolveReplacementProfileSource(request: {
    readonly sourceSelectionKey: string;
    readonly sourceSnapshotCursor: number;
  }): Promise<SessionProfile | undefined>;
  close(): Promise<void>;
}

export function createWorkbenchLiveView(options: {
  readonly channel: ProjectChannel;
  readonly projectDirectory: string;
}): WorkbenchLiveView {
  const projectDirectory = resolve(options.projectDirectory);
  const projectLabel = deriveProjectLabel(projectDirectory);
  const sessionOrdinals = new Map<string, number>();
  const observations = new Set<ObservationState>();
  const continuationStops = new Map<string, WorkbenchContinuationStop>();
  const continuationProgresses = new Map<string, WorkbenchContinuationProgress>();
  let nextSessionOrdinal = 1;
  let selectionCursor: number | undefined;
  let selectionSignature: string | undefined;
  let selectionKeysBySession = new Map<string, string>();
  let continuationSelections = new Map<
    string,
    { readonly targetSessionId: string; readonly profile: SessionProfile }
  >();
  let removalCursor: number | undefined;
  let removalSignature: string | undefined;
  let removalKeysBySession = new Map<string, string>();
  let sessionRemovals = new Map<
    string,
    { readonly sessionId: string }
  >();
  let metadataCursor: number | undefined;
  let metadataSignature: string | undefined;
  let metadataKeysBySession = new Map<string, string>();
  let sessionMetadataTargets = new Map<
    string,
    { readonly sessionId: string }
  >();
  let replacementSourceCursor: number | undefined;
  let replacementSourceSignature: string | undefined;
  let replacementProfilesByCommandKey = new Map<string, SessionProfile>();
  let interruptCursor: number | undefined;
  let interruptSignature: string | undefined;
  let interruptKeysByCommandId = new Map<string, string>();
  let interruptTargets = new Map<string, { readonly commandId: string }>();
  let steerCursor: number | undefined;
  let steerSignature: string | undefined;
  let steerKeysByCommandId = new Map<string, string>();
  let steerTargets = new Map<string, { readonly commandId: string }>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const releaseSettledObservation = (state: ObservationState): void => {
    if (state.completionDone && state.cancellationDone) {
      observations.delete(state);
    }
  };

  const resetSnapshotCapabilities = (): void => {
      selectionCursor = undefined;
      selectionSignature = undefined;
      selectionKeysBySession = new Map();
      continuationSelections = new Map();
      removalCursor = undefined;
      removalSignature = undefined;
      removalKeysBySession = new Map();
      sessionRemovals = new Map();
      metadataCursor = undefined;
      metadataSignature = undefined;
      metadataKeysBySession = new Map();
      sessionMetadataTargets = new Map();
      replacementSourceCursor = undefined;
      replacementSourceSignature = undefined;
      replacementProfilesByCommandKey = new Map();
      interruptCursor = undefined;
      interruptSignature = undefined;
      interruptKeysByCommandId = new Map();
      interruptTargets = new Map();
      steerCursor = undefined;
      steerSignature = undefined;
      steerKeysByCommandId = new Map();
      steerTargets = new Map();
  };

  const commandTimelineCache = new WeakMap<readonly ProjectTimelineEvent[], Map<string, { input: unknown; requested: unknown; effective: unknown; timeline: ProjectTimelineEvent[] }>>();
  const turnCache = new WeakMap<readonly ProjectTimelineEvent[], WorkbenchTurnView>();
  const contextCache = new WeakMap<readonly ProjectTimelineEvent[], { completed: boolean; value: WorkbenchSessionContextUsage | undefined }>();

  const applyChanges = (previous: ProjectSnapshot, changes: ProjectSnapshotChanges): ProjectSnapshot => {
    if (changes.projectId !== previous.projectId || changes.after !== previous.cursor ||
      !Number.isSafeInteger(changes.cursor) || changes.cursor <= previous.cursor ||
      !Array.isArray(changes.commands) || !Array.isArray(changes.sessions)) throw new Error("invalid-project-changes");
    const commands = new Map(previous.commands.map(command => [command.commandId, command]));
    const changedIds = new Set<string>();
    for (const command of changes.commands) {
      if (changedIds.has(command.commandId)) throw new Error("duplicate-project-change");
      changedIds.add(command.commandId);
      const before = commands.get(command.commandId);
      if (before?.session !== undefined && command.session?.sessionId !== before.session.sessionId) throw new Error("changed-session-link");
      commands.set(command.commandId, command.session === undefined ? command : {
        ...command, session: { ...command.session,
          events: [...(before?.session?.events ?? []), ...command.session.events],
        },
      });
    }
    const sessions = new Map(changes.sessions.map(session => [session.sessionId, session]));
    if (sessions.size !== changes.sessions.length) throw new Error("duplicate-session-change");
    return deepFreeze({ projectId: previous.projectId, cursor: changes.cursor,
      commands: [...commands.values()].map(command => {
        if (command.session === undefined) return command;
        const shared = sessions.get(command.session.sessionId);
        if (shared === undefined) throw new Error("missing-session-change");
        const { lastModelReplyCursor: _previousReply, ...session } = command.session;
        if (session.displayName === shared.displayName && session.archived === shared.archived &&
          session.resumable === shared.resumable && command.session.lastModelReplyCursor === shared.lastModelReplyCursor) return command;
        return { ...command, session: { ...session, ...shared } };
      }),
    });
  };

  const projectSnapshot = (snapshot: ProjectSnapshot): WorkbenchProjectView => {
    if (!Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0) {
      throw new Error("invalid-snapshot");
    }
    const snapshotCommandIds = new Set<string>();
    const grouped = new Map<
      string,
      {
        readonly identity: string;
        latestCommandId: string;
        readonly sessionId?: string;
        profile?: SessionProfile;
        displayName?: string;
        archived: boolean;
        requestedProfileProjection?: RequestedSessionProfileProjection;
        effectiveProfileProjection?: EffectiveSessionProfileProjection;
        runtimeLabel: string;
        readonly turns: Array<{
          readonly recovery?: ProjectCommandRecovery;
          readonly timeline: ProjectTimelineEvent[];
          readonly requestedProfileProjection?: RequestedSessionProfileProjection;
          readonly effectiveProfileProjection?: EffectiveSessionProfileProjection;
        }>;
        resumable: boolean;
        status: ProjectCommandStatus;
        failureCategory?: ProjectCommandFailureCategory;
        /** Cursor of the last recorded model reply for this Session. */
        lastModelReplyCursor: number;
        /** Latest accepted command cursor grouped into this Session. */
        lastAcceptedCommandCursor: number;
      }
    >();
    for (const command of snapshot.commands) {
      const commandId = requireString(command.commandId);
      if (commandId.length === 0 || snapshotCommandIds.has(commandId)) {
        throw new Error("invalid-command-identity");
      }
      snapshotCommandIds.add(commandId);
      if (command.runtime !== "codex" || !isStatus(command.status)) {
        throw new Error("invalid-command");
      }
      if (
        command.failureCategory !== undefined &&
        !isFailureCategory(command.failureCategory)
      ) {
        throw new Error("invalid-failure");
      }
      if (command.continuationStop !== undefined) {
        continuationStops.set(commandId, sanitizeWorkbenchContinuationStop(command.continuationStop));
      }
      const commandTimeline = projectCommandTimeline(command);
      const sessionId = command.session?.sessionId;
      if (sessionId !== undefined && requireString(sessionId).length === 0) {
        throw new Error("invalid-session-identity");
      }
      const identity =
        sessionId === undefined ? `command:${commandId}` : `session:${sessionId}`;
      const existing = grouped.get(identity);
      const lastModelReplyCursor = command.session?.lastModelReplyCursor;
      const acceptedCommandCursor = command.session?.acceptedCommandCursor;
      if (
        lastModelReplyCursor !== undefined &&
        (!Number.isSafeInteger(lastModelReplyCursor) || lastModelReplyCursor < 0)
      ) {
        throw new Error("invalid-session");
      }
      if (
        acceptedCommandCursor !== undefined &&
        (!Number.isSafeInteger(acceptedCommandCursor) ||
          acceptedCommandCursor < 0)
      ) {
        throw new Error("invalid-session");
      }
      if (existing === undefined) {
        if (command.session === undefined) {
          grouped.set(identity, {
            identity,
            latestCommandId: commandId,
            runtimeLabel: "Codex",
            turns: [],
            archived: false,
            resumable: false,
            status: command.status,
            lastModelReplyCursor: 0,
            lastAcceptedCommandCursor: 0,
            ...(command.failureCategory === undefined
              ? {}
              : { failureCategory: command.failureCategory }),
          });
          continue;
        }
        if (
          typeof command.session.resumable !== "boolean" ||
          typeof command.session.displayName !== "string" ||
          normalizeSessionDisplayName(command.session.displayName) !==
            command.session.displayName ||
          typeof command.session.archived !== "boolean"
        ) {
          throw new Error("invalid-session");
        }
        const requestedProfileProjection = projectRequestedProfileProjection(
          command.session.requestedProfileProjection,
        );
        grouped.set(identity, {
          identity,
          latestCommandId: commandId,
          sessionId,
          displayName: command.session.displayName,
          archived: command.session.archived,
          profile: cloneInternalProfile(command.session.profile),
          ...(requestedProfileProjection === undefined
            ? {}
            : { requestedProfileProjection }),
          effectiveProfileProjection: projectEffectiveProfileProjection(
            requestedProfileProjection,
            command.session.effectiveProfileProjection,
          ),
          runtimeLabel:
            requestedProfileProjection?.runtimeFamilyLabel ?? "Codex",
          turns: [{
            ...(command.recovery === undefined ? {} : { recovery: command.recovery }),
            timeline: commandTimeline,
            ...(requestedProfileProjection === undefined
              ? {}
              : { requestedProfileProjection }),
            effectiveProfileProjection: projectEffectiveProfileProjection(
              requestedProfileProjection,
              command.session.effectiveProfileProjection,
            ),
          }],
          resumable: command.session.resumable,
          status: command.status,
          lastModelReplyCursor: lastModelReplyCursor ?? 0,
          lastAcceptedCommandCursor: acceptedCommandCursor ?? 0,
          ...(command.failureCategory === undefined
            ? {}
            : { failureCategory: command.failureCategory }),
        });
        continue;
      }
      if (command.session === undefined || existing.profile === undefined) {
        throw new Error("invalid-session-link");
      }
      if (
        typeof command.session.resumable !== "boolean" ||
        command.session.displayName !== existing.displayName ||
        command.session.archived !== existing.archived
      ) {
        throw new Error("invalid-session");
      }
      const profile = cloneInternalProfile(command.session.profile);
      if (!sameLockedProfileFields(existing.profile, profile)) {
        throw new Error("profile-drift");
      }
      const requestedProfileProjection = projectRequestedProfileProjection(
        command.session.requestedProfileProjection,
      );
      existing.profile = profile;
      if (requestedProfileProjection === undefined) {
        delete existing.requestedProfileProjection;
      } else {
        existing.requestedProfileProjection = requestedProfileProjection;
      }
      existing.effectiveProfileProjection = projectEffectiveProfileProjection(
        requestedProfileProjection,
        command.session.effectiveProfileProjection,
      );
      existing.runtimeLabel = requestedProfileProjection?.runtimeFamilyLabel ?? "Codex";
      existing.turns.push({
        ...(command.recovery === undefined ? {} : { recovery: command.recovery }),
        timeline: commandTimeline,
        ...(requestedProfileProjection === undefined
          ? {}
          : { requestedProfileProjection }),
        effectiveProfileProjection: existing.effectiveProfileProjection,
      });
      existing.resumable = command.session.resumable;
      existing.latestCommandId = commandId;
      existing.status = command.status;
      existing.lastModelReplyCursor = Math.max(
        existing.lastModelReplyCursor,
        lastModelReplyCursor ?? 0,
      );
      existing.lastAcceptedCommandCursor = Math.max(
        existing.lastAcceptedCommandCursor,
        acceptedCommandCursor ?? 0,
      );
      if (command.failureCategory === undefined) delete existing.failureCategory;
      else existing.failureCategory = command.failureCategory;
    }

    const groups = [...grouped.values()];
    const eligible = groups.filter(
      (entry) =>
        entry.sessionId !== undefined &&
        entry.profile !== undefined &&
        entry.resumable &&
        !entry.archived &&
        isResumableTerminal(entry),
    );
    const currentSignature = eligible
      .map((entry) => entry.sessionId!)
      .sort()
      .join("\u0000");
    if (selectionCursor !== snapshot.cursor) {
      selectionCursor = snapshot.cursor;
      selectionSignature = currentSignature;
      selectionKeysBySession = new Map();
      continuationSelections = new Map();
      for (const entry of eligible) {
        const sessionId = entry.sessionId!;
        const profile = entry.profile!;
        const selectionKey = `session-selection:${randomUUID()}`;
        selectionKeysBySession.set(sessionId, selectionKey);
        continuationSelections.set(selectionKey, {
          targetSessionId: sessionId,
          profile,
        });
      }
    } else if (selectionSignature !== currentSignature) {
      throw new Error("snapshot-drift");
    }

    const removable = groups.filter(
      (entry) => entry.sessionId !== undefined,
    );
    const currentRemovalSignature = removable
      .map((entry) => entry.sessionId!)
      .sort()
      .join("\u0000");
    if (removalCursor !== snapshot.cursor) {
      removalCursor = snapshot.cursor;
      removalSignature = currentRemovalSignature;
      removalKeysBySession = new Map();
      sessionRemovals = new Map();
      for (const entry of removable) {
        const sessionId = entry.sessionId!;
        const removalKey = `session-removal:${randomUUID()}`;
        removalKeysBySession.set(sessionId, removalKey);
        sessionRemovals.set(removalKey, { sessionId });
      }
    } else if (removalSignature !== currentRemovalSignature) {
      throw new Error("snapshot-drift");
    }

    const currentMetadataSignature = removable
      .map((entry) => [entry.sessionId!, entry.displayName, entry.archived])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
      .map((entry) => JSON.stringify(entry))
      .join("\u0000");
    if (metadataCursor !== snapshot.cursor) {
      metadataCursor = snapshot.cursor;
      metadataSignature = currentMetadataSignature;
      metadataKeysBySession = new Map();
      sessionMetadataTargets = new Map();
      for (const entry of removable) {
        const sessionId = entry.sessionId!;
        const metadataKey = `session-metadata:${randomUUID()}`;
        metadataKeysBySession.set(sessionId, metadataKey);
        sessionMetadataTargets.set(metadataKey, { sessionId });
      }
    } else if (metadataSignature !== currentMetadataSignature) {
      throw new Error("snapshot-drift");
    }

    // Ordinals are assigned in FIRST-SEEN order, so `command-N` stays stable
    // across snapshots regardless of display order. Display order is a
    // separate decision (issue #6 comment 3.1): active Sessions lead terminal
    // history. Within that tier, a Session currently waiting for its first
    // reply leads, ordered by its latest accepted command. Otherwise Sessions
    // remain ordered by their last model reply, with first-seen order breaking
    // ties. Progress, steering, metadata and terminal updates do not affect
    // either recency signal.
    const projectedEntries = groups
      .map((entry) => {
        let ordinal = sessionOrdinals.get(entry.identity);
        if (ordinal === undefined) {
          ordinal = nextSessionOrdinal;
          nextSessionOrdinal += 1;
          sessionOrdinals.set(entry.identity, ordinal);
        }
        return Object.freeze({
          commandKey: `command-${ordinal}`,
          ordinal,
          entry,
        });
      })
      .sort((left, right) => {
        const leftActive =
          left.entry.status === "accepted" ||
          left.entry.status === "in-flight";
        const rightActive =
          right.entry.status === "accepted" ||
          right.entry.status === "in-flight";
        if (leftActive !== rightActive) return leftActive ? -1 : 1;
        const leftWaitsForFirstReply =
          leftActive &&
          left.entry.lastModelReplyCursor === 0;
        const rightWaitsForFirstReply =
          rightActive &&
          right.entry.lastModelReplyCursor === 0;
        if (leftWaitsForFirstReply !== rightWaitsForFirstReply) {
          return leftWaitsForFirstReply ? -1 : 1;
        }
        if (
          leftWaitsForFirstReply &&
          left.entry.lastAcceptedCommandCursor !==
            right.entry.lastAcceptedCommandCursor
        ) {
          return (
            right.entry.lastAcceptedCommandCursor -
            left.entry.lastAcceptedCommandCursor
          );
        }
        if (
          left.entry.lastModelReplyCursor !==
          right.entry.lastModelReplyCursor
        ) {
          return (
            right.entry.lastModelReplyCursor -
            left.entry.lastModelReplyCursor
          );
        }
        return left.ordinal - right.ordinal;
      });
    const interruptCapability = readInterruptCapability(options.channel);
    const steerCapability = readSteerCapability(options.channel);
    const runningEntries = projectedEntries.filter(
      ({ entry }) => entry.status === "in-flight",
    );
    const currentInterruptSignature = JSON.stringify({
      capability: interruptCapability,
      running: runningEntries.map(({ commandKey, entry }) => [
        commandKey,
        entry.latestCommandId,
      ]),
    });
    if (interruptCursor !== snapshot.cursor) {
      interruptCursor = snapshot.cursor;
      interruptSignature = currentInterruptSignature;
      interruptKeysByCommandId = new Map();
      interruptTargets = new Map();
      if (interruptCapability.status === "available") {
        const running = runningEntries.find(
          ({ entry }) => entry.latestCommandId === interruptCapability.commandId,
        );
        if (running !== undefined) {
          const interruptKey = `turn-interrupt:${randomUUID()}`;
          interruptKeysByCommandId.set(interruptCapability.commandId, interruptKey);
          interruptTargets.set(interruptKey, {
            commandId: interruptCapability.commandId,
          });
        }
      }
    } else if (interruptSignature !== currentInterruptSignature) {
      throw new Error("snapshot-drift");
    }
    const currentSteerSignature = JSON.stringify({
      capability: steerCapability,
      running: runningEntries.map(({ commandKey, entry }) => [
        commandKey,
        entry.latestCommandId,
      ]),
    });
    if (steerCursor !== snapshot.cursor) {
      steerCursor = snapshot.cursor;
      steerSignature = currentSteerSignature;
      steerKeysByCommandId = new Map();
      steerTargets = new Map();
      if (steerCapability.status === "available") {
        const running = runningEntries.find(
          ({ entry }) => entry.latestCommandId === steerCapability.commandId,
        );
        if (running !== undefined) {
          const steerKey = `turn-steer:${randomUUID()}`;
          steerKeysByCommandId.set(steerCapability.commandId, steerKey);
          steerTargets.set(steerKey, {
            commandId: steerCapability.commandId,
          });
        }
      }
    } else if (steerSignature !== currentSteerSignature) {
      throw new Error("snapshot-drift");
    }
    const currentReplacementSourceSignature = JSON.stringify(
      projectedEntries.map(({ commandKey, entry }) => [
        commandKey,
        entry.identity,
        entry.profile === undefined
          ? null
          : [
              entry.profile.model,
              entry.profile.effortLevel,
              entry.profile.executionMode,
              entry.profile.accessMode,
            ],
      ]),
    );
    if (replacementSourceCursor !== snapshot.cursor) {
      replacementSourceCursor = snapshot.cursor;
      replacementSourceSignature = currentReplacementSourceSignature;
      replacementProfilesByCommandKey = new Map(
        projectedEntries.flatMap(({ commandKey, entry }) =>
          entry.profile === undefined
            ? []
            : [[commandKey, cloneInternalProfile(entry.profile)] as const],
        ),
      );
    } else if (
      replacementSourceSignature !== currentReplacementSourceSignature
    ) {
      throw new Error("snapshot-drift");
    }

    const commands = projectedEntries.map(({ commandKey, entry }) => {
      const turns = entry.turns.map((turn) => {
        const cached =
          turn.recovery === undefined
            ? turnCache.get(turn.timeline)
            : undefined;
        if (cached !== undefined) return cached;
        const projected = deepFreeze({
          ...(turn.recovery === undefined
            ? {}
            : { recovery: structuredClone(turn.recovery) }),
          profile: projectPublicProfile(turn.requestedProfileProjection, turn.effectiveProfileProjection),
          timeline: projectTimeline(turn.timeline),
        });
        if (turn.recovery === undefined) {
          turnCache.set(turn.timeline, projected);
        }
        return projected;
      });
      const timeline = turns.flatMap((turn) => turn.timeline);
      let context: WorkbenchSessionContextUsage | undefined;
      for (const turn of entry.turns) {
        let cached = contextCache.get(turn.timeline);
        if (cached === undefined) {
          cached = { completed: turn.timeline.some(event => event.kind === "turn-completed"), value: projectLatestContext(turn.timeline) };
          contextCache.set(turn.timeline, cached);
        }
        if (cached.completed) context = cached.value;
      }
      const continuationStop = continuationStops.get(entry.latestCommandId);
      const continuationProgress = entry.status === "in-flight"
        ? continuationProgresses.get(entry.latestCommandId)
        : undefined;
      const projected: WorkbenchCommandView = {
        key: commandKey,
        label:
          entry.displayName ??
          `Agent Session ${commandKey.slice("command-".length).padStart(2, "0")}`,
        runtime: entry.runtimeLabel,
        status: entry.status,
        ...(continuationStop === undefined ? {} : { continuationStop }),
        ...(continuationProgress === undefined ? {} : { continuationProgress }),
        ...(entry.status === "in-flight"
          ? {
              interrupt: projectInterruptControl(
                interruptCapability,
                entry.latestCommandId,
                interruptKeysByCommandId,
              ),
              steer: projectSteerControl(
                steerCapability,
                entry.latestCommandId,
                steerKeysByCommandId,
              ),
            }
          : {}),
        ...(entry.failureCategory === undefined
          ? {}
          : { failureCategory: entry.failureCategory }),
        ...(entry.profile === undefined || entry.sessionId === undefined
          ? {}
          : {
              session: {
                ...(context === undefined ? {} : { context }),
                profile: turns.at(-1)!.profile,
                timeline,
                turns,
                archived: entry.archived,
                metadataKey: metadataKeysBySession.get(entry.sessionId)!,
                removalKey: removalKeysBySession.get(entry.sessionId)!,
                resumable:
                  !entry.archived && entry.resumable && isResumableTerminal(entry),
                selectionKey:
                  !entry.archived && entry.resumable && isResumableTerminal(entry)
                    ? selectionKeysBySession.get(entry.sessionId) ?? null
                    : null,
              },
            }),
      };
      return deepFreeze(projected);
    });
    const initialSelection =
      commands.find((command) => command.session?.archived === false) ??
      commands.find((command) => command.session !== undefined) ??
      commands[0];
    return deepFreeze({
      project: { label: projectLabel },
      observation: { cursor: snapshot.cursor, live: true },
      commands,
      initialSelectionKey: initialSelection?.key ?? null,
    });
  };

  const observe = (listener: WorkbenchProjectListener): (() => void) => {
    let state!: ObservationState;
    const dispose = () => {
      if (state.disposed) return;
      state.disposed = true;
      state.listener = undefined;
      let returned: PromiseLike<IteratorResult<ProjectUpdate>> | undefined;
      try {
        returned = state.iterator?.return?.();
      } catch {
        returned = undefined;
      }
      if (returned === undefined) {
        state.awaitClose = false;
        observations.delete(state);
        return;
      }
      state.awaitClose = true;
      state.cancellationDone = false;
      state.cancellation = Promise.resolve(returned)
        .then(() => undefined, () => undefined)
        .finally(() => {
          state.cancellationDone = true;
          releaseSettledObservation(state);
        });
    };
    state = {
      disposed: closed,
      listener: closed ? undefined : listener,
      completion: Promise.resolve(),
      cancellation: Promise.resolve(),
      completionDone: false,
      cancellationDone: true,
      awaitClose: false,
      dispose,
    };
    if (closed) {
      emit(listener, publicProjectFailure());
      return dispose;
    }
    observations.add(state);
    state.completion = runObservation(state).finally(() => {
      state.disposed = true;
      state.listener = undefined;
      state.completionDone = true;
      releaseSettledObservation(state);
    });
    return dispose;
  };

  const runObservation = async (state: ObservationState): Promise<void> => {
    try {
      const snapshot = deepFreeze(await options.channel.snapshot());
      state.snapshot = snapshot;
      if (state.disposed || closed) return;
      if (!emitState(state, { ok: true, view: projectSnapshot(snapshot) })) {
        state.dispose();
        return;
      }
      state.emittedCursor = snapshot.cursor;
      if (state.disposed || closed) return;
      const iterator = options.channel
        .observe({ after: snapshot.cursor })
        [Symbol.asyncIterator]();
      state.iterator = iterator;
      state.awaitClose = true;
      let rawCursor = snapshot.cursor;
      while (!state.disposed && !closed) {
        const next = await iterator.next();
        if (state.disposed || closed) return;
        if (next.done) {
          emitState(state, publicProjectFailure());
          state.dispose();
          return;
        }
        const sequential = next.value.kind !== "snapshot" && Number.isSafeInteger(next.value.cursor) && next.value.cursor === rawCursor + 1;
        if (sequential) rawCursor = next.value.cursor;
        if (sequential && rawCursor <= (state.emittedCursor ?? -1)) continue;
        let freshSnapshot: ProjectSnapshot;
        let freshView: WorkbenchProjectView | undefined;
        const priorOrdinals = new Map(sessionOrdinals);
        const priorNextOrdinal = nextSessionOrdinal;
        if (sequential && options.channel.snapshotChanges !== undefined) {
          try {
            const changes = await options.channel.snapshotChanges(state.snapshot!.cursor);
            if (!changes.commands.some(command => command.commandId === next.value.commandId)) throw new Error("missing-command-change");
            freshSnapshot = applyChanges(state.snapshot!, changes);
            if (freshSnapshot.cursor < rawCursor) throw new Error("stale-project-changes");
            freshView = projectSnapshot(freshSnapshot);
          } catch {
            console.warn("Live Project update mismatch; reloading the full snapshot.");
            resetSnapshotCapabilities();
            sessionOrdinals.clear();
            for (const [identity, ordinal] of priorOrdinals) sessionOrdinals.set(identity, ordinal);
            nextSessionOrdinal = priorNextOrdinal;
            freshSnapshot = deepFreeze(await options.channel.snapshot());
          }
        } else {
          if (!sequential) console.warn("Live Project cursor mismatch; reloading the full snapshot.");
          freshSnapshot = deepFreeze(await options.channel.snapshot());
        }
        if (!sequential) rawCursor = next.value.cursor;
        if (state.disposed || closed) return;
        if (
          freshSnapshot.cursor < rawCursor ||
          freshSnapshot.cursor <= (state.emittedCursor ?? -1)
        ) {
          throw new Error("invalid-observation");
        }
        if (
          !emitState(state, {
            ok: true,
            view: freshView ?? projectSnapshot(freshSnapshot),
          })
        ) {
          state.dispose();
          return;
        }
        state.snapshot = freshSnapshot;
        state.emittedCursor = freshSnapshot.cursor;
      }
    } catch {
      if (!state.disposed && !closed) {
        emitState(state, publicProjectFailure());
      }
      state.dispose();
    }
  };

  return Object.freeze({
    observe,
    reportContinuationStop(commandId: string, stop: WorkbenchContinuationStop) {
      if (closed) return;
      continuationStops.set(commandId, sanitizeWorkbenchContinuationStop(stop));
      // A stop always ends the run that owned any progress annotation on this
      // exact command: yield to the stop notice, never show both at once.
      continuationProgresses.delete(commandId);
      // Only annotate the last public view: rebuilding an older raw snapshot
      // against today's Runtime controls would falsely report snapshot drift.
      // An observer still catching up picks up the stored annotation normally.
      for (const state of [...observations]) {
        if (state.disposed || state.view === undefined) continue;
        const command = state.snapshot?.commands.find(entry => entry.commandId === commandId);
        if (command === undefined) continue;
        const identity = command.session === undefined ? `command:${commandId}` : `session:${command.session.sessionId}`;
        const key = `command-${sessionOrdinals.get(identity)}`;
        const view = deepFreeze({ ...state.view, commands: state.view.commands.map((entry) => {
          if (entry.key !== key) return entry;
          const { continuationProgress: _drop, ...rest } = entry;
          return { ...rest, continuationStop: continuationStops.get(commandId)! };
        }) });
        if (!emitState(state, { ok: true, view })) state.dispose();
      }
    },
    reportContinuationProgress(commandId: string, progress: WorkbenchContinuationProgress) {
      if (closed) return;
      continuationProgresses.set(commandId, sanitizeWorkbenchContinuationProgress(progress));
      for (const state of [...observations]) {
        if (state.disposed || state.view === undefined) continue;
        const command = state.snapshot?.commands.find(entry => entry.commandId === commandId);
        if (command === undefined) continue;
        const identity = command.session === undefined ? `command:${commandId}` : `session:${command.session.sessionId}`;
        const key = `command-${sessionOrdinals.get(identity)}`;
        const view = deepFreeze({ ...state.view, commands: state.view.commands.map(entry =>
          entry.key === key && entry.status === "in-flight"
            ? { ...entry, continuationProgress: continuationProgresses.get(commandId)! }
            : entry),
        });
        if (!emitState(state, { ok: true, view })) state.dispose();
      }
    },
    async refreshAfterSessionMutation(): Promise<void> {
      if (closed) return;
      // Session metadata changes and hard deletion intentionally leave no update
      // cursor. Rotate every snapshot-scoped capability before same-cursor projection.
      resetSnapshotCapabilities();
      try {
        const snapshot = deepFreeze(await options.channel.snapshot());
        if (closed) return;
        const result = {
          ok: true as const,
          view: projectSnapshot(snapshot),
        };
        for (const state of [...observations]) {
          if (
            state.disposed ||
            snapshot.cursor < (state.emittedCursor ?? -1)
          ) {
            continue;
          }
          if (!emitState(state, result)) {
            state.dispose();
            continue;
          }
          state.snapshot = snapshot;
          state.emittedCursor = snapshot.cursor;
        }
      } catch {
        for (const state of [...observations]) {
          if (state.disposed) continue;
          emitState(state, publicProjectFailure());
          state.dispose();
        }
      }
    },
    resolveSessionRemoval(removalKey: string) {
      if (closed || typeof removalKey !== "string") return undefined;
      const removal = sessionRemovals.get(removalKey);
      return removal === undefined
        ? undefined
        : Object.freeze({ sessionId: removal.sessionId });
    },
    resolveSessionMetadata(metadataKey: string) {
      if (closed || typeof metadataKey !== "string") return undefined;
      const target = sessionMetadataTargets.get(metadataKey);
      return target === undefined
        ? undefined
        : Object.freeze({ sessionId: target.sessionId });
    },
    resolveInterrupt(interruptKey: string) {
      if (closed || typeof interruptKey !== "string") return undefined;
      const target = interruptTargets.get(interruptKey);
      return target === undefined
        ? undefined
        : Object.freeze({ commandId: target.commandId });
    },
    resolveSteer(steerKey: string) {
      if (closed || typeof steerKey !== "string") return undefined;
      const target = steerTargets.get(steerKey);
      return target === undefined
        ? undefined
        : Object.freeze({ commandId: target.commandId });
    },
    resolveContinuationSelection(selectionKey: string) {
      if (closed || typeof selectionKey !== "string") return undefined;
      const selection = continuationSelections.get(selectionKey);
      if (selection === undefined) return undefined;
      return Object.freeze({
        targetSessionId: selection.targetSessionId,
        profile: cloneInternalProfile(selection.profile),
      });
    },
    async resolveContinuationRuntimeResumeIdentities(selectionKey: string) {
      if (closed || typeof selectionKey !== "string") return undefined;
      const selection = continuationSelections.get(selectionKey);
      if (selection === undefined) return undefined;
      const read = options.channel.readSessionRuntimeResumeIdentities;
      if (typeof read !== "function") return Object.freeze([]);
      try {
        const identities = await read.call(
          options.channel,
          selection.targetSessionId,
        );
        if (
          closed ||
          continuationSelections.get(selectionKey) !== selection
        ) {
          return undefined;
        }
        return Object.freeze(
          identities.map((identity) =>
            Object.freeze({
              endpointId: identity.endpointId,
              selectionProfile: Object.freeze(
                cloneInternalProfile(identity.selectionProfile),
              ),
              nativeProfile: Object.freeze(
                cloneInternalProfile(identity.nativeProfile),
              ),
            }),
          ),
        );
      } catch {
        return undefined;
      }
    },
    async resolveContinuationProfile(
      selectionKey: string,
      requestedProfile: SessionProfile,
    ): Promise<
      | {
          readonly targetSessionId: string;
          readonly profile: SessionProfile;
        }
      | undefined
    > {
      if (closed || typeof selectionKey !== "string") return undefined;
      const selection = continuationSelections.get(selectionKey);
      if (selection === undefined) return undefined;
      let profile: SessionProfile;
      try {
        profile = cloneInternalProfile(requestedProfile);
      } catch {
        return undefined;
      }
      try {
        const result = await options.channel.validateContinuationProfile({
          sessionId: selection.targetSessionId,
          profile,
        });
        if (
          closed ||
          continuationSelections.get(selectionKey) !== selection ||
          typeof result !== "object" ||
          result === null ||
          !hasExactKeys(result as Record<string, unknown>, ["status"]) ||
          result.status !== "compatible"
        ) {
          return undefined;
        }
        return Object.freeze({
          targetSessionId: selection.targetSessionId,
          profile: cloneInternalProfile(profile),
        });
      } catch {
        return undefined;
      }
    },
    async resolveReplacementProfileSource(request: {
      readonly sourceSelectionKey: string;
      readonly sourceSnapshotCursor: number;
    }): Promise<SessionProfile | undefined> {
      if (
        closed ||
        typeof request !== "object" ||
        request === null ||
        typeof request.sourceSelectionKey !== "string" ||
        !/^command-[1-9][0-9]*$/u.test(request.sourceSelectionKey) ||
        !Number.isSafeInteger(request.sourceSnapshotCursor) ||
        request.sourceSnapshotCursor < 0
      ) {
        return undefined;
      }
      try {
        const snapshot = await options.channel.snapshot();
        if (closed || snapshot.cursor !== request.sourceSnapshotCursor) {
          return undefined;
        }
        projectSnapshot(snapshot);
        if (replacementSourceCursor !== request.sourceSnapshotCursor) {
          return undefined;
        }
        const source = replacementProfilesByCommandKey.get(
          request.sourceSelectionKey,
        );
        return source === undefined ? undefined : cloneInternalProfile(source);
      } catch {
        return undefined;
      }
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        closed = true;
        removalKeysBySession.clear();
        sessionRemovals.clear();
        metadataKeysBySession.clear();
        sessionMetadataTargets.clear();
        selectionKeysBySession.clear();
        continuationSelections.clear();
        replacementProfilesByCommandKey.clear();
        interruptKeysByCommandId.clear();
        interruptTargets.clear();
        steerKeysByCommandId.clear();
        steerTargets.clear();
        const active = [...observations];
        for (const observation of active) observation.dispose();
        await Promise.all(
          active
            .filter((observation) => observation.awaitClose)
            .flatMap((observation) => [
              observation.completion,
              observation.cancellation,
            ]),
        );
      })();
      return closePromise;
    },
  });

  function cloneInternalProfile(profile: unknown): SessionProfile {
    if (
      typeof profile !== "object" ||
      profile === null ||
      Array.isArray(profile) ||
      !hasExactKeys(profile as Record<string, unknown>, [
        "accessMode",
        "effortLevel",
        "executionMode",
        "model",
      ])
    ) {
      throw new Error("invalid-profile");
    }
    const candidate = profile as Record<string, unknown>;
    if (
      typeof candidate.model !== "string" ||
      candidate.model.trim().length === 0 ||
      typeof candidate.effortLevel !== "string" ||
      candidate.effortLevel.trim().length === 0 ||
      candidate.executionMode !== "single-agent" ||
      candidate.accessMode !== "full-access"
    ) {
      throw new Error("invalid-profile");
    }
    return Object.freeze({
      model: candidate.model,
      effortLevel: candidate.effortLevel,
      executionMode: candidate.executionMode,
      accessMode: candidate.accessMode,
    });
  }

  function projectRequestedProfileProjection(
    value: unknown,
  ): RequestedSessionProfileProjection | undefined {
    return value === undefined
      ? undefined
      : cloneRequestedSessionProfileProjection(value);
  }

  function projectEffectiveProfileProjection(
    requested: RequestedSessionProfileProjection | undefined,
    value: unknown,
  ): EffectiveSessionProfileProjection | undefined {
    if (requested === undefined) return undefined;
    return value === undefined
      ? unknownEffectiveSessionProfileProjection()
      : cloneEffectiveSessionProfileProjection(value);
  }

  function projectPublicProfile(
    requested: RequestedSessionProfileProjection | undefined,
    effective: EffectiveSessionProfileProjection | undefined,
  ): WorkbenchSessionProfileProjection {
    if (requested === undefined) {
      return deepFreeze({
        requested: { kind: "not-recorded" as const },
        effective: { kind: "not-recorded" as const },
      });
    }
    return deepFreeze({
      requested,
      effective: effective ?? unknownEffectiveSessionProfileProjection(),
    });
  }

  function projectCommandTimeline(command: ProjectCommandSummary): ProjectTimelineEvent[] {
    const input = command.input;
    const events = command.session?.events ?? [];
    const requested = command.session?.requestedProfileProjection;
    const effective = command.session?.effectiveProfileProjection;
    const cached = commandTimelineCache.get(events)?.get(command.commandId);
    if (cached !== undefined && cached.input === input && cached.requested === requested && cached.effective === effective) return cached.timeline;
    const cache = (timeline: ProjectTimelineEvent[]) => {
      let entries = commandTimelineCache.get(events);
      if (entries === undefined) commandTimelineCache.set(events, entries = new Map());
      entries.set(command.commandId, { input, requested, effective, timeline });
      return timeline;
    };
    const runtimeEvents = events.map((event) => {
      if (
        event.kind === "user-message" &&
        !isValidWorkbenchDirectInput(event.text)
      ) {
        throw new Error("invalid-user-message");
      }
      if (
        event.kind === "turn-completed" &&
        Object.prototype.hasOwnProperty.call(event, "context")
      ) {
        projectContext(event.context);
      }
      return structuredClone(event);
    });
    if (input === undefined) {
      return cache(runtimeEvents);
    }
    if (!isValidWorkbenchDirectInput(input)) {
      throw new Error("invalid-user-message");
    }
    const timeline: ProjectTimelineEvent[] = [Object.freeze({ kind: "user-message", text: input }), ...runtimeEvents];
    return cache(timeline);
  }

  function projectTimeline(events: readonly ProjectTimelineEvent[]): WorkbenchTimelineEvent[] {
    const combined: ProjectTimelineEvent[] = [];
    let reasoning: { kind: "reasoning"; text: string } | undefined;
    for (const event of events) {
      if (event.kind === "reasoning") {
        // Sanitize the assembled text: a filesystem path can cross deltas,
        // including a runtime activity notification between its fragments.
        if (reasoning === undefined) {
          reasoning = { kind: "reasoning", text: "" };
          combined.push(reasoning);
        }
        reasoning.text += requireString(event.text);
      } else {
        combined.push(event);
        if (event.kind !== "progress" && event.kind !== "item-started" && event.kind !== "item-completed") {
          reasoning = undefined;
        }
      }
    }
    return combined.map(projectEvent);
  }

  function projectEvent(event: ProjectTimelineEvent): WorkbenchTimelineEvent {
    switch (event.kind) {
      case "user-message":
        return Object.freeze({ kind: "user-message", text: event.text });
      case "session-started":
      case "turn-started":
        return Object.freeze({ kind: event.kind });
      case "item-started":
      case "item-completed":
        if (event.itemType !== "agent-message") throw new Error("invalid-event");
        return Object.freeze({ kind: event.kind, itemType: "agent-message" });
      case "agent-message":
      case "reasoning":
        return Object.freeze({
          kind: event.kind,
          text: sanitizeVisibleString(requireString(event.text)),
        });
      case "progress":
        if (!runtimeProgressActivities.includes(event.activity)) {
          throw new Error("invalid-event");
        }
        return Object.freeze({
          kind: "progress" as const,
          activity: event.activity,
          ...(event.tool === undefined
            ? {}
            : { tool: projectToolActivity(event.tool) }),
        });
      case "turn-completed":
        if (event.status !== "completed") throw new Error("invalid-event");
        return Object.freeze({
          kind: "turn-completed",
          status: "completed",
          ...(event.suggestions === undefined
            ? {}
            : { suggestions: projectPromptSuggestions(event.suggestions) }),
        });
      case "turn-interrupted":
        if (event.status !== "interrupted") throw new Error("invalid-event");
        return Object.freeze({ kind: "turn-interrupted", status: "interrupted" });
      case "turn-paused":
        if (event.reason !== "quota-exhausted") throw new Error("invalid-event");
        return Object.freeze({ kind: "turn-paused", reason: "quota-exhausted" });
      case "failed":
        if (!isWorkbenchRuntimeFailureCategory(event.category)) {
          throw new Error("invalid-event");
        }
        return Object.freeze({ kind: "failed", category: event.category });
      default:
        throw new Error("invalid-event");
    }
  }

  function projectToolActivity(
    tool: RuntimeToolActivity,
  ): WorkbenchToolActivity {
    return Object.freeze({
      type: tool.type,
      name: tool.name,
      ...(tool.sourceType === undefined ? {} : { sourceType: tool.sourceType }),
      ...(tool.parameter === undefined
        ? {}
        : {
            parameter: Object.freeze({
              kind: tool.parameter.kind,
              value: tool.parameter.value,
              truncated: tool.parameter.truncated,
            }),
          }),
      ...(tool.fileChanges === undefined
        ? {}
        : {
            fileChanges: Object.freeze({
              files: Object.freeze(tool.fileChanges.files.map((file) =>
                Object.freeze({
                  path: file.path,
                  truncated: file.truncated,
                  ...(file.lines === undefined
                    ? {}
                    : {
                        lines: Object.freeze({
                          additions: file.lines.additions,
                          deletions: file.lines.deletions,
                        }),
                      }),
                })
              )),
              totalFiles: tool.fileChanges.totalFiles,
              truncated: tool.fileChanges.truncated,
            }),
          }),
    });
  }

  function projectPromptSuggestions(value: unknown): readonly string[] {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every(isValidWorkbenchDirectInput)
    ) {
      throw new Error("invalid-event");
    }
    return Object.freeze([...value]);
  }

  function projectLatestContext(
    timeline: readonly ProjectTimelineEvent[],
  ): WorkbenchSessionContextUsage | undefined {
    let latest: WorkbenchSessionContextUsage | undefined;
    for (const event of timeline) {
      if (event.kind !== "turn-completed") continue;
      if (!Object.prototype.hasOwnProperty.call(event, "context")) {
        latest = undefined;
        continue;
      }
      latest = projectContext(event.context);
    }
    return latest;
  }

  function projectContext(value: unknown): WorkbenchSessionContextUsage {
    if (
      !isExactDataRecord(value, [
        "basis",
        "usedTokens",
        "windowTokens",
      ])
    ) {
      throw new Error("invalid-context");
    }
    const context = value as Record<string, unknown>;
    if (
      typeof context.usedTokens !== "number" ||
      !Number.isSafeInteger(context.usedTokens) ||
      context.usedTokens < 0 ||
      (context.basis === "active-context"
        ? typeof context.windowTokens !== "number" ||
          !Number.isSafeInteger(context.windowTokens) ||
          context.windowTokens < context.usedTokens
        : context.basis === "turn-usage"
          ? context.windowTokens !== null
          : true)
    ) {
      throw new Error("invalid-context");
    }
    return Object.freeze({
      usedTokens: context.usedTokens,
      windowTokens: context.windowTokens as number | null,
    });
  }

  function hasExactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
  ): boolean {
    const actual = Object.keys(value);
    const allowed = new Set(expected);
    return actual.length === expected.length && actual.every((key) => allowed.has(key));
  }

  function isExactDataRecord(
    value: unknown,
    expected: readonly string[],
  ): value is Record<string, unknown> {
    try {
      if (
        typeof value !== "object" ||
        value === null ||
        nodeUtilTypes.isProxy(value) ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
      ) {
        return false;
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== expected.length ||
        keys.some((key) => typeof key !== "string" || !expected.includes(key))
      ) {
        return false;
      }
      return expected.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          "value" in descriptor &&
          descriptor.enumerable
        );
      });
    } catch {
      return false;
    }
  }

  function sanitizeVisibleString(value: string): string {
    const variants = new Set([
      projectDirectory,
      projectDirectory.replaceAll("\\", "/"),
    ]);
    let sanitized = value;
    for (const variant of variants) {
      if (variant.length === 0) continue;
      sanitized = sanitized.replace(
        new RegExp(escapeRegularExpression(variant), "giu"),
        "[Project]",
      );
    }
    return redactFilesystemPaths(sanitized);
  }
}

function isResumableTerminal(entry: {
  readonly status: ProjectCommandStatus;
  readonly failureCategory?: ProjectCommandFailureCategory;
}): boolean {
  return entry.status === "completed" || entry.status === "recovery-required" || entry.status === "quota-paused" || entry.failureCategory === "interrupted";
}

function readInterruptCapability(
  channel: ProjectChannel,
): ProjectInterruptCapability {
  const read = (channel as Partial<ProjectChannel>).readInterruptCapability;
  if (typeof read !== "function") {
    return Object.freeze({ status: "unknown" as const });
  }
  try {
    const value = read.call(channel) as unknown;
    if (!isExactInterruptCapabilityRecord(value)) {
      return Object.freeze({ status: "unknown" as const });
    }
    const candidate = value;
    if (
      (candidate.status === "idle" || candidate.status === "unknown") &&
      Object.keys(candidate).length === 1 &&
      Object.prototype.hasOwnProperty.call(candidate, "status")
    ) {
      return Object.freeze({ status: candidate.status });
    }
    if (
      (candidate.status === "pending" ||
        candidate.status === "available" ||
        candidate.status === "unsupported" ||
        candidate.status === "requested") &&
      typeof candidate.commandId === "string" &&
      candidate.commandId.length > 0 &&
      Object.keys(candidate).length === 2 &&
      Object.prototype.hasOwnProperty.call(candidate, "status") &&
      Object.prototype.hasOwnProperty.call(candidate, "commandId")
    ) {
      return Object.freeze({
        status: candidate.status,
        commandId: candidate.commandId,
      });
    }
  } catch {
    // A live control that cannot be read is unavailable, never optimistically enabled.
  }
  return Object.freeze({ status: "unknown" as const });
}

function readSteerCapability(channel: ProjectChannel): ProjectSteerCapability {
  const read = (channel as Partial<ProjectChannel>).readSteerCapability;
  if (typeof read !== "function") {
    return Object.freeze({ status: "unknown" as const });
  }
  try {
    const value = read.call(channel) as unknown;
    if (!isExactInterruptCapabilityRecord(value)) {
      return Object.freeze({ status: "unknown" as const });
    }
    const candidate = value;
    if (
      (candidate.status === "idle" || candidate.status === "unknown") &&
      Object.keys(candidate).length === 1 &&
      Object.prototype.hasOwnProperty.call(candidate, "status")
    ) {
      return Object.freeze({ status: candidate.status });
    }
    if (
      (candidate.status === "pending" ||
        candidate.status === "available" ||
        candidate.status === "unsupported" ||
        candidate.status === "submitting" ||
        candidate.status === "unavailable") &&
      typeof candidate.commandId === "string" &&
      candidate.commandId.length > 0 &&
      Object.keys(candidate).length === 2 &&
      Object.prototype.hasOwnProperty.call(candidate, "status") &&
      Object.prototype.hasOwnProperty.call(candidate, "commandId")
    ) {
      return Object.freeze({
        status: candidate.status,
        commandId: candidate.commandId,
      });
    }
  } catch {
    // A live control that cannot be read is unavailable, never optimistically enabled.
  }
  return Object.freeze({ status: "unknown" as const });
}

function isExactInterruptCapabilityRecord(
  value: unknown,
): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length < 1 ||
      ownKeys.length > 2 ||
      ownKeys.some((key) => typeof key !== "string")
    ) {
      return false;
    }
    return ownKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function projectInterruptControl(
  capability: ProjectInterruptCapability,
  commandId: string,
  keysByCommandId: ReadonlyMap<string, string>,
): WorkbenchInterruptControl {
  if (!("commandId" in capability) || capability.commandId !== commandId) {
    return Object.freeze({
      status: "unavailable",
      reason: "Interrupt is unavailable for this turn.",
    });
  }
  switch (capability.status) {
    case "available": {
      const interruptKey = keysByCommandId.get(commandId);
      return interruptKey === undefined
        ? Object.freeze({
            status: "unavailable" as const,
            reason: "Interrupt is unavailable for this turn." as const,
          })
        : Object.freeze({ status: "available" as const, interruptKey });
    }
    case "pending":
      return Object.freeze({
        status: "pending",
        reason: "Interrupt becomes available when the Runtime turn starts.",
      });
    case "unsupported":
      return Object.freeze({
        status: "unsupported",
        reason: "This Runtime does not support interruption.",
      });
    case "requested":
      return Object.freeze({
        status: "requested",
        reason: "Interrupt requested. Waiting for the Runtime to stop.",
      });
  }
}

function projectSteerControl(
  capability: ProjectSteerCapability,
  commandId: string,
  keysByCommandId: ReadonlyMap<string, string>,
): WorkbenchSteerControl {
  if (!("commandId" in capability) || capability.commandId !== commandId) {
    return Object.freeze({
      status: "unavailable",
      reason: "Same-turn guidance is unavailable. Your draft stays local.",
    });
  }
  switch (capability.status) {
    case "available": {
      const steerKey = keysByCommandId.get(commandId);
      return steerKey === undefined
        ? Object.freeze({
            status: "unavailable" as const,
            reason:
              "Same-turn guidance is unavailable. Your draft stays local." as const,
          })
        : Object.freeze({ status: "available" as const, steerKey });
    }
    case "pending":
      return Object.freeze({
        status: "pending",
        reason:
          "Same-turn guidance becomes available when the Runtime turn starts.",
      });
    case "unsupported":
      return Object.freeze({
        status: "unsupported",
        reason:
          "This Runtime does not support same-turn guidance. Your draft stays local.",
      });
    case "submitting":
      return Object.freeze({
        status: "submitting",
        reason: "Sending guidance to this running turn.",
      });
    case "unavailable":
      return Object.freeze({
        status: "unavailable",
        reason: "Same-turn guidance is unavailable. Your draft stays local.",
      });
  }
}

function emitState(
  state: ObservationState,
  result: WorkbenchProjectResult,
): boolean {
  const listener = state.listener;
  state.view = result.ok ? result.view : undefined;
  return listener === undefined ? false : emit(listener, result);
}

export function deriveProjectLabel(projectDirectory: string): string {
  const rawLabel = basename(resolve(projectDirectory));
  const label = rawLabel
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim();
  if (label.length === 0) throw new Error("invalid-project-label");
  return [...label].slice(0, 80).join("");
}

function emit(listener: WorkbenchProjectListener, result: WorkbenchProjectResult): boolean {
  try {
    listener(deepFreeze(result));
    return true;
  } catch {
    return false;
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isStatus(value: unknown): value is ProjectCommandStatus {
  return statuses.includes(value as ProjectCommandStatus);
}

function isFailureCategory(
  value: unknown,
): value is ProjectCommandFailureCategory {
  return failureCategories.includes(value as ProjectCommandFailureCategory);
}

function sameLockedProfileFields(
  left: SessionProfile,
  right: SessionProfile,
): boolean {
  return (
    left.executionMode === right.executionMode &&
    left.accessMode === right.accessMode
  );
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid-string");
  return value;
}

const deeplyFrozen = new WeakSet<object>();
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || deeplyFrozen.has(value)) {
    return value;
  }
  Object.freeze(value);
  deeplyFrozen.add(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
