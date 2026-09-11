import { randomUUID } from "node:crypto";
import type { WorkbenchUserInputBridge, WorkbenchUserInputReadRequest, WorkbenchUserInputResponse, WorkbenchUserInputResult, WorkbenchUserInputResponseResult } from "./contract.ts";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import type { AgentRuntimeAdapter } from "../agent-runtime/index.ts";
import type { ProjectTurnActivity } from "../coordinator/index.ts";
import type { WorkLedgerAuthGenerationModule } from "../coordinator/index.ts";
import {
  createWorkbenchBackend,
  type WorkbenchBackend,
} from "./backend.ts";
import {
  publicEmptyProjectRegistry,
  publicInvalidProjectSelection,
  publicInterruptUnavailable,
  publicSteerUnavailable,
  publicHostedProjectFailure,
  publicPreferenceUnavailable,
  publicProfileUnavailable,
  publicProjectFailure,
  publicProjectHistorySelectionRequired,
  publicProjectSelected,
  publicProjectSelectedWithExistingHistory,
  publicProjectDriveRootRefused,
  publicProjectSwitchUnavailable,
  publicProjectUnavailable,
  publicUnavailableSubmission,
  type WorkbenchDirectInputRequest,
  type WorkbenchDirectSessionProfileDefaultRequest,
  type WorkbenchDirectSessionProfileDefaultResult,
  type WorkbenchDirectSessionProfileLoadRequest,
  type WorkbenchDirectSessionProfileResult,
  type WorkbenchDirectSessionProfileResultFor,
  type WorkbenchHostedProjectListener,
  type WorkbenchHostedProjectResult,
  type WorkbenchInterruptRequest,
  type WorkbenchInterruptResult,
  type WorkbenchSteerRequest,
  type WorkbenchSteerResult,
  type WorkbenchProjectAvailability,
  type WorkbenchProjectHistoryAdoptionRequest,
  type WorkbenchProjectHistoryAdoptionResult,
  type WorkbenchProjectHistoryDiscoveryResult,
  type WorkbenchProjectHistoryHideRequest,
  type WorkbenchProjectHistoryHideResult,
  type WorkbenchProjectHistoryOption,
  type WorkbenchProjectHistorySnapshot,
  type WorkbenchProjectListener,
  type WorkbenchProjectOption,
  type WorkbenchProjectResult,
  type WorkbenchProjectSelectionRequest,
  type WorkbenchProjectSelectionResult,
  type WorkbenchProjectRemovalResult,
  type WorkbenchSessionMetadataMutationRequest,
  type WorkbenchSessionMetadataMutationResult,
  type WorkbenchSessionRemovalRequest,
  type WorkbenchSessionRemovalResult,
  type WorkbenchSubmissionResult,
} from "./contract.ts";
import { deriveProjectLabel } from "./live-view.ts";
import {
  discoverProjectLedgers,
  projectDirectoryDigest,
  type DiscoveredProjectLedger,
} from "./project-ledger-discovery.ts";
import {
  openProjectHistoryHideStore,
  type ProjectHistoryHideStore,
} from "./project-history-hides.ts";
import {
  reconstructWorkbenchProjectHistoryAdoptionRequest,
  reconstructWorkbenchProjectHistoryHideRequest,
  reconstructWorkbenchProjectSelectionRequest,
  reconstructWorkbenchSessionMetadataMutationRequest,
  reconstructWorkbenchSessionRemovalRequest,
} from "./result-sanitizer.ts";

const registrySchemaVersion = 1;
const maximumRegistryBytes = 256 * 1024;
const maximumRegistryRecords = 1_000;
const maximumRegistryRevision = Number.MAX_SAFE_INTEGER - 1;
const registryFileName = "project-registry-v1.json";
const registryReplacementName = "project-registry-v1.replacement";
const registryBackupName = "project-registry-v1.backup";
const ledgerDirectoryName = "project-ledgers";
const projectAvailabilityProbeTimeoutMilliseconds = 5_000;
const recordKeyPattern =
  /^project-record-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ledgerSlotPattern =
  /^project-ledger-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Matches the public discovery-snapshot ceiling the sanitizer enforces. */
const maximumDiscoveredHistories = 100;

type PrivateProjectRecord = {
  readonly recordKey: string;
  readonly canonicalDirectory: string;
  readonly ledgerSlot: string;
};

type PrivateProjectRegistry = {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly nextProjectOrdinal: number;
  readonly selectedRecordKey: string | null;
  readonly records: readonly PrivateProjectRecord[];
};

type ActiveProject = {
  readonly record: PrivateProjectRecord;
  readonly backend: WorkbenchBackend;
  disposeObservation: () => void;
};

/** What one rotating history key stands for at the host's private seam. */
type PrivateHistoryTarget =
  | {
      readonly kind: "registered";
      readonly recordKey: string;
      readonly ledgerSlot: string;
    }
  | {
      readonly kind: "registration";
      readonly canonicalDirectory: string;
      readonly ledgerSlot: string;
    };

type FirstProjectionCompletion = {
  readonly generation: number;
  readonly promise: Promise<boolean>;
  complete(successful: boolean): void;
};

export type WorkbenchProjectBackendFactory = (options: {
  readonly projectDirectory: string;
  readonly databasePath: string;
  readonly preferencePath: string;
  readonly adapter?: AgentRuntimeAdapter;
  readonly authGeneration?: WorkLedgerAuthGenerationModule;
}) => Promise<WorkbenchBackend>;

export type WorkbenchProjectAvailabilityProbe = (
  canonicalDirectory: string,
) => Promise<WorkbenchProjectAvailability>;

export type WorkbenchProjectRegistryAtomicReplace = (
  replacementPath: string,
  destinationPath: string,
) => Promise<void>;

