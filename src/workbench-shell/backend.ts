import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import type {
  AgentRuntimeAdapter,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeModel,
  RuntimeStart,
  SessionProfile,
} from "../agent-runtime/index.ts";
import { RuntimeAdapterError } from "../agent-runtime/index.ts";
import type { WorkbenchUserInputBridge, WorkbenchUserInputReadRequest, WorkbenchUserInputResponse, WorkbenchUserInputResult, WorkbenchUserInputResponseResult } from "./contract.ts";
import { reconstructUserInputRead, reconstructUserInputResponse, sanitizeUserInputResult } from "./user-input-sanitizer.ts";
import {
  CoordinatorError,
  createWorkbenchCoordinator,
  createSessionContinuationPlan,
  parseSessionContinuationPlan,
  sessionContinuationStepInput,
} from "../coordinator/index.ts";
import type {
  ProjectChannel,
  ProjectSnapshot,
  ProjectTurnActivity,
} from "../coordinator/index.ts";
import type { WorkLedgerAuthGenerationModule } from "../coordinator/index.ts";
import { resolveSessionProfile } from "../session-profile/index.ts";
import { WORKBENCH_RUNTIME_ENDPOINT_IDS } from "./runtime-endpoint-identity.ts";
import {
  createDirectSessionProfilePreferenceStore,
  LEGACY_CODEX_DIRECT_SESSION_PROFILE_ENDPOINT_KEY,
  type DirectSessionProfilePreferenceSnapshot,
  type DirectSessionProfilePreferenceStore,
} from "./preference-store.ts";
import {
  isValidWorkbenchDirectInput,
  publicInvalidProfileSelection,
  publicInvalidProfileDefaultSelection,
  publicInvalidSubmission,
  publicInterruptRequested,
  publicInterruptUnavailable,
  publicInvalidInterrupt,
  publicInvalidSteer,
  publicContinuationProfileUnavailable,
  publicContinuationModelUnavailable,
  publicProfileUnavailable,
  publicRuntimeEndpointDiscovery,
  publicRuntimeNotLocated,
  publicSingleInspectedRuntimeEndpointDiscovery,
  publicUniformRuntimeEndpointDiscovery,
  publicProfileDefaultSaved,
  publicPreferenceUnavailable,
  publicSubmissionAccepted,
  publicSteerAccepted,
  publicSteerUnavailable,
  publicRuntimeStartUnsupported,
  publicUnavailableSubmission,
  publicContinuationUnavailable,
  type WorkbenchAnyDirectSessionProfileResult,
  type WorkbenchDirectInputRequest,
  type WorkbenchBackendDirectSessionProfile,
  type WorkbenchBackendContinuationDirectSessionProfile,
  type WorkbenchBackendReplacementDirectSessionProfile,
  type WorkbenchCatalogDefaultProfileResult,
  type WorkbenchDirectSessionProfileDefaultRequest,
  type WorkbenchDirectSessionProfileDefaultResult,
  type WorkbenchDirectSessionProfileLoadRequest,
  type WorkbenchDirectSessionProfileResultFor,
  type WorkbenchProjectListener,
  type WorkbenchInterruptRequest,
  type WorkbenchInterruptResult,
  type WorkbenchSteerRequest,
  type WorkbenchSteerResult,
  type WorkbenchRuntimeEndpointDiscovery,
  type WorkbenchRuntimeEndpointDiscoveryCategory,
  type WorkbenchSessionMetadataMutationRequest,
  type WorkbenchSessionMetadataMutationResult,
  type WorkbenchSessionRemovalRequest,
  type WorkbenchSessionRemovalResult,
  type WorkbenchReplacementPrefill,
  type WorkbenchReplacementSessionProfileResult,
  type WorkbenchContinuationPrefill,
  type WorkbenchContinuationSessionProfileResult,
  type WorkbenchSubmissionResult,
} from "./contract.ts";
import {
  createDirectSessionProfileSnapshot,
  type DirectSessionProfileCatalog,
  type DirectSessionProfileSnapshot,
  type WorkIntensityExecutionModeCoupling,
} from "./direct-session-profile-snapshot.ts";
import {
  createWorkbenchLiveView,
  type WorkbenchLiveView,
} from "./live-view.ts";
import {
  reconstructWorkbenchDirectInputRequest,
  reconstructWorkbenchDirectSessionProfileDefaultRequest,
  reconstructWorkbenchDirectSessionProfileLoadRequest,
  reconstructWorkbenchInterruptRequest,
  reconstructWorkbenchSteerRequest,
  reconstructWorkbenchSessionMetadataMutationRequest,
  reconstructWorkbenchSessionRemovalRequest,
} from "./result-sanitizer.ts";
import {
  readWorkbenchDirectRuntimeEndpoints,
  readWorkbenchRuntimeResumeIdentityResolver,
  type WorkbenchDirectRuntimeEndpointCatalog,
  type WorkbenchDirectRuntimeEndpointSnapshot,
} from "./runtime-endpoint-adapter.ts";

export interface WorkbenchBackend extends Partial<WorkbenchUserInputBridge> {
  observeProject(listener: WorkbenchProjectListener): () => void;
  readTurnActivity(): ProjectTurnActivity;
  interruptActiveTurn?(
    request: WorkbenchInterruptRequest,
  ): Promise<WorkbenchInterruptResult>;
  steerActiveTurn?(
    request: WorkbenchSteerRequest,
  ): Promise<WorkbenchSteerResult>;
  /** Trusted host seam. Renderer-owned opaque keys must resolve before this call. */
  removeSession?(
    request: WorkbenchSessionRemovalRequest,
  ): Promise<WorkbenchSessionRemovalResult>;
  mutateSessionMetadata?(
    request: WorkbenchSessionMetadataMutationRequest,
  ): Promise<WorkbenchSessionMetadataMutationResult>;
  loadDirectSessionProfile(): Promise<WorkbenchCatalogDefaultProfileResult>;
  loadDirectSessionProfile<
    Request extends WorkbenchDirectSessionProfileLoadRequest,
  >(
    request: Request,
  ): Promise<WorkbenchDirectSessionProfileResultFor<Request>>;
  useDirectSessionProfileAsDefault(
    request:
      | WorkbenchDirectSessionProfileDefaultRequest
      | WorkbenchBackendLegacyDefaultRequest,
  ): Promise<WorkbenchDirectSessionProfileDefaultResult>;
  submitDirectInput(
    request: WorkbenchDirectInputRequest,
  ): Promise<WorkbenchSubmissionResult>;
  close(): Promise<void>;
}

/** Backend-only compatibility for the protected headless catalog validator. */
export interface WorkbenchBackendLegacyDefaultRequest {
  readonly snapshotKey: string;
  readonly modelKey: string;
  readonly workIntensityKey: string;
}

const initialCodexProfile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});
type CatalogSnapshot = {
  readonly value: DirectSessionProfileSnapshot;
  readonly compatibilityRuntime: string;
  readonly endpointPreferenceKeys: readonly string[];
  readonly directStartByEndpoint: readonly ("supported" | "inspect-only")[];
};

interface ActiveContinuationCapability {
  readonly selectionKey: string;
  readonly prefill: WorkbenchContinuationPrefill;
}

export interface WorkbenchDirectEndpointPresentation {
  readonly preferenceKey: string;
  readonly runtimeFamilyLabel: string;
  readonly endpointLabel: string;
}

