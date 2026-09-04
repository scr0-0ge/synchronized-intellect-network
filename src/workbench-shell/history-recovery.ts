import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  historyRecoveryBounds,
  historyRecoveryProblem,
  type HistoryRecoveryActionResult,
  type HistoryRecoveryBrowseItem,
  type HistoryRecoveryBrowseRequest,
  type HistoryRecoveryBrowseResult,
  type HistoryRecoveryCancelRequest,
  type HistoryRecoveryCancelResult,
  type HistoryRecoveryCounts,
  type HistoryRecoveryGenerationReference,
  type HistoryRecoveryPerformRequest,
  type HistoryRecoveryProblemCode,
  type HistoryRecoverySnapshot,
  type HistoryRecoverySnapshotRequest,
  type HistoryRecoverySnapshotResult,
  type HistoryRecoverySourceSummary,
} from "./history-recovery-contract.ts";
import {
  HistoryRecoveryPrivateReaderError,
  readHistoricalRecoveryInventory,
  type HistoryRecoveryPrivateInventory,
  type HistoryRecoveryPrivateProject,
  type HistoryRecoveryPrivateSession,
} from "./history-recovery-private-reader.ts";
import {
  failedAction,
  reconstructHistoryRecoveryBrowseRequest,
  reconstructHistoryRecoveryCancelRequest,
  reconstructHistoryRecoveryPerformRequest,
  reconstructHistoryRecoverySnapshotRequest,
  unavailableBrowse,
  unavailableSnapshot,
} from "./history-recovery-sanitizer.ts";

export type HistoryRecoverySourceRole = "current" | "historical";

export interface HistoryRecoverySourceCandidate {
  readonly providerClass: string;
  readonly role: HistoryRecoverySourceRole;
  readonly rootPath: string;
}

export interface HistoryRecoverySourceDiscovery {
  discover(): Promise<readonly HistoryRecoverySourceCandidate[]>;
}

export interface HistoryRecoveryExportChoice {
  readonly targetPath: string;
}

export interface HistoryRecoveryExportChooser {
  choose(options: {
    readonly suggestedName: string;
    readonly warning: "The exported copy may contain conversation history and private local metadata.";
  }): Promise<HistoryRecoveryExportChoice | null>;
}

interface HistoryRecoveryOwnerOnlyStorage {
  establish(path: string, kind: "directory" | "file"): Promise<void>;
  verify(path: string, kind: "directory" | "file"): Promise<boolean>;
}

class HistoryRecoveryOwnerOnlyStorageError extends Error {
  constructor() {
    super("owner-only-postcondition-unproved");
    this.name = "HistoryRecoveryOwnerOnlyStorageError";
  }
}

export type HistoryRecoveryPreparationResult =
  | {
      readonly status: "ready" | "partial";
      readonly sourceCount: number;
      readonly captureAttempts: number;
    }
  | {
      readonly status: "unavailable";
      readonly sourceCount: 0;
      readonly captureAttempts: number;
    };

export type HistoryRecoveryExecutionResult =
  | HistoryRecoverySnapshotResult
  | HistoryRecoveryBrowseResult
  | HistoryRecoveryActionResult;

export interface HistoricalRecoveryLibrary {
  prepareLaunch(): Promise<HistoryRecoveryPreparationResult>;
  execute(
    owner: object,
    request:
      | HistoryRecoverySnapshotRequest
      | HistoryRecoveryBrowseRequest
      | HistoryRecoveryPerformRequest
      | unknown,
  ): Promise<HistoryRecoveryExecutionResult>;
  cancel(
    owner: object,
    request: HistoryRecoveryCancelRequest | unknown,
  ): Promise<HistoryRecoveryCancelResult>;
  close(owner?: object): Promise<void>;
}

interface CapturedFile {
  readonly relativePath: string;
  readonly capturePath: string;
  readonly length: number;
  readonly digest: string;
  readonly mode: number;
  readonly mtimeNanoseconds: string;
}

interface PreparedSource {
  readonly id: string;
  readonly providerClass: string;
  readonly role: HistoryRecoverySourceRole;
  readonly sourceOrdinal: number;
  readonly sourceFingerprint: string;
  readonly contentFingerprint: string;
  readonly intakeDirectory: string | null;
  readonly files: readonly CapturedFile[];
  readonly inventory: HistoryRecoveryPrivateInventory | null;
  readonly browseProblem: HistoryRecoveryProblemCode | null;
  readonly captureProblem: HistoryRecoveryProblemCode | null;
  acknowledged: boolean;
  preservedGenerationId: string | null;
  cleanupPending: boolean;
}

interface StoredFile {
  readonly relativePath: string;
  readonly length: number;
  readonly digest: string;
  readonly mode: number;
  readonly mtimeNanoseconds: string;
}

interface CommittedGeneration {
  readonly id: string;
  readonly ordinal: number;
  readonly sourceOrdinal: number;
  readonly sourceFingerprint: string;
  readonly contentFingerprint: string;
  readonly files: readonly StoredFile[];
  readonly inventory: HistoryRecoveryPrivateInventory | null;
  readonly browseProblem: HistoryRecoveryProblemCode | null;
}

interface OwnerState {
  readonly id: string;
  closed: boolean;
  snapshotKey: string | null;
  libraryKey: string | null;
  readonly sources: Map<string, PreparedSource>;
  readonly generations: Map<string, CommittedGeneration>;
  readonly projects: Map<
    string,
    { readonly generation: CommittedGeneration; readonly project: HistoryRecoveryPrivateProject }
  >;
  readonly sessions: Map<
    string,
    { readonly generation: CommittedGeneration; readonly session: HistoryRecoveryPrivateSession }
  >;
  activeReads: number;
  readonly operations: Map<string, OperationRecord>;
  readonly terminalOperations: Map<
    string,
    {
      readonly request: HistoryRecoveryPerformRequest;
      readonly result: HistoryRecoveryActionResult;
    }
  >;
}

interface OperationRecord {
  readonly request: HistoryRecoveryPerformRequest;
  cancelRequested: boolean;
  committed: boolean;
  transitionTail: Promise<void>;
  readonly promise: Promise<HistoryRecoveryActionResult>;
}

interface CaptureIdentity {
  readonly candidate: HistoryRecoverySourceCandidate;
  readonly resolvedPath: string;
  readonly physicalKey: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNanoseconds: string;
  readonly ctimeNanoseconds: string;
}

interface SourceManifestEntry {
  readonly relativePath: string;
  readonly kind: "directory" | "file";
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly length: number;
  readonly mtimeNanoseconds: string;
  readonly ctimeNanoseconds: string;
  readonly birthtimeNanoseconds: string;
}

interface EnumeratedSource {
  readonly files: readonly {
    readonly path: string;
    readonly relativePath: string;
  }[];
  readonly manifest: readonly SourceManifestEntry[];
}

interface CaptureBudget {
  openedBytes: number;
  copiedBytes: number;
}

interface CaptureAttemptResult {
  readonly intakeDirectory: string;
  readonly files: readonly CapturedFile[];
  readonly contentFingerprint: string;
}

interface DurableExportOperation {
  readonly schemaVersion: 1;
  readonly operationKey: string;
  readonly generationId: string;
  readonly state:
    | "registered"
    | "chooser-claimed"
    | "target-authorized"
    | "committed"
    | "chooser-cancelled"
    | "outcome-unknown";
  readonly targetPath: string | null;
  readonly exportDigest: string | null;
}

interface DurableExportCancellation {
  readonly schemaVersion: 1;
  readonly operationKey: string;
  readonly generationId: string;
  readonly cancelled: true;
}

const emptyCounts: HistoryRecoveryCounts = Object.freeze({
  projects: 0,
  sessions: 0,
  commands: 0,
  updates: 0,
});
const exportWarning =
  "The exported copy may contain conversation history and private local metadata." as const;
const ownerDirectoryMode = 0o700;
const ownerFileMode = 0o600;
const durableMetadataMaxBytes = 64 * 1024;

function platformOwnerOnlyStorage(): HistoryRecoveryOwnerOnlyStorage {
  if (process.platform === "win32") {
    return Object.freeze({
      async establish() {
        throw new Error("owner-only-access-control-unavailable");
      },
      async verify() {
        return false;
      },
    });
  }
  return Object.freeze({
    async establish(path: string, kind: "directory" | "file") {
      await chmod(path, kind === "directory" ? ownerDirectoryMode : ownerFileMode);
    },
    async verify(path: string, kind: "directory" | "file") {
      const information = await lstat(path);
      return !information.isSymbolicLink() &&
        (kind === "directory" ? information.isDirectory() : information.isFile()) &&
        (information.mode & 0o077) === 0;
    },
  });
}