export interface WorkbenchProjectHost extends WorkbenchUserInputBridge {
  observeProject(listener: WorkbenchHostedProjectListener): () => void;
  readTurnActivity(): ProjectTurnActivity;
  removeSession(
    request: WorkbenchSessionRemovalRequest,
  ): Promise<WorkbenchSessionRemovalResult>;
  mutateSessionMetadata(
    request: WorkbenchSessionMetadataMutationRequest,
  ): Promise<WorkbenchSessionMetadataMutationResult>;
  registerTrustedProject(
    directory: string,
  ): Promise<WorkbenchProjectSelectionResult>;
  selectProject(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectSelectionResult>;
  removeProject(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectRemovalResult>;
  /**
   * Every recorded conversation history that belongs to the chosen Project's
   * directory, attributed by the digest each ledger stores about itself. Purely
   * read-only: no ledger is opened for writing and nothing is registered.
   */
  discoverProjectHistories(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectHistoryDiscoveryResult>;
  /**
   * Points the Project Registry at a discovered history and opens it. No ledger
   * file is written, copied, moved, merged or deleted, so every unchosen history
   * stays on disk, stays discoverable, and can be adopted later.
   */
  adoptProjectHistory(
    request: WorkbenchProjectHistoryAdoptionRequest,
  ): Promise<WorkbenchProjectHistoryAdoptionResult>;
  /**
   * Records a non-current, zero-Session ledger as hidden. The ledger remains
   * byte-for-byte in place and becomes visible again automatically if it ever
   * contains a recorded Session.
   */
  hideProjectHistory(
    request: WorkbenchProjectHistoryHideRequest,
  ): Promise<WorkbenchProjectHistoryHideResult>;
  loadDirectSessionProfile<
    Request extends WorkbenchDirectSessionProfileLoadRequest,
  >(
    request: Request,
  ): Promise<WorkbenchDirectSessionProfileResultFor<Request>>;
  useDirectSessionProfileAsDefault(
    request: WorkbenchDirectSessionProfileDefaultRequest,
  ): Promise<WorkbenchDirectSessionProfileDefaultResult>;
  submitDirectInput(
    request: WorkbenchDirectInputRequest,
  ): Promise<WorkbenchSubmissionResult>;
  interruptActiveTurn(
    request: WorkbenchInterruptRequest,
  ): Promise<WorkbenchInterruptResult>;
  steerActiveTurn(
    request: WorkbenchSteerRequest,
  ): Promise<WorkbenchSteerResult>;
  close(): Promise<void>;
}

export type { WorkbenchProjectRemovalResult } from "./contract.ts";

export async function createWorkbenchProjectHost(options: {
  readonly dataDirectory: string;
  readonly fallbackProjectDirectory: string;
  readonly startupProjectDirectory?: string;
  readonly adapter?: AgentRuntimeAdapter;
  readonly preferencePath?: string;
  readonly backendFactory?: WorkbenchProjectBackendFactory;
  readonly availabilityProbe?: WorkbenchProjectAvailabilityProbe;
  /** May shorten the production deadline for a deterministic test, never extend it. */
  readonly availabilityProbeTimeoutMilliseconds?: number;
  readonly atomicReplace?: WorkbenchProjectRegistryAtomicReplace;
  readonly authGeneration?: WorkLedgerAuthGenerationModule;
}): Promise<WorkbenchProjectHost> {
  const dataDirectory = canonicalDirectory(options.dataDirectory);
  const paths = registryPaths(dataDirectory);
  const backendFactory = options.backendFactory ?? defaultBackendFactory;
  const availabilityProbe = boundedProjectAvailabilityProbe(
    options.availabilityProbe ?? defaultAvailabilityProbe,
    resolveAvailabilityProbeTimeoutMilliseconds(
      options.availabilityProbeTimeoutMilliseconds,
    ),
  );
  const atomicReplace = options.atomicReplace ?? rename;
  const preferencePath =
    options.preferencePath ??
    join(dataDirectory, "direct-session-profile-preferences.json");
  const historyHides = await openProjectHistoryHideStore(dataDirectory);
  const opened = await openRegistry(paths).catch(
    () => Object.freeze({ ok: false as const }),
  );
  if (!opened.ok) {
    return createHostController({
      paths,
      registry: undefined,
      active: undefined,
      backendFactory,
      availabilityProbe,
      atomicReplace,
      adapter: options.adapter,
      authGeneration: options.authGeneration,
      historyHides,
      preferencePath,
      teardownBlocked: false,
    });
  }

  let registry = opened.registry;
  let active: ActiveProject | undefined;
  let bootstrapTeardownBlocked = false;
  const startupDirectory = options.startupProjectDirectory;
  if (startupDirectory !== undefined) {
    const prepared = prepareUnambiguousRegistration(
      paths,
      registry,
      startupDirectory,
    );
    if (
      prepared !== undefined &&
      (await probeProjectAvailability(
        availabilityProbe,
        prepared.record.canonicalDirectory,
      )) ===
        "available"
    ) {
      const candidate = await openBackend(
        prepared.record,
        dataDirectory,
        preferencePath,
        options.adapter,
        backendFactory,
        options.authGeneration,
      ).catch(() => undefined);
      if (candidate !== undefined) {
        if (
          prepared.changed &&
          !(await writeRegistry(
            paths,
            registry,
            prepared.registry,
            atomicReplace,
          ))
        ) {
          try {
            await candidate.close();
          } catch {
            bootstrapTeardownBlocked = true;
            active = {
              record: prepared.record,
              backend: candidate,
              disposeObservation: () => undefined,
            };
          }
        } else {
          registry = prepared.registry;
          active = {
            record: prepared.record,
            backend: candidate,
            disposeObservation: () => undefined,
          };
        }
      }
    }
  } else {
    const selected = selectedRecord(registry);
    if (selected !== undefined) {
      if (
        (await probeProjectAvailability(
          availabilityProbe,
          selected.canonicalDirectory,
        )) === "available"
      ) {
        const backend = await openBackend(
          selected,
          dataDirectory,
          preferencePath,
          options.adapter,
          backendFactory,
          options.authGeneration,
        ).catch(() => undefined);
        if (backend !== undefined) {
          active = {
            record: selected,
            backend,
            disposeObservation: () => undefined,
          };
        }
      }
    } else if (registry.records.length === 0 && !opened.stateExisted) {
      const prepared = prepareUnambiguousRegistration(
        paths,
        registry,
        options.fallbackProjectDirectory,
      );
      if (
        prepared !== undefined &&
        (await probeProjectAvailability(
          availabilityProbe,
          prepared.record.canonicalDirectory,
        )) ===
          "available"
      ) {
        const backend = await openBackend(
          prepared.record,
          dataDirectory,
          preferencePath,
          options.adapter,
          backendFactory,
          options.authGeneration,
        ).catch(() => undefined);
        if (backend !== undefined) {
          if (
            await writeRegistry(
              paths,
              registry,
              prepared.registry,
              atomicReplace,
            )
          ) {
            registry = prepared.registry;
            active = {
              record: prepared.record,
              backend,
              disposeObservation: () => undefined,
            };
          } else {
            try {
              await backend.close();
            } catch {
              bootstrapTeardownBlocked = true;
              active = {
                record: prepared.record,
                backend,
                disposeObservation: () => undefined,
              };
            }
          }
        }
      }
    }
  }

  if (
    active === undefined &&
    !bootstrapTeardownBlocked &&
    startupDirectory !== undefined
  ) {
    const prior = selectedRecord(registry);
    if (
      prior !== undefined &&
      (await probeProjectAvailability(
        availabilityProbe,
        prior.canonicalDirectory,
      )) === "available"
    ) {
      const restored = await openBackend(
        prior,
        dataDirectory,
        preferencePath,
        options.adapter,
        backendFactory,
        options.authGeneration,
      ).catch(() => undefined);
      if (restored !== undefined) {
        active = {
          record: prior,
          backend: restored,
          disposeObservation: () => undefined,
        };
      }
    }
  }

  return createHostController({
    paths,
    registry,
    active,
    backendFactory,
    availabilityProbe,
    atomicReplace,
    adapter: options.adapter,
    authGeneration: options.authGeneration,
    historyHides,
    preferencePath,
    teardownBlocked: bootstrapTeardownBlocked,
  });
}

function createHostController(options: {
  readonly paths: RegistryPaths;
  readonly registry: PrivateProjectRegistry | undefined;
  readonly active: ActiveProject | undefined;
  readonly backendFactory: WorkbenchProjectBackendFactory;
  readonly availabilityProbe: WorkbenchProjectAvailabilityProbe;
  readonly atomicReplace: WorkbenchProjectRegistryAtomicReplace;
  readonly adapter?: AgentRuntimeAdapter;
  readonly authGeneration?: WorkLedgerAuthGenerationModule;
  readonly historyHides: ProjectHistoryHideStore;
  readonly preferencePath: string;
  readonly teardownBlocked: boolean;
}): WorkbenchProjectHost {
  let registry = options.registry;
  let active = options.active;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let generation = 0;
  let pendingActions = 0;
  let switching = false;
  let teardownBlocked = options.teardownBlocked;
  let lastResult: WorkbenchHostedProjectResult | undefined;
  let selectionRecords = new Map<string, PrivateProjectRecord>();
  // History keys rotate with the discovery that minted them, exactly as
  // selection keys rotate with the Project snapshot. A key from an earlier
  // discovery names nothing and therefore authorises nothing.
  const historyRecords = new Map<string, PrivateHistoryTarget>();
  const listeners = new Set<WorkbenchHostedProjectListener>();
  const userInputListeners = new Set<() => void>();
  const publishUserInput = () => {
    for (const listener of userInputListeners) {
      try { listener(); } catch { userInputListeners.delete(listener); }
    }
  };
  const actionPromises = new Set<Promise<unknown>>();
  let switchPromise: Promise<unknown> | undefined;
  let projectionTail: Promise<void> = Promise.resolve();
  let pendingTargetProjection: FirstProjectionCompletion | undefined;

  const advanceGeneration = (): number => {
    generation += 1;
    // A superseded generation may still be waiting on an availability probe.
    // Its generation checks make it inert; the new authoritative projection
    // must not queue behind it.
    projectionTail = Promise.resolve();
    return generation;
  };

  const emit = (
    listener: WorkbenchHostedProjectListener,
    result: WorkbenchHostedProjectResult,
  ): void => {
    try {
      listener(result);
    } catch {
      listeners.delete(listener);
    }
  };

  const publish = (result: WorkbenchHostedProjectResult): void => {
    if (closed) return;
    lastResult = deepFreeze(result);
    for (const listener of [...listeners]) emit(listener, lastResult);
  };

  const publishEmptyRegistry = (
    observedGeneration: number,
    firstProjection?: FirstProjectionCompletion,
  ): void => {
    const successful =
      !closed &&
      observedGeneration === generation &&
      registry?.records.length === 0;
    if (successful) {
      selectionRecords.clear();
      publish(publicEmptyProjectRegistry());
    }
    if (firstProjection?.generation === observedGeneration) {
      firstProjection.complete(successful);
    }
  };

  const projectResult = (
    result: WorkbenchProjectResult,
    observedGeneration: number,
    firstProjection?: FirstProjectionCompletion,
  ): void => {
    let successful = false;
    const projection = projectionTail
      .catch(() => undefined)
      .then(async () => {
        if (closed || observedGeneration !== generation) return;
        if (!result.ok || registry === undefined) {
          publish(publicHostedProjectFailure());
          return;
        }
        const projected = await projectSelectionSnapshot(
          registry,
          options.availabilityProbe,
        );
        if (closed || observedGeneration !== generation) return;
        selectionRecords = projected.selectionRecords;
        publish({
          ok: true,
          view: deepFreeze({
            ...result.view,
            projectSelection: projected.snapshot,
          }),
        });
        successful = true;
      })
      .catch(() => {
        if (!closed && observedGeneration === generation) {
          publish(publicHostedProjectFailure());
        }
      })
      .finally(() => {
        if (firstProjection?.generation === observedGeneration) {
          firstProjection.complete(successful);
        }
      });
    projectionTail = projection;
  };

  const attachObservation = (
    opened: ActiveProject,
    firstProjection?: FirstProjectionCompletion,
  ): void => {
    const observedGeneration = generation;
    const listener: WorkbenchProjectListener = (result) =>
      projectResult(result, observedGeneration, firstProjection);
    try {
      const disposeProject = opened.backend.observeProject(listener);
      const disposeUserInput = opened.backend.observeUserInput?.(() => {
        if (!closed && active === opened) publishUserInput();
      });
      opened.disposeObservation = () => { disposeProject(); disposeUserInput?.(); };
      publishUserInput();
    } catch {
      projectResult(
        publicProjectFailure(),
        observedGeneration,
        firstProjection,
      );
    }
  };

  if (teardownBlocked) {
    projectResult(publicProjectFailure(), generation);
  } else if (active !== undefined) {
    attachObservation(active);
  } else if (registry !== undefined) {
    if (registry.records.length === 0) {
      publishEmptyRegistry(generation);
    } else {
      const selected = selectedRecord(registry);
      if (selected === undefined) {
        projectResult(publicProjectFailure(), generation);
      } else {
        projectResult(
          {
            ok: true,
            view: {
              project: { label: deriveProjectLabel(selected.canonicalDirectory) },
              observation: { cursor: 0, live: true },
              commands: [],
              initialSelectionKey: null,
            },
          },
          generation,
        );
      }
    }
  } else {
    projectResult(publicProjectFailure(), generation);
  }

  const closeActiveProject = async (): Promise<boolean> => {
    const closing = active;
    active = undefined;
    publishUserInput();
    if (closing === undefined) return true;
    try {
      closing.disposeObservation();
    } catch {
      // The backend close below remains the authoritative teardown gate.
    }
    try {
      await closing.backend.close();
      return true;
    } catch {
      teardownBlocked = true;
      active = closing;
      publish(publicHostedProjectFailure());
      return false;
    }
  };

  const closeUnpublishedCandidate = async (
    record: PrivateProjectRecord,
    backend: WorkbenchBackend,
  ): Promise<boolean> => {
    try {
      await backend.close();
      return true;
    } catch {
      teardownBlocked = true;
      active = {
        record,
        backend,
        disposeObservation: () => undefined,
      };
      publish(publicHostedProjectFailure());
      return false;
    }
  };

  const reopenPriorProject = async (
    priorRecord: PrivateProjectRecord | undefined,
    firstProjection?: FirstProjectionCompletion,
  ): Promise<void> => {
    if (
      closed ||
      teardownBlocked ||
      priorRecord === undefined ||
      (await probeProjectAvailability(
        options.availabilityProbe,
        priorRecord.canonicalDirectory,
      )) !==
        "available"
    ) {
      if (firstProjection !== undefined) {
        if (closed) firstProjection.complete(false);
        else projectResult(publicProjectFailure(), generation, firstProjection);
      } else if (!closed) {
        publish(publicHostedProjectFailure());
      }
      return;
    }
    const restored = await openBackend(
      priorRecord,
      options.paths.dataDirectory,
      options.preferencePath,
      options.adapter,
      options.backendFactory,
      options.authGeneration,
    ).catch(() => undefined);
    if (restored === undefined || closed) {
      await restored?.close().catch(() => undefined);
      if (firstProjection !== undefined) {
        if (closed) firstProjection.complete(false);
        else projectResult(publicProjectFailure(), generation, firstProjection);
      } else if (!closed) {
        publish(publicHostedProjectFailure());
      }
      return;
    }
    active = {
      record: priorRecord,
      backend: restored,
      disposeObservation: () => undefined,
    };
    attachObservation(active, firstProjection);
  };

  const switchToPrepared = (prepared: {
    readonly registry: PrivateProjectRegistry;
    readonly record: PrivateProjectRecord;
    readonly changed: boolean;
  }): Promise<WorkbenchProjectSelectionResult> => {
    if (
      closed ||
      switching ||
      teardownBlocked ||
      pendingActions > 0 ||
      registry === undefined
    ) {
      return Promise.resolve(publicProjectSwitchUnavailable());
    }
    if (
      active?.record.recordKey === prepared.record.recordKey &&
      !prepared.changed &&
      lastResult?.ok === true
    ) {
      return Promise.resolve(publicProjectSelected());
    }

    switching = true;
    const operation = (async (): Promise<WorkbenchProjectSelectionResult> => {
      const priorRegistry = registry;
      const priorRecord = selectedRecord(priorRegistry);
      try {
        if (
          (await probeProjectAvailability(
            options.availabilityProbe,
            prepared.record.canonicalDirectory,
          )) !== "available"
        ) {
          return publicProjectUnavailable();
        }
        if (closed) return publicProjectSwitchUnavailable();
        const targetGeneration = advanceGeneration();
        selectionRecords.clear();
        historyRecords.clear();
        if (!(await closeActiveProject())) {
          return publicProjectSwitchUnavailable();
        }
        if (closed) return publicProjectSwitchUnavailable();
        const candidate = await openBackend(
          prepared.record,
          options.paths.dataDirectory,
          options.preferencePath,
          options.adapter,
          options.backendFactory,
          options.authGeneration,
        ).catch(() => undefined);
        if (candidate === undefined) {
          await reopenPriorProject(priorRecord);
          return publicProjectSwitchUnavailable();
        }
        if (closed) {
          await closeUnpublishedCandidate(prepared.record, candidate);
          return publicProjectSwitchUnavailable();
        }
        if (
          prepared.changed &&
          !(await writeRegistry(
            options.paths,
            priorRegistry,
            prepared.registry,
            options.atomicReplace,
          ))
        ) {
          if (
            await closeUnpublishedCandidate(prepared.record, candidate)
          ) {
            await reopenPriorProject(priorRecord);
          }
          return publicProjectSwitchUnavailable();
        }
        if (closed) {
          registry = prepared.registry;
          await closeUnpublishedCandidate(prepared.record, candidate);
          return publicProjectSwitchUnavailable();
        }
        registry = prepared.registry;
        active = {
          record: prepared.record,
          backend: candidate,
          disposeObservation: () => undefined,
        };
        const firstTargetProjection = createFirstProjectionCompletion(
          targetGeneration,
        );
        pendingTargetProjection = firstTargetProjection;
        attachObservation(active, firstTargetProjection);
        const targetProjected = await firstTargetProjection.promise;
        if (pendingTargetProjection === firstTargetProjection) {
          pendingTargetProjection = undefined;
        }
        if (!targetProjected || closed || generation !== targetGeneration) {
          return publicProjectSwitchUnavailable();
        }
        return publicProjectSelected();
      } catch {
        await reopenPriorProject(priorRecord);
        return publicProjectSwitchUnavailable();
      }
    })().finally(() => {
      if (switchPromise === operation) switchPromise = undefined;
      if (!closed) switching = false;
    });
    switchPromise = operation;
    return operation;
  };

  const discoverDirectoryLedgers = (
    canonicalDirectory: string,
    registeredLedgerSlot?: string,
  ): readonly DiscoveredProjectLedger[] => {
    try {
      return discoverProjectLedgers({
        ledgerDirectory: options.paths.ledgerDirectory,
        canonicalDirectory,
        registeredLedgerSlot,
      });
    } catch {
      // Discovery is advisory. An unreadable store directory offers nothing.
      return [];
    }
  };

  const discoverLedgers = (
    record: PrivateProjectRecord,
  ): readonly DiscoveredProjectLedger[] =>
    discoverDirectoryLedgers(record.canonicalDirectory, record.ledgerSlot);

  const pendingRegistrationHistories = (
    canonicalDirectory: string,
    ledgers: readonly DiscoveredProjectLedger[],
  ): WorkbenchProjectSelectionResult => {
    if (ledgers.length < 2 || ledgers.length > maximumDiscoveredHistories) {
      return publicProjectSwitchUnavailable();
    }
    historyRecords.clear();
    const histories = ledgers.map((ledger) => {
      const historyKey = `project-history:${randomUUID()}`;
      historyRecords.set(
        historyKey,
        Object.freeze({
          kind: "registration" as const,
          canonicalDirectory,
          ledgerSlot: ledger.ledgerSlot,
        }),
      );
      return deepFreeze({
        historyKey,
        current: false,
        sessionCount: ledger.sessionCount,
        commandCount: ledger.commandCount,
        updateCount: ledger.updateCount,
        byteSize: ledger.byteSize,
        lastModified: ledger.lastModified,
        schemaVersion: ledger.schemaVersion,
      }) as WorkbenchProjectHistoryOption;
    });
    const snapshot = deepFreeze({
      projectLabel: deriveProjectLabel(canonicalDirectory),
      histories,
    }) as WorkbenchProjectHistorySnapshot;
    return publicProjectHistorySelectionRequired(snapshot);
  };

  const projectHistories = (
    record: PrivateProjectRecord,
  ): WorkbenchProjectHistoryDiscoveryResult => {
    const directoryDigest = projectDirectoryDigest(record.canonicalDirectory);
    const discovered = discoverLedgers(record).filter(
      (ledger) =>
        ledger.registered ||
        ledger.sessionCount > 0 ||
        !options.historyHides.isHidden(directoryDigest, ledger.ledgerSlot),
    );
    // A Project that has never been opened has no ledger file yet, and one that
    // is locked or corrupt is skipped by discovery. The registered slot is
    // still reported so the owner always sees which history is current.
    const ledgers = discovered.some((ledger) => ledger.registered)
      ? discovered
      : [unopenedLedger(record.ledgerSlot), ...discovered];
    if (ledgers.length > maximumDiscoveredHistories) {
      return Object.freeze({ status: "unavailable" as const });
    }
    historyRecords.clear();
    const histories = ledgers.map((ledger) => {
      const historyKey = `project-history:${randomUUID()}`;
      historyRecords.set(
        historyKey,
        Object.freeze({
          kind: "registered" as const,
          recordKey: record.recordKey,
          ledgerSlot: ledger.ledgerSlot,
        }),
      );
      return deepFreeze({
        historyKey,
        current: ledger.registered,
        sessionCount: ledger.sessionCount,
        commandCount: ledger.commandCount,
        updateCount: ledger.updateCount,
        byteSize: ledger.byteSize,
        lastModified: ledger.lastModified,
        schemaVersion: ledger.schemaVersion,
      }) as WorkbenchProjectHistoryOption;
    });
    return deepFreeze({
      status: "discovered" as const,
      snapshot: {
        projectLabel: deriveProjectLabel(record.canonicalDirectory),
        histories,
      },
    });
  };

  const trackAction = <T>(
    operation: () => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    pendingActions += 1;
    const promise = Promise.resolve()
      .then(operation)
      .catch(() => fallback)
      .finally(() => {
        pendingActions -= 1;
        actionPromises.delete(promise);
      });
    actionPromises.add(promise);
    return promise;
  };

  const republishCurrentProject = (): void => {
    if (lastResult?.ok !== true || !("view" in lastResult)) {
      projectResult(publicProjectFailure(), generation);
      return;
    }
    projectResult(
      {
        ok: true,
        view: {
          project: lastResult.view.project,
          observation: lastResult.view.observation,
          commands: lastResult.view.commands,
          initialSelectionKey: lastResult.view.initialSelectionKey,
        },
      },
      generation,
    );
  };

  const controller: WorkbenchProjectHost = Object.freeze({
    observeProject(listener: WorkbenchHostedProjectListener): () => void {
      if (closed) {
        emit(listener, publicHostedProjectFailure());
        return () => undefined;
      }
      listeners.add(listener);
      if (lastResult !== undefined) {
        queueMicrotask(() => {
          if (listeners.has(listener) && lastResult !== undefined) {
            emit(listener, lastResult);
          }
        });
      }
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        listeners.delete(listener);
      };
    },
    readTurnActivity(): ProjectTurnActivity {
      if (
        closed ||
        switching ||
        teardownBlocked ||
        pendingActions > 0 ||
        active === undefined
      ) {
        return "unknown";
      }
      try {
        return active.backend.readTurnActivity();
      } catch {
        return "unknown";
      }
    },
    removeSession(
      request: WorkbenchSessionRemovalRequest,
    ): Promise<WorkbenchSessionRemovalResult> {
      const reconstructed = reconstructWorkbenchSessionRemovalRequest(request);
      if (
        !reconstructed.ok ||
        closed ||
        switching ||
        teardownBlocked ||
        active === undefined ||
        active.backend.removeSession === undefined
      ) {
        return Promise.resolve(
          !reconstructed.ok
            ? Object.freeze({ status: "not-found" as const })
            :
          Object.freeze({
            status: "blocked" as const,
            activity: "unknown" as const,
          }),
        );
      }
      const backend = active.backend;
      return trackAction(
        () => backend.removeSession!(reconstructed.request),
        Object.freeze({
          status: "blocked" as const,
          activity: "unknown" as const,
        }),
      );
    },
    mutateSessionMetadata(
      request: WorkbenchSessionMetadataMutationRequest,
    ): Promise<WorkbenchSessionMetadataMutationResult> {
      const reconstructed =
        reconstructWorkbenchSessionMetadataMutationRequest(request);
      if (
        !reconstructed.ok ||
        closed ||
        switching ||
        teardownBlocked ||
        active === undefined ||
        active.backend.mutateSessionMetadata === undefined
      ) {
        return Promise.resolve(
          Object.freeze({ status: "unavailable" as const }),
        );
      }
      const backend = active.backend;
      return trackAction(
        () => backend.mutateSessionMetadata!(reconstructed.request),
        Object.freeze({ status: "unavailable" as const }),
      );
    },
    async registerTrustedProject(
      directory: string,
    ): Promise<WorkbenchProjectSelectionResult> {
      if (
        closed ||
        switching ||
        teardownBlocked ||
        pendingActions > 0 ||
        registry === undefined
      ) {
        return publicProjectSwitchUnavailable();
      }
      let canonical: string;
      try {
        canonical = canonicalDirectory(directory);
      } catch {
        return publicProjectSwitchUnavailable();
      }
      // Refused HERE, before ledger discovery, before the registry is
      // prepared, and before `openBackend` creates a SQLite file for the
      // directory: a refusal must leave nothing on disk. This is the explicit
      // boundary; the empty-label throw in `deriveProjectLabel` that used to
      // stand in for it was an accident of `basename`, and a boundary that
      // exists by accident stops existing the day the accident is fixed.
      if (isDriveRoot(canonical)) return publicProjectDriveRootRefused();
      const current = selectedRecord(registry);
      const alreadyRegistered = registry.records.some((record) =>
        sameDirectory(record.canonicalDirectory, canonical),
      );
      const candidates = alreadyRegistered
        ? Object.freeze([] as DiscoveredProjectLedger[])
        : discoverDirectoryLedgers(canonical);
      if (candidates.length > 1) {
        return pendingRegistrationHistories(canonical, candidates);
      }
      const adoptedExistingHistory = candidates.length === 1;
      const prepared = prepareRegistration(
        registry,
        canonical,
        candidates[0]?.ledgerSlot,
      );
      if (prepared === undefined) return publicProjectSwitchUnavailable();
      if (
        current !== undefined &&
        sameDirectory(current.canonicalDirectory, canonical) &&
        active?.record.recordKey === current.recordKey &&
        !prepared.changed &&
        lastResult?.ok === true
      ) {
        if (lastResult !== undefined) publish(lastResult);
        return publicProjectSelected();
      }
      const result = await switchToPrepared(prepared);
      return result.ok && adoptedExistingHistory
        ? publicProjectSelectedWithExistingHistory()
        : result;
    },
    async selectProject(
      request: WorkbenchProjectSelectionRequest,
    ): Promise<WorkbenchProjectSelectionResult> {
      if (
        closed ||
        switching ||
        teardownBlocked ||
        pendingActions > 0 ||
        registry === undefined
      ) {
        return publicProjectSwitchUnavailable();
      }
      const reconstructed = reconstructWorkbenchProjectSelectionRequest(request);
      if (!reconstructed.ok) return publicInvalidProjectSelection();
      const selectionKey = reconstructed.request.selectionKey;
      const record = selectionRecords.get(selectionKey);
      if (record === undefined) return publicInvalidProjectSelection();
      const prepared = prepareSelection(registry, record);
      return prepared === undefined
        ? publicInvalidProjectSelection()
        : switchToPrepared(prepared);
    },
    async removeProject(
      request: WorkbenchProjectSelectionRequest,
    ): Promise<WorkbenchProjectRemovalResult> {
      if (
        closed ||
        switching ||
        teardownBlocked ||
        pendingActions > 0 ||
        registry === undefined
      ) {
        return Object.freeze({ status: "unavailable" as const });
      }
      const reconstructed = reconstructWorkbenchProjectSelectionRequest(request);
      if (!reconstructed.ok) {
        return Object.freeze({ status: "invalid-selection" as const });
      }
      const selectionKey = reconstructed.request.selectionKey;
      const record = selectionRecords.get(selectionKey);
      if (record === undefined) {
        return Object.freeze({ status: "invalid-selection" as const });
      }
      const nextRegistry = prepareRemoval(registry, record);
      if (nextRegistry === undefined) {
        return Object.freeze({ status: "invalid-selection" as const });
      }
      const removingActive = active?.record.recordKey === record.recordKey;
      if (removingActive) {
        let activity: ProjectTurnActivity;
        try {
          activity = active?.backend.readTurnActivity() ?? "unknown";
        } catch {
          activity = "unknown";
        }
        if (activity !== "idle") {
          return Object.freeze({ status: "blocked" as const, activity });
        }
      }

      switching = true;
      const operation = (async (): Promise<WorkbenchProjectRemovalResult> => {
        const priorRegistry = registry!;
        const priorRecord = selectedRecord(priorRegistry);
        if (removingActive) {
          advanceGeneration();
          selectionRecords.clear();
          historyRecords.clear();
          if (!(await closeActiveProject())) {
            return Object.freeze({ status: "unavailable" as const });
          }
        }
        if (
          !(await writeRegistry(
            options.paths,
            priorRegistry,
            nextRegistry,
            options.atomicReplace,
          ))
        ) {
          if (removingActive) await reopenPriorProject(priorRecord);
          return Object.freeze({ status: "unavailable" as const });
        }

        registry = nextRegistry;
        selectionRecords.clear();
        historyRecords.clear();
        if (!removingActive) advanceGeneration();
        const removalGeneration = generation;
        const removalProjection =
          createFirstProjectionCompletion(removalGeneration);
        pendingTargetProjection = removalProjection;
        if (removingActive) {
          const successor = selectedRecord(nextRegistry);
          if (successor === undefined) {
            if (nextRegistry.records.length === 0) {
              publishEmptyRegistry(removalGeneration, removalProjection);
            } else {
              projectResult(
                publicProjectFailure(),
                removalGeneration,
                removalProjection,
              );
            }
          } else {
            await reopenPriorProject(successor, removalProjection);
          }
        } else {
          const current = active;
          if (current === undefined) {
            if (nextRegistry.records.length === 0) {
              publishEmptyRegistry(removalGeneration, removalProjection);
            } else {
              projectResult(
                publicProjectFailure(),
                removalGeneration,
                removalProjection,
              );
            }
          } else {
            try {
              current.disposeObservation();
            } catch {
              // Reattaching below remains the authoritative observation seam.
            }
            current.disposeObservation = () => undefined;
            attachObservation(current, removalProjection);
          }
        }
        await removalProjection.promise;
        if (pendingTargetProjection === removalProjection) {
          pendingTargetProjection = undefined;
        }
        return Object.freeze({ status: "removed" as const });
      })().finally(() => {
        if (switchPromise === operation) switchPromise = undefined;
        if (!closed) switching = false;
      });
      switchPromise = operation;
      return operation;
    },
    discoverProjectHistories(
      request: WorkbenchProjectSelectionRequest,
    ): Promise<WorkbenchProjectHistoryDiscoveryResult> {
      if (closed || registry === undefined) {
        return Promise.resolve(
          Object.freeze({ status: "unavailable" as const }),
        );
      }
      const reconstructed = reconstructWorkbenchProjectSelectionRequest(request);
      if (!reconstructed.ok) {
        return Promise.resolve(
          Object.freeze({ status: "invalid-selection" as const }),
        );
      }
      const record = selectionRecords.get(reconstructed.request.selectionKey);
      if (record === undefined) {
        return Promise.resolve(
          Object.freeze({ status: "invalid-selection" as const }),
        );
      }
      return Promise.resolve(projectHistories(record));
    },
    adoptProjectHistory(
      request: WorkbenchProjectHistoryAdoptionRequest,
    ): Promise<WorkbenchProjectHistoryAdoptionResult> {
      if (
        closed ||
        switching ||
        teardownBlocked ||
        pendingActions > 0 ||
        registry === undefined
      ) {
        return Promise.resolve(
          Object.freeze({ status: "unavailable" as const }),
        );
      }
      const reconstructed =
        reconstructWorkbenchProjectHistoryAdoptionRequest(request);
      if (!reconstructed.ok) {
        return Promise.resolve(
          Object.freeze({ status: "invalid-selection" as const }),
        );
      }
      const target = historyRecords.get(reconstructed.request.historyKey);
      if (target === undefined) {
        return Promise.resolve(
          Object.freeze({ status: "invalid-selection" as const }),
        );
      }
      if (target.kind === "registration") {
        if (
          registry.records.some((record) =>
            sameDirectory(
              record.canonicalDirectory,
              target.canonicalDirectory,
            ),
          ) ||
          !discoverDirectoryLedgers(target.canonicalDirectory).some(
            (ledger) => ledger.ledgerSlot === target.ledgerSlot,
          )
        ) {
          return Promise.resolve(
            Object.freeze({ status: "invalid-selection" as const }),
          );
        }
        const prepared = prepareRegistration(
          registry,
          target.canonicalDirectory,
          target.ledgerSlot,
        );
        if (prepared === undefined) {
          return Promise.resolve(
            Object.freeze({ status: "invalid-selection" as const }),
          );
        }
        historyRecords.clear();
        return switchToPrepared(prepared).then((result) =>
          Object.freeze(
            result.ok
              ? { status: "adopted" as const }
              : { status: "unavailable" as const },
          ),
        );
      }
      const record = registry.records.find(
        (candidate) => candidate.recordKey === target.recordKey,
      );
      if (record === undefined) {
        return Promise.resolve(
          Object.freeze({ status: "invalid-selection" as const }),
        );
      }
      if (record.ledgerSlot === target.ledgerSlot) {
        // Already the current history. Nothing is written for a no-op.
        return Promise.resolve(Object.freeze({ status: "adopted" as const }));
      }
      // A minted key never authorises the write on its own: the slot must still
      // be a ledger whose own recorded digest names this exact directory.
      if (
        !discoverLedgers(record).some(
          (ledger) => ledger.ledgerSlot === target.ledgerSlot,
        )
      ) {
        return Promise.resolve(
          Object.freeze({ status: "invalid-selection" as const }),
        );
      }
      // Swapping the ledger under a live turn would strand that turn's record
      // in the history the Project is about to stop showing, so a starting or
      // running turn refuses the adoption.
      //
      // A permanently unknown outcome deliberately does NOT block. It can
      // never become idle, so blocking on it would trap the owner in exactly
      // the history he is trying to leave — and adoption deletes nothing, so
      // switching away and back leaves that record untouched either way.
      let activity: ProjectTurnActivity = "idle";
      if (active !== undefined) {
        try {
          activity = active.backend.readTurnActivity();
        } catch {
          activity = "unknown";
        }
      }
      if (activity === "accepted" || activity === "in-flight") {
        return Promise.resolve(
          Object.freeze({ status: "blocked" as const, activity }),
        );
      }
      const prepared = prepareHistoryAdoption(
        registry,
        record,
        target.ledgerSlot,
      );
      if (prepared === undefined) {
        return Promise.resolve(
          Object.freeze({ status: "invalid-selection" as const }),
        );
      }
      historyRecords.clear();
      return switchToPrepared(prepared).then((result) =>
        Object.freeze(
          result.ok
            ? { status: "adopted" as const }
            : { status: "unavailable" as const },
        ),
      );
    },
    hideProjectHistory(
      request: WorkbenchProjectHistoryHideRequest,
    ): Promise<WorkbenchProjectHistoryHideResult> {
      if (
        closed ||
        switching ||
        teardownBlocked ||
        pendingActions > 0 ||
        registry === undefined ||
        !options.historyHides.available
      ) {
        return Promise.resolve(
          Object.freeze({ status: "unavailable" as const }),
        );
      }
      const reconstructed = reconstructWorkbenchProjectHistoryHideRequest(request);
      if (!reconstructed.ok) {
        return Promise.resolve(
          Object.freeze({ status: "invalid-selection" as const }),
        );
      }
      const target = historyRecords.get(reconstructed.request.historyKey);
      const record =
        target === undefined || target.kind !== "registered"
          ? undefined
          : registry.records.find(
              (candidate) => candidate.recordKey === target.recordKey,
            );
      if (target === undefined || record === undefined) {
        return Promise.resolve(
          Object.freeze({ status: "invalid-selection" as const }),
        );
      }
      return trackAction(async () => {
        // The rotating key is necessary but never sufficient. Re-read the
        // ledger inventory immediately before the visibility record commits,
        // so a history that gained a Session after discovery is refused.
        const latest = discoverLedgers(record).find(
          (ledger) => ledger.ledgerSlot === target.ledgerSlot,
        );
        if (latest === undefined) {
          return Object.freeze({ status: "invalid-selection" as const });
        }
        if (latest.registered || latest.sessionCount !== 0) {
          return Object.freeze({ status: "ineligible" as const });
        }
        const hidden = await options.historyHides.hide(
          projectDirectoryDigest(record.canonicalDirectory),
          target.ledgerSlot,
        );
        if (!hidden) {
          return Object.freeze({ status: "unavailable" as const });
        }
        historyRecords.clear();
        return Object.freeze({ status: "hidden" as const });
      }, Object.freeze({ status: "unavailable" as const }));
    },
    loadDirectSessionProfile<
      Request extends WorkbenchDirectSessionProfileLoadRequest,
    >(
      request: Request,
    ): Promise<WorkbenchDirectSessionProfileResultFor<Request>> {
      if (closed || switching || teardownBlocked || active === undefined) {
        return Promise.resolve(
          publicProfileUnavailable() as WorkbenchDirectSessionProfileResultFor<Request>,
        );
      }
      const backend = active.backend;
      return trackAction(
        () => backend.loadDirectSessionProfile(request),
        publicProfileUnavailable() as WorkbenchDirectSessionProfileResultFor<Request>,
      );
    },
    useDirectSessionProfileAsDefault(
      request: WorkbenchDirectSessionProfileDefaultRequest,
    ): Promise<WorkbenchDirectSessionProfileDefaultResult> {
      if (closed || switching || teardownBlocked || active === undefined) {
        return Promise.resolve(publicPreferenceUnavailable());
      }
      const backend = active.backend;
      return trackAction(
        () => backend.useDirectSessionProfileAsDefault(request),
        publicPreferenceUnavailable(),
      );
    },
    submitDirectInput(
      request: WorkbenchDirectInputRequest,
    ): Promise<WorkbenchSubmissionResult> {
      if (closed || switching || teardownBlocked || active === undefined) {
        return Promise.resolve(publicUnavailableSubmission());
      }
      const backend = active.backend;
      return trackAction(
        () => backend.submitDirectInput(request),
        publicUnavailableSubmission(),
      );
    },
    interruptActiveTurn(
      request: WorkbenchInterruptRequest,
    ): Promise<WorkbenchInterruptResult> {
      if (closed || switching || teardownBlocked || active === undefined) {
        return Promise.resolve(publicInterruptUnavailable());
      }
      const backend = active.backend;
      const interrupt = backend.interruptActiveTurn;
      if (typeof interrupt !== "function") {
        return Promise.resolve(publicInterruptUnavailable());
      }
      return trackAction(
        () => interrupt.call(backend, request),
        publicInterruptUnavailable(),
      );
    },
    observeUserInput(listener: () => void): () => void {
      userInputListeners.add(listener);
      return () => { userInputListeners.delete(listener); };
    },
    async readUserInput(request: WorkbenchUserInputReadRequest): Promise<WorkbenchUserInputResult> {
      if (closed || switching || teardownBlocked || !active?.backend.readUserInput) return { ok: false };
      const selected = active;
      const result = await selected.backend.readUserInput!(request);
      return active === selected && !closed && !switching ? result : { ok: false };
    },
    async respondToUserInput(request: WorkbenchUserInputResponse): Promise<WorkbenchUserInputResponseResult> {
      if (closed || switching || teardownBlocked || !active?.backend.respondToUserInput) return { status: "unavailable" };
      // Do not hold Project switching/close behind a Runtime waiting for user input.
      return active.backend.respondToUserInput(request);
    },
    steerActiveTurn(
      request: WorkbenchSteerRequest,
    ): Promise<WorkbenchSteerResult> {
      if (closed || switching || teardownBlocked || active === undefined) {
        return Promise.resolve(publicSteerUnavailable());
      }
      const backend = active.backend;
      const steer = backend.steerActiveTurn;
      if (typeof steer !== "function") {
        return Promise.resolve(publicSteerUnavailable());
      }
      return trackAction(
        () => steer.call(backend, request),
        publicSteerUnavailable(),
      );
    },
    close(): Promise<void> {
      closed = true;
      generation += 1;
      pendingTargetProjection?.complete(false);
      selectionRecords.clear();
      historyRecords.clear();
      listeners.clear();
      publishUserInput();
      userInputListeners.clear();
      closePromise ??= (async () => {
        switching = true;
        await projectionTail;
        await switchPromise;
        await Promise.all([...actionPromises]);
        const closing = active;
        active = undefined;
        try {
          closing?.disposeObservation();
        } catch {
          // Backend close remains authoritative for durable teardown.
        }
        await closing?.backend.close().catch(() => undefined);
      })();
      return closePromise;
    },
  });
  return controller;
}

function createFirstProjectionCompletion(
  generation: number,
): FirstProjectionCompletion {
  let settled = false;
  let resolvePromise!: (successful: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({
    generation,
    promise,
    complete(successful: boolean): void {
      if (settled) return;
      settled = true;
      resolvePromise(successful);
    },
  });
}

type RegistryPaths = {
  readonly dataDirectory: string;
  readonly stateFile: string;
  readonly replacementFile: string;
  readonly backupFile: string;
  readonly ledgerDirectory: string;
};

function registryPaths(dataDirectory: string): RegistryPaths {
  return Object.freeze({
    dataDirectory,
    stateFile: join(dataDirectory, registryFileName),
    replacementFile: join(dataDirectory, registryReplacementName),
    backupFile: join(dataDirectory, registryBackupName),
    ledgerDirectory: join(dataDirectory, ledgerDirectoryName),
  });
}

async function openRegistry(
  paths: RegistryPaths,
): Promise<
  | {
      readonly ok: true;
      readonly registry: PrivateProjectRegistry;
      readonly stateExisted: boolean;
    }
  | { readonly ok: false }
> {
  await mkdir(paths.dataDirectory, { recursive: true });
  let information: Awaited<ReturnType<typeof lstat>>;
  try {
    information = await lstat(paths.stateFile);
  } catch (error) {
    if (!isMissing(error)) return Object.freeze({ ok: false });
    if (await pathExists(paths.backupFile)) return Object.freeze({ ok: false });
    await rm(paths.replacementFile, { force: true }).catch(() => undefined);
    return Object.freeze({
      ok: true,
      registry: emptyRegistry(),
      stateExisted: false,
    });
  }
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size > maximumRegistryBytes
  ) {
    return Object.freeze({ ok: false });
  }
  try {
    const contents = await readFile(paths.stateFile, "utf8");
    if (Buffer.byteLength(contents, "utf8") > maximumRegistryBytes) {
      return Object.freeze({ ok: false });
    }
    assertNoDuplicateObjectKeys(contents);
    assertExactRegistryNumericTokens(contents);
    const parsed: unknown = JSON.parse(contents);
    const registry = validateRegistry(parsed);
    if (registry === undefined) return Object.freeze({ ok: false });
    await rm(paths.replacementFile, { force: true }).catch(() => undefined);
    await rm(paths.backupFile, { force: true }).catch(() => undefined);
    return Object.freeze({ ok: true, registry, stateExisted: true });
  } catch {
    return Object.freeze({ ok: false });
  }
}

function emptyRegistry(): PrivateProjectRegistry {
  return deepFreeze({
    schemaVersion: registrySchemaVersion as 1,
    revision: 0,
    nextProjectOrdinal: 1,
    selectedRecordKey: null,
    records: [],
  });
}

/**
 * Startup has no owner-facing chooser yet. It may therefore reuse zero or one
 * matching ledger, but two legitimate histories leave registration untouched
 * until Open Project can present the existing history dialog.
 */
function prepareUnambiguousRegistration(
  paths: RegistryPaths,
  registry: PrivateProjectRegistry,
  directory: string,
): ReturnType<typeof prepareRegistration> {
  let canonical: string;
  try {
    canonical = canonicalDirectory(directory);
  } catch {
    return undefined;
  }
  if (
    registry.records.some((record) =>
      sameDirectory(record.canonicalDirectory, canonical),
    )
  ) {
    return prepareRegistration(registry, canonical);
  }
  let candidates: readonly DiscoveredProjectLedger[];
  try {
    candidates = discoverProjectLedgers({
      ledgerDirectory: paths.ledgerDirectory,
      canonicalDirectory: canonical,
    });
  } catch {
    candidates = [];
  }
  return candidates.length > 1
    ? undefined
    : prepareRegistration(registry, canonical, candidates[0]?.ledgerSlot);
}

function prepareRegistration(
  registry: PrivateProjectRegistry,
  directory: string,
  existingLedgerSlot?: string,
):
  | {
      readonly registry: PrivateProjectRegistry;
      readonly record: PrivateProjectRecord;
      readonly changed: boolean;
    }
  | undefined {
  let canonical: string;
  try {
    canonical = canonicalDirectory(directory);
  } catch {
    return undefined;
  }
  const matches = registry.records.filter((record) =>
    sameDirectory(record.canonicalDirectory, canonical),
  );
  if (matches.length > 1 || registry.revision >= maximumRegistryRevision) {
    return undefined;
  }
  const existing = matches[0];
  if (existing !== undefined) {
    if (registry.selectedRecordKey === existing.recordKey) {
      return Object.freeze({ registry, record: existing, changed: false });
    }
    return Object.freeze({
      registry: deepFreeze({
        ...registry,
        revision: registry.revision + 1,
        selectedRecordKey: existing.recordKey,
      }),
      record: existing,
      changed: true,
    });
  }
  if (
    registry.records.length >= maximumRegistryRecords ||
    registry.nextProjectOrdinal >= Number.MAX_SAFE_INTEGER ||
    (existingLedgerSlot !== undefined &&
      (!ledgerSlotPattern.test(existingLedgerSlot) ||
        registry.records.some(
          (record) => record.ledgerSlot === existingLedgerSlot,
        )))
  ) {
    return undefined;
  }
  const record = deepFreeze({
    recordKey: `project-record-v1-${randomUUID()}`,
    canonicalDirectory: canonical,
    ledgerSlot:
      existingLedgerSlot ?? `project-ledger-v1-${randomUUID()}`,
  });
  return Object.freeze({
    registry: deepFreeze({
      ...registry,
      revision: registry.revision + 1,
      nextProjectOrdinal: registry.nextProjectOrdinal + 1,
      selectedRecordKey: record.recordKey,
      records: [...registry.records, record],
    }),
    record,
    changed: true,
  });
}

function prepareSelection(
  registry: PrivateProjectRegistry,
  requested: PrivateProjectRecord,
):
  | {
      readonly registry: PrivateProjectRegistry;
      readonly record: PrivateProjectRecord;
      readonly changed: boolean;
    }
  | undefined {
  const matches = registry.records.filter(
    (record) => record.recordKey === requested.recordKey,
  );
  if (matches.length !== 1) return undefined;
  const record = matches[0]!;
  if (registry.selectedRecordKey === record.recordKey) {
    return Object.freeze({ registry, record, changed: false });
  }
  if (registry.revision >= maximumRegistryRevision) return undefined;
  return Object.freeze({
    registry: deepFreeze({
      ...registry,
      revision: registry.revision + 1,
      selectedRecordKey: record.recordKey,
    }),
    record,
    changed: true,
  });
}

/**
 * Re-points one record at a discovered ledger slot, leaving every other record,
 * the ordinal counter and the ledger files themselves untouched.
 *
 * Adoption is a registry re-point and nothing else. The result flows through
 * the same validated write path as registration and removal, so a slot that
 * another Project already shows, a malformed slot spelling, or an exhausted
 * revision counter refuses the adoption instead of writing an invalid registry.
 */
function prepareHistoryAdoption(
  registry: PrivateProjectRegistry,
  requested: PrivateProjectRecord,
  ledgerSlot: string,
):
  | {
      readonly registry: PrivateProjectRegistry;
      readonly record: PrivateProjectRecord;
      readonly changed: boolean;
    }
  | undefined {
  const matches = registry.records.filter(
    (record) => record.recordKey === requested.recordKey,
  );
  if (
    matches.length !== 1 ||
    !ledgerSlotPattern.test(ledgerSlot) ||
    registry.revision >= maximumRegistryRevision
  ) {
    return undefined;
  }
  const current = matches[0]!;
  if (current.ledgerSlot === ledgerSlot) return undefined;
  if (
    registry.records.some(
      (record) =>
        record.recordKey !== current.recordKey &&
        record.ledgerSlot === ledgerSlot,
    )
  ) {
    return undefined;
  }
  const record = deepFreeze({
    recordKey: current.recordKey,
    canonicalDirectory: current.canonicalDirectory,
    ledgerSlot,
  });
  return Object.freeze({
    registry: deepFreeze({
      ...registry,
      revision: registry.revision + 1,
      selectedRecordKey: record.recordKey,
      records: registry.records.map((candidate) =>
        candidate.recordKey === record.recordKey ? record : candidate,
      ),
    }),
    record,
    changed: true,
  });
}

/** The inventory of a registered slot whose ledger file is not readable yet. */
function unopenedLedger(ledgerSlot: string): DiscoveredProjectLedger {
  return Object.freeze({
    ledgerSlot,
    registered: true,
    sessionCount: 0,
    commandCount: 0,
    updateCount: 0,
    byteSize: 0,
    lastModified: "1970-01-01T00:00:00Z",
    schemaVersion: 0,
  });
}

function prepareRemoval(
  registry: PrivateProjectRegistry,
  requested: PrivateProjectRecord,
): PrivateProjectRegistry | undefined {
  const matches = registry.records.filter(
    (record) => record.recordKey === requested.recordKey,
  );
  if (matches.length !== 1 || registry.revision >= maximumRegistryRevision) {
    return undefined;
  }
  const records = registry.records.filter(
    (record) => record.recordKey !== requested.recordKey,
  );
  const selectedRecordKey =
    registry.selectedRecordKey === requested.recordKey
      ? records[0]?.recordKey ?? null
      : registry.selectedRecordKey;
  return deepFreeze({
    ...registry,
    revision: registry.revision + 1,
    selectedRecordKey,
    records,
  });
}

async function writeRegistry(
  paths: RegistryPaths,
  prior: PrivateProjectRegistry,
  next: PrivateProjectRegistry,
  atomicReplace: WorkbenchProjectRegistryAtomicReplace,
): Promise<boolean> {
  const contents = serializeRegistry(next);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (
      (await pathExists(paths.replacementFile)) ||
      (await pathExists(paths.backupFile))
    ) {
      return false;
    }
    await mkdir(dirname(paths.stateFile), { recursive: true });
    handle = await open(paths.replacementFile, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await atomicReplace(paths.replacementFile, paths.stateFile);
    await rm(paths.backupFile, { force: true }).catch(() => undefined);
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    const committed = await readCommittedRegistry(paths.stateFile);
    if (committed !== undefined && serializeRegistry(committed) === contents) {
      await rm(paths.replacementFile, { force: true }).catch(() => undefined);
      await rm(paths.backupFile, { force: true }).catch(() => undefined);
      return true;
    }
    if (
      committed !== undefined &&
      serializeRegistry(committed) === serializeRegistry(prior)
    ) {
      await rm(paths.replacementFile, { force: true }).catch(() => undefined);
    }
    return false;
  }
}

async function readCommittedRegistry(
  stateFile: string,
): Promise<PrivateProjectRegistry | undefined> {
  try {
    const contents = await readFile(stateFile, "utf8");
    assertNoDuplicateObjectKeys(contents);
    assertExactRegistryNumericTokens(contents);
    return validateRegistry(JSON.parse(contents));
  } catch {
    return undefined;
  }
}

function serializeRegistry(registry: PrivateProjectRegistry): string {
  return `${JSON.stringify(registry)}\n`;
}

function validateRegistry(value: unknown): PrivateProjectRegistry | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "nextProjectOrdinal",
      "records",
      "revision",
      "schemaVersion",
      "selectedRecordKey",
    ]) ||
    value.schemaVersion !== registrySchemaVersion ||
    !Number.isSafeInteger(value.schemaVersion) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    (value.revision as number) > maximumRegistryRevision ||
    !Number.isSafeInteger(value.nextProjectOrdinal) ||
    (value.nextProjectOrdinal as number) < 1 ||
    (value.nextProjectOrdinal as number) >= Number.MAX_SAFE_INTEGER ||
    !Array.isArray(value.records) ||
    value.records.length > maximumRegistryRecords ||
    (value.selectedRecordKey !== null &&
      typeof value.selectedRecordKey !== "string")
  ) {
    return undefined;
  }
  const records: PrivateProjectRecord[] = [];
  const recordKeys = new Set<string>();
  const ledgerSlots = new Set<string>();
  const directories = new Set<string>();
  for (const candidate of value.records) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        "canonicalDirectory",
        "ledgerSlot",
        "recordKey",
      ]) ||
      typeof candidate.recordKey !== "string" ||
      !recordKeyPattern.test(candidate.recordKey) ||
      typeof candidate.ledgerSlot !== "string" ||
      !ledgerSlotPattern.test(candidate.ledgerSlot) ||
      typeof candidate.canonicalDirectory !== "string"
    ) {
      return undefined;
    }
    let canonical: string;
    try {
      canonical = canonicalDirectory(candidate.canonicalDirectory);
    } catch {
      return undefined;
    }
    const identity = directoryIdentity(canonical);
    if (
      identity !== directoryIdentity(candidate.canonicalDirectory) ||
      recordKeys.has(candidate.recordKey) ||
      ledgerSlots.has(candidate.ledgerSlot) ||
      directories.has(identity)
    ) {
      return undefined;
    }
    recordKeys.add(candidate.recordKey);
    ledgerSlots.add(candidate.ledgerSlot);
    directories.add(identity);
    records.push(
      deepFreeze({
        recordKey: candidate.recordKey,
        canonicalDirectory: candidate.canonicalDirectory,
        ledgerSlot: candidate.ledgerSlot,
      }),
    );
  }
  if ((value.nextProjectOrdinal as number) < records.length + 1) {
    return undefined;
  }
  if (
    (records.length === 0 && value.selectedRecordKey !== null) ||
    (records.length > 0 &&
      (typeof value.selectedRecordKey !== "string" ||
        !recordKeys.has(value.selectedRecordKey)))
  ) {
    return undefined;
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    revision: value.revision as number,
    nextProjectOrdinal: value.nextProjectOrdinal as number,
    selectedRecordKey: value.selectedRecordKey as string | null,
    records,
  });
}