const productionEndpointPresentation: WorkbenchDirectEndpointPresentation =
  Object.freeze({
    preferenceKey: LEGACY_CODEX_DIRECT_SESSION_PROFILE_ENDPOINT_KEY,
    runtimeFamilyLabel: "Codex",
    endpointLabel: "Codex desktop",
  });

const noLaunchAdapter: ResumableAgentRuntimeAdapter = Object.freeze({
  async inspect() {
    throw new RuntimeAdapterError("runtime-unavailable");
  },
  async start() {
    throw new RuntimeAdapterError("runtime-unavailable");
  },
  async resume() {
    throw new RuntimeAdapterError("runtime-unavailable");
  },
});

export async function createWorkbenchBackend(options: {
  readonly projectDirectory: string;
  readonly databasePath: string;
  readonly adapter?: AgentRuntimeAdapter;
  readonly preferencePath?: string;
  readonly preferenceStore?: DirectSessionProfilePreferenceStore;
  readonly directEndpointPresentation?: WorkbenchDirectEndpointPresentation;
  readonly authGeneration?: WorkLedgerAuthGenerationModule;
}): Promise<WorkbenchBackend> {
  const adapter = toResumableAdapter(options.adapter ?? noLaunchAdapter);
  const preferenceStore =
    options.preferenceStore ??
    createDirectSessionProfilePreferenceStore({
      filePath:
        options.preferencePath ??
        join(dirname(options.databasePath), "direct-session-profile-preferences.json"),
    });
  const coordinator = createWorkbenchCoordinator({
    databasePath: options.databasePath,
    adapter,
    authGeneration: options.authGeneration,
    // The shell admits its full registered endpoint roster (including the
    // api-key endpoints GLM/Kimi/DeepSeek); the coordinator's own default
    // stays narrower.
    endpointIds: [...WORKBENCH_RUNTIME_ENDPOINT_IDS],
  });
  const channel = await coordinator.openProject(options.projectDirectory);
  try {
    const liveView = createWorkbenchLiveView({
      channel,
      projectDirectory: options.projectDirectory,
    });
    return createBackend(
      liveView,
      channel,
      adapter,
      options.projectDirectory,
      preferenceStore,
      options.directEndpointPresentation ?? productionEndpointPresentation,
    );
  } catch (error) {
    // `openProject` has already opened -- and created -- the SQLite ledger for
    // this directory, and the caller only ever sees the rejection, so nothing
    // downstream holds the channel to close it. Every construction step after
    // this point can still throw: `createWorkbenchLiveView` does exactly that
    // for a directory whose label cannot be derived (a drive root, F-w187 /
    // public issue #5), and each failed attempt used to leave one more open
    // handle on the ledger file for the lifetime of the process.
    await channel.close().catch(() => undefined);
    throw error;
  }
}

function toResumableAdapter(
  adapter: AgentRuntimeAdapter,
): ResumableAgentRuntimeAdapter {
  if (
    "resume" in adapter &&
    typeof (adapter as { readonly resume?: unknown }).resume === "function"
  ) {
    return adapter as ResumableAgentRuntimeAdapter;
  }
  return Object.freeze({
    inspect: (projectDirectory: string) => adapter.inspect(projectDirectory),
    start: async (
      request: RuntimeStart,
    ): Promise<ResumableRuntimeBinding> => {
      const binding = await adapter.start(request);
      if (
        !("opaqueSessionReference" in binding) ||
        typeof binding.opaqueSessionReference !== "string"
      ) {
        throw new RuntimeAdapterError("protocol-invalid");
      }
      return binding as ResumableRuntimeBinding;
    },
    async resume() {
      throw new RuntimeAdapterError("runtime-unavailable");
    },
  });
}

