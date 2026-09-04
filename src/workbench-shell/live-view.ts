import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { types as nodeUtilTypes } from "node:util";

import type {
  NormalizedRuntimeEvent,
  RuntimeFailureCategory,
  SessionProfile,
} from "../agent-runtime/index.ts";
import type {
  ProjectChannel,
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
import { redactFilesystemPaths } from "./path-redaction.ts";
import {
  cloneEffectiveSessionProfileProjection,
  cloneRequestedSessionProfileProjection,
  unknownEffectiveSessionProfileProjection,
} from "../coordinator/profile-projection.ts";
import {
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
} from "./contract.ts";

const statuses: readonly ProjectCommandStatus[] = [
  "accepted",
  "in-flight",
  "completed",
  "failed",
  "recovery-required",
];
const failureCategories: readonly ProjectCommandFailureCategory[] = [
  "interrupted",
  "profile-resolution-failed",
  "runtime-failed",
];
const runtimeFailureCategories: readonly RuntimeFailureCategory[] = [
  "approval-required",
  "authentication-required",
  "catalog-invalid",
  "correlation-invalid",
  "invalid-input",
  "protocol-invalid",
  "protocol-rejected",
  "runtime-shutdown",
  "runtime-unavailable",
  "temp-cleanup",
  "temp-cleanup-guard",
  "transport-failed",
  "turn-failed",
  "unexpected-server-request",
  "unsupported-selection",
];

type ProjectTimelineEvent =
  | NormalizedRuntimeEvent
  | { readonly kind: "user-message"; readonly text: string };

type ObservationState = {
  disposed: boolean;
  emittedCursor?: number;
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
          readonly timeline: ProjectTimelineEvent[];
          readonly requestedProfileProjection?: RequestedSessionProfileProjection;
          readonly effectiveProfileProjection?: EffectiveSessionProfileProjection;
        }>;
        resumable: boolean;
        status: ProjectCommandStatus;
        failureCategory?: ProjectCommandFailureCategory;
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
      const commandTimeline = projectCommandTimeline(
        command.input,
        command.session?.events ?? [],
      );
      const sessionId = command.session?.sessionId;
      if (sessionId !== undefined && requireString(sessionId).length === 0) {
        throw new Error("invalid-session-identity");
      }
      const identity =
        sessionId === undefined ? `command:${commandId}` : `session:${sessionId}`;
      const existing = grouped.get(identity);
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
        timeline: commandTimeline,
        ...(requestedProfileProjection === undefined
          ? {}
          : { requestedProfileProjection }),
        effectiveProfileProjection: existing.effectiveProfileProjection,
      });
      existing.resumable = command.session.resumable;
      existing.latestCommandId = commandId;
      existing.status = command.status;
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

    const projectedEntries = groups.map((entry) => {
      let ordinal = sessionOrdinals.get(entry.identity);
      if (ordinal === undefined) {
        ordinal = nextSessionOrdinal;
        nextSessionOrdinal += 1;
        sessionOrdinals.set(entry.identity, ordinal);
      }
      return Object.freeze({
        commandKey: `command-${ordinal}`,
        entry,
      });
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
      const turns = entry.turns.map((turn) => deepFreeze({
        profile: projectPublicProfile(
          turn.requestedProfileProjection,
          turn.effectiveProfileProjection,
        ),
        timeline: turn.timeline.map(projectEvent),
      }));
      const timeline = turns.flatMap((turn) => turn.timeline);
      const context = projectLatestContext(
        entry.turns.flatMap((turn) => turn.timeline),
      );
      const projected: WorkbenchCommandView = {
        key: commandKey,
        label:
          entry.displayName ??
          `Agent Session ${commandKey.slice("command-".length).padStart(2, "0")}`,
        runtime: entry.runtimeLabel,
        status: entry.status,
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
      const snapshot = await options.channel.snapshot();
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
        if (
          next.value.kind === "snapshot" ||
          !Number.isSafeInteger(next.value.cursor) ||
          next.value.cursor !== rawCursor + 1
        ) {
          throw new Error("invalid-observation");
        }
        rawCursor = next.value.cursor;
        if (rawCursor <= (state.emittedCursor ?? -1)) continue;
        const freshSnapshot = await options.channel.snapshot();
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
            view: projectSnapshot(freshSnapshot),
          })
        ) {
          state.dispose();
          return;
        }
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
    async refreshAfterSessionMutation(): Promise<void> {
      if (closed) return;
      // Session metadata changes and hard deletion intentionally leave no update
      // cursor. Rotate every snapshot-scoped capability before same-cursor projection.
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
      try {
        const snapshot = await options.channel.snapshot();
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

  function projectCommandTimeline(
    input: unknown,
    events: readonly ProjectTimelineEvent[],
  ): ProjectTimelineEvent[] {
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
    if (input === undefined) return runtimeEvents;
    if (!isValidWorkbenchDirectInput(input)) {
      throw new Error("invalid-user-message");
    }
    return [Object.freeze({ kind: "user-message", text: input }), ...runtimeEvents];
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
        return Object.freeze({
          kind: "agent-message",
          text: sanitizeVisibleString(requireString(event.text)),
        });
      case "turn-completed":
        if (event.status !== "completed") throw new Error("invalid-event");
        return Object.freeze({ kind: "turn-completed", status: "completed" });
      case "turn-interrupted":
        if (event.status !== "interrupted") throw new Error("invalid-event");
        return Object.freeze({ kind: "turn-interrupted", status: "interrupted" });
      case "failed":
        if (!runtimeFailureCategories.includes(event.category)) {
          throw new Error("invalid-event");
        }
        return Object.freeze({ kind: "failed" });
      default:
        throw new Error("invalid-event");
    }
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
  return entry.status === "completed" || entry.failureCategory === "interrupted";
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