async function projectSelectionSnapshot(
  registry: PrivateProjectRegistry,
  availabilityProbe: WorkbenchProjectAvailabilityProbe,
): Promise<{
  readonly snapshot: { readonly projects: readonly WorkbenchProjectOption[] };
  readonly selectionRecords: Map<string, PrivateProjectRecord>;
}> {
  const selectionRecords = new Map<string, PrivateProjectRecord>();
  const projects = await Promise.all(
    registry.records.map(async (record) => {
      const selectionKey = `project-selection:${randomUUID()}`;
      selectionRecords.set(selectionKey, record);
      return deepFreeze({
        label: deriveProjectLabel(record.canonicalDirectory),
        availability: await probeProjectAvailability(
          availabilityProbe,
          record.canonicalDirectory,
        ),
        selected: record.recordKey === registry.selectedRecordKey,
        selectionKey,
      });
    }),
  );
  return Object.freeze({
    snapshot: deepFreeze({ projects }),
    selectionRecords,
  });
}

async function openBackend(
  record: PrivateProjectRecord,
  dataDirectory: string,
  preferencePath: string,
  adapter: AgentRuntimeAdapter | undefined,
  backendFactory: WorkbenchProjectBackendFactory,
  authGeneration?: WorkLedgerAuthGenerationModule,
): Promise<WorkbenchBackend> {
  const ledgerDirectory = join(dataDirectory, ledgerDirectoryName);
  await mkdir(ledgerDirectory, { recursive: true });
  return backendFactory({
    projectDirectory: record.canonicalDirectory,
    databasePath: join(ledgerDirectory, `${record.ledgerSlot}.sqlite`),
    preferencePath,
    ...(adapter === undefined ? {} : { adapter }),
    ...(authGeneration === undefined ? {} : { authGeneration }),
  });
}