function createBackend(
  liveView: WorkbenchLiveView,
  channel: ProjectChannel,
  adapter: ResumableAgentRuntimeAdapter,
  projectDirectory: string,
  preferenceStore: DirectSessionProfilePreferenceStore,
  endpointPresentation: WorkbenchDirectEndpointPresentation,
): WorkbenchBackend {
  let closePromise: Promise<void> | undefined;
  const profileLoadPromises = new Set<
    Promise<WorkbenchAnyDirectSessionProfileResult>
  >();
  let profileLoadGeneration = 0;
  const preferenceSavePromises = new Set<
    Promise<WorkbenchDirectSessionProfileDefaultResult>
  >();
  const submissionPromises = new Set<Promise<WorkbenchSubmissionResult>>();
  const sessionRemovalPromises = new Set<
    Promise<WorkbenchSessionRemovalResult>
  >();
  const sessionMetadataPromises = new Set<
    Promise<WorkbenchSessionMetadataMutationResult>
  >();
  const interruptPromises = new Set<Promise<WorkbenchInterruptResult>>();
  const steerPromises = new Set<Promise<WorkbenchSteerResult>>();
  let submissionTail: Promise<void> = Promise.resolve();
  let activeSnapshot: CatalogSnapshot | undefined;
  let activeSnapshotRecoveryCommandIds: ReadonlySet<string> | undefined;
  let activeContinuationCapability: ActiveContinuationCapability | undefined;
  const runtimeResumeIdentityResolver =
    readWorkbenchRuntimeResumeIdentityResolver(adapter);
  let closing = false;
  const continuationPlan = createSessionContinuationPlan(channel, (commandId, stop) => {
    liveView.reportContinuationStop(commandId, stop);
  });
  return Object.freeze({
    observeProject: (listener: WorkbenchProjectListener) =>
      liveView.observe(listener),
    observeUserInput: (listener: () => void) => channel.observeUserInput?.(listener) ?? (() => undefined),
    async readUserInput(request: WorkbenchUserInputReadRequest): Promise<WorkbenchUserInputResult> {
      const parsed = reconstructUserInputRead(request);
      const target = parsed && !closing ? liveView.resolveSessionMetadata(parsed.sessionKey) : undefined;
      if (!target) return { ok: false };
      return sanitizeUserInputResult({ ok: true, requests: channel.readUserInput?.(target.sessionId) ?? [] });
    },
    async respondToUserInput(request: WorkbenchUserInputResponse): Promise<WorkbenchUserInputResponseResult> {
      const parsed = reconstructUserInputResponse(request);
      if (closing || !parsed || !channel.respondToUserInput) return { status: "unavailable" };
      return channel.respondToUserInput(parsed);
    },
    readTurnActivity(): ProjectTurnActivity {
      if (closing) return "unknown";
      try {
        return channel.readTurnActivity();
      } catch {
        return "unknown";
      }
    },
    interruptActiveTurn(
      request: WorkbenchInterruptRequest,
    ): Promise<WorkbenchInterruptResult> {
      const reconstructed = reconstructWorkbenchInterruptRequest(request);
      if (!reconstructed.ok) return Promise.resolve(publicInvalidInterrupt());
      continuationPlan.cancel();
      if (closing) return Promise.resolve(publicInterruptUnavailable());
      const resolved = liveView.resolveInterrupt(
        reconstructed.request.interruptKey,
      );
      if (resolved === undefined) return Promise.resolve(publicInvalidInterrupt());
      const interrupt = channel.interruptActiveTurn;
      if (typeof interrupt !== "function") {
        return Promise.resolve(publicInterruptUnavailable());
      }
      const operation = Promise.resolve()
        .then(() => interrupt.call(channel, resolved))
        .then(
          (result) =>
            result.status === "requested"
              ? publicInterruptRequested()
              : result.status === "not-running"
                ? publicInvalidInterrupt()
                : publicInterruptUnavailable(),
          () => publicInterruptUnavailable(),
        );
      interruptPromises.add(operation);
      void operation.then(
        () => interruptPromises.delete(operation),
        () => interruptPromises.delete(operation),
      );
      return operation;
    },
    steerActiveTurn(request: WorkbenchSteerRequest): Promise<WorkbenchSteerResult> {
      const reconstructed = reconstructWorkbenchSteerRequest(request);
      if (!reconstructed.ok) return Promise.resolve(publicInvalidSteer());
      continuationPlan.cancel();
      if (closing) return Promise.resolve(publicSteerUnavailable());
      const resolved = liveView.resolveSteer(reconstructed.request.steerKey);
      if (resolved === undefined) return Promise.resolve(publicInvalidSteer());
      const steer = channel.steerActiveTurn;
      if (typeof steer !== "function") {
        return Promise.resolve(publicSteerUnavailable());
      }
      const operation = Promise.resolve()
        .then(() =>
          steer.call(channel, {
            commandId: resolved.commandId,
            input: reconstructed.request.input,
          }),
        )
        .then(
          (result) =>
            result.status === "accepted"
              ? publicSteerAccepted()
              : result.status === "not-running"
                ? publicInvalidSteer()
                : publicSteerUnavailable(),
          () => publicSteerUnavailable(),
        );
      steerPromises.add(operation);
      void operation.then(
        () => steerPromises.delete(operation),
        () => steerPromises.delete(operation),
      );
      return operation;
    },
    removeSession(
      request: WorkbenchSessionRemovalRequest,
    ): Promise<WorkbenchSessionRemovalResult> {
      const reconstructed = reconstructWorkbenchSessionRemovalRequest(request);
      if (!reconstructed.ok) {
        return Promise.resolve(Object.freeze({ status: "not-found" as const }));
      }
      if (closing) {
        return Promise.resolve(
          Object.freeze({
            status: "blocked" as const,
            activity: "unknown" as const,
          }),
        );
      }
      const resolved = liveView.resolveSessionRemoval(
        reconstructed.request.removalKey,
      );
      if (resolved === undefined) {
        return Promise.resolve(Object.freeze({ status: "not-found" as const }));
      }
      const operation: Promise<WorkbenchSessionRemovalResult> = channel
        .removeSession(
          reconstructed.request.acknowledgedUnknownOutcome === true
            ? Object.freeze({
                ...resolved,
                acknowledgedUnknownOutcome: true as const,
              })
            : resolved,
        )
        .then(async (result) => {
          if (result.status === "removed") {
            await liveView.refreshAfterSessionMutation();
          }
          return result;
        });
      sessionRemovalPromises.add(operation);
      void operation.then(
        () => sessionRemovalPromises.delete(operation),
        () => sessionRemovalPromises.delete(operation),
      );
      return operation;
    },
    mutateSessionMetadata(
      request: WorkbenchSessionMetadataMutationRequest,
    ): Promise<WorkbenchSessionMetadataMutationResult> {
      const reconstructed =
        reconstructWorkbenchSessionMetadataMutationRequest(request);
      if (!reconstructed.ok) {
        return Promise.resolve(Object.freeze({ status: "unavailable" as const }));
      }
      if (closing) {
        return Promise.resolve(Object.freeze({ status: "unavailable" as const }));
      }
      const resolved = liveView.resolveSessionMetadata(
        reconstructed.request.metadataKey,
      );
      if (resolved === undefined) {
        return Promise.resolve(Object.freeze({ status: "not-found" as const }));
      }
      const operation: Promise<WorkbenchSessionMetadataMutationResult> = channel
        .mutateSessionMetadata({
          sessionId: resolved.sessionId,
          operation: reconstructed.request.operation,
          ...(reconstructed.request.acknowledgedUnknownOutcome === true
            ? { acknowledgedUnknownOutcome: true as const }
            : {}),
        })
        .then(async (result) => {
          if (
            result.status === "renamed" ||
            result.status === "archived" ||
            result.status === "restored"
          ) {
            await liveView.refreshAfterSessionMutation();
          }
          return result;
        });
      sessionMetadataPromises.add(operation);
      void operation.then(
        () => sessionMetadataPromises.delete(operation),
        () => sessionMetadataPromises.delete(operation),
      );
      return operation;
    },
    loadDirectSessionProfile(
      request: WorkbenchDirectSessionProfileLoadRequest = Object.freeze({
        kind: "catalog-default",
      }),
    ): Promise<WorkbenchAnyDirectSessionProfileResult> {
      const reconstructed =
        reconstructWorkbenchDirectSessionProfileLoadRequest(request);
      if (closing || !reconstructed.ok) {
        return Promise.resolve(publicProfileUnavailable());
      }
      const exactRequest = reconstructed.request;
      const loadGeneration = ++profileLoadGeneration;
      const operation = (async () => {
        let endpointDiscovery = publicUniformRuntimeEndpointDiscovery(
          "not-inspected",
        );
        try {
          const project = await channel.snapshot();
          const initialReplacementSource =
            exactRequest.kind === "replacement-session" &&
            project.cursor === exactRequest.sourceSnapshotCursor
              ? await liveView.resolveReplacementProfileSource(exactRequest)
              : undefined;
          const initialContinuationSource =
            exactRequest.kind === "continuation-session"
              ? liveView.resolveContinuationSelection(exactRequest.selectionKey)
              : undefined;
          const initialContinuationRuntimeResumeIdentities =
            exactRequest.kind === "continuation-session"
              ? await liveView.resolveContinuationRuntimeResumeIdentities(
                  exactRequest.selectionKey,
                )
              : undefined;
          if (
            exactRequest.kind === "continuation-session" &&
            (initialContinuationSource === undefined ||
              initialContinuationRuntimeResumeIdentities === undefined)
          ) {
            return publicContinuationProfileUnavailable(endpointDiscovery);
          }
          const endpointLoader = readWorkbenchDirectRuntimeEndpoints(adapter);
          const endpointSnapshot =
            endpointLoader === undefined
              ? await inspectLegacyRuntimeEndpoint(
                  adapter,
                  projectDirectory,
                  endpointPresentation,
                )
              : await endpointLoader(
                  projectDirectory,
                  exactRequest.kind,
                  exactRequest.kind === "continuation-session"
                    ? Object.freeze({
                        recordedProfile: initialContinuationSource!.profile,
                        runtimeResumeIdentities:
                          initialContinuationRuntimeResumeIdentities!,
                      })
                    : undefined,
                );
          endpointDiscovery = endpointSnapshot.endpointDiscovery;
          if (endpointSnapshot.endpoints.length === 0) {
            return exactRequest.kind === "continuation-session"
              ? publicContinuationProfileUnavailable(endpointDiscovery)
              : profileLoadFailureForDiscovery(endpointDiscovery);
          }
          const preferences = await preferenceStore.read();
          const recordedContinuationEndpointId =
            exactRequest.kind === "continuation-session" &&
            endpointLoader !== undefined
              ? continuationEndpointId(
                  initialContinuationRuntimeResumeIdentities!,
                  initialContinuationSource!.profile,
                )
              : undefined;
          const continuationEndpointSources =
            exactRequest.kind === "continuation-session" &&
            recordedContinuationEndpointId !== undefined
              ? endpointSnapshot.endpoints.filter(
                  (source) =>
                    source.endpointId === recordedContinuationEndpointId,
                )
              : endpointSnapshot.endpoints;
          const continuationCandidate =
            exactRequest.kind === "continuation-session"
              ? resolveContinuationCatalogCandidate({
                  endpointSources: continuationEndpointSources,
                  preferences,
                  includeLegacyGlobalPreferences: endpointLoader === undefined,
                  recordedProfile: initialContinuationSource!.profile,
                })
              : undefined;
          if (
            exactRequest.kind === "continuation-session" &&
            continuationCandidate === undefined
          ) {
            /* A model-retirement claim needs the recorded endpoint's catalog.
               The legacy adapter is one known Codex endpoint; the endpoint
               directory instead uses the durable resume route. A catalog from
               another endpoint says nothing about this Session's provider. */
            return endpointLoader === undefined ||
              (recordedContinuationEndpointId !== undefined &&
                continuationEndpointSources.length === 1)
              ? publicContinuationModelUnavailable(endpointDiscovery)
              : publicContinuationProfileUnavailable(endpointDiscovery);
          }
          const snapshot = continuationCandidate?.snapshot ??
            createCatalogSnapshot(
              endpointSnapshot.endpoints,
              endpointDiscovery,
              preferences,
              endpointLoader === undefined,
            );
          let replacementPrefill: WorkbenchReplacementPrefill | undefined;
          const finalProject = await channel.snapshot();
          if (exactRequest.kind === "replacement-session") {
            const finalReplacementSource =
              finalProject.cursor === exactRequest.sourceSnapshotCursor
                ? await liveView.resolveReplacementProfileSource(exactRequest)
                : undefined;
            replacementPrefill =
              initialReplacementSource !== undefined &&
              finalReplacementSource !== undefined &&
              samePrivateProfile(
                initialReplacementSource,
                finalReplacementSource,
              )
                ? snapshot.value.resolveReplacementPrefill(
                    initialReplacementSource,
                  )
                : Object.freeze({ kind: "manual-selection-required" });
          }
          if (
            exactRequest.kind === "continuation-session" &&
            continuationCandidate !== undefined &&
            await liveView.resolveContinuationProfile(
              exactRequest.selectionKey,
              continuationCandidate.resolvedProfile,
            ) === undefined
          ) {
            return publicContinuationProfileUnavailable(endpointDiscovery);
          }
          if (closing) {
            return publicProfileUnavailable(
              downgradeCatalogReadyDiscovery(endpointDiscovery),
            );
          }
          const result =
            exactRequest.kind === "catalog-default"
              ? toBackendProfileResult(snapshot)
              : exactRequest.kind === "replacement-session"
                ? toBackendReplacementProfileResult(
                    snapshot,
                    replacementPrefill ??
                      Object.freeze({ kind: "manual-selection-required" }),
                  )
                : toBackendContinuationProfileResult(
                    snapshot,
                    continuationCandidate!.prefill,
                    endpointDiscovery,
                  );
          if (loadGeneration === profileLoadGeneration) {
            activeSnapshot = snapshot;
            activeSnapshotRecoveryCommandIds = recoveryRequiredCommandIds(finalProject);
            activeContinuationCapability =
              exactRequest.kind === "continuation-session"
                ? Object.freeze({
                    selectionKey: exactRequest.selectionKey,
                    prefill: continuationCandidate!.prefill,
                  })
                : undefined;
          }
          return result;
        } catch {
          if (exactRequest.kind === "continuation-session") {
            return publicContinuationProfileUnavailable(endpointDiscovery);
          }
          return profileLoadFailureForDiscovery(
            downgradeCatalogReadyDiscovery(endpointDiscovery),
          );
        }
      })();
      profileLoadPromises.add(operation);
      void operation.then(
        () => profileLoadPromises.delete(operation),
        () => profileLoadPromises.delete(operation),
      );
      return operation;
    },
    useDirectSessionProfileAsDefault(
      request:
        | WorkbenchDirectSessionProfileDefaultRequest
        | WorkbenchBackendLegacyDefaultRequest,
    ): Promise<WorkbenchDirectSessionProfileDefaultResult> {
      const snapshot = activeSnapshot;
      let reconstructed =
        reconstructWorkbenchDirectSessionProfileDefaultRequest(request);
      if (!reconstructed.ok && snapshot !== undefined) {
        const compatibilityRequest = completeLegacyDefaultRequest(
          request,
          snapshot,
        );
        if (compatibilityRequest !== undefined) {
          reconstructed =
            reconstructWorkbenchDirectSessionProfileDefaultRequest(
              compatibilityRequest,
            );
        }
      }
      if (!reconstructed.ok) {
        return Promise.resolve(publicInvalidProfileDefaultSelection());
      }
      if (closing) return Promise.resolve(publicPreferenceUnavailable());
      if (
        snapshot === undefined ||
        reconstructed.request.snapshotKey !==
          snapshot.value.publicResult.profile.snapshotKey
      ) {
        return Promise.resolve(publicInvalidProfileDefaultSelection());
      }
      const resolved = snapshot.value.resolveSelection(reconstructed.request);
      if (resolved === undefined) {
        return Promise.resolve(publicInvalidProfileDefaultSelection());
      }
      const operation = (async () => {
        try {
          await preferenceStore.saveDefault(
            Object.freeze({
              endpointKey:
                snapshot.endpointPreferenceKeys[resolved.endpointIndex]!,
              model: resolved.profile.model,
              workIntensity: resolved.profile.effortLevel,
            }),
          );
          if (activeSnapshot === snapshot) {
            activeSnapshot = Object.freeze({
              value: snapshot.value.withDesiredDefault(reconstructed.request),
              compatibilityRuntime: snapshot.compatibilityRuntime,
              endpointPreferenceKeys: snapshot.endpointPreferenceKeys,
              directStartByEndpoint: snapshot.directStartByEndpoint,
            });
          }
          return publicProfileDefaultSaved();
        } catch {
          return publicPreferenceUnavailable();
        }
      })();
      preferenceSavePromises.add(operation);
      void operation.then(
        () => preferenceSavePromises.delete(operation),
        () => preferenceSavePromises.delete(operation),
      );
      return operation;
    },
    submitDirectInput(
      request: WorkbenchDirectInputRequest,
    ): Promise<WorkbenchSubmissionResult> {
      const submittedWhileOpen = !closing;
      // A human submission takes over this Project immediately, even while an
      // older catalog/acceptance request is awaiting its serialized turn.
      const continuationIntent = continuationPlan.cancel();
      const operation = submissionTail.then(async (): Promise<WorkbenchSubmissionResult> => {
        const reconstructed = reconstructWorkbenchDirectInputRequest(request);
        if (!reconstructed.ok) {
          if (reconstructed.category === "invalid-input") {
            return publicInvalidSubmission();
          }
          return reconstructed.category === "continuation-unavailable"
            ? publicContinuationUnavailable()
            : publicInvalidProfileSelection();
        }
        if (!submittedWhileOpen) return publicUnavailableSubmission();
        const plan = parseSessionContinuationPlan(reconstructed.request.input);
        if (plan === null || (plan !== undefined &&
            !isValidWorkbenchDirectInput(sessionContinuationStepInput(plan, plan.steps)))) {
          return publicInvalidSubmission();
        }
        if (reconstructed.request.kind === "continue") {
          const continuationRequest = reconstructed.request;
          const snapshot = activeSnapshot;
          const capability = activeContinuationCapability;
          if (
            snapshot === undefined ||
            capability === undefined ||
            capability.selectionKey !== continuationRequest.selectionKey ||
            continuationRequest.snapshotKey !==
              snapshot.value.publicResult.profile.snapshotKey ||
            continuationRequest.endpointKey !== capability.prefill.endpointKey ||
            continuationRequest.executionModeKey !==
              capability.prefill.executionModeKey ||
            continuationRequest.accessModeKey !== capability.prefill.accessModeKey
          ) {
            return publicInvalidProfileSelection();
          }
          const resolved = snapshot.value.resolveSelection(continuationRequest);
          if (resolved === undefined || resolved.endpointIndex !== 0) {
            return publicInvalidProfileSelection();
          }
          const resolvedEndpoint =
            snapshot.value.publicResult.profile.endpoints[resolved.endpointIndex];
          if (resolvedEndpoint === undefined) return publicInvalidProfileSelection();
          const continuation = await liveView.resolveContinuationProfile(
            continuationRequest.selectionKey,
            resolved.profile,
          );
          if (continuation === undefined) return publicContinuationUnavailable();
          try {
            const runtimeResumeIdentity =
              runtimeResumeIdentityResolver === undefined
                ? undefined
                : await runtimeResumeIdentityResolver(
                    projectDirectory,
                    continuation.profile,
                  );
            if (
              runtimeResumeIdentityResolver !== undefined &&
              (runtimeResumeIdentity === undefined ||
                runtimeResumeIdentity.endpointId !== resolvedEndpoint.endpointId)
            ) {
              return publicContinuationUnavailable();
            }
            await continuationPlan.submit(
              Object.freeze({
                kind: "direct" as const,
                commandKind: "continue" as const,
                idempotencyKey: randomUUID(),
                runtime: "codex" as const,
                targetSessionId: continuation.targetSessionId,
                profile: continuation.profile,
                profileProjection: Object.freeze({
                  version: 1 as const,
                  requested: resolved.requestedProfileProjection,
                }),
                ...(runtimeResumeIdentity === undefined
                  ? {}
                  : { runtimeResumeIdentity }),
                input: continuationRequest.input,
              }),
              Object.freeze({ endpointId: resolvedEndpoint.endpointId }),
              plan,
              continuationIntent,
            );
            if (activeSnapshot === snapshot) {
              activeSnapshot = undefined;
              activeSnapshotRecoveryCommandIds = undefined;
              activeContinuationCapability = undefined;
            }
            return publicSubmissionAccepted();
          } catch (error) {
            return error instanceof CoordinatorError &&
              error.category === "continuation-unavailable"
              ? publicContinuationUnavailable()
              : publicUnavailableSubmission();
          }
        }

        const startRequest = reconstructed.request;
        const snapshot = activeSnapshot;
        const recoveryCommandIds = activeSnapshotRecoveryCommandIds;
        if (
          snapshot === undefined ||
          recoveryCommandIds === undefined ||
          startRequest.snapshotKey !==
            snapshot.value.publicResult.profile.snapshotKey
        ) {
          return publicInvalidProfileSelection();
        }
        try {
          const project = await channel.snapshot();
          if (hasNewRecoveryRequiredCommand(project, recoveryCommandIds)) {
            return publicUnavailableSubmission();
          }
        } catch {
          return publicUnavailableSubmission();
        }
        const resolved = snapshot.value.resolveSelection(startRequest);
        if (resolved === undefined) {
          return publicInvalidProfileSelection();
        }
        if (
          snapshot.directStartByEndpoint[resolved.endpointIndex] !== "supported"
        ) {
          return publicRuntimeStartUnsupported();
        }
        const selectedProfile: SessionProfile = resolved.profile;
        const resolvedEndpoint =
          snapshot.value.publicResult.profile.endpoints[resolved.endpointIndex];
        if (resolvedEndpoint === undefined) {
          return publicInvalidProfileSelection();
        }
        try {
          const runtimeResumeIdentity =
            runtimeResumeIdentityResolver === undefined
              ? undefined
              : await runtimeResumeIdentityResolver(
                  projectDirectory,
                  selectedProfile,
                );
          if (
            runtimeResumeIdentityResolver !== undefined &&
            (runtimeResumeIdentity === undefined ||
              runtimeResumeIdentity.endpointId !== resolvedEndpoint.endpointId)
          ) {
            return publicUnavailableSubmission();
          }
          await continuationPlan.submit(
            Object.freeze({
              kind: "direct" as const,
              commandKind: "start" as const,
              idempotencyKey: randomUUID(),
              runtime: "codex" as const,
              catalogRevision: resolved.catalogRevision,
              preferences: Object.freeze({ global: selectedProfile }),
              profile: selectedProfile,
              requestedProfileProjection: resolved.requestedProfileProjection,
              ...(runtimeResumeIdentity === undefined
                ? {}
                : { runtimeResumeIdentity }),
              input: startRequest.input,
            }),
            Object.freeze({ endpointId: resolvedEndpoint.endpointId }),
            plan,
            continuationIntent,
          );
          if (activeSnapshot === snapshot) {
            activeSnapshot = undefined;
            activeSnapshotRecoveryCommandIds = undefined;
            activeContinuationCapability = undefined;
          }
          return publicSubmissionAccepted();
        } catch {
          return publicUnavailableSubmission();
        }
      });
      submissionTail = operation.then(
        () => undefined,
        () => undefined,
      );
      submissionPromises.add(operation);
      void operation.then(
        () => submissionPromises.delete(operation),
        () => submissionPromises.delete(operation),
      );
      return operation;
    },
    close(): Promise<void> {
      closing = true;
      continuationPlan.cancel();
      closePromise ??= (async () => {
        await Promise.all([...profileLoadPromises.values()]);
        await Promise.all([...preferenceSavePromises]);
        await Promise.all([...submissionPromises]);
        await Promise.allSettled([...sessionRemovalPromises]);
        await Promise.allSettled([...sessionMetadataPromises]);
        await Promise.allSettled([...interruptPromises]);
        await Promise.allSettled([...steerPromises]);
        activeSnapshot = undefined;
        activeSnapshotRecoveryCommandIds = undefined;
        activeContinuationCapability = undefined;
        await preferenceStore.close();
        await liveView.close();
        await channel.close();
        await continuationPlan.close();
      })();
      return closePromise;
    },
  }) as WorkbenchBackend;
}