export function createHistoricalRecoveryLibrary(options: {
  readonly dataDirectory: string;
  readonly sourceDiscovery: HistoryRecoverySourceDiscovery;
  readonly exportChooser: HistoryRecoveryExportChooser;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly createSecret?: () => Buffer;
  readonly failureInjector?: (point: string) => void | Promise<void>;
  readonly ownerOnlyStorage?: HistoryRecoveryOwnerOnlyStorage;
}): HistoricalRecoveryLibrary {
  const dataDirectory = resolve(options.dataDirectory);
  const intakeRoot = join(dataDirectory, "recovery-intake-v1");
  const libraryRoot = join(dataDirectory, "historical-recovery-library-v1");
  const quarantineRoot = join(dataDirectory, "recovery-quarantine-v1");
  const blobContainerRoot = join(libraryRoot, "blobs");
  const blobRoot = join(blobContainerRoot, "sha256");
  const generationRoot = join(libraryRoot, "generations");
  const acknowledgementRoot = join(libraryRoot, "acknowledgements");
  const operationRoot = join(libraryRoot, "export-operations");
  const secretPath = join(dataDirectory, "history-recovery-secret-v1.bin");
  const createId = options.createId ?? randomUUID;
  const createSecret = options.createSecret ?? (() => randomBytes(32));
  const now = options.now ?? Date.now;
  const ownerOnlyStorage = options.ownerOnlyStorage ?? platformOwnerOnlyStorage();
  const owners = new Map<object, OwnerState>();
  const preparedSources: PreparedSource[] = [];
  const generations: CommittedGeneration[] = [];
  const exportOperations = new Map<string, DurableExportOperation>();
  const exportCancellations = new Map<string, DurableExportCancellation>();
  let secret: Buffer | undefined;
  let preparation: Promise<HistoryRecoveryPreparationResult> | undefined;
  let prepared = false;
  let preparationUnavailable = false;
  let closed = false;
  let mutationTail: Promise<void> = Promise.resolve();
  let captureAttempts = 0;

  const module: HistoricalRecoveryLibrary = Object.freeze({
    prepareLaunch(): Promise<HistoryRecoveryPreparationResult> {
      preparation ??= prepare();
      return preparation;
    },
    async execute(
      owner: object,
      request: unknown,
    ): Promise<HistoryRecoveryExecutionResult> {
      await module.prepareLaunch();
      const snapshotRequest = reconstructHistoryRecoverySnapshotRequest(request);
      if (snapshotRequest.ok) {
        if (closed || preparationUnavailable) {
          return unavailableSnapshot(
            snapshotRequest.value.requestKey,
            closed ? "bridge-closed" : "library-unavailable",
          );
        }
        const state = ownerState(owner);
        if (state.closed) {
          return unavailableSnapshot(
            snapshotRequest.value.requestKey,
            "bridge-closed",
          );
        }
        const snapshot = rotateSnapshot(state);
        return boundedResult(
          Object.freeze({
            version: 1 as const,
            kind: "snapshot" as const,
            requestKey: snapshotRequest.value.requestKey,
            status: preparationStatus() as "ready" | "partial",
            snapshot,
          }),
          () =>
            unavailableSnapshot(
              snapshotRequest.value.requestKey,
              "verification-failed",
            ),
        );
      }
      const browseRequest = reconstructHistoryRecoveryBrowseRequest(request);
      if (browseRequest.ok) {
        return executeBrowse(owner, browseRequest.value);
      }
      const actionRequest = reconstructHistoryRecoveryPerformRequest(request);
      if (actionRequest.ok) {
        return executeAction(owner, actionRequest.value);
      }
      return unavailableSnapshot("history-request-v1-invalid", "invalid-request");
    },
    async cancel(
      owner: object,
      request: unknown,
    ): Promise<HistoryRecoveryCancelResult> {
      const reconstructed = reconstructHistoryRecoveryCancelRequest(request);
      const fallbackRequest = reconstructed.ok
        ? reconstructed.value
        : Object.freeze({
            version: 1 as const,
            requestKey: "history-request-v1-invalid",
            operationKey: "history-operation-v1-invalid",
          });
      const state = owners.get(owner);
      if (!reconstructed.ok || closed || state?.closed !== false) {
        return cancelResult(fallbackRequest, "bridge-closed");
      }
      if (state.terminalOperations.has(reconstructed.value.operationKey)) {
        return cancelResult(reconstructed.value, "already-terminal");
      }
      const operation = state.operations.get(reconstructed.value.operationKey);
      if (operation === undefined) {
        return cancelResult(reconstructed.value, "unknown-request");
      }
      if (operation.committed) {
        return cancelResult(reconstructed.value, "already-terminal");
      }
      try {
        const outcome = await requestOperationCancellation(state, operation);
        return cancelResult(
          reconstructed.value,
          outcome === "committed" ? "already-terminal" : "cancel-requested",
        );
      } catch {
        return cancelResult(reconstructed.value, "bridge-closed");
      }
    },
    async close(owner?: object): Promise<void> {
      if (owner !== undefined) {
        const state = owners.get(owner);
        if (state === undefined || state.closed) return;
        state.closed = true;
        for (const operation of state.operations.values()) {
          if (!operation.committed) {
            await requestOperationCancellation(state, operation).catch(
              () => undefined,
            );
          }
        }
        revokeCapabilities(state);
        owners.delete(owner);
        return;
      }
      if (closed) return;
      closed = true;
      for (const [ownerKey] of owners) await module.close(ownerKey);
      await Promise.race([
        mutationTail.catch(() => undefined),
        new Promise<void>((resolvePromise) => {
          const timer = setTimeout(resolvePromise, historyRecoveryBounds.closeGraceMilliseconds);
          timer.unref?.();
        }),
      ]);
      for (const source of preparedSources) {
        if (source.intakeDirectory !== null) {
          source.cleanupPending = !(await removeOrQuarantine(source.intakeDirectory));
        }
      }
    },
  });

  return module;

  async function prepare(): Promise<HistoryRecoveryPreparationResult> {
    const deadline = now() + historyRecoveryBounds.preparationDeadlineMilliseconds;
    try {
      await Promise.all([
        ensureOwnerDirectory(dataDirectory),
        ensureOwnerDirectory(intakeRoot),
        ensureOwnerDirectory(libraryRoot),
        ensureOwnerDirectory(quarantineRoot),
        ensureOwnerDirectory(blobContainerRoot),
        ensureOwnerDirectory(blobRoot),
        ensureOwnerDirectory(generationRoot),
        ensureOwnerDirectory(acknowledgementRoot),
        ensureOwnerDirectory(operationRoot),
      ]);
      secret = await loadOrCreateSecret();
      await recoverUnpublishedIntake();
      await reassertStoredBlobPostconditions();
      generations.push(...(await loadCommittedGenerations()));
      await loadAcknowledgements();
      await recoverExportOperations();
      assertCaptureDeadline(deadline);
      const candidates = await options.sourceDiscovery.discover();
      assertCaptureDeadline(deadline);
      if (
        !Array.isArray(candidates) ||
        candidates.length > historyRecoveryBounds.maximumPhysicalSources
      ) {
        throw new Error("invalid-source-provider");
      }
      const identities = await discoverPhysicalSources(candidates, deadline);
      let historicalOrdinal = 0;
      let currentOrdinal = 0;
      for (const identity of identities) {
        if (now() > deadline) {
          preparedSources.push(
            unavailablePreparedSource(
              identity,
              identity.candidate.role === "current"
                ? ++currentOrdinal
                : ++historicalOrdinal,
              "source-unavailable",
            ),
          );
          continue;
        }
        const sourceOrdinal = identity.candidate.role === "current"
          ? ++currentOrdinal
          : ++historicalOrdinal;
        const sourceFingerprint = keyedDigest(
          [
            "history-source-v1",
            identity.candidate.providerClass,
            identity.candidate.role,
            identity.device,
            identity.inode,
            identity.resolvedPath,
          ].join("\u0000"),
        );
        let captured: CaptureAttemptResult | undefined;
        let captureProblem: HistoryRecoveryProblemCode = "verification-failed";
        for (
          let attempt = 1;
          attempt <= historyRecoveryBounds.captureAttempts;
          attempt += 1
        ) {
          captureAttempts += 1;
          try {
            assertCaptureDeadline(deadline);
            await inject(`capture:${attempt}:before`);
            assertCaptureDeadline(deadline);
            captured = await captureSource(identity, sourceFingerprint, deadline);
            break;
          } catch (error) {
            captureProblem = captureErrorCode(error);
            await inject(`capture:${attempt}:failed`).catch(() => undefined);
          }
        }
        if (captured === undefined) {
          preparedSources.push(
            unavailablePreparedSource(
              identity,
              sourceOrdinal,
              captureProblem,
              sourceFingerprint,
            ),
          );
          continue;
        }
        let inventory: HistoryRecoveryPrivateInventory | null = null;
        let browseProblem: HistoryRecoveryProblemCode | null = null;
        try {
          inventory = await readHistoricalRecoveryInventory(
            join(captured.intakeDirectory, "raw"),
            { deadline, now },
          );
        } catch (error) {
          if (error instanceof Error && error.message === "capture-deadline") {
            await quarantine(captured.intakeDirectory).catch(() => undefined);
            preparedSources.push(
              unavailablePreparedSource(
                identity,
                sourceOrdinal,
                "source-unavailable",
                sourceFingerprint,
              ),
            );
            continue;
          }
          browseProblem = privateReaderProblem(error);
        }
        const existing = generations.find(
          (generation) =>
            generation.sourceFingerprint === sourceFingerprint &&
            generation.contentFingerprint === captured!.contentFingerprint,
        );
        const source: PreparedSource = {
          id: createId(),
          providerClass: identity.candidate.providerClass,
          role: identity.candidate.role,
          sourceOrdinal,
          sourceFingerprint,
          contentFingerprint: captured.contentFingerprint,
          intakeDirectory: captured.intakeDirectory,
          files: captured.files,
          inventory,
          browseProblem,
          captureProblem: null,
          acknowledged: await acknowledgementExists(
            sourceFingerprint,
            captured.contentFingerprint,
          ),
          preservedGenerationId: existing?.id ?? null,
          cleanupPending: false,
        };
        preparedSources.push(source);
        if (source.role === "current") {
          source.cleanupPending = !(await removeOrQuarantine(captured.intakeDirectory));
        } else if (source.preservedGenerationId !== null || source.acknowledged) {
          source.cleanupPending = !(await removeOrQuarantine(captured.intakeDirectory));
        }
      }
      prepared = true;
      return Object.freeze({
        status: preparationStatus(),
        sourceCount: preparedSources.length,
        captureAttempts,
      });
    } catch {
      prepared = true;
      preparationUnavailable = true;
      return Object.freeze({
        status: "unavailable" as const,
        sourceCount: 0 as const,
        captureAttempts,
      });
    }
  }

  function preparationStatus(): "ready" | "partial" {
    return preparedSources.some(
      (source) =>
        source.captureProblem !== null ||
        source.browseProblem !== null ||
        source.cleanupPending,
    )
      ? "partial"
      : "ready";
  }

  function ownerState(owner: object): OwnerState {
    const existing = owners.get(owner);
    if (existing !== undefined) return existing;
    const created: OwnerState = {
      id: createId(),
      closed: false,
      snapshotKey: null,
      libraryKey: null,
      sources: new Map(),
      generations: new Map(),
      projects: new Map(),
      sessions: new Map(),
      activeReads: 0,
      operations: new Map(),
      terminalOperations: new Map(),
    };
    owners.set(owner, created);
    return created;
  }

  function rotateSnapshot(state: OwnerState): HistoryRecoverySnapshot {
    revokeCapabilities(state);
    const snapshotKey = capability("snapshot");
    const libraryKey = capability("library");
    state.snapshotKey = snapshotKey;
    state.libraryKey = libraryKey;
    const sources: HistoryRecoverySourceSummary[] = [];
    for (const source of preparedSources) {
      const sourceKey = capability("source");
      state.sources.set(sourceKey, source);
      sources.push(publicSource(source, sourceKey));
    }
    return deepFreeze({
      snapshotKey,
      attention:
        generations.length > 0 ||
        sources.some(
          (source) =>
            source.state === "unavailable" ||
            source.state === "cleanup-pending" ||
            (source.role === "historical" && source.action !== "none"),
        ),
      library: {
        libraryKey,
        label: "Historical Recovery Library" as const,
        generationCount: generations.length,
      },
      sources,
    });
  }

  function publicSource(
    source: PreparedSource,
    sourceKey: string,
  ): HistoryRecoverySourceSummary {
    const label = source.role === "current"
      ? `Current store ${source.sourceOrdinal}`
      : `Historical store ${source.sourceOrdinal}`;
    if (source.captureProblem !== null) {
      return Object.freeze({
        sourceKey,
        label,
        role: source.role,
        state: "unavailable" as const,
        action: "none" as const,
        counts: null,
      });
    }
    const counts = source.inventory?.counts ?? emptyCounts;
    if (source.role === "current") {
      return Object.freeze({
        sourceKey,
        label,
        role: "current" as const,
        state: source.cleanupPending ? "cleanup-pending" as const : "current" as const,
        action: "none" as const,
        counts,
      });
    }
    if (source.preservedGenerationId !== null) {
      return Object.freeze({
        sourceKey,
        label,
        role: "historical" as const,
        state: source.cleanupPending
          ? "cleanup-pending" as const
          : "preserved" as const,
        action: "none" as const,
        counts,
      });
    }
    if (source.acknowledged) {
      return Object.freeze({
        sourceKey,
        label,
        role: "historical" as const,
        state: source.cleanupPending
          ? "cleanup-pending" as const
          : "acknowledged" as const,
        action: "none" as const,
        counts,
      });
    }
    if (source.inventory !== null && allCountsZero(source.inventory.counts)) {
      return Object.freeze({
        sourceKey,
        label,
        role: "historical" as const,
        state: "empty" as const,
        action: "acknowledge" as const,
        counts,
      });
    }
    return Object.freeze({
      sourceKey,
      label,
      role: "historical" as const,
      state: "available" as const,
      action: "preserve" as const,
      counts,
    });
  }

  async function executeBrowse(
    owner: object,
    request: HistoryRecoveryBrowseRequest,
  ): Promise<HistoryRecoveryBrowseResult> {
    const state = owners.get(owner);
    if (closed || state === undefined || state.closed) {
      return unavailableBrowse(request.requestKey, "bridge-closed");
    }
    if (request.snapshotKey !== state.snapshotKey) {
      return unavailableBrowse(request.requestKey, "stale-capability", "stale");
    }
    if (state.activeReads >= historyRecoveryBounds.maximumConcurrentReadsPerSender) {
      return unavailableBrowse(request.requestKey, "busy");
    }
    state.activeReads += 1;
    try {
      await inject(`browse:${request.kind}:before`);
      const items: HistoryRecoveryBrowseItem[] = [];
      let parentKey: string;
      if (request.kind === "generations") {
        if (request.libraryKey !== state.libraryKey) {
          return unavailableBrowse(request.requestKey, "stale-capability", "stale");
        }
        parentKey = request.libraryKey;
        for (const generation of generations) {
          const generationKey = capability("generation");
          state.generations.set(generationKey, generation);
          items.push(
            Object.freeze({
              kind: "generation" as const,
              ordinal: generation.ordinal,
              label: `Recovery ${generation.ordinal}`,
              generationKey,
              sourceLabel: `Historical store ${generation.sourceOrdinal}`,
              counts: generation.inventory?.counts ?? emptyCounts,
            }),
          );
        }
      } else if (request.kind === "projects") {
        parentKey = request.generationKey;
        const generation = state.generations.get(request.generationKey);
        if (generation === undefined) {
          return unavailableBrowse(request.requestKey, "stale-capability", "stale");
        }
        if (generation.inventory === null) {
          return unavailableBrowse(
            request.requestKey,
            generation.browseProblem ?? "unsupported-schema",
          );
        }
        generation.inventory.projects.forEach((project, index) => {
          const ordinal = index + 1;
          const projectKey = capability("project");
          state.projects.set(projectKey, { generation, project });
          items.push(
            Object.freeze({
              kind: "project" as const,
              ordinal,
              label: `Project ${ordinal}`,
              projectKey,
              counts: project.counts,
            }),
          );
        });
      } else if (request.kind === "sessions") {
        parentKey = request.projectKey;
        const target = state.projects.get(request.projectKey);
        if (target === undefined) {
          return unavailableBrowse(request.requestKey, "stale-capability", "stale");
        }
        target.project.sessions.forEach((session, index) => {
          const ordinal = index + 1;
          const sessionKey = capability("session");
          state.sessions.set(sessionKey, {
            generation: target.generation,
            session,
          });
          items.push(
            Object.freeze({
              kind: "session" as const,
              ordinal,
              label: `Session ${ordinal}`,
              sessionKey,
              status: session.status,
              commandCount: session.turns.length,
              turnCount: session.turns.length,
            }),
          );
        });
      } else {
        parentKey = request.sessionKey;
        const target = state.sessions.get(request.sessionKey);
        if (target === undefined) {
          return unavailableBrowse(request.requestKey, "stale-capability", "stale");
        }
        target.session.turns.forEach((turn, index) => {
          const ordinal = index + 1;
          items.push(
            Object.freeze({
              kind: "turn" as const,
              ordinal,
              label: `Turn ${ordinal}`,
              status: turn.status,
              eventCount: turn.eventCount,
            }),
          );
        });
      }
      const page = paginate(items, request.page.after, request.page.size);
      return boundedResult(
        Object.freeze({
          version: 1 as const,
          kind: "browse" as const,
          requestKey: request.requestKey,
          status: "ready" as const,
          snapshotKey: request.snapshotKey,
          branch: request.kind,
          parentKey,
          page,
        }),
        () => unavailableBrowse(request.requestKey, "verification-failed"),
      );
    } catch {
      return unavailableBrowse(request.requestKey, "verification-failed");
    } finally {
      state.activeReads -= 1;
    }
  }

  async function executeAction(
    owner: object,
    request: HistoryRecoveryPerformRequest,
  ): Promise<HistoryRecoveryActionResult> {
    const state = owners.get(owner);
    if (closed || state === undefined || state.closed) {
      return failedAction(request, "bridge-closed");
    }
    const existing = state.operations.get(request.operationKey);
    if (existing !== undefined) {
      return samePerformRequest(existing.request, request)
        ? existing.promise
        : failedAction(request, "invalid-request");
    }
    const terminal = state.terminalOperations.get(request.operationKey);
    if (terminal !== undefined) {
      return samePerformRequest(terminal.request, request)
        ? idempotentTerminalResult(terminal.result)
        : failedAction(request, "invalid-request");
    }
    if (request.snapshotKey !== state.snapshotKey) {
      return failedAction(request, "stale-capability");
    }
    let resolveOperation!: (result: HistoryRecoveryActionResult) => void;
    const promise = new Promise<HistoryRecoveryActionResult>((resolvePromise) => {
      resolveOperation = resolvePromise;
    });
    const operation: OperationRecord = {
      request,
      cancelRequested: false,
      committed: false,
      transitionTail: Promise.resolve(),
      promise,
    };
    state.operations.set(request.operationKey, operation);
    const prior = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    void prior
      .catch(() => undefined)
      .then(async () => {
        let result: HistoryRecoveryActionResult;
        try {
          result = await performMutation(state, request, operation);
        } catch (error) {
          result = failedAction(request, mutationErrorCode(error));
        }
        state.operations.delete(request.operationKey);
        state.terminalOperations.set(
          request.operationKey,
          Object.freeze({ request, result }),
        );
        resolveOperation(result);
        release();
      });
    return promise;
  }

  async function performMutation(
    state: OwnerState,
    request: HistoryRecoveryPerformRequest,
    operation: OperationRecord,
  ): Promise<HistoryRecoveryActionResult> {
    if (operation.cancelRequested || state.closed || closed) {
      return await cancelledMutationResult(state, request, operation);
    }
    await inject(`${request.action}:before`);
    if (request.action === "preserve") {
      const source = state.sources.get(request.sourceKey);
      if (
        source === undefined ||
        source.role !== "historical" ||
        source.captureProblem !== null ||
        source.intakeDirectory === null
      ) {
        return failedAction(request, "source-unavailable");
      }
      if (
        source.inventory !== null &&
        allCountsZero(source.inventory.counts)
      ) {
        return failedAction(request, "invalid-request");
      }
      let generation = source.preservedGenerationId === null
        ? undefined
        : generations.find(
            (candidate) => candidate.id === source.preservedGenerationId,
          );
      let status: "preserved" | "already-preserved" = "already-preserved";
      if (generation === undefined) {
        generation = await preserveSource(source, operation);
        status = "preserved";
      }
      operation.committed = true;
      source.preservedGenerationId = generation.id;
      source.cleanupPending = !(await removeOrQuarantine(source.intakeDirectory));
      const snapshot = rotateSnapshot(state);
      const generationKey = capability("generation");
      state.generations.set(generationKey, generation);
      const reference = publicGenerationReference(generation, generationKey);
      return boundedResult(
        Object.freeze({
          version: 1 as const,
          action: "preserve" as const,
          requestKey: request.requestKey,
          operationKey: request.operationKey,
          status,
          snapshot,
          generation: reference,
          cleanup: source.cleanupPending ? "pending" as const : "complete" as const,
        }),
        () => failedAction(request, "verification-failed"),
      );
    }
    if (request.action === "acknowledge") {
      const source = state.sources.get(request.sourceKey);
      if (
        source === undefined ||
        source.role !== "historical" ||
        source.inventory === null ||
        !allCountsZero(source.inventory.counts) ||
        source.intakeDirectory === null
      ) {
        return failedAction(request, "source-unavailable");
      }
      const already = source.acknowledged;
      if (!already) {
        await persistAcknowledgement(source, operation);
        operation.committed = true;
        source.acknowledged = true;
      }
      source.cleanupPending = !(await removeOrQuarantine(source.intakeDirectory));
      const snapshot = rotateSnapshot(state);
      return boundedResult(
        Object.freeze({
          version: 1 as const,
          action: "acknowledge" as const,
          requestKey: request.requestKey,
          operationKey: request.operationKey,
          status: already
            ? "already-acknowledged" as const
            : "acknowledged" as const,
          snapshot,
          cleanup: source.cleanupPending ? "pending" as const : "complete" as const,
        }),
        () => failedAction(request, "verification-failed"),
      );
    }
    if (request.action !== "export-copy") {
      return failedAction(request, "invalid-request");
    }
    const generation = state.generations.get(request.generationKey);
    if (generation === undefined) {
      return failedAction(request, "stale-capability");
    }
    return exportGeneration(state, request, generation, operation);
  }

  async function preserveSource(
    source: PreparedSource,
    operation: OperationRecord,
  ): Promise<CommittedGeneration> {
    const existing = generations.find(
      (generation) =>
        generation.sourceFingerprint === source.sourceFingerprint &&
        generation.contentFingerprint === source.contentFingerprint,
    );
    if (existing !== undefined) return existing;
    const ordinal = Math.max(0, ...generations.map((value) => value.ordinal)) + 1;
    if (ordinal > historyRecoveryBounds.maximumOrdinal) {
      throw new Error("quota-exceeded");
    }
    const generationId = `generation-v1-${createId()}`;
    const generationDirectory = join(generationRoot, generationId);
    await ensureOwnerDirectory(generationDirectory);
    try {
      const storedFiles: StoredFile[] = [];
      for (const file of source.files) {
        if (operation.cancelRequested) throw new Error("cancelled");
        await persistBlob(file);
        storedFiles.push(
          Object.freeze({
            relativePath: file.relativePath,
            length: file.length,
            digest: file.digest,
            mode: file.mode,
            mtimeNanoseconds: file.mtimeNanoseconds,
          }),
        );
      }
      const manifest = deepFreeze({
        schemaVersion: 1 as const,
        generationId,
        ordinal,
        sourceOrdinal: source.sourceOrdinal,
        sourceFingerprint: source.sourceFingerprint,
        contentFingerprint: source.contentFingerprint,
        files: storedFiles,
        inventory: source.inventory,
        browseProblem: source.browseProblem,
      });
      const manifestBytes = canonicalJson(manifest);
      const manifestDigest = digest(manifestBytes);
      await atomicCreateFile(
        join(generationDirectory, "manifest-v1.json"),
        manifestBytes,
      );
      if (operation.cancelRequested) throw new Error("cancelled");
      await inject("preserve:before-receipt");
      if (operation.cancelRequested) throw new Error("cancelled");
      const receipt = deepFreeze({
        schemaVersion: 1 as const,
        generationId,
        ordinal,
        manifestDigest,
        sourceFingerprint: source.sourceFingerprint,
        contentFingerprint: source.contentFingerprint,
      });
      await atomicCreateFile(
        join(generationDirectory, "receipt-v1.json"),
        canonicalJson(receipt),
      );
      operation.committed = true;
      const committed: CommittedGeneration = deepFreeze({
        id: generationId,
        ordinal,
        sourceOrdinal: source.sourceOrdinal,
        sourceFingerprint: source.sourceFingerprint,
        contentFingerprint: source.contentFingerprint,
        files: storedFiles,
        inventory: source.inventory,
        browseProblem: source.browseProblem,
      });
      generations.push(committed);
      generations.sort((left, right) => left.ordinal - right.ordinal);
      return committed;
    } catch (error) {
      if (!operation.committed) await quarantine(generationDirectory);
      throw error;
    }
  }

  async function persistBlob(file: CapturedFile): Promise<void> {
    const destination = join(blobRoot, `${file.digest}.blob`);
    if (await fileExists(destination)) {
      await assertOwnerOnlyPostcondition(destination, "file");
      if (!(await filesEqual(file.capturePath, destination, file.length, file.digest))) {
        throw new Error("blob-collision");
      }
      return;
    }
    const temporary = join(blobRoot, `.blob-${createId()}.temporary`);
    await copyVerifiedFile(file.capturePath, temporary, file.length, file.digest);
    let linked = false;
    try {
      await link(temporary, destination);
      linked = true;
      await assertOwnerOnlyPostcondition(destination, "file");
      await syncDirectory(blobRoot);
    } catch (error) {
      if (linked) {
        await unlink(destination).catch(() => undefined);
        throw error;
      }
      if (!isAlreadyExists(error)) throw error;
      await assertOwnerOnlyPostcondition(destination, "file");
      if (!(await filesEqual(file.capturePath, destination, file.length, file.digest))) {
        throw new Error("blob-collision");
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async function persistAcknowledgement(
    source: PreparedSource,
    operation: OperationRecord,
  ): Promise<void> {
    if (!allCountsZero(source.inventory?.counts ?? emptyCounts)) {
      throw new Error("invalid-acknowledgement");
    }
    const receipt = deepFreeze({
      schemaVersion: 1 as const,
      sourceFingerprint: source.sourceFingerprint,
      contentFingerprint: source.contentFingerprint,
      counts: emptyCounts,
      state: "acknowledged" as const,
    });
    if (operation.cancelRequested) throw new Error("cancelled");
    const path = acknowledgementPath(
      source.sourceFingerprint,
      source.contentFingerprint,
    );
    if (await fileExists(path)) {
      await assertOwnerOnlyPostcondition(path, "file");
      return;
    }
    await atomicCreateFile(path, canonicalJson(receipt));
    operation.committed = true;
  }

  async function exportGeneration(
    state: OwnerState,
    request: Extract<HistoryRecoveryPerformRequest, { action: "export-copy" }>,
    generation: CommittedGeneration,
    operation: OperationRecord,
  ): Promise<HistoryRecoveryActionResult> {
    let journal = await withOperationTransition(operation, async () => {
      if (operation.cancelRequested) {
        await persistExportCancellation(state, operation);
      }
      const current = exportOperations.get(request.operationKey);
      if (exportCancellations.has(request.operationKey)) return current;
      if (current?.state === "target-authorized") {
        const reconciled = await reconcileTargetAuthorized(current, generation);
        await persistExportOperation(reconciled);
        exportOperations.set(request.operationKey, reconciled);
        if (reconciled.state === "committed") operation.committed = true;
        return reconciled;
      }
      return current;
    });
    const durableCancellation = exportCancellations.get(request.operationKey);
    if (durableCancellation !== undefined) {
      return durableCancellation.generationId === generation.id
        ? failedAction(request, "cancelled", "cancelled")
        : failedAction(request, "invalid-request");
    }
    if (journal !== undefined) {
      if (journal.generationId !== generation.id) {
        return failedAction(request, "invalid-request");
      }
      if (journal.state === "committed") {
        operation.committed = true;
        return exportedResult(request, generation, "already-exported");
      }
      if (journal.state === "chooser-cancelled") {
        return Object.freeze({
          version: 1 as const,
          action: "export-copy" as const,
          requestKey: request.requestKey,
          operationKey: request.operationKey,
          status: "chooser-cancelled" as const,
        });
      }
      if (journal.state === "outcome-unknown" || journal.state === "chooser-claimed") {
        return Object.freeze({
          version: 1 as const,
          action: "export-copy" as const,
          requestKey: request.requestKey,
          operationKey: request.operationKey,
          status: "outcome-unknown" as const,
        });
      }
    }
    journal = Object.freeze({
      schemaVersion: 1 as const,
      operationKey: request.operationKey,
      generationId: generation.id,
      state: "registered" as const,
      targetPath: null,
      exportDigest: null,
    });
    journal = await persistExportTransition(state, operation, journal);
    if (await operationIsCancelled(state, operation)) {
      return failedAction(request, "cancelled", "cancelled");
    }
    journal = Object.freeze({ ...journal, state: "chooser-claimed" as const });
    journal = await persistExportTransition(state, operation, journal);
    if (await operationIsCancelled(state, operation)) {
      return failedAction(request, "cancelled", "cancelled");
    }
    try {
      await inject("export:after-chooser-claimed");
    } catch {
      journal = await persistExportTransition(
        state,
        operation,
        Object.freeze({ ...journal, state: "outcome-unknown" as const }),
      ).catch(() => journal!);
      if (await operationIsCancelled(state, operation)) {
        return failedAction(request, "cancelled", "cancelled");
      }
      return Object.freeze({
        version: 1 as const,
        action: "export-copy" as const,
        requestKey: request.requestKey,
        operationKey: request.operationKey,
        status: "outcome-unknown" as const,
      });
    }
    if (await operationIsCancelled(state, operation)) {
      return failedAction(request, "cancelled", "cancelled");
    }
    let choice: HistoryRecoveryExportChoice | null;
    try {
      choice = await options.exportChooser.choose({
        suggestedName: `Recovery ${generation.ordinal}.uawr-history`,
        warning: exportWarning,
      });
    } catch {
      journal = await persistExportTransition(
        state,
        operation,
        Object.freeze({ ...journal, state: "outcome-unknown" as const }),
      ).catch(() => journal!);
      if (await operationIsCancelled(state, operation)) {
        return failedAction(request, "cancelled", "cancelled");
      }
      return Object.freeze({
        version: 1 as const,
        action: "export-copy" as const,
        requestKey: request.requestKey,
        operationKey: request.operationKey,
        status: "outcome-unknown" as const,
      });
    }
    if (await operationIsCancelled(state, operation)) {
      return failedAction(request, "cancelled", "cancelled");
    }
    if (choice === null) {
      journal = Object.freeze({ ...journal, state: "chooser-cancelled" as const });
      journal = await persistExportTransition(state, operation, journal);
      if (await operationIsCancelled(state, operation)) {
        return failedAction(request, "cancelled", "cancelled");
      }
      return Object.freeze({
        version: 1 as const,
        action: "export-copy" as const,
        requestKey: request.requestKey,
        operationKey: request.operationKey,
        status: "chooser-cancelled" as const,
      });
    }
    const targetPath = validateExportTarget(choice.targetPath);
    journal = Object.freeze({
      ...journal,
      state: "target-authorized" as const,
      targetPath,
    });
    journal = await persistExportTransition(state, operation, journal);
    if (await operationIsCancelled(state, operation)) {
      return failedAction(request, "cancelled", "cancelled");
    }
    await inject("export:before-commit");
    await inject("export:commit-entry");
    return withOperationTransition(operation, async () => {
      if (
        operation.cancelRequested ||
        exportCancellations.has(request.operationKey)
      ) {
        await persistExportCancellation(state, operation);
        return failedAction(request, "cancelled", "cancelled");
      }
      const exportDigest = await writeExportBundle(
        generation,
        targetPath,
        request.operationKey,
      );
      journal = Object.freeze({
        ...journal!,
        state: "committed" as const,
        exportDigest,
      });
      await persistExportOperation(journal);
      exportOperations.set(request.operationKey, journal);
      operation.committed = true;
      return exportedResult(request, generation, "exported");
    });
  }

  async function requestOperationCancellation(
    state: OwnerState,
    operation: OperationRecord,
  ): Promise<"cancelled" | "committed"> {
    return withOperationTransition(operation, async () => {
      if (operation.committed) return "committed";
      operation.cancelRequested = true;
      if (operation.request.action === "export-copy") {
        const journal = exportOperations.get(operation.request.operationKey);
        if (journal?.state === "committed") {
          operation.committed = true;
          return "committed";
        }
        await persistExportCancellation(state, operation);
      }
      return "cancelled";
    });
  }

  async function cancelledMutationResult(
    state: OwnerState,
    request: HistoryRecoveryPerformRequest,
    operation: OperationRecord,
  ): Promise<HistoryRecoveryActionResult> {
    if (request.action === "export-copy") {
      try {
        if (!operation.cancelRequested) {
          await requestOperationCancellation(state, operation);
        } else {
          await withOperationTransition(operation, async () => {
            await persistExportCancellation(state, operation);
          });
        }
      } catch {
        return failedAction(request, "verification-failed");
      }
    }
    return failedAction(request, "cancelled", "cancelled");
  }

  async function operationIsCancelled(
    state: OwnerState,
    operation: OperationRecord,
  ): Promise<boolean> {
    return withOperationTransition(operation, async () => {
      if (exportCancellations.has(operation.request.operationKey)) return true;
      if (!operation.cancelRequested) return false;
      await persistExportCancellation(state, operation);
      return true;
    });
  }

  async function persistExportTransition(
    state: OwnerState,
    operation: OperationRecord,
    next: DurableExportOperation,
  ): Promise<DurableExportOperation> {
    return withOperationTransition(operation, async () => {
      if (
        operation.cancelRequested ||
        exportCancellations.has(operation.request.operationKey)
      ) {
        if (operation.cancelRequested) {
          await persistExportCancellation(state, operation);
        }
        return exportOperations.get(operation.request.operationKey) ?? next;
      }
      await persistExportOperation(next);
      exportOperations.set(operation.request.operationKey, next);
      return next;
    });
  }

  async function persistExportCancellation(
    state: OwnerState,
    operation: OperationRecord,
  ): Promise<DurableExportCancellation> {
    if (operation.request.action !== "export-copy") {
      throw new Error("invalid-export-cancellation");
    }
    const current = exportOperations.get(operation.request.operationKey);
    if (current?.state === "committed") {
      throw new Error("export-already-committed");
    }
    const existing = exportCancellations.get(operation.request.operationKey);
    if (existing !== undefined) return existing;
    const generation = state.generations.get(operation.request.generationKey);
    const generationId = current?.generationId ?? generation?.id;
    if (generationId === undefined) {
      throw new Error("invalid-export-cancellation");
    }
    const cancellation = Object.freeze({
      schemaVersion: 1 as const,
      operationKey: operation.request.operationKey,
      generationId,
      cancelled: true as const,
    });
    await atomicReplaceFile(
      exportCancellationPath(operation.request.operationKey),
      canonicalJson(cancellation),
    );
    exportCancellations.set(operation.request.operationKey, cancellation);
    return cancellation;
  }

  async function withOperationTransition<T>(
    operation: OperationRecord,
    action: () => Promise<T>,
  ): Promise<T> {
    const prior = operation.transitionTail;
    let release!: () => void;
    operation.transitionTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await prior.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
    }
  }

  async function captureSource(
    identity: CaptureIdentity,
    sourceFingerprint: string,
    deadline: number,
  ): Promise<CaptureAttemptResult> {
    const attemptDirectory = join(intakeRoot, `capture-v1-${createId()}`);
    const raw = join(attemptDirectory, "raw");
    await ensureOwnerDirectory(attemptDirectory);
    await ensureOwnerDirectory(raw);
    try {
      await assertCaptureRootIdentity(identity, deadline);
      const before = await enumerateSourceFiles(identity.resolvedPath, deadline);
      await inject("capture:after-enumeration");
      assertCaptureDeadline(deadline);
      await assertCaptureRootIdentity(identity, deadline);
      const captured: CapturedFile[] = [];
      const budget: CaptureBudget = { openedBytes: 0, copiedBytes: 0 };
      for (const entry of before.manifest) {
        if (entry.kind === "directory") {
          await ensureOwnerDirectory(safeJoin(raw, entry.relativePath));
        }
      }
      for (const source of before.files) {
        assertCaptureDeadline(deadline);
        const destination = safeJoin(raw, source.relativePath);
        await ensureOwnerDirectory(dirname(destination));
        captured.push(
          await copyStableSourceFile(
            source.path,
            destination,
            source.relativePath,
            deadline,
            budget,
          ),
        );
      }
      await inject("capture:before-reconciliation");
      assertCaptureDeadline(deadline);
      await assertCaptureRootIdentity(identity, deadline);
      const after = await enumerateSourceFiles(identity.resolvedPath, deadline);
      if (!canonicalJson(before.manifest).equals(canonicalJson(after.manifest))) {
        throw new Error("capture-drift");
      }
      await assertCaptureRootIdentity(identity, deadline);
      assertCaptureDeadline(deadline);
      const contentFingerprint = keyedDigest(
        canonicalJson(
          captured.map((file) => ({
            relativePath: file.relativePath,
            length: file.length,
            digest: file.digest,
            mode: file.mode,
            mtimeNanoseconds: file.mtimeNanoseconds,
          })),
        ),
      );
      await atomicCreateFile(
        join(attemptDirectory, "capture-receipt-v1.json"),
        canonicalJson({
          schemaVersion: 1,
          sourceFingerprint,
          contentFingerprint,
          fileCount: captured.length,
        }),
      );
      return Object.freeze({
        intakeDirectory: attemptDirectory,
        files: Object.freeze(captured),
        contentFingerprint,
      });
    } catch (error) {
      await quarantine(attemptDirectory);
      throw error;
    }
  }

  async function enumerateSourceFiles(
    root: string,
    deadline: number,
  ): Promise<EnumeratedSource> {
    const files: Array<{ readonly path: string; readonly relativePath: string }> = [];
    const manifest: SourceManifestEntry[] = [];
    let totalBytes = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      assertCaptureDeadline(deadline);
      if (depth > historyRecoveryBounds.maximumTraversalDepth) {
        throw new Error("quota-exceeded");
      }
      const entries = await readdir(directory, { withFileTypes: true });
      assertCaptureDeadline(deadline);
      entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
      for (const entry of entries) {
        assertCaptureDeadline(deadline);
        const path = join(directory, entry.name);
        const information = await lstat(path, { bigint: true });
        assertCaptureDeadline(deadline);
        if (information.isSymbolicLink()) throw new Error("unsupported-artifact");
        const relativePath = relative(root, path).split(sep).join("/");
        if (!isSafeRelativePath(relativePath)) {
          throw new Error("unsupported-artifact");
        }
        if (manifest.length >= historyRecoveryBounds.maximumFilesPerSource) {
          throw new Error("quota-exceeded");
        }
        if (information.isDirectory()) {
          manifest.push(sourceManifestEntry(relativePath, "directory", information));
          await visit(path, depth + 1);
          continue;
        }
        if (!information.isFile()) throw new Error("unsupported-artifact");
        const length = Number(information.size);
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > historyRecoveryBounds.maximumFileBytes
        ) {
          throw new Error("quota-exceeded");
        }
        totalBytes += length;
        if (
          totalBytes > historyRecoveryBounds.maximumSourceBytes ||
          files.length >= historyRecoveryBounds.maximumFilesPerSource
        ) {
          throw new Error("quota-exceeded");
        }
        manifest.push(sourceManifestEntry(relativePath, "file", information));
        files.push(Object.freeze({ path, relativePath }));
      }
    };
    await visit(root, 0);
    return Object.freeze({
      files: Object.freeze(files),
      manifest: Object.freeze(manifest),
    });
  }

  async function copyStableSourceFile(
    sourcePath: string,
    destinationPath: string,
    relativePath: string,
    deadline: number,
    budget: CaptureBudget,
  ): Promise<CapturedFile> {
    assertCaptureDeadline(deadline);
    const source = await open(sourcePath, "r");
    let destination: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await source.stat({ bigint: true });
      const pathBefore = await lstat(sourcePath, { bigint: true });
      assertCaptureDeadline(deadline);
      if (
        !before.isFile() ||
        !sameFileIdentity(before, pathBefore)
      ) {
        throw new Error("capture-drift");
      }
      if (before.size > BigInt(historyRecoveryBounds.maximumFileBytes)) {
        throw new Error("quota-exceeded");
      }
      const openedLength = Number(before.size);
      if (!Number.isSafeInteger(openedLength) || openedLength < 0) {
        throw new Error("quota-exceeded");
      }
      budget.openedBytes += openedLength;
      if (budget.openedBytes > historyRecoveryBounds.maximumSourceBytes) {
        throw new Error("quota-exceeded");
      }
      destination = await open(destinationPath, "wx", ownerFileMode);
      await assertOwnerOnlyPostcondition(destinationPath, "file");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < Number(before.size)) {
        assertCaptureDeadline(deadline);
        const requested = Math.min(buffer.length, Number(before.size) - position);
        const read = await source.read(buffer, 0, requested, position);
        if (read.bytesRead <= 0) throw new Error("capture-drift");
        budget.copiedBytes += read.bytesRead;
        if (budget.copiedBytes > historyRecoveryBounds.maximumSourceBytes) {
          throw new Error("quota-exceeded");
        }
        const chunk = buffer.subarray(0, read.bytesRead);
        await destination.write(chunk, 0, chunk.length, position);
        hash.update(chunk);
        position += read.bytesRead;
        await inject("capture:file:chunk");
        assertCaptureDeadline(deadline);
      }
      await destination.sync();
      await inject("capture:file:after-copy");
      const after = await source.stat({ bigint: true });
      const pathAfter = await lstat(sourcePath, { bigint: true });
      if (
        !sameStableFile(before, after) ||
        !sameFileIdentity(after, pathAfter) ||
        position !== Number(before.size)
      ) {
        throw new Error("capture-drift");
      }
      return Object.freeze({
        relativePath,
        capturePath: destinationPath,
        length: position,
        digest: hash.digest("hex"),
        mode: Number(before.mode & 0o777n),
        mtimeNanoseconds: before.mtimeNs.toString(),
      });
    } catch (error) {
      if (isMissing(error)) throw new Error("capture-drift");
      throw error;
    } finally {
      await destination?.close().catch(() => undefined);
      await source.close().catch(() => undefined);
    }
  }

  async function discoverPhysicalSources(
    candidates: readonly HistoryRecoverySourceCandidate[],
    deadline: number,
  ): Promise<readonly CaptureIdentity[]> {
    const identities: CaptureIdentity[] = [];
    for (const candidate of candidates) {
      assertCaptureDeadline(deadline);
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        (candidate.role !== "current" && candidate.role !== "historical") ||
        typeof candidate.providerClass !== "string" ||
        !/^[a-z0-9-]{1,64}$/u.test(candidate.providerClass) ||
        typeof candidate.rootPath !== "string" ||
        !isAbsolute(candidate.rootPath)
      ) {
        throw new Error("invalid-source-provider");
      }
      try {
        const lexical = resolve(candidate.rootPath);
        const information = await lstat(lexical, { bigint: true });
        assertCaptureDeadline(deadline);
        if (!information.isDirectory() || information.isSymbolicLink()) continue;
        const resolvedPath = await realpath(lexical);
        const resolvedInformation = await lstat(resolvedPath, { bigint: true });
        const lexicalAfter = await lstat(lexical, { bigint: true });
        assertCaptureDeadline(deadline);
        if (
          !resolvedInformation.isDirectory() ||
          resolvedInformation.isSymbolicLink() ||
          !lexicalAfter.isDirectory() ||
          lexicalAfter.isSymbolicLink() ||
          !sameFileIdentity(information, lexicalAfter) ||
          !sameFileIdentity(lexicalAfter, resolvedInformation)
        ) {
          continue;
        }
        const device = resolvedInformation.dev.toString();
        const inode = resolvedInformation.ino.toString();
        const physicalKey =
          inode === "0"
            ? normalizePhysicalPath(resolvedPath)
            : `${device}:${inode}`;
        identities.push(
          Object.freeze({
            candidate: Object.freeze({ ...candidate, rootPath: lexical }),
            resolvedPath,
            physicalKey,
            device,
            inode,
            birthtimeNanoseconds: resolvedInformation.birthtimeNs.toString(),
            ctimeNanoseconds: resolvedInformation.ctimeNs.toString(),
          }),
        );
      } catch (error) {
        if (isMissing(error)) continue;
        const syntheticIdentity = keyedDigest(
          `${candidate.providerClass}\u0000${candidate.role}\u0000${candidate.rootPath}`,
        );
        identities.push(
          Object.freeze({
            candidate,
            resolvedPath: resolve(candidate.rootPath),
            physicalKey: `unavailable:${syntheticIdentity}`,
            device: "unavailable",
            inode: syntheticIdentity,
            birthtimeNanoseconds: "unavailable",
            ctimeNanoseconds: "unavailable",
          }),
        );
      }
    }
    const deduplicated = new Map<string, CaptureIdentity>();
    for (const identity of identities) {
      const prior = deduplicated.get(identity.physicalKey);
      if (
        prior === undefined ||
        (prior.candidate.role === "historical" &&
          identity.candidate.role === "current")
      ) {
        deduplicated.set(identity.physicalKey, identity);
      }
    }
    return Object.freeze([
      ...[...deduplicated.values()].filter(
        (identity) => identity.candidate.role === "current",
      ),
      ...[...deduplicated.values()].filter(
        (identity) => identity.candidate.role === "historical",
      ),
    ]);
  }

  async function assertCaptureRootIdentity(
    identity: CaptureIdentity,
    deadline: number,
  ): Promise<void> {
    try {
      assertCaptureDeadline(deadline);
      const lexical = identity.candidate.rootPath;
      const before = await lstat(lexical, { bigint: true });
      const reboundPath = await realpath(lexical);
      const rebound = await lstat(reboundPath, { bigint: true });
      const after = await lstat(lexical, { bigint: true });
      assertCaptureDeadline(deadline);
      if (
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        !rebound.isDirectory() ||
        rebound.isSymbolicLink() ||
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        !sameFileIdentity(before, after) ||
        !sameFileIdentity(after, rebound) ||
        normalizePhysicalPath(reboundPath) !==
          normalizePhysicalPath(identity.resolvedPath) ||
        rebound.dev.toString() !== identity.device ||
        rebound.ino.toString() !== identity.inode ||
        rebound.birthtimeNs.toString() !== identity.birthtimeNanoseconds ||
        rebound.ctimeNs.toString() !== identity.ctimeNanoseconds
      ) {
        throw new Error("capture-drift");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "capture-deadline") {
        throw error;
      }
      throw new Error("capture-drift");
    }
  }

  function sourceManifestEntry(
    relativePath: string,
    kind: "directory" | "file",
    information: {
      readonly dev: bigint;
      readonly ino: bigint;
      readonly mode: bigint;
      readonly size: bigint;
      readonly mtimeNs: bigint;
      readonly ctimeNs: bigint;
      readonly birthtimeNs: bigint;
    },
  ): SourceManifestEntry {
    const length = Number(information.size);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error("quota-exceeded");
    }
    return Object.freeze({
      relativePath,
      kind,
      device: information.dev.toString(),
      inode: information.ino.toString(),
      mode: Number(information.mode & 0o7777n),
      length,
      mtimeNanoseconds: information.mtimeNs.toString(),
      ctimeNanoseconds: information.ctimeNs.toString(),
      birthtimeNanoseconds: information.birthtimeNs.toString(),
    });
  }

  function unavailablePreparedSource(
    identity: CaptureIdentity,
    sourceOrdinal: number,
    problem: HistoryRecoveryProblemCode,
    sourceFingerprint = keyedDigest(
      `${identity.candidate.providerClass}\u0000${identity.physicalKey}`,
    ),
  ): PreparedSource {
    return {
      id: createId(),
      providerClass: identity.candidate.providerClass,
      role: identity.candidate.role,
      sourceOrdinal,
      sourceFingerprint,
      contentFingerprint: keyedDigest(`unavailable\u0000${sourceFingerprint}`),
      intakeDirectory: null,
      files: Object.freeze([]),
      inventory: null,
      browseProblem: null,
      captureProblem: problem,
      acknowledged: false,
      preservedGenerationId: null,
      cleanupPending: false,
    };
  }

  async function loadOrCreateSecret(): Promise<Buffer> {
    try {
      await assertOwnerOnlyPostcondition(secretPath, "file");
      const existing = await readFile(secretPath);
      if (existing.length !== 32) throw new Error("invalid-secret");
      return existing;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const created = createSecret();
      if (!Buffer.isBuffer(created) || created.length !== 32) {
        throw new Error("invalid-secret");
      }
      try {
        await atomicCreateFile(secretPath, created);
        return created;
      } catch (createError) {
        if (!isAlreadyExists(createError)) throw createError;
        await assertOwnerOnlyPostcondition(secretPath, "file");
        const raced = await readFile(secretPath);
        if (raced.length !== 32) throw new Error("invalid-secret");
        return raced;
      }
    }
  }

  async function recoverUnpublishedIntake(): Promise<void> {
    const entries = await readdir(intakeRoot, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(intakeRoot, entry.name);
      await quarantine(path);
    }
  }

  async function reassertStoredBlobPostconditions(): Promise<void> {
    const entries = await readdir(blobRoot, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(blobRoot, entry.name);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !/^[0-9a-f]{64}\.blob$/u.test(entry.name)
      ) {
        await quarantine(path);
        continue;
      }
      await assertOwnerOnlyPostcondition(path, "file");
    }
  }

  async function loadCommittedGenerations(): Promise<CommittedGeneration[]> {
    const loaded: CommittedGeneration[] = [];
    const entries = await readdir(generationRoot, { withFileTypes: true });
    for (const entry of entries) {
      const directory = join(generationRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        await quarantine(directory);
        continue;
      }
      try {
        loaded.push(await validateCommittedGeneration(directory));
      } catch (error) {
        if (error instanceof HistoryRecoveryOwnerOnlyStorageError) throw error;
        await quarantine(directory);
      }
    }
    loaded.sort((left, right) => left.ordinal - right.ordinal);
    if (
      new Set(loaded.map((generation) => generation.ordinal)).size !== loaded.length ||
      new Set(loaded.map((generation) => generation.id)).size !== loaded.length
    ) {
      throw new Error("duplicate-generation");
    }
    return loaded;
  }

  async function validateCommittedGeneration(
    directory: string,
  ): Promise<CommittedGeneration> {
    await ensureOwnerDirectory(directory);
    const generationEntries = await readdir(directory, { withFileTypes: true });
    generationEntries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    if (
      generationEntries.length !== 2 ||
      generationEntries[0]?.name !== "manifest-v1.json" ||
      generationEntries[1]?.name !== "receipt-v1.json" ||
      generationEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    ) {
      throw new Error("invalid-generation");
    }
    const manifestPath = join(directory, "manifest-v1.json");
    const receiptPath = join(directory, "receipt-v1.json");
    await Promise.all([
      assertOwnerOnlyPostcondition(manifestPath, "file"),
      assertOwnerOnlyPostcondition(receiptPath, "file"),
    ]);
    const [manifestInformation, receiptInformation] = await Promise.all([
      lstat(manifestPath),
      lstat(receiptPath),
    ]);
    if (
      manifestInformation.size > 256 * 1_024 * 1_024 ||
      receiptInformation.size > 64 * 1_024
    ) {
      throw new Error("invalid-generation");
    }
    const [manifestBytes, receiptBytes] = await Promise.all([
      readFile(manifestPath),
      readFile(receiptPath),
    ]);
    const receiptValue = JSON.parse(receiptBytes.toString("utf8")) as unknown;
    const manifestValue = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    const receipt = exactPlainObject(
      receiptValue,
      [
        "contentFingerprint",
        "generationId",
        "manifestDigest",
        "ordinal",
        "schemaVersion",
        "sourceFingerprint",
      ],
    );
    const manifest = exactPlainObject(
      manifestValue,
      [
        "browseProblem",
        "contentFingerprint",
        "files",
        "generationId",
        "inventory",
        "ordinal",
        "schemaVersion",
        "sourceFingerprint",
        "sourceOrdinal",
      ],
    );
    if (
      receipt === undefined ||
      manifest === undefined ||
      !canonicalJson(receiptValue).equals(receiptBytes) ||
      !canonicalJson(manifestValue).equals(manifestBytes) ||
      receipt.schemaVersion !== 1 ||
      manifest.schemaVersion !== 1 ||
      typeof receipt.generationId !== "string" ||
      !/^generation-v1-[0-9a-f-]{36}$/u.test(receipt.generationId) ||
      receipt.generationId !== manifest.generationId ||
      receipt.generationId !== directory.split(/[\\/]/u).at(-1) ||
      typeof receipt.manifestDigest !== "string" ||
      receipt.manifestDigest !== digest(manifestBytes) ||
      receipt.ordinal !== manifest.ordinal ||
      receipt.sourceFingerprint !== manifest.sourceFingerprint ||
      receipt.contentFingerprint !== manifest.contentFingerprint ||
      !Number.isSafeInteger(manifest.ordinal) ||
      (manifest.ordinal as number) < 1 ||
      !Number.isSafeInteger(manifest.sourceOrdinal) ||
      (manifest.sourceOrdinal as number) < 1 ||
      typeof manifest.sourceFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(manifest.sourceFingerprint) ||
      typeof manifest.contentFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(manifest.contentFingerprint) ||
      !Array.isArray(manifest.files) ||
      manifest.files.length > historyRecoveryBounds.maximumFilesPerSource
    ) {
      throw new Error("invalid-generation");
    }
    const files: StoredFile[] = [];
    let totalBytes = 0;
    for (const value of manifest.files) {
      const file = exactPlainObject(value, [
        "digest",
        "length",
        "mode",
        "mtimeNanoseconds",
        "relativePath",
      ]);
      if (
        file === undefined ||
        typeof file.relativePath !== "string" ||
        !isSafeRelativePath(file.relativePath) ||
        typeof file.digest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(file.digest) ||
        !Number.isSafeInteger(file.length) ||
        (file.length as number) < 0 ||
        (file.length as number) > historyRecoveryBounds.maximumFileBytes ||
        !Number.isSafeInteger(file.mode) ||
        (file.mode as number) < 0 ||
        (file.mode as number) > 0o7777 ||
        typeof file.mtimeNanoseconds !== "string" ||
        !/^(0|[1-9][0-9]{0,31})$/u.test(file.mtimeNanoseconds)
      ) {
        throw new Error("invalid-generation");
      }
      totalBytes += file.length as number;
      if (totalBytes > historyRecoveryBounds.maximumSourceBytes) {
        throw new Error("invalid-generation");
      }
      const blob = join(blobRoot, `${file.digest}.blob`);
      await assertOwnerOnlyPostcondition(blob, "file");
      if (!(await verifyFile(blob, file.length as number, file.digest))) {
        throw new Error("invalid-blob");
      }
      files.push(
        Object.freeze({
          relativePath: file.relativePath,
          length: file.length as number,
          digest: file.digest,
          mode: file.mode as number,
          mtimeNanoseconds: file.mtimeNanoseconds,
        }),
      );
    }
    if (new Set(files.map((file) => file.relativePath)).size !== files.length) {
      throw new Error("invalid-generation");
    }
    const inventory = validatePrivateInventory(manifest.inventory);
    const browseProblem = manifest.browseProblem;
    if (
      inventory === undefined ||
      ((inventory === null) !== (browseProblem !== null)) ||
      (browseProblem !== null &&
        browseProblem !== "unsupported-artifact" &&
        browseProblem !== "unsupported-schema" &&
        browseProblem !== "verification-failed")
    ) {
      throw new Error("invalid-generation");
    }
    return deepFreeze({
      id: receipt.generationId,
      ordinal: manifest.ordinal as number,
      sourceOrdinal: manifest.sourceOrdinal as number,
      sourceFingerprint: manifest.sourceFingerprint,
      contentFingerprint: manifest.contentFingerprint,
      files,
      inventory,
      browseProblem: browseProblem as HistoryRecoveryProblemCode | null,
    });
  }

  async function loadAcknowledgements(): Promise<void> {
    // Receipts are matched to captures after discovery. Invalid entries stay private and inert.
    const entries = await readdir(acknowledgementRoot, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(acknowledgementRoot, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        await quarantine(path);
        continue;
      }
      await assertOwnerOnlyPostcondition(path, "file");
    }
  }

  async function acknowledgementExists(
    sourceFingerprint: string,
    contentFingerprint: string,
  ): Promise<boolean> {
    const path = acknowledgementPath(sourceFingerprint, contentFingerprint);
    try {
      const { value: parsed } = await readCanonicalMetadata(path);
      const value = exactPlainObject(parsed, [
        "contentFingerprint",
        "counts",
        "schemaVersion",
        "sourceFingerprint",
        "state",
      ]);
      return value !== undefined &&
        value.schemaVersion === 1 &&
        value.sourceFingerprint === sourceFingerprint &&
        value.contentFingerprint === contentFingerprint &&
        value.state === "acknowledged" &&
        validateCounts(value.counts) !== undefined &&
        canonicalJson(value.counts).equals(canonicalJson(emptyCounts));
    } catch (error) {
      if (error instanceof HistoryRecoveryOwnerOnlyStorageError) throw error;
      return false;
    }
  }

  function acknowledgementPath(
    sourceFingerprint: string,
    contentFingerprint: string,
  ): string {
    return join(
      acknowledgementRoot,
      `${keyedDigest(`${sourceFingerprint}\u0000${contentFingerprint}`)}.json`,
    );
  }

  async function recoverExportOperations(): Promise<void> {
    const entries = await readdir(operationRoot, { withFileTypes: true });
    let unsafeJournalFound = false;
    for (const entry of entries.filter((value) =>
      value.name.endsWith(".cancel-v1.json")
    )) {
      const path = join(operationRoot, entry.name);
      try {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error("invalid-export-cancellation");
        }
        const { value } = await readCanonicalMetadata(path);
        const cancellation = validateExportCancellation(value);
        if (
          entry.name !==
            `${keyedDigest(cancellation.operationKey)}.cancel-v1.json` ||
          !generations.some(
            (generation) => generation.id === cancellation.generationId,
          )
        ) {
          throw new Error("invalid-export-cancellation");
        }
        exportCancellations.set(cancellation.operationKey, cancellation);
      } catch (error) {
        if (error instanceof HistoryRecoveryOwnerOnlyStorageError) throw error;
        await quarantine(path);
        unsafeJournalFound = true;
      }
    }
    for (const entry of entries) {
      if (entry.name.endsWith(".cancel-v1.json")) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
        await quarantine(join(operationRoot, entry.name));
        unsafeJournalFound = true;
        continue;
      }
      const path = join(operationRoot, entry.name);
      try {
        const { value } = await readCanonicalMetadata(path);
        let operation = validateExportOperation(value);
        if (
          entry.name !== `${keyedDigest(operation.operationKey)}.json` ||
          !generations.some((generation) => generation.id === operation.generationId)
        ) {
          throw new Error("invalid-export-operation");
        }
        const cancellation = exportCancellations.get(operation.operationKey);
        if (
          cancellation !== undefined &&
          (cancellation.generationId !== operation.generationId ||
            operation.state === "committed")
        ) {
          throw new Error("invalid-export-cancellation");
        }
        if (cancellation !== undefined) {
          exportOperations.set(operation.operationKey, operation);
          continue;
        }
        if (operation.state === "chooser-claimed") {
          operation = Object.freeze({
            ...operation,
            state: "outcome-unknown" as const,
          });
          await persistExportOperation(operation);
        } else if (operation.state === "target-authorized") {
          const generation = generations.find(
            (candidate) => candidate.id === operation.generationId,
          );
          operation = await reconcileTargetAuthorized(operation, generation!);
          await persistExportOperation(operation);
        }
        exportOperations.set(operation.operationKey, operation);
      } catch (error) {
        if (error instanceof HistoryRecoveryOwnerOnlyStorageError) throw error;
        await quarantine(path);
        unsafeJournalFound = true;
      }
    }
    if (unsafeJournalFound) throw new Error("invalid-export-operation-journal");
  }

  async function reconcileTargetAuthorized(
    operation: DurableExportOperation,
    generation: CommittedGeneration,
  ): Promise<DurableExportOperation> {
    if (operation.targetPath === null) {
      return Object.freeze({ ...operation, state: "outcome-unknown" as const });
    }
    if (await fileExists(operation.targetPath)) {
      const exportDigest = await verifyExportBundle(
        operation.targetPath,
        generation,
      );
      if (exportDigest === null) {
        return Object.freeze({ ...operation, state: "outcome-unknown" as const });
      }
      return Object.freeze({
        ...operation,
        state: "committed" as const,
        exportDigest,
      });
    }
    try {
      const exportDigest = await writeExportBundle(
        generation,
        operation.targetPath,
        operation.operationKey,
      );
      return Object.freeze({
        ...operation,
        state: "committed" as const,
        exportDigest,
      });
    } catch {
      return Object.freeze({ ...operation, state: "outcome-unknown" as const });
    }
  }

  async function persistExportOperation(
    operation: DurableExportOperation,
  ): Promise<void> {
    const path = exportOperationPath(operation.operationKey);
    await atomicReplaceFile(path, canonicalJson(operation));
  }

  function exportOperationPath(operationKey: string): string {
    return join(operationRoot, `${keyedDigest(operationKey)}.json`);
  }

  function exportCancellationPath(operationKey: string): string {
    return join(
      operationRoot,
      `${keyedDigest(operationKey)}.cancel-v1.json`,
    );
  }

  async function readCanonicalMetadata(
    path: string,
  ): Promise<Readonly<{ bytes: Buffer; value: unknown }>> {
    await assertOwnerOnlyPostcondition(path, "file");
    const handle = await open(path, "r");
    try {
      const before = await handle.stat({ bigint: true });
      const pathBefore = await lstat(path, { bigint: true });
      if (
        !before.isFile() ||
        !pathBefore.isFile() ||
        pathBefore.isSymbolicLink() ||
        before.size > BigInt(durableMetadataMaxBytes) ||
        !sameFileIdentity(before, pathBefore)
      ) {
        throw new Error("invalid-durable-metadata");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const pathAfter = await lstat(path, { bigint: true });
      if (
        bytes.length > durableMetadataMaxBytes ||
        !sameStableFile(before, after) ||
        !sameFileIdentity(after, pathAfter) ||
        pathAfter.isSymbolicLink()
      ) {
        throw new Error("unstable-durable-metadata");
      }
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!canonicalJson(value).equals(bytes)) {
        throw new Error("non-canonical-durable-metadata");
      }
      return Object.freeze({ bytes, value });
    } finally {
      await handle.close();
    }
  }

  function validateExportOperation(value: unknown): DurableExportOperation {
    const record = exactPlainObject(value, [
      "exportDigest",
      "generationId",
      "operationKey",
      "schemaVersion",
      "state",
      "targetPath",
    ]);
    if (
      record === undefined ||
      record.schemaVersion !== 1 ||
      typeof record.operationKey !== "string" ||
      !/^[A-Za-z0-9:_-]{1,160}$/u.test(record.operationKey) ||
      typeof record.generationId !== "string" ||
      !/^generation-v1-[0-9a-f-]{36}$/u.test(record.generationId) ||
      (record.state !== "registered" &&
        record.state !== "chooser-claimed" &&
        record.state !== "target-authorized" &&
        record.state !== "committed" &&
        record.state !== "chooser-cancelled" &&
        record.state !== "outcome-unknown") ||
      (record.targetPath !== null && typeof record.targetPath !== "string") ||
      (record.exportDigest !== null &&
        (typeof record.exportDigest !== "string" ||
          !/^[0-9a-f]{64}$/u.test(record.exportDigest))) ||
      ((record.state === "registered" ||
        record.state === "chooser-claimed" ||
        record.state === "chooser-cancelled") &&
        (record.targetPath !== null || record.exportDigest !== null)) ||
      (record.state === "target-authorized" &&
        (typeof record.targetPath !== "string" || record.exportDigest !== null)) ||
      (record.state === "committed" &&
        (typeof record.targetPath !== "string" ||
          typeof record.exportDigest !== "string")) ||
      (typeof record.targetPath === "string" &&
        validateDurableExportTarget(record.targetPath) !== record.targetPath)
    ) {
      throw new Error("invalid-export-operation");
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      operationKey: record.operationKey,
      generationId: record.generationId,
      state: record.state,
      targetPath: record.targetPath,
      exportDigest: record.exportDigest,
    }) as DurableExportOperation;
  }

  function validateExportCancellation(
    value: unknown,
  ): DurableExportCancellation {
    const record = exactPlainObject(value, [
      "cancelled",
      "generationId",
      "operationKey",
      "schemaVersion",
    ]);
    if (
      record === undefined ||
      record.schemaVersion !== 1 ||
      record.cancelled !== true ||
      typeof record.operationKey !== "string" ||
      !/^[A-Za-z0-9:_-]{1,160}$/u.test(record.operationKey) ||
      typeof record.generationId !== "string" ||
      !/^generation-v1-[0-9a-f-]{36}$/u.test(record.generationId)
    ) {
      throw new Error("invalid-export-cancellation");
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      operationKey: record.operationKey,
      generationId: record.generationId,
      cancelled: true as const,
    });
  }

  async function writeExportBundle(
    generation: CommittedGeneration,
    targetPath: string,
    operationKey: string,
  ): Promise<string> {
    const targetDirectory = dirname(targetPath);
    const stagingPath = join(
      targetDirectory,
      `.uaw-history-export-${keyedDigest(operationKey).slice(0, 24)}.temporary`,
    );
    await rm(stagingPath, { force: true }).catch(() => undefined);
    const handle = await open(stagingPath, "wx", ownerFileMode);
    let targetLinked = false;
    const hash = createHash("sha256");
    let position = 0;
    const write = async (bytes: Buffer): Promise<void> => {
      await handle.write(bytes, 0, bytes.length, position);
      hash.update(bytes);
      position += bytes.length;
    };
    try {
      await assertOwnerOnlyPostcondition(stagingPath, "file");
      const bundleManifest = exportBundleManifest(generation);
      await write(Buffer.from("UAWR-HISTORY-1\n", "utf8"));
      await write(Buffer.from(`${bundleManifest.length}\n`, "utf8"));
      await write(bundleManifest);
      await write(Buffer.from("\n", "utf8"));
      for (const file of generation.files) {
        const blobPath = join(blobRoot, `${file.digest}.blob`);
        await assertOwnerOnlyPostcondition(blobPath, "file");
        const source = await open(blobPath, "r");
        try {
          const buffer = Buffer.allocUnsafe(1024 * 1024);
          let sourcePosition = 0;
          const fileHash = createHash("sha256");
          while (sourcePosition < file.length) {
            const requested = Math.min(buffer.length, file.length - sourcePosition);
            const read = await source.read(buffer, 0, requested, sourcePosition);
            if (read.bytesRead <= 0) throw new Error("invalid-blob");
            const chunk = buffer.subarray(0, read.bytesRead);
            fileHash.update(chunk);
            await write(chunk);
            sourcePosition += read.bytesRead;
          }
          if (fileHash.digest("hex") !== file.digest) {
            throw new Error("invalid-blob");
          }
        } finally {
          await source.close();
        }
      }
      await handle.sync();
      await handle.close();
      await link(stagingPath, targetPath);
      targetLinked = true;
      await assertOwnerOnlyPostcondition(targetPath, "file");
      await unlink(stagingPath);
      await syncDirectory(targetDirectory);
      return hash.digest("hex");
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (targetLinked) await unlink(targetPath).catch(() => undefined);
      await rm(stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  function exportBundleManifest(generation: CommittedGeneration): Buffer {
    return canonicalJson({
      schemaVersion: 1,
      generation: `Recovery ${generation.ordinal}`,
      files: generation.files.map((file) => ({
        relativePath: file.relativePath,
        length: file.length,
        digest: file.digest,
        mode: file.mode,
        mtimeNanoseconds: file.mtimeNanoseconds,
      })),
    });
  }

  async function verifyExportBundle(
    targetPath: string,
    generation: CommittedGeneration,
  ): Promise<string | null> {
    const magic = Buffer.from("UAWR-HISTORY-1\n", "utf8");
    const manifest = exportBundleManifest(generation);
    const lengthLine = Buffer.from(`${manifest.length}\n`, "utf8");
    const separator = Buffer.from("\n", "utf8");
    const expectedLength =
      magic.length +
      lengthLine.length +
      manifest.length +
      separator.length +
      generation.files.reduce((sum, file) => sum + file.length, 0);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const metadata = await lstat(targetPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size !== expectedLength
      ) {
        return null;
      }
      handle = await open(targetPath, "r");
      const wholeHash = createHash("sha256");
      let position = 0;
      const verifyExpected = async (expected: Buffer): Promise<boolean> => {
        const actual = Buffer.allocUnsafe(expected.length);
        const read = await handle!.read(actual, 0, actual.length, position);
        if (read.bytesRead !== actual.length || !actual.equals(expected)) return false;
        wholeHash.update(actual);
        position += actual.length;
        return true;
      };
      if (
        !(await verifyExpected(magic)) ||
        !(await verifyExpected(lengthLine)) ||
        !(await verifyExpected(manifest)) ||
        !(await verifyExpected(separator))
      ) {
        return null;
      }
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (const file of generation.files) {
        const fileHash = createHash("sha256");
        let remaining = file.length;
        while (remaining > 0) {
          const requested = Math.min(buffer.length, remaining);
          const read = await handle.read(buffer, 0, requested, position);
          if (read.bytesRead !== requested) return null;
          const chunk = buffer.subarray(0, read.bytesRead);
          fileHash.update(chunk);
          wholeHash.update(chunk);
          position += read.bytesRead;
          remaining -= read.bytesRead;
        }
        if (fileHash.digest("hex") !== file.digest) return null;
      }
      return position === expectedLength ? wholeHash.digest("hex") : null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  function validateExportTarget(value: string): string {
    const target = validateDurableExportTarget(value);
    if (target === null) throw new Error("invalid-export-target");
    return target;
  }

  function validateDurableExportTarget(value: string): string | null {
    if (!isAbsolute(value) || value.includes("\u0000")) return null;
    const target = resolve(value);
    return target === resolve(dirname(target)) ? null : target;
  }

  function exportedResult(
    request: Extract<HistoryRecoveryPerformRequest, { action: "export-copy" }>,
    generation: CommittedGeneration,
    status: "exported" | "already-exported",
  ): HistoryRecoveryActionResult {
    return Object.freeze({
      version: 1 as const,
      action: "export-copy" as const,
      requestKey: request.requestKey,
      operationKey: request.operationKey,
      status,
      export: Object.freeze({
        label: `Recovery export ${generation.ordinal}`,
        warning: exportWarning,
      }),
    });
  }

  function idempotentTerminalResult(
    result: HistoryRecoveryActionResult,
  ): HistoryRecoveryActionResult {
    if (result.action === "preserve" && result.status === "preserved") {
      return Object.freeze({ ...result, status: "already-preserved" as const });
    }
    if (
      result.action === "acknowledge" &&
      result.status === "acknowledged"
    ) {
      return Object.freeze({
        ...result,
        status: "already-acknowledged" as const,
      });
    }
    if (result.action === "export-copy" && result.status === "exported") {
      return Object.freeze({ ...result, status: "already-exported" as const });
    }
    return result;
  }

  function samePerformRequest(
    left: HistoryRecoveryPerformRequest,
    right: HistoryRecoveryPerformRequest,
  ): boolean {
    return canonicalJson(left).equals(canonicalJson(right));
  }

  function publicGenerationReference(
    generation: CommittedGeneration,
    generationKey: string,
  ): HistoryRecoveryGenerationReference {
    return Object.freeze({
      ordinal: generation.ordinal,
      label: `Recovery ${generation.ordinal}`,
      generationKey,
      counts: generation.inventory?.counts ?? emptyCounts,
    });
  }

  function paginate(
    items: readonly HistoryRecoveryBrowseItem[],
    after: number | null,
    size: number,
  ) {
    const start = after === null
      ? 0
      : items.findIndex((item) => item.ordinal > after);
    const normalizedStart = start < 0 ? items.length : start;
    const pageItems = items.slice(normalizedStart, normalizedStart + size);
    const last = pageItems.at(-1)?.ordinal ?? after;
    const nextAfter = normalizedStart + pageItems.length < items.length
      ? last
      : null;
    return Object.freeze({
      after,
      nextAfter,
      totalCount: items.length,
      items: Object.freeze(pageItems),
    });
  }

  function revokeCapabilities(state: OwnerState): void {
    state.snapshotKey = null;
    state.libraryKey = null;
    state.sources.clear();
    state.generations.clear();
    state.projects.clear();
    state.sessions.clear();
  }

  function cancelResult(
    request: HistoryRecoveryCancelRequest,
    status: HistoryRecoveryCancelResult["status"],
  ): HistoryRecoveryCancelResult {
    return Object.freeze({
      version: 1 as const,
      kind: "cancel" as const,
      requestKey: request.requestKey,
      operationKey: request.operationKey,
      status,
    });
  }

  function capability(scope: string): string {
    return `history-capability-v1:${scope}:${createId()}`;
  }

  function keyedDigest(value: string | Buffer): string {
    if (secret === undefined) throw new Error("recovery-not-prepared");
    return createHmac("sha256", secret).update(value).digest("hex");
  }

  async function assertOwnerOnlyPostcondition(
    path: string,
    kind: "directory" | "file",
  ): Promise<void> {
    try {
      await ownerOnlyStorage.establish(path, kind);
      if ((await ownerOnlyStorage.verify(path, kind)) !== true) {
        throw new HistoryRecoveryOwnerOnlyStorageError();
      }
    } catch (error) {
      if (error instanceof HistoryRecoveryOwnerOnlyStorageError) throw error;
      throw new HistoryRecoveryOwnerOnlyStorageError();
    }
  }

  async function ensureOwnerDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: ownerDirectoryMode });
    await assertOwnerOnlyPostcondition(path, "directory");
  }

  async function atomicCreateFile(path: string, bytes: Buffer): Promise<void> {
    const temporary = join(dirname(path), `.atomic-${randomUUID()}.temporary`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let linked = false;
    try {
      handle = await open(temporary, "wx", ownerFileMode);
      await assertOwnerOnlyPostcondition(temporary, "file");
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporary, path);
      linked = true;
      await assertOwnerOnlyPostcondition(path, "file");
      await syncDirectory(dirname(path));
    } catch (error) {
      if (linked) await unlink(path).catch(() => undefined);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async function atomicReplaceFile(path: string, bytes: Buffer): Promise<void> {
    const temporary = join(dirname(path), `.replace-${randomUUID()}.temporary`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      handle = await open(temporary, "wx", ownerFileMode);
      await assertOwnerOnlyPostcondition(temporary, "file");
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      renamed = true;
      await assertOwnerOnlyPostcondition(path, "file");
      await syncDirectory(dirname(path));
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }

  async function copyVerifiedFile(
    sourcePath: string,
    destinationPath: string,
    expectedLength: number,
    expectedDigest: string,
  ): Promise<void> {
    const source = await open(sourcePath, "r");
    let destination: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    const hash = createHash("sha256");
    let position = 0;
    try {
      destination = await open(destinationPath, "wx", ownerFileMode);
      created = true;
      await assertOwnerOnlyPostcondition(destinationPath, "file");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      while (position < expectedLength) {
        const requested = Math.min(buffer.length, expectedLength - position);
        const read = await source.read(buffer, 0, requested, position);
        if (read.bytesRead <= 0) throw new Error("verification-failed");
        const chunk = buffer.subarray(0, read.bytesRead);
        await destination.write(chunk, 0, chunk.length, position);
        hash.update(chunk);
        position += read.bytesRead;
      }
      if (position !== expectedLength || hash.digest("hex") !== expectedDigest) {
        throw new Error("verification-failed");
      }
      await destination.sync();
    } catch (error) {
      if (created) await rm(destinationPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await source.close().catch(() => undefined);
      await destination?.close().catch(() => undefined);
    }
  }

  async function removeOrQuarantine(path: string): Promise<boolean> {
    try {
      await inject("cleanup:before-remove");
      await rm(path, { recursive: true, force: true });
      return true;
    } catch {
      try {
        await inject("cleanup:before-quarantine");
        await quarantine(path);
        return true;
      } catch (error) {
        if (error instanceof HistoryRecoveryOwnerOnlyStorageError) throw error;
        return false;
      }
    }
  }

  async function quarantine(path: string): Promise<void> {
    if (!(await pathExists(path))) return;
    await ensureOwnerDirectory(quarantineRoot);
    const destination = join(quarantineRoot, `residue-v1-${createId()}`);
    await rename(path, destination);
    const information = await lstat(destination);
    if (information.isDirectory() && !information.isSymbolicLink()) {
      await assertOwnerOnlyPostcondition(destination, "directory");
    } else if (information.isFile() && !information.isSymbolicLink()) {
      await assertOwnerOnlyPostcondition(destination, "file");
    }
    await syncDirectory(quarantineRoot);
  }

  async function inject(point: string): Promise<void> {
    await options.failureInjector?.(point);
  }

  function assertCaptureDeadline(deadline: number): void {
    if (now() > deadline) throw new Error("capture-deadline");
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}


async function filesEqual(
  leftPath: string,
  rightPath: string,
  expectedLength: number,
  expectedDigest: string,
): Promise<boolean> {
  if (
    !(await verifyFile(leftPath, expectedLength, expectedDigest)) ||
    !(await verifyFile(rightPath, expectedLength, expectedDigest))
  ) {
    return false;
  }
  const left = await open(leftPath, "r");
  const right = await open(rightPath, "r");
  try {
    const leftBuffer = Buffer.allocUnsafe(1024 * 1024);
    const rightBuffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < expectedLength) {
      const length = Math.min(leftBuffer.length, expectedLength - position);
      const [leftRead, rightRead] = await Promise.all([
        left.read(leftBuffer, 0, length, position),
        right.read(rightBuffer, 0, length, position),
      ]);
      if (
        leftRead.bytesRead !== rightRead.bytesRead ||
        !leftBuffer
          .subarray(0, leftRead.bytesRead)
          .equals(rightBuffer.subarray(0, rightRead.bytesRead))
      ) {
        return false;
      }
      position += leftRead.bytesRead;
    }
    return true;
  } finally {
    await left.close();
    await right.close();
  }
}

async function verifyFile(
  path: string,
  expectedLength: number,
  expectedDigest: string,
): Promise<boolean> {
  try {
    const information = await lstat(path);
    return information.isFile() &&
      !information.isSymbolicLink() &&
      information.size === expectedLength &&
      (await hashFile(path)) === expectedDigest;
  } catch {
    return false;
  }
}

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    const information = await handle.stat();
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < information.size) {
      const read = await handle.read(buffer, 0, buffer.length, position);
      if (read.bytesRead <= 0) throw new Error("verification-failed");
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const information = await lstat(path);
    return information.isFile() && !information.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
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

function validatePrivateInventory(
  value: unknown,
): HistoryRecoveryPrivateInventory | null | undefined {
  if (value === null) return null;
  const inventory = exactPlainObject(value, [
    "counts",
    "projects",
    "readerVersion",
  ]);
  if (
    inventory === undefined ||
    (inventory.readerVersion !== 1 && inventory.readerVersion !== 2) ||
    !Array.isArray(inventory.projects) ||
    inventory.projects.length > historyRecoveryBounds.maximumCount
  ) {
    return undefined;
  }
  const counts = validateCounts(inventory.counts);
  if (counts === undefined) return undefined;
  const projects: HistoryRecoveryPrivateProject[] = [];
  for (const value of inventory.projects) {
    const project = exactPlainObject(value, ["counts", "sessions"]);
    const projectCounts = validateCounts(project?.counts);
    if (
      project === undefined ||
      projectCounts === undefined ||
      !Array.isArray(project.sessions) ||
      project.sessions.length > historyRecoveryBounds.maximumCount
    ) {
      return undefined;
    }
    const sessions: HistoryRecoveryPrivateSession[] = [];
    for (const value of project.sessions) {
      const session = exactPlainObject(value, ["status", "turns"]);
      if (
        session === undefined ||
        !isRecoveryStatus(session.status) ||
        !Array.isArray(session.turns) ||
        session.turns.length === 0 ||
        session.turns.length > historyRecoveryBounds.maximumCount
      ) {
        return undefined;
      }
      const turns = session.turns.map((value) => {
        const turn = exactPlainObject(value, ["eventCount", "status"]);
        return turn !== undefined &&
            isRecoveryStatus(turn.status) &&
            isBoundedCount(turn.eventCount)
          ? Object.freeze({
              status: turn.status,
              eventCount: turn.eventCount,
            })
          : undefined;
      });
      if (turns.some((turn) => turn === undefined)) return undefined;
      sessions.push(
        Object.freeze({
          status: session.status,
          turns: Object.freeze(
            turns as Array<{
              readonly status: HistoryRecoveryPrivateSession["status"];
              readonly eventCount: number;
            }>,
          ),
        }),
      );
    }
    projects.push(
      Object.freeze({
        counts: projectCounts,
        sessions: Object.freeze(sessions),
      }),
    );
  }
  const summed = projects.reduce(
    (total, project) => ({
      projects: total.projects + project.counts.projects,
      sessions: total.sessions + project.counts.sessions,
      commands: total.commands + project.counts.commands,
      updates: total.updates + project.counts.updates,
    }),
    { projects: 0, sessions: 0, commands: 0, updates: 0 },
  );
  if (canonicalJson(summed).equals(canonicalJson(counts)) === false) {
    return undefined;
  }
  return deepFreeze({
    readerVersion: inventory.readerVersion,
    counts,
    projects,
  });
}

function validateCounts(value: unknown): HistoryRecoveryCounts | undefined {
  const counts = exactPlainObject(value, [
    "commands",
    "projects",
    "sessions",
    "updates",
  ]);
  return counts !== undefined &&
      isBoundedCount(counts.projects) &&
      isBoundedCount(counts.sessions) &&
      isBoundedCount(counts.commands) &&
      isBoundedCount(counts.updates)
    ? Object.freeze({
        projects: counts.projects,
        sessions: counts.sessions,
        commands: counts.commands,
        updates: counts.updates,
      })
    : undefined;
}

function exactPlainObject(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return undefined;
  }
  const clone: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return undefined;
    }
    clone[key] = descriptor.value;
  }
  return Object.freeze(clone);
}

function isRecoveryStatus(
  value: unknown,
): value is HistoryRecoveryPrivateSession["status"] {
  return value === "accepted" ||
    value === "in-flight" ||
    value === "completed" ||
    value === "failed" ||
    value === "recovery-required";
}

function isBoundedCount(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= historyRecoveryBounds.maximumCount;
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function allCountsZero(counts: HistoryRecoveryCounts): boolean {
  return counts.projects === 0 &&
    counts.sessions === 0 &&
    counts.commands === 0 &&
    counts.updates === 0;
}

function sameFileIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(
  left: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  },
  right: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  },
): boolean {
  return sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function safeJoin(root: string, relativePath: string): string {
  const destination = resolve(root, ...relativePath.split("/"));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!destination.startsWith(prefix)) throw new Error("path-escaped");
  return destination;
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..") &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function normalizePhysicalPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function privateReaderProblem(error: unknown): HistoryRecoveryProblemCode {
  if (!(error instanceof HistoryRecoveryPrivateReaderError)) {
    return "verification-failed";
  }
  return error.category === "unsupported-artifact"
    ? "unsupported-artifact"
    : error.category === "unsupported-schema"
      ? "unsupported-schema"
      : "verification-failed";
}

function captureErrorCode(error: unknown): HistoryRecoveryProblemCode {
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") return "permission-denied";
  if (code === "ENOSPC" || code === "EDQUOT") return "quota-exceeded";
  if (error instanceof Error && error.message === "capture-drift") {
    return "capture-drift";
  }
  if (error instanceof Error && error.message === "quota-exceeded") {
    return "quota-exceeded";
  }
  if (error instanceof Error && error.message === "capture-deadline") {
    return "source-unavailable";
  }
  return "verification-failed";
}

function mutationErrorCode(error: unknown): HistoryRecoveryProblemCode {
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") return "permission-denied";
  if (code === "ENOSPC" || code === "EDQUOT") return "quota-exceeded";
  if (error instanceof Error && error.message === "cancelled") return "cancelled";
  if (error instanceof Error && error.message === "quota-exceeded") {
    return "quota-exceeded";
  }
  return "verification-failed";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EISDIR" ||
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    (process.platform === "win32" && code === "EPERM");
}

function boundedResult<T>(value: T, fallback: () => T): T {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <=
        historyRecoveryBounds.maximumPublicResponseBytes
      ? value
      : fallback();
  } catch {
    return fallback();
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