const defaultBackendFactory: WorkbenchProjectBackendFactory = (options) =>
  createWorkbenchBackend(options);

async function probeProjectAvailability(
  probe: WorkbenchProjectAvailabilityProbe,
  canonical: string,
): Promise<WorkbenchProjectAvailability> {
  try {
    const value = await probe(canonical);
    return value === "available" || value === "missing" || value === "unreadable"
      ? value
      : "unreadable";
  } catch {
    return "unreadable";
  }
}

function boundedProjectAvailabilityProbe(
  probe: WorkbenchProjectAvailabilityProbe,
  timeoutMilliseconds: number,
): WorkbenchProjectAvailabilityProbe {
  return async (canonical) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<WorkbenchProjectAvailability>((resolvePromise) => {
      timer = setTimeout(
        resolvePromise,
        timeoutMilliseconds,
        "unreadable" satisfies WorkbenchProjectAvailability,
      );
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => probe(canonical)),
        deadline,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

function resolveAvailabilityProbeTimeoutMilliseconds(
  requested: number | undefined,
): number {
  const timeout = requested ?? projectAvailabilityProbeTimeoutMilliseconds;
  if (
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > projectAvailabilityProbeTimeoutMilliseconds
  ) {
    throw new TypeError(
      `Project availability timeout must be greater than zero and at most ${projectAvailabilityProbeTimeoutMilliseconds} milliseconds.`,
    );
  }
  return timeout;
}

async function defaultAvailabilityProbe(
  canonical: string,
): Promise<WorkbenchProjectAvailability> {
  try {
    const information = await stat(canonical);
    if (!information.isDirectory()) return "missing";
    const handle = await open(canonical, "r");
    await handle.close();
    return "available";
  } catch (error) {
    return isMissing(error) ? "missing" : "unreadable";
  }
}

function selectedRecord(
  registry: PrivateProjectRegistry,
): PrivateProjectRecord | undefined {
  return registry.records.find(
    (record) => record.recordKey === registry.selectedRecordKey,
  );
}

function canonicalDirectory(directory: string): string {
  if (typeof directory !== "string" || directory.trim().length === 0) {
    throw new Error("invalid-directory");
  }
  const canonical = resolve(directory);
  const root = parse(canonical).root;
  return sameDirectory(canonical, root)
    ? canonical
    : canonical.replace(/[\\/]+$/u, "");
}

/**
 * `C:\`, `/`, or the root of a UNC share -- a path that is its own
 * `parse().root`. The same notion of "root" `canonicalDirectory` already
 * uses, so the two cannot disagree about which paths are roots.
 */
function isDriveRoot(canonical: string): boolean {
  return sameDirectory(canonical, parse(canonical).root);
}

function sameDirectory(left: string, right: string): boolean {
  return directoryIdentity(left) === directoryIdentity(right);
}

function directoryIdentity(directory: string): string {
  return process.platform === "win32" ? directory.toLocaleLowerCase("en-US") : directory;
}

function isMissing(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "ENOENT"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function assertNoDuplicateObjectKeys(contents: string): void {
  let index = 0;
  const skipWhitespace = (): void => {
    while (/\s/u.test(contents[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    if (contents[index] !== '"') throw new Error("invalid-registry");
    index += 1;
    while (index < contents.length) {
      const character = contents[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') {
        return JSON.parse(contents.slice(start, index)) as string;
      }
    }
    throw new Error("invalid-registry");
  };
  const parsePrimitive = (): void => {
    const start = index;
    while (index < contents.length && !/[\s,}\]]/u.test(contents[index] ?? "")) {
      index += 1;
    }
    if (index === start) throw new Error("invalid-registry");
  };
  const parseValue = (): void => {
    skipWhitespace();
    if (contents[index] === "{") parseObject();
    else if (contents[index] === "[") parseArray();
    else if (contents[index] === '"') void parseString();
    else parsePrimitive();
  };
  const parseObject = (): void => {
    index += 1;
    skipWhitespace();
    if (contents[index] === "}") {
      index += 1;
      return;
    }
    const keys = new Set<string>();
    while (index < contents.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) throw new Error("invalid-registry");
      keys.add(key);
      skipWhitespace();
      if (contents[index] !== ":") throw new Error("invalid-registry");
      index += 1;
      parseValue();
      skipWhitespace();
      if (contents[index] === "}") {
        index += 1;
        return;
      }
      if (contents[index] !== ",") throw new Error("invalid-registry");
      index += 1;
    }
    throw new Error("invalid-registry");
  };
  const parseArray = (): void => {
    index += 1;
    skipWhitespace();
    if (contents[index] === "]") {
      index += 1;
      return;
    }
    while (index < contents.length) {
      parseValue();
      skipWhitespace();
      if (contents[index] === "]") {
        index += 1;
        return;
      }
      if (contents[index] !== ",") throw new Error("invalid-registry");
      index += 1;
    }
    throw new Error("invalid-registry");
  };
  parseValue();
  skipWhitespace();
  if (index !== contents.length) throw new Error("invalid-registry");
}

function assertExactRegistryNumericTokens(contents: string): void {
  const tokens = new Map<string, string[]>();
  const pattern =
    /"(schemaVersion|revision|nextProjectOrdinal)"\s*:\s*([^,}\]]+)/gu;
  for (const match of contents.matchAll(pattern)) {
    const field = match[1]!;
    const values = tokens.get(field) ?? [];
    values.push(match[2]!.trim());
    tokens.set(field, values);
  }
  const schemaTokens = tokens.get("schemaVersion");
  const revisionTokens = tokens.get("revision");
  const ordinalTokens = tokens.get("nextProjectOrdinal");
  if (
    schemaTokens?.length !== 1 ||
    revisionTokens?.length !== 1 ||
    ordinalTokens?.length !== 1 ||
    schemaTokens[0] !== "1" ||
    !isCanonicalSafeIntegerToken(
      revisionTokens[0]!,
      0,
      maximumRegistryRevision,
    ) ||
    !isCanonicalSafeIntegerToken(
      ordinalTokens[0]!,
      1,
      Number.MAX_SAFE_INTEGER - 1,
    )
  ) {
    throw new Error("invalid-registry");
  }
}

function isCanonicalSafeIntegerToken(
  token: string,
  minimum: number,
  maximum: number,
): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) return false;
  const value = Number(token);
  return (
    Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