function recoveryRequiredCommandIds(project: ProjectSnapshot): ReadonlySet<string> {
  return new Set(
    project.commands
      .filter((command) => command.status === "recovery-required")
      .map((command) => command.commandId),
  );
}

function hasNewRecoveryRequiredCommand(
  project: ProjectSnapshot,
  knownCommandIds: ReadonlySet<string>,
): boolean {
  return project.commands.some(
    (command) =>
      command.status === "recovery-required" &&
      !knownCommandIds.has(command.commandId),
  );
}

function createCatalogSnapshot(
  endpointSources: readonly WorkbenchDirectRuntimeEndpointCatalog[],
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery,
  preferences: DirectSessionProfilePreferenceSnapshot,
  includeLegacyGlobalPreferences: boolean,
): CatalogSnapshot {
  if (endpointSources.length === 0) throw new Error("invalid-endpoints");
  const prepared = endpointSources.map((source, endpointIndex) => {
    if (
      !isSafePreferenceEndpointKey(source.preferenceKey) ||
      !isSafeDisplayText(source.runtimeFamilyLabel, 160) ||
      !isSafeDisplayText(source.endpointLabel, 160) ||
      (source.directStart !== "supported" &&
        source.directStart !== "inspect-only")
    ) {
      throw new Error("invalid-endpoint-presentation");
    }
    const catalog = sanitizeCatalog(source.catalog);
    const catalogRevision = `catalog:${randomUUID()}`;
    const storedEndpoint = preferences.endpoints.find(
      (candidate) => candidate.endpointKey === source.preferenceKey,
    );
    const explicitPreference = storedEndpoint?.model !== undefined;
    const baseline =
      source.desiredDefault ?? firstAvailableProfile(catalog);
    let desiredProfile: SessionProfile | undefined;
    if (explicitPreference || source.desiredDefault !== undefined) {
      try {
        desiredProfile = resolveSessionProfile({
          catalog,
          catalogRevision,
          preferences: toResolverPreferences(
            preferences,
            source.preferenceKey,
            baseline,
            includeLegacyGlobalPreferences,
          ),
        }).profile;
      } catch {
        // An unavailable desired default is explicit and never downgraded.
      }
    }
    return Object.freeze({
      source,
      endpointIndex,
      catalog,
      catalogRevision,
      explicitPreference,
      desiredProfile,
    });
  });
  const desired =
    prepared.find(
      (candidate) =>
        candidate.explicitPreference && candidate.desiredProfile !== undefined,
    ) ??
    prepared.find((candidate) => candidate.desiredProfile !== undefined);
  const snapshot = createDirectSessionProfileSnapshot({
    endpoints: Object.freeze(
      prepared.map(({ source, catalog, catalogRevision }) =>
        Object.freeze({
          endpointId: source.endpointId,
          runtimeFamilyLabel: source.runtimeFamilyLabel,
          endpointLabel: source.endpointLabel,
          catalog,
          catalogRevision,
          executionModeLabels: Object.freeze(
            catalog.executionModes.map((mode) =>
              mode === "single-agent" ? "Single agent" : mode,
            ),
          ),
          accessModeLabels: Object.freeze(
            catalog.accessModes.map((mode) =>
              mode === "full-access"
                ? "Full access"
                : mode === "restricted"
                  ? "Restricted"
                  : mode,
            ),
          ),
        }),
      ),
    ),
    endpointDiscovery,
    ...(desired?.desiredProfile === undefined
      ? {}
      : {
          desiredDefault: Object.freeze({
            endpointIndex: desired.endpointIndex,
            profile: desired.desiredProfile,
          }),
        }),
  });
  return Object.freeze({
    value: snapshot,
    compatibilityRuntime: prepared[0]!.catalog.runtime,
    endpointPreferenceKeys: Object.freeze(
      prepared.map(({ source }) => source.preferenceKey),
    ),
    directStartByEndpoint: Object.freeze(
      prepared.map(({ source }) => source.directStart),
    ),
  });
}

interface ContinuationCatalogCandidate {
  readonly snapshot: CatalogSnapshot;
  readonly prefill: WorkbenchContinuationPrefill;
  readonly resolvedProfile: SessionProfile;
}

function resolveContinuationCatalogCandidate(options: {
  readonly endpointSources: readonly WorkbenchDirectRuntimeEndpointCatalog[];
  readonly preferences: DirectSessionProfilePreferenceSnapshot;
  readonly includeLegacyGlobalPreferences: boolean;
  readonly recordedProfile: SessionProfile;
}): ContinuationCatalogCandidate | undefined {
  const candidates: ContinuationCatalogCandidate[] = [];
  for (const source of options.endpointSources) {
    let snapshot: CatalogSnapshot;
    try {
      snapshot = createCatalogSnapshot(
        Object.freeze([source]),
        continuationEndpointDiscovery(source.endpointId),
        options.preferences,
        options.includeLegacyGlobalPreferences,
      );
    } catch {
      continue;
    }
    const prefill = snapshot.value.resolveReplacementPrefill(
      options.recordedProfile,
    );
    if (prefill.kind !== "resolved") continue;
    const resolved = snapshot.value.resolveSelection(
      Object.freeze({
        snapshotKey: snapshot.value.publicResult.profile.snapshotKey,
        endpointKey: prefill.endpointKey,
        modelKey: prefill.modelKey,
        workIntensityKey: prefill.workIntensityKey,
        executionModeKey: prefill.executionModeKey,
        accessModeKey: prefill.accessModeKey,
      }),
    );
    if (resolved === undefined) continue;
    candidates.push(
      Object.freeze({
        snapshot,
        prefill,
        resolvedProfile: resolved.profile,
      }),
    );
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function continuationEndpointDiscovery(
  endpointId: WorkbenchDirectRuntimeEndpointCatalog["endpointId"],
): WorkbenchRuntimeEndpointDiscovery {
  return publicSingleInspectedRuntimeEndpointDiscovery(
    endpointId,
    "catalog-ready",
  );
}

async function inspectLegacyRuntimeEndpoint(
  adapter: ResumableAgentRuntimeAdapter,
  projectDirectory: string,
  presentation: WorkbenchDirectEndpointPresentation,
): Promise<WorkbenchDirectRuntimeEndpointSnapshot> {
  try {
    const catalog = await adapter.inspect(projectDirectory);
    return Object.freeze({
      endpoints: Object.freeze([
        Object.freeze({
          endpointId: "codex-desktop" as const,
          preferenceKey: presentation.preferenceKey,
          runtimeFamilyLabel: presentation.runtimeFamilyLabel,
          endpointLabel: presentation.endpointLabel,
          catalog,
          desiredDefault: initialCodexProfile,
          directStart: "supported" as const,
        }),
      ]),
      endpointDiscovery: publicSingleInspectedRuntimeEndpointDiscovery(
        "codex-desktop",
        "catalog-ready",
      ),
    });
  } catch (error) {
    return Object.freeze({
      endpoints: Object.freeze([]),
      endpointDiscovery: publicSingleInspectedRuntimeEndpointDiscovery(
        "codex-desktop",
        legacyDiscoveryCategory(error),
      ),
    });
  }
}

function legacyDiscoveryCategory(
  error: unknown,
): Extract<
  WorkbenchRuntimeEndpointDiscoveryCategory,
  "authentication-required" | "inspection-failed" | "runtime-not-located"
> {
  if (error instanceof RuntimeAdapterError) {
    if (error.category === "runtime-not-located") {
      return "runtime-not-located";
    }
    if (error.category === "authentication-required") {
      return "authentication-required";
    }
  }
  return "inspection-failed";
}

function profileLoadFailureForDiscovery(
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery,
): WorkbenchAnyDirectSessionProfileResult {
  const coherentDiscovery = downgradeCatalogReadyDiscovery(endpointDiscovery);
  return coherentDiscovery.statuses.every(
    (status) => status.category === "runtime-not-located",
  )
    ? publicRuntimeNotLocated(coherentDiscovery)
    : publicProfileUnavailable(coherentDiscovery);
}

function downgradeCatalogReadyDiscovery(
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery,
): WorkbenchRuntimeEndpointDiscovery {
  return publicRuntimeEndpointDiscovery(
    endpointDiscovery.statuses.map((status) => ({
      endpointId: status.endpointId,
      category:
        status.category === "catalog-ready"
          ? ("inspection-failed" as const)
          : status.category,
    })),
  );
}

function firstAvailableProfile(catalog: DirectSessionProfileCatalog): SessionProfile {
  return Object.freeze({
    model: catalog.models[0]!.id,
    effortLevel: catalog.models[0]!.effortLevels[0]!,
    executionMode: catalog.executionModes[0]!,
    accessMode: catalog.accessModes[0]!,
  });
}

function toBackendProfileResult(
  snapshot: CatalogSnapshot,
): Extract<WorkbenchCatalogDefaultProfileResult, { readonly ok: true }> {
  const publicProfile = snapshot.value.publicResult.profile;
  const profile = {
    snapshotKey: publicProfile.snapshotKey,
    endpoints: publicProfile.endpoints,
    desiredDefault: publicProfile.desiredDefault,
  } as WorkbenchBackendDirectSessionProfile;
  defineBackendProfileCompatibility(profile, snapshot);
  return Object.freeze({
    ok: true as const,
    endpointDiscovery: snapshot.value.publicResult.endpointDiscovery,
    profile: Object.freeze(profile),
  });
}

function toBackendReplacementProfileResult(
  snapshot: CatalogSnapshot,
  replacementPrefill: WorkbenchReplacementPrefill,
): Extract<WorkbenchReplacementSessionProfileResult, { readonly ok: true }> {
  const publicProfile = snapshot.value.publicResult.profile;
  const profile = {
    snapshotKey: publicProfile.snapshotKey,
    endpoints: publicProfile.endpoints,
    replacementPrefill,
  } as WorkbenchBackendReplacementDirectSessionProfile;
  defineBackendProfileCompatibility(profile, snapshot);
  return Object.freeze({
    ok: true as const,
    endpointDiscovery: snapshot.value.publicResult.endpointDiscovery,
    profile: Object.freeze(profile),
  });
}

function toBackendContinuationProfileResult(
  snapshot: CatalogSnapshot,
  continuationPrefill: WorkbenchContinuationPrefill,
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery,
): Extract<WorkbenchContinuationSessionProfileResult, { readonly ok: true }> {
  const publicProfile = snapshot.value.publicResult.profile;
  const endpoint = publicProfile.endpoints[0];
  if (endpoint === undefined || publicProfile.endpoints.length !== 1) {
    throw new Error("invalid-continuation-endpoint");
  }
  const profile = {
    snapshotKey: publicProfile.snapshotKey,
    endpoints: Object.freeze([endpoint] as const),
    continuationPrefill,
  } as WorkbenchBackendContinuationDirectSessionProfile;
  defineBackendProfileCompatibility(profile, snapshot);
  return Object.freeze({
    ok: true as const,
    endpointDiscovery,
    profile: Object.freeze(profile),
  });
}

function defineBackendProfileCompatibility(
  profile:
    | WorkbenchBackendDirectSessionProfile
    | WorkbenchBackendReplacementDirectSessionProfile
    | WorkbenchBackendContinuationDirectSessionProfile,
  snapshot: CatalogSnapshot,
): void {
  const endpoint = profile.endpoints[0];
  if (endpoint === undefined) throw new Error("invalid-endpoint-catalog");
  Object.defineProperties(profile, {
    runtime: Object.freeze({
      value: snapshot.compatibilityRuntime,
      enumerable: false,
    }),
    models: Object.freeze({
      value: endpoint.models,
      enumerable: false,
    }),
    executionMode: Object.freeze({
      value: Object.freeze({
        value: "single-agent" as const,
        label: endpoint.executionModes[0]?.label ?? "Single agent",
        fixed: true as const,
      }),
      enumerable: false,
    }),
    accessMode: Object.freeze({
      value: Object.freeze({
        value: "full-access" as const,
        label: endpoint.accessModes[0]?.label ?? "Full access",
        fixed: true as const,
        independent: true as const,
      }),
      enumerable: false,
    }),
  });
}

function samePrivateProfile(left: SessionProfile, right: SessionProfile): boolean {
  return (
    left.model === right.model &&
    left.effortLevel === right.effortLevel &&
    left.executionMode === right.executionMode &&
    left.accessMode === right.accessMode
  );
}

function continuationEndpointId(
  mappings: readonly {
    readonly endpointId: WorkbenchDirectRuntimeEndpointCatalog["endpointId"];
    readonly selectionProfile: SessionProfile;
  }[],
  recordedProfile: SessionProfile,
): WorkbenchDirectRuntimeEndpointCatalog["endpointId"] | undefined {
  const matching = mappings.find((mapping) =>
    samePrivateProfile(mapping.selectionProfile, recordedProfile),
  );
  const anchor = matching ?? mappings[0];
  if (
    anchor === undefined ||
    mappings.some((mapping) => mapping.endpointId !== anchor.endpointId)
  ) {
    return undefined;
  }
  return anchor.endpointId;
}

function completeLegacyDefaultRequest(
  request: unknown,
  snapshot: CatalogSnapshot,
): WorkbenchDirectSessionProfileDefaultRequest | undefined {
  try {
    if (
      !isRecord(request) ||
      Object.keys(request).sort().join("\0") !==
        ["modelKey", "snapshotKey", "workIntensityKey"].sort().join("\0") ||
      typeof request.snapshotKey !== "string" ||
      typeof request.modelKey !== "string" ||
      typeof request.workIntensityKey !== "string"
    ) {
      return undefined;
    }
    const publicProfile = snapshot.value.publicResult.profile;
    const matches = publicProfile.endpoints.filter((endpoint) =>
      endpoint.models.some(
        (model) =>
          model.key === request.modelKey &&
          model.workIntensities.some(
            (intensity) => intensity.key === request.workIntensityKey,
          ),
      ),
    );
    const endpoint = matches.length === 1 ? matches[0] : undefined;
    const model = endpoint?.models.find(
      (candidate) => candidate.key === request.modelKey,
    );
    const intensity = model?.workIntensities.find(
      (candidate) => candidate.key === request.workIntensityKey,
    );
    const executionMode =
      intensity?.impliedExecutionModeKey === undefined
        ? endpoint?.executionModes[0]
        : endpoint?.executionModes.find(
            (candidate) =>
              candidate.key === intensity.impliedExecutionModeKey,
          );
    const accessMode = endpoint?.accessModes[0];
    if (
      endpoint === undefined ||
      executionMode === undefined ||
      accessMode === undefined
    ) {
      return undefined;
    }
    return Object.freeze({
      snapshotKey: request.snapshotKey,
      endpointKey: endpoint.key,
      modelKey: request.modelKey,
      workIntensityKey: request.workIntensityKey,
      executionModeKey: executionMode.key,
      accessModeKey: accessMode.key,
    });
  } catch {
    return undefined;
  }
}

function toResolverPreferences(
  preferences: DirectSessionProfilePreferenceSnapshot,
  endpointPreferenceKey: string,
  baseline: SessionProfile,
  includeLegacyGlobalPreferences: boolean,
) {
  const endpoint = preferences.endpoints.find(
    (candidate) => candidate.endpointKey === endpointPreferenceKey,
  );
  const models = Object.fromEntries(
    (endpoint?.models ?? []).map((entry) => [
      entry.model,
      Object.freeze({ effortLevel: entry.workIntensity }),
    ]),
  );
  return Object.freeze({
    global: Object.freeze({
      ...baseline,
      ...(!includeLegacyGlobalPreferences ||
      preferences.global.model === undefined
        ? {}
        : { model: preferences.global.model }),
      ...(!includeLegacyGlobalPreferences ||
      preferences.global.workIntensity === undefined
        ? {}
        : { effortLevel: preferences.global.workIntensity }),
    }),
    ...(endpoint?.model === undefined
      ? {}
      : { runtime: Object.freeze({ model: endpoint.model }) }),
    ...(endpoint === undefined || endpoint.models.length === 0
      ? {}
      : { models: Object.freeze(models) }),
  });
}

function isSafePreferenceEndpointKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function sanitizeCatalog(value: unknown): DirectSessionProfileCatalog {
  if (
    !isRecord(value) ||
    !hasExactRecordShape(
      value,
      ["runtime", "models", "executionModes", "accessModes"],
      ["workIntensityExecutionModeCouplings"],
    ) ||
    !isSafeLabel(value.runtime, 80)
  ) {
    throw new Error("invalid-catalog");
  }
  if (
    !hasOnlyArrayEntries(value.models) ||
    value.models.length === 0 ||
    !isStringArray(value.executionModes) ||
    !isStringArray(value.accessModes) ||
    value.executionModes.length === 0 ||
    !value.executionModes.includes("single-agent") ||
    !value.accessModes.includes("full-access")
  ) {
    throw new Error("invalid-catalog");
  }
  const executionModes: string[] = [];
  const seenExecutionModes = new Set<string>();
  for (const executionMode of value.executionModes) {
    if (
      !isSafeLabel(executionMode, 80) ||
      seenExecutionModes.has(executionMode)
    ) {
      throw new Error("invalid-catalog");
    }
    seenExecutionModes.add(executionMode);
    executionModes.push(executionMode);
  }
  const models: RuntimeModel[] = [];
  const modelIds = new Set<string>();
  for (const candidate of value.models) {
    if (
      !isRecord(candidate) ||
      !hasExactRecordShape(
        candidate,
        ["id", "effortLevels"],
        [
          "resolvedModel",
          "displayName",
          "workIntensityLabel",
          "effortLevelLabels",
        ],
      ) ||
      !hasOnlyArrayEntries(candidate.effortLevels)
    ) {
      throw new Error("invalid-catalog");
    }
    if (!isSafeLabel(candidate.id, 80)) throw new Error("invalid-catalog");
    if (
      candidate.resolvedModel !== undefined &&
      !isSafeDisplayText(candidate.resolvedModel, 160)
    ) {
      throw new Error("invalid-catalog");
    }
    if (
      candidate.displayName !== undefined &&
      !isSafeDisplayText(candidate.displayName, 160)
    ) {
      throw new Error("invalid-catalog");
    }
    if (
      candidate.workIntensityLabel !== undefined &&
      !isSafeDisplayText(candidate.workIntensityLabel, 160)
    ) {
      throw new Error("invalid-catalog");
    }
    if (
      candidate.effortLevelLabels !== undefined &&
      (!hasOnlyArrayEntries(candidate.effortLevelLabels) ||
        candidate.effortLevelLabels.length !== candidate.effortLevels.length)
    ) {
      throw new Error("invalid-catalog");
    }
    if (
      candidate.effortLevels.length === 0 ||
      modelIds.has(candidate.id)
    ) {
      throw new Error("invalid-catalog");
    }
    const effortLevels: string[] = [];
    const effortLevelLabels: (string | null)[] = [];
    const efforts = new Set<string>();
    for (const [effortIndex, effort] of candidate.effortLevels.entries()) {
      if (!isSafeLabel(effort, 32)) throw new Error("invalid-catalog");
      if (efforts.has(effort)) throw new Error("invalid-catalog");
      const displayLabel = candidate.effortLevelLabels?.[effortIndex];
      if (
        displayLabel !== undefined &&
        displayLabel !== null &&
        !isSafeDisplayText(displayLabel, 240)
      ) {
        throw new Error("invalid-catalog");
      }
      efforts.add(effort);
      effortLevels.push(effort);
      effortLevelLabels.push(displayLabel ?? null);
    }
    if (effortLevels.length === 0) continue;
    modelIds.add(candidate.id);
    models.push(
      Object.freeze({
        id: candidate.id,
        ...(typeof candidate.resolvedModel === "string"
          ? { resolvedModel: candidate.resolvedModel }
          : {}),
        ...(typeof candidate.displayName === "string"
          ? { displayName: candidate.displayName }
          : {}),
        effortLevels: Object.freeze(effortLevels),
        ...(candidate.effortLevelLabels === undefined
          ? {}
          : { effortLevelLabels: Object.freeze(effortLevelLabels) }),
        ...(typeof candidate.workIntensityLabel === "string"
          ? { workIntensityLabel: candidate.workIntensityLabel }
          : {}),
      }),
    );
  }
  if (models.length === 0) throw new Error("invalid-catalog");
  const workIntensityExecutionModeCouplings: WorkIntensityExecutionModeCoupling[] = [];
  const coupledIntensities = new Set<string>();
  const hasWorkIntensityExecutionModeCouplings = Object.prototype.hasOwnProperty.call(
    value,
    "workIntensityExecutionModeCouplings",
  );
  if (hasWorkIntensityExecutionModeCouplings) {
    if (
      !hasOnlyArrayEntries(value.workIntensityExecutionModeCouplings) ||
      value.workIntensityExecutionModeCouplings.length > 1_000
    ) {
      throw new Error("invalid-catalog");
    }
    for (const declaration of value.workIntensityExecutionModeCouplings) {
      if (
        !isRecord(declaration) ||
        !hasExactRecordShape(declaration, [
          "model",
          "workIntensity",
          "executionMode",
        ]) ||
        !isSafeLabel(declaration.model, 80) ||
        !isSafeLabel(declaration.workIntensity, 32) ||
        !isSafeLabel(declaration.executionMode, 80)
      ) {
        throw new Error("invalid-catalog");
      }
      const model = models.find(
        (candidate) => candidate.id === declaration.model,
      );
      const key = `${declaration.model}\u0000${declaration.workIntensity}`;
      if (
        model === undefined ||
        !model.effortLevels.includes(declaration.workIntensity) ||
        !executionModes.includes(declaration.executionMode) ||
        coupledIntensities.has(key)
      ) {
        throw new Error("invalid-catalog");
      }
      coupledIntensities.add(key);
      workIntensityExecutionModeCouplings.push(
        Object.freeze({
          model: declaration.model,
          workIntensity: declaration.workIntensity,
          executionMode: declaration.executionMode,
        }),
      );
    }
  }
  return deepFreeze({
    runtime: value.runtime,
    models,
    executionModes,
    accessModes: ["full-access"],
    ...(!hasWorkIntensityExecutionModeCouplings
      ? {}
      : {
          workIntensityExecutionModeCouplings: Object.freeze(
            workIntensityExecutionModeCouplings,
          ),
        }),
  });
}

function isSafeDisplayText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    [...value].length <= maximumLength &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.includes("\\") &&
    !value.includes("://") &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function isSafeLabel(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9][A-Za-z0-9 .+_-]*$/u.test(value)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    hasOnlyArrayEntries(value) &&
    value.every((candidate) => typeof candidate === "string")
  );
}

function hasExactRecordShape(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Reflect.ownKeys(value);
  return (
    requiredKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

function hasOnlyArrayEntries(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (key === "length") return true;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      return false;
    }
    const index = Number(key);
    return Number.isSafeInteger(index) && index < value.length;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
