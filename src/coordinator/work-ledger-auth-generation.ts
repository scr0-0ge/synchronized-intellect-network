import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  automaticSessionDisplayName,
  normalizeSessionDisplayName,
} from "../session-metadata.ts";

export type DurableRuntimeEndpointId =
  | "codex-desktop"
  | "claude-code-desktop";

export type WorkbenchAuthenticationAction = "login" | "logout";

export type DurableAuthenticationContext =
  | {
      readonly schemaVersion: 1;
      readonly endpointId: DurableRuntimeEndpointId;
      readonly management: "pristine-legacy";
    }
  | {
      readonly schemaVersion: 1;
      readonly endpointId: DurableRuntimeEndpointId;
      readonly management: "managed";
      /** Workbench-private equality value. It carries no account meaning. */
      readonly generation: string;
    };

export interface RuntimeEndpointAuthGenerationSnapshot {
  readonly codex: DurableAuthenticationContext;
  readonly claude: DurableAuthenticationContext;
}

/**
 * The exact three-valued authentication signal the existing auth-status path
 * already returns for both endpoints. It is the *only* non-secret signal either
 * provider surfaces to the Workbench: `claude auth status --json` yields just
 * `loggedIn`/`authMethod`/`apiProvider`, and Codex `account/read` is projected
 * down to the presence and type of an account. Neither carries an
 * account-scoped value, so nothing here can name, rank, or reverse an account.
 */
export type ObservedAuthenticationState =
  | "bound"
  | "sign-in-required"
  | "unknown";

/**
 * An opaque, locally minted, non-reversible discriminator for one continuous
 * run of observed provider sign-in.
 *
 * It is a change detector, never an identity. The mark is a locally generated
 * random value with no derivation from any account, email, token, or credential
 * file; it is re-minted whenever the Workbench observes sign-in return after an
 * observed sign-out. Two Sessions carrying the same mark were provably created
 * inside one uninterrupted observed sign-in; two different marks prove only
 * that the observed sign-in run changed, never *which* accounts were involved.
 */
export interface DurableAccountObservation {
  readonly schemaVersion: 1;
  readonly endpointId: DurableRuntimeEndpointId;
  /** Workbench-private equality value. It carries no account meaning. */
  readonly mark: string;
}

/**
 * The comparison a Session's durable stamp supports at the resume seam.
 *
 * Only `different-sign-in` is a positive proof of change, and only it and
 * `unreadable` may refuse; `not-comparable` covers legacy rows and every state
 * in which the Workbench has observed nothing, and must defer to the other
 * gates rather than invent a refusal it cannot justify.
 */
export type AccountObservationVerdict =
  | "not-comparable"
  | "same-sign-in"
  | "different-sign-in"
  | "unreadable";

/**
 * Owner-facing refusal wording for a proven sign-in change at the resume seam.
 * It claims exactly what the discriminator proves — that the active sign-in run
 * differs from the one this Session was started under — and never claims to
 * know which account is signed in, because the Workbench never reads that.
 */
export const accountSignInChangedRefusalCopy =
  "This Agent Session cannot be continued. A different provider sign-in is active now and this Session was started under an earlier one, so continuing could replay it into another account.";

export interface AuthenticationMutationBlockers {
  readonly accepted: number;
  readonly starting: number;
  readonly inFlight: number;
  readonly recoveryRequired: number;
  readonly unknown: number;
}

export interface AuthenticationMutationConsequences {
  readonly resumableSessionCount: number;
  readonly projectCount: number;
}

export type AuthenticationMutationPreparation =
  | {
      readonly kind: "blocked";
      readonly blockers: AuthenticationMutationBlockers;
    }
  | {
      readonly kind: "confirmation-required";
      readonly preparationKey: string;
      readonly consequences: AuthenticationMutationConsequences;
    }
  | {
      readonly kind: "ready";
      readonly preparationKey: string;
    };

export type AuthenticationMutationBeginResult =
  | {
      readonly kind: "begun";
      readonly endpointId: DurableRuntimeEndpointId;
      readonly action: WorkbenchAuthenticationAction;
    }
  | {
      readonly kind: "blocked";
      readonly blockers: AuthenticationMutationBlockers;
    }
  | { readonly kind: "stale" }
  | { readonly kind: "rejected" }
  | { readonly kind: "persistence-failed" };

export interface WorkLedgerAuthGenerationModule {
  captureRuntimeEndpointAuthGenerationSnapshot():
    | RuntimeEndpointAuthGenerationSnapshot
    | undefined;
  captureForAcceptedCommand(
    endpointId: DurableRuntimeEndpointId,
  ): DurableAuthenticationContext | undefined;
  isNativeResumeEligible(request: {
    readonly endpointId: DurableRuntimeEndpointId;
    readonly sessionContext: unknown;
    readonly commandContext: unknown;
  }): boolean;
  isSessionNativeResumable(context: unknown): boolean;
  prepareAuthenticationMutation(request: {
    readonly endpointId: DurableRuntimeEndpointId;
    readonly action: WorkbenchAuthenticationAction;
  }): AuthenticationMutationPreparation;
  beginAuthenticationMutation(request: {
    readonly preparationKey: string;
  }): AuthenticationMutationBeginResult;
  cancelAuthenticationMutation(request: {
    readonly preparationKey: string;
  }): boolean;
  /**
   * Records one observation of an endpoint's authentication state and mints a
   * fresh discriminator whenever sign-in returns after an observed sign-out.
   * `unknown` is deliberately inert: a failed status read teaches nothing, and
   * treating it as a sign-out would refuse healthy Sessions after any transient
   * provider hiccup. Returns false only when the observation could not be made
   * durable, in which case the prior mark stands.
   */
  observeEndpointAuthentication(request: {
    readonly endpointId: DurableRuntimeEndpointId;
    readonly state: ObservedAuthenticationState;
  }): boolean;
  /**
   * The discriminator to stamp on a Session being created, or undefined when no
   * sign-in has been observed for that endpoint and there is nothing to prove.
   */
  captureAccountObservation(
    endpointId: DurableRuntimeEndpointId,
  ): DurableAccountObservation | undefined;
  /** Compares one Session's durable stamp against the current observation. */
  classifySessionAccountObservation(value: unknown): AccountObservationVerdict;
}

export type WorkLedgerAuthGenerationAtomicReplace = (
  replacementPath: string,
  destinationPath: string,
) => void;

export interface WorkLedgerAuthGenerationOptions {
  readonly dataDirectory: string;
  readonly createGeneration?: () => string;
  readonly createPreparationKey?: () => string;
  /** Injected only by tests; production mints a random, non-reversible mark. */
  readonly createAccountObservationMark?: () => string;
  readonly atomicReplace?: WorkLedgerAuthGenerationAtomicReplace;
}

type PristineEndpointState = {
  readonly endpointId: DurableRuntimeEndpointId;
  readonly management: "pristine-legacy";
};

type ManagedEndpointState = {
  readonly endpointId: DurableRuntimeEndpointId;
  readonly management: "managed";
  readonly generation: string;
};

type EndpointState = PristineEndpointState | ManagedEndpointState;

type AuthenticationState = {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly endpoints: readonly [EndpointState, EndpointState];
};

type ObservationEndpointState =
  | {
      readonly endpointId: DurableRuntimeEndpointId;
      readonly observed: "no-sign-in";
    }
  | {
      readonly endpointId: DurableRuntimeEndpointId;
      readonly observed: "signed-in";
      readonly mark: string;
    };

type AccountObservationState = {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly endpoints: readonly [
    ObservationEndpointState,
    ObservationEndpointState,
  ];
};

type PreparationRecord = {
  readonly endpointId: DurableRuntimeEndpointId;
  readonly action: WorkbenchAuthenticationAction;
  readonly stateRevision: number;
  readonly scanFingerprint: string;
  readonly requiredConfirmation: boolean;
};

type ProjectScan = {
  readonly blockers: AuthenticationMutationBlockers;
  readonly consequences: AuthenticationMutationConsequences;
  readonly fingerprint: string;
};

const stateFileName = "work-ledger-auth-generations-v1.json";
const replacementFileName = "work-ledger-auth-generations-v1.replacement";
const initializedMarkerFileName = "work-ledger-auth-generations-v1.initialized";
const initializedMarkerContents = "work-ledger-auth-generations-v1\n";
const observationStateFileName = "work-ledger-account-observations-v1.json";
const observationReplacementFileName =
  "work-ledger-account-observations-v1.replacement";
const observationInitializedMarkerFileName =
  "work-ledger-account-observations-v1.initialized";
const observationInitializedMarkerContents =
  "work-ledger-account-observations-v1\n";
const registryFileName = "project-registry-v1.json";
const maximumStateBytes = 16 * 1024;
const maximumRegistryBytes = 256 * 1024;
const generationPattern =
  /^auth-generation-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const preparationPattern =
  /^auth-preparation-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const accountObservationMarkPattern =
  /^account-observation-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const projectRecordPattern =
  /^project-record-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ledgerSlotPattern =
  /^project-ledger-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const endpointIds = Object.freeze([
  "codex-desktop" as const,
  "claude-code-desktop" as const,
]);

export function createWorkLedgerAuthGenerationModule(
  options: WorkLedgerAuthGenerationOptions,
): WorkLedgerAuthGenerationModule {
  const dataDirectory = options.dataDirectory;
  const statePath = join(dataDirectory, stateFileName);
  const replacementPath = join(dataDirectory, replacementFileName);
  const initializedMarkerPath = join(dataDirectory, initializedMarkerFileName);
  const observationStatePath = join(dataDirectory, observationStateFileName);
  const observationReplacementPath = join(
    dataDirectory,
    observationReplacementFileName,
  );
  const observationInitializedMarkerPath = join(
    dataDirectory,
    observationInitializedMarkerFileName,
  );
  const registryPath = join(dataDirectory, registryFileName);
  const atomicReplace = options.atomicReplace ?? renameSync;
  const createGeneration =
    options.createGeneration ?? (() => `auth-generation-v1-${randomUUID()}`);
  const createPreparationKey =
    options.createPreparationKey ?? (() => `auth-preparation-v1-${randomUUID()}`);
  const createAccountObservationMark =
    options.createAccountObservationMark ??
    (() => `account-observation-v1-${randomUUID()}`);
  const preparations = new Map<string, PreparationRecord>();
  const issuedPreparationKeys = new Set<string>();
  const readObservations = (): AccountObservationState | undefined =>
    readObservationState(
      observationStatePath,
      observationReplacementPath,
      observationInitializedMarkerPath,
    );
  const currentObservationEndpoint = (
    endpointId: DurableRuntimeEndpointId,
  ): ObservationEndpointState | undefined =>
    isEndpointId(endpointId)
      ? readObservations()?.endpoints.find(
          (candidate) => candidate.endpointId === endpointId,
        )
      : undefined;

  try {
    mkdirSync(dataDirectory, { recursive: true });
    if (
      existsSync(statePath) &&
      !existsSync(initializedMarkerPath) &&
      readStateFile(statePath) !== undefined
    ) {
      createInitializedMarker(initializedMarkerPath);
    }
    if (
      !existsSync(statePath) &&
      !existsSync(replacementPath) &&
      !existsSync(initializedMarkerPath)
    ) {
      createInitializedMarker(initializedMarkerPath);
      const initial = initialState();
      persistState({
        statePath,
        replacementPath,
        initializedMarkerPath,
        prior: undefined,
        next: initial,
        atomicReplace,
      });
    }
  } catch {
    // All public operations below reload and fail closed.
  }

  try {
    if (
      existsSync(observationStatePath) &&
      !existsSync(observationInitializedMarkerPath) &&
      readObservationStateFile(observationStatePath) !== undefined
    ) {
      createObservationInitializedMarker(observationInitializedMarkerPath);
    }
    if (
      !existsSync(observationStatePath) &&
      !existsSync(observationReplacementPath) &&
      !existsSync(observationInitializedMarkerPath)
    ) {
      createObservationInitializedMarker(observationInitializedMarkerPath);
      persistObservationState({
        statePath: observationStatePath,
        replacementPath: observationReplacementPath,
        initializedMarkerPath: observationInitializedMarkerPath,
        next: initialObservationState(),
        atomicReplace,
      });
    }
  } catch {
    // A missing or unreadable observation state yields `not-comparable` below.
  }

  const captureForAcceptedCommand = (
    endpointId: DurableRuntimeEndpointId,
  ): DurableAuthenticationContext | undefined => {
    if (!isEndpointId(endpointId)) return undefined;
    const state = readState(
      statePath,
      replacementPath,
      initializedMarkerPath,
    );
    const endpoint = state?.endpoints.find(
      (candidate) => candidate.endpointId === endpointId,
    );
    if (endpoint === undefined) return undefined;
    return endpoint.management === "pristine-legacy"
      ? Object.freeze({
          schemaVersion: 1 as const,
          endpointId,
          management: "pristine-legacy" as const,
        })
      : Object.freeze({
          schemaVersion: 1 as const,
          endpointId,
          management: "managed" as const,
          generation: endpoint.generation,
        });
  };

  const captureRuntimeEndpointAuthGenerationSnapshot = ():
    | RuntimeEndpointAuthGenerationSnapshot
    | undefined => {
    const state = readState(
      statePath,
      replacementPath,
      initializedMarkerPath,
    );
    if (state === undefined) return undefined;
    const codex = state.endpoints[0];
    const claude = state.endpoints[1];
    if (
      codex?.endpointId !== "codex-desktop" ||
      claude?.endpointId !== "claude-code-desktop"
    ) {
      return undefined;
    }
    return Object.freeze({
      codex: authenticationContextForEndpoint(codex),
      claude: authenticationContextForEndpoint(claude),
    });
  };

  return Object.freeze({
    captureRuntimeEndpointAuthGenerationSnapshot,
    captureForAcceptedCommand,
    isNativeResumeEligible(request: {
      readonly endpointId: DurableRuntimeEndpointId;
      readonly sessionContext: unknown;
      readonly commandContext: unknown;
    }): boolean {
      if (
        !isExactRecord(request, [
          "commandContext",
          "endpointId",
          "sessionContext",
        ]) ||
        !isEndpointId(request.endpointId)
      ) {
        return false;
      }
      const state = readState(
        statePath,
        replacementPath,
        initializedMarkerPath,
      );
      const endpoint = state?.endpoints.find(
        (candidate) => candidate.endpointId === request.endpointId,
      );
      if (endpoint === undefined) return false;
      const sessionContext = parseAuthenticationContext(request.sessionContext);
      const commandContext = parseAuthenticationContext(request.commandContext);
      if (endpoint.management === "pristine-legacy") {
        return (
          contextMatchesPristineOrLegacy(sessionContext, request.sessionContext, endpoint.endpointId) &&
          contextMatchesPristineOrLegacy(commandContext, request.commandContext, endpoint.endpointId)
        );
      }
      return (
        sessionContext?.management === "managed" &&
        sessionContext.endpointId === endpoint.endpointId &&
        sessionContext.generation === endpoint.generation &&
        commandContext?.management === "managed" &&
        commandContext.endpointId === endpoint.endpointId &&
        commandContext.generation === endpoint.generation
      );
    },
    isSessionNativeResumable(context: unknown): boolean {
      const state = readState(
        statePath,
        replacementPath,
        initializedMarkerPath,
      );
      if (state === undefined) return false;
      if (context === null || context === undefined) {
        return isUnmodifiedPristineLegacyState(state);
      }
      const parsed = parseAuthenticationContext(context);
      if (parsed === undefined) return false;
      const endpoint = state.endpoints.find(
        (candidate) => candidate.endpointId === parsed.endpointId,
      );
      if (endpoint === undefined) return false;
      return endpoint.management === "pristine-legacy"
        ? parsed.management === "pristine-legacy"
        : parsed.management === "managed" &&
            parsed.generation === endpoint.generation;
    },
    prepareAuthenticationMutation(request: {
      readonly endpointId: DurableRuntimeEndpointId;
      readonly action: WorkbenchAuthenticationAction;
    }): AuthenticationMutationPreparation {
      if (
        !isExactRecord(request, ["action", "endpointId"]) ||
        !isEndpointId(request.endpointId) ||
        !isAuthenticationAction(request.action)
      ) {
        return blockedUnknown();
      }
      const state = readState(
        statePath,
        replacementPath,
        initializedMarkerPath,
      );
      if (state === undefined) return blockedUnknown();
      const scan = scanRegisteredProjects(registryPath, request.endpointId, state);
      if (hasBlockers(scan.blockers)) {
        return Object.freeze({ kind: "blocked" as const, blockers: scan.blockers });
      }
      let preparationKey: unknown;
      try {
        preparationKey = createPreparationKey();
      } catch {
        return blockedUnknown();
      }
      if (
        typeof preparationKey !== "string" ||
        !preparationPattern.test(preparationKey) ||
        issuedPreparationKeys.has(preparationKey)
      ) {
        return blockedUnknown();
      }
      const requiredConfirmation = scan.consequences.resumableSessionCount > 0;
      preparations.set(
        preparationKey,
        Object.freeze({
          endpointId: request.endpointId,
          action: request.action,
          stateRevision: state.revision,
          scanFingerprint: scan.fingerprint,
          requiredConfirmation,
        }),
      );
      issuedPreparationKeys.add(preparationKey);
      return requiredConfirmation
        ? Object.freeze({
            kind: "confirmation-required" as const,
            preparationKey,
            consequences: scan.consequences,
          })
        : Object.freeze({ kind: "ready" as const, preparationKey });
    },
    beginAuthenticationMutation(request: {
      readonly preparationKey: string;
    }): AuthenticationMutationBeginResult {
      if (
        !isExactRecord(request, ["preparationKey"]) ||
        typeof request.preparationKey !== "string" ||
        !preparationPattern.test(request.preparationKey)
      ) {
        return Object.freeze({ kind: "rejected" as const });
      }
      const preparation = preparations.get(request.preparationKey);
      preparations.delete(request.preparationKey);
      if (preparation === undefined) {
        return Object.freeze({ kind: "rejected" as const });
      }
      const state = readState(
        statePath,
        replacementPath,
        initializedMarkerPath,
      );
      if (state === undefined || state.revision !== preparation.stateRevision) {
        return Object.freeze({ kind: "stale" as const });
      }
      const scan = scanRegisteredProjects(
        registryPath,
        preparation.endpointId,
        state,
      );
      if (hasBlockers(scan.blockers)) {
        return Object.freeze({ kind: "blocked" as const, blockers: scan.blockers });
      }
      if (
        scan.fingerprint !== preparation.scanFingerprint ||
        (scan.consequences.resumableSessionCount > 0) !==
          preparation.requiredConfirmation
      ) {
        return Object.freeze({ kind: "stale" as const });
      }
      let generation: unknown;
      try {
        generation = createGeneration();
      } catch {
        return Object.freeze({ kind: "persistence-failed" as const });
      }
      const previous = state.endpoints.find(
        (endpoint) => endpoint.endpointId === preparation.endpointId,
      );
      if (
        typeof generation !== "string" ||
        !generationPattern.test(generation) ||
        state.revision >= Number.MAX_SAFE_INTEGER - 1 ||
        (previous?.management === "managed" &&
          previous.generation === generation)
      ) {
        return Object.freeze({ kind: "persistence-failed" as const });
      }
      const next: AuthenticationState = deepFreeze({
        schemaVersion: 1 as const,
        revision: state.revision + 1,
        endpoints: state.endpoints.map((endpoint) =>
          endpoint.endpointId === preparation.endpointId
            ? {
                endpointId: preparation.endpointId,
                management: "managed" as const,
                generation,
              }
            : endpoint,
        ) as unknown as readonly [EndpointState, EndpointState],
      });
      if (
        !persistState({
          statePath,
          replacementPath,
          initializedMarkerPath,
          prior: state,
          next,
          atomicReplace,
        })
      ) {
        return Object.freeze({ kind: "persistence-failed" as const });
      }
      return Object.freeze({
        kind: "begun" as const,
        endpointId: preparation.endpointId,
        action: preparation.action,
      });
    },
    cancelAuthenticationMutation(request: {
      readonly preparationKey: string;
    }): boolean {
      if (
        !isExactRecord(request, ["preparationKey"]) ||
        typeof request.preparationKey !== "string"
      ) {
        return false;
      }
      return preparations.delete(request.preparationKey);
    },
    observeEndpointAuthentication(request: {
      readonly endpointId: DurableRuntimeEndpointId;
      readonly state: ObservedAuthenticationState;
    }): boolean {
      if (
        !isExactRecord(request, ["endpointId", "state"]) ||
        !isEndpointId(request.endpointId) ||
        !isObservedAuthenticationState(request.state)
      ) {
        return false;
      }
      if (request.state === "unknown") return true;
      const state = readObservations();
      if (state === undefined) return false;
      const endpoint = state.endpoints.find(
        (candidate) => candidate.endpointId === request.endpointId,
      );
      if (endpoint === undefined) return false;
      if (request.state === "bound" && endpoint.observed === "signed-in") {
        return true;
      }
      if (request.state === "sign-in-required" && endpoint.observed === "no-sign-in") {
        return true;
      }
      let replacement: ObservationEndpointState;
      if (request.state === "sign-in-required") {
        replacement = {
          endpointId: request.endpointId,
          observed: "no-sign-in" as const,
        };
      } else {
        let mark: unknown;
        try {
          mark = createAccountObservationMark();
        } catch {
          return false;
        }
        if (
          typeof mark !== "string" ||
          !accountObservationMarkPattern.test(mark) ||
          state.endpoints.some(
            (candidate) =>
              candidate.observed === "signed-in" && candidate.mark === mark,
          )
        ) {
          return false;
        }
        replacement = {
          endpointId: request.endpointId,
          observed: "signed-in" as const,
          mark,
        };
      }
      if (state.revision >= Number.MAX_SAFE_INTEGER - 1) return false;
      const next: AccountObservationState = deepFreeze({
        schemaVersion: 1 as const,
        revision: state.revision + 1,
        endpoints: state.endpoints.map((candidate) =>
          candidate.endpointId === request.endpointId ? replacement : candidate,
        ) as unknown as readonly [
          ObservationEndpointState,
          ObservationEndpointState,
        ],
      });
      return persistObservationState({
        statePath: observationStatePath,
        replacementPath: observationReplacementPath,
        initializedMarkerPath: observationInitializedMarkerPath,
        next,
        atomicReplace,
      });
    },
    captureAccountObservation(
      endpointId: DurableRuntimeEndpointId,
    ): DurableAccountObservation | undefined {
      const endpoint = currentObservationEndpoint(endpointId);
      return endpoint?.observed === "signed-in"
        ? Object.freeze({
            schemaVersion: 1 as const,
            endpointId: endpoint.endpointId,
            mark: endpoint.mark,
          })
        : undefined;
    },
    classifySessionAccountObservation(value: unknown): AccountObservationVerdict {
      if (value === null || value === undefined) return "not-comparable";
      const stamped = parseAccountObservation(value);
      if (stamped === undefined) return "unreadable";
      const state = readObservations();
      const endpoint = state?.endpoints.find(
        (candidate) => candidate.endpointId === stamped.endpointId,
      );
      // A stamp exists but the durable observation state does not, so the
      // module's own record is broken and sameness can no longer be proven.
      if (endpoint === undefined) return "unreadable";
      // Nobody is signed in, so nothing can be replayed into another account;
      // the provider layer owns that message.
      if (endpoint.observed === "no-sign-in") return "not-comparable";
      return endpoint.mark === stamped.mark ? "same-sign-in" : "different-sign-in";
    },
  });
}

function authenticationContextForEndpoint(
  endpoint: EndpointState,
): DurableAuthenticationContext {
  return endpoint.management === "pristine-legacy"
    ? Object.freeze({
        schemaVersion: 1 as const,
        endpointId: endpoint.endpointId,
        management: "pristine-legacy" as const,
      })
    : Object.freeze({
        schemaVersion: 1 as const,
        endpointId: endpoint.endpointId,
        management: "managed" as const,
        generation: endpoint.generation,
      });
}

export function parseDurableAuthenticationContext(
  value: unknown,
): DurableAuthenticationContext | undefined {
  return parseAuthenticationContext(value);
}

/**
 * Exact-shape reader for a Session's durable account-observation stamp. A
 * serialized stamp must round-trip to the one canonical encoding, so no extra,
 * reordered, or prototype-borrowed key can be smuggled through the seam.
 */
export function parseDurableAccountObservation(
  value: unknown,
): DurableAccountObservation | undefined {
  return parseAccountObservation(value);
}

function parseAccountObservation(
  value: unknown,
): DurableAccountObservation | undefined {
  let candidate = value;
  const serialized = typeof candidate === "string" ? candidate : undefined;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (
    !isExactRecord(candidate, ["endpointId", "mark", "schemaVersion"]) ||
    candidate.schemaVersion !== 1 ||
    !isEndpointId(candidate.endpointId) ||
    typeof candidate.mark !== "string" ||
    !accountObservationMarkPattern.test(candidate.mark)
  ) {
    return undefined;
  }
  const parsed = Object.freeze({
    schemaVersion: 1 as const,
    endpointId: candidate.endpointId,
    mark: candidate.mark,
  });
  return serialized === undefined || JSON.stringify(parsed) === serialized
    ? parsed
    : undefined;
}

function isObservedAuthenticationState(
  value: unknown,
): value is ObservedAuthenticationState {
  return (
    value === "bound" || value === "sign-in-required" || value === "unknown"
  );
}

function initialObservationState(): AccountObservationState {
  return deepFreeze({
    schemaVersion: 1 as const,
    revision: 0,
    endpoints: [
      {
        endpointId: "codex-desktop" as const,
        observed: "no-sign-in" as const,
      },
      {
        endpointId: "claude-code-desktop" as const,
        observed: "no-sign-in" as const,
      },
    ] as const,
  });
}

function serializeObservationState(state: AccountObservationState): string {
  return `${JSON.stringify(state)}\n`;
}

function readObservationState(
  statePath: string,
  replacementPath: string,
  initializedMarkerPath: string,
): AccountObservationState | undefined {
  try {
    if (
      existsSync(replacementPath) ||
      !isValidObservationInitializedMarker(initializedMarkerPath)
    ) {
      return undefined;
    }
    return readObservationStateFile(statePath);
  } catch {
    return undefined;
  }
}

function readObservationStateFile(
  statePath: string,
): AccountObservationState | undefined {
  try {
    const information = lstatSync(statePath);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.size > maximumStateBytes
    ) {
      return undefined;
    }
    const contents = readFileSync(statePath, "utf8");
    if (Buffer.byteLength(contents, "utf8") > maximumStateBytes) return undefined;
    const state = validateObservationState(JSON.parse(contents) as unknown);
    return state !== undefined && serializeObservationState(state) === contents
      ? state
      : undefined;
  } catch {
    return undefined;
  }
}

function validateObservationState(
  value: unknown,
): AccountObservationState | undefined {
  if (
    !isExactRecord(value, ["endpoints", "revision", "schemaVersion"]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    (value.revision as number) >= Number.MAX_SAFE_INTEGER ||
    !Array.isArray(value.endpoints) ||
    value.endpoints.length !== endpointIds.length
  ) {
    return undefined;
  }
  const endpoints: ObservationEndpointState[] = [];
  const marks = new Set<string>();
  for (const [index, endpointId] of endpointIds.entries()) {
    const endpoint = value.endpoints[index];
    if (!isExactObservationEndpointState(endpoint, endpointId)) return undefined;
    if (endpoint.observed === "signed-in") {
      if (marks.has(endpoint.mark)) return undefined;
      marks.add(endpoint.mark);
    }
    endpoints.push(endpoint);
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    revision: value.revision as number,
    endpoints: endpoints as unknown as readonly [
      ObservationEndpointState,
      ObservationEndpointState,
    ],
  });
}

function isExactObservationEndpointState(
  value: unknown,
  endpointId: DurableRuntimeEndpointId,
): value is ObservationEndpointState {
  if (!isPlainRecord(value) || value.endpointId !== endpointId) return false;
  if (value.observed === "no-sign-in") {
    return isExactRecord(value, ["endpointId", "observed"]);
  }
  return (
    value.observed === "signed-in" &&
    isExactRecord(value, ["endpointId", "mark", "observed"]) &&
    typeof value.mark === "string" &&
    accountObservationMarkPattern.test(value.mark)
  );
}

function persistObservationState(options: {
  readonly statePath: string;
  readonly replacementPath: string;
  readonly initializedMarkerPath: string;
  readonly next: AccountObservationState;
  readonly atomicReplace: WorkLedgerAuthGenerationAtomicReplace;
}): boolean {
  const contents = serializeObservationState(options.next);
  let handle: number | undefined;
  try {
    if (existsSync(options.replacementPath)) return false;
    handle = openSync(options.replacementPath, "wx", 0o600);
    writeFileSync(handle, contents, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    options.atomicReplace(options.replacementPath, options.statePath);
  } catch {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // The committed-state comparison below remains authoritative.
      }
    }
    const committed = readObservationStateFile(options.statePath);
    if (committed === undefined || serializeObservationState(committed) !== contents) {
      try {
        rmSync(options.replacementPath, { force: true });
      } catch {
        // Residue intentionally makes later reads fail closed.
      }
      return false;
    }
    try {
      rmSync(options.replacementPath, { force: true });
    } catch {
      // A committed destination remains valid; residue fails later reads closed.
    }
    return true;
  }
  const committed = readObservationState(
    options.statePath,
    options.replacementPath,
    options.initializedMarkerPath,
  );
  return (
    committed !== undefined && serializeObservationState(committed) === contents
  );
}

function createObservationInitializedMarker(markerPath: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(markerPath, "wx", 0o600);
    writeFileSync(handle, observationInitializedMarkerContents, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function isValidObservationInitializedMarker(markerPath: string): boolean {
  try {
    const information = lstatSync(markerPath);
    return (
      information.isFile() &&
      !information.isSymbolicLink() &&
      information.size ===
        Buffer.byteLength(observationInitializedMarkerContents, "utf8") &&
      readFileSync(markerPath, "utf8") === observationInitializedMarkerContents
    );
  } catch {
    return false;
  }
}

function initialState(): AuthenticationState {
  return deepFreeze({
    schemaVersion: 1 as const,
    revision: 0,
    endpoints: [
      {
        endpointId: "codex-desktop" as const,
        management: "pristine-legacy" as const,
      },
      {
        endpointId: "claude-code-desktop" as const,
        management: "pristine-legacy" as const,
      },
    ] as const,
  });
}

function serializeState(state: AuthenticationState): string {
  return `${JSON.stringify(state)}\n`;
}

function readState(
  statePath: string,
  replacementPath: string,
  initializedMarkerPath: string,
): AuthenticationState | undefined {
  try {
    if (
      existsSync(replacementPath) ||
      !isValidInitializedMarker(initializedMarkerPath)
    ) {
      return undefined;
    }
    return readStateFile(statePath);
  } catch {
    return undefined;
  }
}

function readStateFile(statePath: string): AuthenticationState | undefined {
  try {
    const information = lstatSync(statePath);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.size > maximumStateBytes
    ) {
      return undefined;
    }
    const contents = readFileSync(statePath, "utf8");
    if (Buffer.byteLength(contents, "utf8") > maximumStateBytes) return undefined;
    const parsed: unknown = JSON.parse(contents);
    const state = validateState(parsed);
    return state !== undefined && serializeState(state) === contents
      ? state
      : undefined;
  } catch {
    return undefined;
  }
}

function validateState(value: unknown): AuthenticationState | undefined {
  if (
    !isExactRecord(value, ["endpoints", "revision", "schemaVersion"]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    (value.revision as number) >= Number.MAX_SAFE_INTEGER ||
    !Array.isArray(value.endpoints) ||
    value.endpoints.length !== endpointIds.length
  ) {
    return undefined;
  }
  const endpoints: EndpointState[] = [];
  for (const [index, endpointId] of endpointIds.entries()) {
    const endpoint = value.endpoints[index];
    if (!isExactEndpointState(endpoint, endpointId)) return undefined;
    endpoints.push(endpoint);
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    revision: value.revision as number,
    endpoints: endpoints as unknown as readonly [EndpointState, EndpointState],
  });
}

function isExactEndpointState(
  value: unknown,
  endpointId: DurableRuntimeEndpointId,
): value is EndpointState {
  if (!isPlainRecord(value) || value.endpointId !== endpointId) return false;
  if (value.management === "pristine-legacy") {
    return isExactRecord(value, ["endpointId", "management"]);
  }
  return (
    value.management === "managed" &&
    isExactRecord(value, ["endpointId", "generation", "management"]) &&
    typeof value.generation === "string" &&
    generationPattern.test(value.generation)
  );
}

function persistState(options: {
  readonly statePath: string;
  readonly replacementPath: string;
  readonly initializedMarkerPath: string;
  readonly prior: AuthenticationState | undefined;
  readonly next: AuthenticationState;
  readonly atomicReplace: WorkLedgerAuthGenerationAtomicReplace;
}): boolean {
  const contents = serializeState(options.next);
  let handle: number | undefined;
  try {
    if (existsSync(options.replacementPath)) return false;
    handle = openSync(options.replacementPath, "wx", 0o600);
    writeFileSync(handle, contents, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    options.atomicReplace(options.replacementPath, options.statePath);
    return (
      serializeState(
        readState(
          options.statePath,
          options.replacementPath,
          options.initializedMarkerPath,
        )!,
      ) === contents
    );
  } catch {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // The committed-state comparison below remains authoritative.
      }
    }
    const committed = readStateFile(options.statePath);
    if (committed !== undefined && serializeState(committed) === contents) {
      try {
        rmSync(options.replacementPath, { force: true });
      } catch {
        // A committed destination remains valid; residue fails later reads closed.
      }
      return true;
    }
    if (
      options.prior !== undefined &&
      committed !== undefined &&
      serializeState(committed) === serializeState(options.prior)
    ) {
      try {
        rmSync(options.replacementPath, { force: true });
      } catch {
        // Residue intentionally makes later reads fail closed.
      }
    }
    return false;
  }
}

function createInitializedMarker(markerPath: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(markerPath, "wx", 0o600);
    writeFileSync(handle, initializedMarkerContents, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function isValidInitializedMarker(markerPath: string): boolean {
  try {
    const information = lstatSync(markerPath);
    return (
      information.isFile() &&
      !information.isSymbolicLink() &&
      information.size === Buffer.byteLength(initializedMarkerContents, "utf8") &&
      readFileSync(markerPath, "utf8") === initializedMarkerContents
    );
  } catch {
    return false;
  }
}

function scanRegisteredProjects(
  registryPath: string,
  endpointId: DurableRuntimeEndpointId,
  state: AuthenticationState,
): ProjectScan {
  const unknown = (): ProjectScan => ({
    blockers: frozenBlockers({ unknown: 1 }),
    consequences: frozenConsequences(),
    fingerprint: "invalid-registry",
  });
  try {
    const information = lstatSync(registryPath);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.size > maximumRegistryBytes
    ) {
      return unknown();
    }
    const contents = readFileSync(registryPath, "utf8");
    if (Buffer.byteLength(contents, "utf8") > maximumRegistryBytes) {
      return unknown();
    }
    const parsed: unknown = JSON.parse(contents);
    if (
      !isExactRecord(parsed, [
        "nextProjectOrdinal",
        "records",
        "revision",
        "schemaVersion",
        "selectedRecordKey",
      ]) ||
      parsed.schemaVersion !== 1 ||
      !Number.isSafeInteger(parsed.revision) ||
      (parsed.revision as number) < 0 ||
      !Number.isSafeInteger(parsed.nextProjectOrdinal) ||
      (parsed.nextProjectOrdinal as number) < 1 ||
      !Array.isArray(parsed.records) ||
      parsed.records.length > 1_000 ||
      (parsed.selectedRecordKey !== null &&
        typeof parsed.selectedRecordKey !== "string")
    ) {
      return unknown();
    }
    const records: Array<{
      readonly recordKey: string;
      readonly ledgerSlot: string;
      readonly canonicalDirectory: string;
      readonly directoryDigest: string;
    }> = [];
    const recordKeys = new Set<string>();
    const ledgerSlots = new Set<string>();
    const directoryIdentities = new Set<string>();
    for (const candidate of parsed.records) {
      if (
        !isExactRecord(candidate, [
          "canonicalDirectory",
          "ledgerSlot",
          "recordKey",
        ]) ||
        typeof candidate.recordKey !== "string" ||
        !projectRecordPattern.test(candidate.recordKey) ||
        recordKeys.has(candidate.recordKey) ||
        typeof candidate.ledgerSlot !== "string" ||
        !ledgerSlotPattern.test(candidate.ledgerSlot) ||
        ledgerSlots.has(candidate.ledgerSlot) ||
        typeof candidate.canonicalDirectory !== "string" ||
        candidate.canonicalDirectory.trim().length === 0
      ) {
        return unknown();
      }
      const canonicalDirectory = normalizeCanonicalDirectory(
        candidate.canonicalDirectory,
      );
      if (canonicalDirectory === undefined) return unknown();
      const directoryIdentity = platformDirectoryIdentity(canonicalDirectory);
      if (
        directoryIdentity !==
          platformDirectoryIdentity(candidate.canonicalDirectory) ||
        directoryIdentities.has(directoryIdentity)
      ) {
        return unknown();
      }
      recordKeys.add(candidate.recordKey);
      ledgerSlots.add(candidate.ledgerSlot);
      directoryIdentities.add(directoryIdentity);
      records.push({
        recordKey: candidate.recordKey,
        ledgerSlot: candidate.ledgerSlot,
        canonicalDirectory,
        directoryDigest: coordinatorDirectoryDigest(canonicalDirectory),
      });
    }
    if (
      (parsed.nextProjectOrdinal as number) < records.length + 1 ||
      (records.length === 0 && parsed.selectedRecordKey !== null) ||
      (records.length > 0 &&
        (typeof parsed.selectedRecordKey !== "string" ||
          !recordKeys.has(parsed.selectedRecordKey)))
    ) {
      return unknown();
    }
    const totals = mutableScanTotals();
    const fingerprintParts = [contents];
    for (const record of records) {
      const ledgerPath = join(
        dirname(registryPath),
        "project-ledgers",
        `${record.ledgerSlot}.sqlite`,
      );
      const project = scanProjectLedger(
        ledgerPath,
        record.directoryDigest,
        endpointId,
        state,
      );
      addBlockers(totals.blockers, project.blockers);
      totals.consequences.resumableSessionCount +=
        project.consequences.resumableSessionCount;
      if (project.consequences.resumableSessionCount > 0) {
        totals.consequences.projectCount += 1;
      }
      fingerprintParts.push(record.recordKey, project.fingerprint);
      if (!safeScanTotals(totals)) return unknown();
    }
    return {
      blockers: frozenBlockers(totals.blockers),
      consequences: frozenConsequences(totals.consequences),
      fingerprint: createHash("sha256")
        .update(fingerprintParts.join("\0"), "utf8")
        .digest("hex"),
    };
  } catch {
    return unknown();
  }
}

type MutableBlockers = {
  accepted: number;
  starting: number;
  inFlight: number;
  recoveryRequired: number;
  unknown: number;
};

type MutableConsequences = {
  resumableSessionCount: number;
  projectCount: number;
};

function mutableScanTotals(): {
  readonly blockers: MutableBlockers;
  readonly consequences: MutableConsequences;
} {
  return {
    blockers: {
      accepted: 0,
      starting: 0,
      inFlight: 0,
      recoveryRequired: 0,
      unknown: 0,
    },
    consequences: { resumableSessionCount: 0, projectCount: 0 },
  };
}

function addBlockers(
  target: MutableBlockers,
  source: AuthenticationMutationBlockers,
): void {
  target.accepted += source.accepted;
  target.starting += source.starting;
  target.inFlight += source.inFlight;
  target.recoveryRequired += source.recoveryRequired;
  target.unknown += source.unknown;
}

function safeScanTotals(totals: {
  readonly blockers: MutableBlockers;
  readonly consequences: MutableConsequences;
}): boolean {
  return [
    ...Object.values(totals.blockers),
    ...Object.values(totals.consequences),
  ].every((value) => Number.isSafeInteger(value) && value >= 0);
}

function scanProjectLedger(
  databasePath: string,
  expectedDirectoryDigest: string,
  endpointId: DurableRuntimeEndpointId,
  state: AuthenticationState,
): ProjectScan {
  let database: DatabaseSync | undefined;
  try {
    const information = lstatSync(databasePath);
    if (!information.isFile() || information.isSymbolicLink()) {
      throw new Error("invalid-ledger-file");
    }
    database = new DatabaseSync(databasePath, { readOnly: true });
    const version = Number(
      (database.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    if (version === 1 || version === 2) {
      if (
        !hasExactLedgerSchema(
          database,
          version === 1 ? versionOneLedgerColumns : versionTwoLedgerColumns,
        )
      ) {
        throw new Error("invalid-legacy-ledger-schema");
      }
      const sessionCount = Number(
        (database.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
          count: number;
        }).count,
      );
      const commandCount = Number(
        (database.prepare("SELECT COUNT(*) AS count FROM commands").get() as {
          count: number;
        }).count,
      );
      const projectCount = Number(
        (database.prepare("SELECT COUNT(*) AS count FROM projects").get() as {
          count: number;
        }).count,
      );
      const project = database
        .prepare("SELECT directory_digest FROM projects")
        .get() as { directory_digest: string } | undefined;
      if (
        !Number.isSafeInteger(sessionCount) ||
        sessionCount < 0 ||
        !Number.isSafeInteger(commandCount) ||
        commandCount < 0 ||
        projectCount !== 1 ||
        project?.directory_digest !== expectedDirectoryDigest ||
        database.prepare("PRAGMA foreign_key_check").all().length !== 0
      ) {
        throw new Error("invalid-session-count");
      }
      const unknownCount = Math.max(
        sessionCount,
        commandCount > 0 ? 1 : 0,
      );
      return {
        blockers: frozenBlockers({ unknown: unknownCount }),
        consequences: frozenConsequences(),
        fingerprint: ledgerFingerprint(
          database,
          `legacy:${version}:${projectCount}:${commandCount}:${sessionCount}`,
        ),
      };
    }
    const currentColumns =
      version === 3
        ? versionThreeColumns
        : version === 4
          ? versionFourColumns
          : version === 5
            ? versionFiveColumns
            : version === 6
              ? versionSixColumns
            : undefined;
    if (
      currentColumns === undefined ||
      !hasExactLedgerSchema(database, currentColumns) ||
      (version >= 4 && !hasExactSessionMetadataConstraints(database, version)) ||
      database.prepare("PRAGMA foreign_key_check").all().length !== 0 ||
      Number(
        (database.prepare("SELECT COUNT(*) AS count FROM projects").get() as {
          count: number;
        }).count,
        ) !== 1 ||
      (
        database.prepare("SELECT directory_digest FROM projects").get() as
          | { directory_digest: string }
          | undefined
      )?.directory_digest !== expectedDirectoryDigest
    ) {
      throw new Error("invalid-ledger-schema");
    }
    const sessions = database
      .prepare(
        version === 6
          ? `SELECT session_id, root_command_id, profile_json, lifecycle_status,
                    opaque_session_reference, auth_context_json, display_name,
                    display_name_source, archived, account_observation_json,
                    display_ordinal
               FROM sessions
              ORDER BY session_id`
          : version === 5
          ? `SELECT session_id, root_command_id, profile_json, lifecycle_status,
                    opaque_session_reference, auth_context_json, display_name,
                    display_name_source, archived, account_observation_json,
                    NULL AS display_ordinal
               FROM sessions
              ORDER BY session_id`
          : version === 4
            ? `SELECT session_id, root_command_id, profile_json, lifecycle_status,
                      opaque_session_reference, auth_context_json, display_name,
                      display_name_source, archived,
                      NULL AS account_observation_json,
                      NULL AS display_ordinal
                 FROM sessions
                ORDER BY session_id`
            : `SELECT session_id, root_command_id, profile_json, lifecycle_status,
                      opaque_session_reference, auth_context_json,
                      NULL AS display_name, NULL AS display_name_source,
                      0 AS archived, NULL AS account_observation_json,
                      NULL AS display_ordinal
                 FROM sessions
                ORDER BY session_id`,
      )
      .all() as unknown as Array<{
      session_id: string;
      root_command_id: string;
      profile_json: string;
      lifecycle_status: string;
      opaque_session_reference: string | null;
      auth_context_json: string | null;
      display_name: string | null;
      display_name_source: string | null;
      archived: number;
      account_observation_json: string | null;
      display_ordinal: number | null;
    }>;
    const commands = database
      .prepare(
        `SELECT command_id, command_kind, target_session_id, status,
                accepted_cursor, effect_phase, outcome_uncertain,
                auth_context_json, private_envelope_json
           FROM commands
          ORDER BY accepted_cursor, command_id`,
      )
      .all() as unknown as Array<{
      command_id: string;
      command_kind: string;
      target_session_id: string | null;
      status: string;
      accepted_cursor: number;
      effect_phase: string;
      outcome_uncertain: number;
      auth_context_json: string | null;
      private_envelope_json: string | null;
    }>;
    const totals = mutableScanTotals();
    const commandsBySession = new Map<string, typeof commands>();
    const commandsById = new Map<string, (typeof commands)[number]>();
    for (const command of commands) {
      if (
        typeof command.command_id !== "string" ||
        command.command_id.trim().length === 0 ||
        commandsById.has(command.command_id) ||
        (command.command_kind !== "start" &&
          command.command_kind !== "continue") ||
        typeof command.target_session_id !== "string" ||
        command.target_session_id.trim().length === 0 ||
        !Number.isSafeInteger(command.accepted_cursor) ||
        command.accepted_cursor <= 0
      ) {
        throw new Error("invalid-command-membership");
      }
      commandsById.set(command.command_id, command);
      const rows = commandsBySession.get(command.target_session_id) ?? [];
      rows.push(command);
      commandsBySession.set(command.target_session_id, rows);
    }
    const sessionIds = new Set<string>();
    for (const session of sessions) {
      if (
        typeof session.session_id !== "string" ||
        session.session_id.trim().length === 0 ||
        sessionIds.has(session.session_id)
      ) {
        throw new Error("invalid-session-membership");
      }
      sessionIds.add(session.session_id);
    }
    if (
      commands.some(
        (command) =>
          typeof command.target_session_id !== "string" ||
          !sessionIds.has(command.target_session_id),
      )
    ) {
      throw new Error("invalid-command-session-link");
    }
    for (const session of sessions) {
      if (
        typeof session.root_command_id !== "string" ||
        !isExactStoredProfileJson(session.profile_json) ||
        typeof session.lifecycle_status !== "string" ||
        (session.opaque_session_reference !== null &&
          (typeof session.opaque_session_reference !== "string" ||
            session.opaque_session_reference.trim().length === 0)) ||
        (version >= 4 && !isExactStoredSessionMetadata(session, version)) ||
        (session.account_observation_json !== null &&
          parseAccountObservation(session.account_observation_json) === undefined)
      ) {
        totals.blockers.unknown += 1;
        continue;
      }
      const sessionContext = parseAuthenticationContext(
        session.auth_context_json,
      );
      // An exact NULL/NULL row has no endpoint identity to manufacture. Its
      // activity matters for either endpoint while it is live; once managed
      // state makes native resume fail closed, a terminal row has no remaining
      // resumability consequence. Keep exact absence classifiable across
      // restarts instead of turning it into a permanent `unknown` blocker.
      const hasAuthenticationContextAbsence =
        session.auth_context_json === null;
      if (sessionContext === undefined && !hasAuthenticationContextAbsence) {
        totals.blockers.unknown += 1;
        continue;
      }
      const sessionCommands = commandsBySession.get(session.session_id) ?? [];
      const rootCommand = commandsById.get(session.root_command_id);
      if (
        rootCommand === undefined ||
        rootCommand.command_kind !== "start" ||
        rootCommand.target_session_id !== session.session_id ||
        sessionCommands.filter((command) => command.command_kind === "start")
          .length !== 1 ||
        sessionCommands.some(
          (command) =>
            (command.command_kind === "start") !==
            (command.command_id === session.root_command_id),
        ) ||
        sessionCommands.some((command) => {
          if (hasAuthenticationContextAbsence) {
            return command.auth_context_json !== null;
          }
          const commandContext = parseAuthenticationContext(
            command.auth_context_json,
          );
          return (
            commandContext === undefined ||
            sessionContext === undefined ||
            !sameAuthenticationContext(commandContext, sessionContext)
          );
        }) ||
        (version >= 4 &&
          session.display_name_source === "default" &&
          session.display_name !==
            `Agent Session ${String(rootCommand.accepted_cursor).padStart(2, "0")}` &&
          (version !== 6 ||
            (session.display_name !==
              `Agent Session ${String(session.display_ordinal).padStart(2, "0")}` &&
              session.display_name !==
                automaticSessionDisplayName(
                  storedCommandInput(rootCommand.private_envelope_json),
                ))))
      ) {
        totals.blockers.unknown += 1;
        continue;
      }
      if (
        sessionContext !== undefined &&
        sessionContext.endpointId !== endpointId
      ) {
        continue;
      }
      const activity = classifySessionActivity(
        session.lifecycle_status,
        sessionCommands,
      );
      if (activity !== "terminal") {
        totals.blockers[activity] += 1;
        continue;
      }
      if (
        session.lifecycle_status === "completed" &&
        typeof session.opaque_session_reference === "string" &&
        session.opaque_session_reference.trim().length > 0 &&
        ((hasAuthenticationContextAbsence &&
          isUnmodifiedPristineLegacyState(state)) ||
          (sessionContext !== undefined &&
            contextEligibleForState(state, sessionContext)))
      ) {
        totals.consequences.resumableSessionCount += 1;
      }
    }
    if (!safeScanTotals(totals)) throw new Error("unsafe-count");
    return {
      blockers: frozenBlockers(totals.blockers),
      consequences: frozenConsequences(totals.consequences),
      fingerprint: ledgerFingerprint(
        database,
        JSON.stringify({ sessions, commands }),
      ),
    };
  } catch {
    return {
      blockers: frozenBlockers({ unknown: 1 }),
      consequences: frozenConsequences(),
      fingerprint: "unreadable-ledger",
    };
  } finally {
    try {
      database?.close();
    } catch {
      // The scan result is already fail closed if the read itself failed.
    }
  }
}

function classifySessionActivity(
  lifecycleStatus: string,
  commands: readonly {
    readonly status: string;
    readonly effect_phase: string;
    readonly outcome_uncertain: number;
  }[],
): keyof MutableBlockers | "terminal" {
  if (
    ![
      "accepted",
      "in-flight",
      "completed",
      "failed",
      "recovery-required",
    ].includes(lifecycleStatus) ||
    commands.some((command) => !isExactCommandActivity(command))
  ) {
    return "unknown";
  }
  if (
    lifecycleStatus === "recovery-required" ||
    commands.some((command) => command.status === "recovery-required")
  ) {
    return "recoveryRequired";
  }
  const inFlight = commands.filter((command) => command.status === "in-flight");
  if (
    inFlight.some(
      (command) =>
        command.effect_phase === "send-claimed" ||
        command.effect_phase === "awaiting-terminal",
    )
  ) {
    return "inFlight";
  }
  if (
    inFlight.some(
      (command) =>
        command.effect_phase === "unclaimed" ||
        command.effect_phase === "binding-claimed" ||
        command.effect_phase === "binding-ready",
    )
  ) {
    return "starting";
  }
  if (
    lifecycleStatus === "accepted" ||
    commands.some((command) => command.status === "accepted")
  ) {
    return "accepted";
  }
  if (
    (lifecycleStatus === "completed" || lifecycleStatus === "failed") &&
    commands.every((command) =>
      ["completed", "failed"].includes(command.status),
    )
  ) {
    return "terminal";
  }
  return "unknown";
}

function isExactCommandActivity(command: {
  readonly status: string;
  readonly effect_phase: string;
  readonly outcome_uncertain: number;
}): boolean {
  if (command.status === "accepted") {
    return command.effect_phase === "unclaimed" && command.outcome_uncertain === 0;
  }
  if (command.status === "in-flight") {
    return (
      (command.effect_phase === "unclaimed" && command.outcome_uncertain === 0) ||
      (command.effect_phase === "binding-claimed" &&
        command.outcome_uncertain === 1) ||
      (command.effect_phase === "binding-ready" &&
        command.outcome_uncertain === 0) ||
      ((command.effect_phase === "send-claimed" ||
        command.effect_phase === "awaiting-terminal") &&
        command.outcome_uncertain === 1)
    );
  }
  if (command.status === "recovery-required") {
    return (
      command.outcome_uncertain === 1 &&
      [
        "binding-claimed",
        "binding-ready",
        "send-claimed",
        "awaiting-terminal",
      ].includes(command.effect_phase)
    );
  }
  if (command.status === "completed" || command.status === "failed") {
    return command.effect_phase === "committed" && command.outcome_uncertain === 0;
  }
  return false;
}

function contextEligibleForState(
  state: AuthenticationState,
  context: DurableAuthenticationContext,
): boolean {
  const endpoint = state.endpoints.find(
    (candidate) => candidate.endpointId === context.endpointId,
  );
  if (endpoint === undefined) return false;
  return endpoint.management === "pristine-legacy"
    ? context.management === "pristine-legacy"
    : context.management === "managed" &&
        context.generation === endpoint.generation;
}

function isUnmodifiedPristineLegacyState(state: AuthenticationState): boolean {
  return (
    state.revision === 0 &&
    state.endpoints.every(
      (endpoint) => endpoint.management === "pristine-legacy",
    )
  );
}

function sameAuthenticationContext(
  left: DurableAuthenticationContext,
  right: DurableAuthenticationContext,
): boolean {
  return (
    left.endpointId === right.endpointId &&
    left.management === right.management &&
    (left.management === "pristine-legacy" ||
      (right.management === "managed" &&
        left.generation === right.generation))
  );
}

function isExactStoredProfileJson(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 16 * 1024) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      isExactRecord(parsed, [
        "accessMode",
        "effortLevel",
        "executionMode",
        "model",
      ]) &&
      isBoundedProfileValue(parsed.model) &&
      isBoundedProfileValue(parsed.effortLevel) &&
      parsed.executionMode === "single-agent" &&
      parsed.accessMode === "full-access"
    );
  } catch {
    return false;
  }
}

function isBoundedProfileValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 1_024 &&
    !value.includes("\0")
  );
}

function ledgerFingerprint(database: DatabaseSync, contents: string): string {
  const cursor = database
    .prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM updates")
    .get() as { cursor: number };
  return createHash("sha256")
    .update(`${Number(cursor.cursor)}\0${contents}`, "utf8")
    .digest("hex");
}

const versionOneLedgerColumns = Object.freeze({
  commands: [
    "command_id",
    "project_id",
    "idempotency_digest",
    "payload_digest",
    "runtime",
    "status",
    "failure_category",
    "accepted_cursor",
  ],
  projects: ["project_id", "directory_digest"],
  sessions: ["session_id", "command_id", "profile_json"],
  updates: [
    "cursor",
    "project_id",
    "command_id",
    "kind",
    "status",
    "session_id",
    "data_json",
  ],
});

const versionTwoLedgerColumns = Object.freeze({
  commands: [
    "command_id",
    "project_id",
    "idempotency_digest",
    "payload_digest",
    "digest_version",
    "command_kind",
    "target_session_id",
    "runtime",
    "status",
    "failure_category",
    "accepted_cursor",
    "private_envelope_json",
    "effect_phase",
    "outcome_uncertain",
  ],
  projects: ["project_id", "directory_digest"],
  sessions: [
    "session_id",
    "project_id",
    "root_command_id",
    "profile_json",
    "opaque_session_reference",
    "lifecycle_status",
  ],
  updates: [
    "cursor",
    "project_id",
    "command_id",
    "kind",
    "status",
    "session_id",
    "data_json",
  ],
});

const versionThreeColumns = Object.freeze({
  ...versionTwoLedgerColumns,
  commands: [...versionTwoLedgerColumns.commands, "auth_context_json"],
  sessions: [...versionTwoLedgerColumns.sessions, "auth_context_json"],
});
const versionFourColumns = Object.freeze({
  ...versionThreeColumns,
  sessions: [
    ...versionThreeColumns.sessions,
    "display_name",
    "display_name_source",
    "archived",
  ],
});
const versionFiveColumns = Object.freeze({
  ...versionFourColumns,
  sessions: [...versionFourColumns.sessions, "account_observation_json"],
});
const versionSixColumns = Object.freeze({
  ...versionFiveColumns,
  sessions: [...versionFiveColumns.sessions, "display_ordinal"],
});

function hasExactLedgerSchema(
  database: DatabaseSync,
  expected: Readonly<
    Record<"commands" | "projects" | "sessions" | "updates", readonly string[]>
  >,
): boolean {
  const tables = (
    database
      .prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as unknown as Array<{ name: string }>
  ).map((row) => row.name);
  if (!sameStrings(tables, ["commands", "projects", "sessions", "updates"])) {
    return false;
  }
  for (const table of tables as Array<keyof typeof expected>) {
    const tableRecord = database
      .prepare(
        "SELECT ncol, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?",
      )
      .get(table) as { ncol: number; strict: number } | undefined;
    const columns = (
      database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    if (
      tableRecord === undefined ||
      Number(tableRecord.strict) !== 1 ||
      Number(tableRecord.ncol) !== expected[table].length ||
      !sameStrings(columns, expected[table])
    ) {
      return false;
    }
  }
  return true;
}

function hasExactSessionMetadataConstraints(
  database: DatabaseSync,
  version: number,
): boolean {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get() as { readonly sql: string } | undefined;
  const sessions = row?.sql.toLowerCase().replace(/\s+/gu, "") ?? "";
  const sourceConstraint =
    "check(display_name_sourceisnullordisplay_name_sourcein('default','manual'))";
  if (
    !sessions.includes(sourceConstraint) ||
    !sessions.includes("check(archivedin(0,1))") ||
    !sessions.includes("archivedintegernotnulldefault0")
  ) {
    return false;
  }
  if (version !== 6) return true;
  if (
    !sessions.includes("display_ordinalintegernotnull") ||
    !sessions.includes("check(display_ordinal>0)")
  ) {
    return false;
  }
  const indexes = database
    .prepare("PRAGMA index_list(sessions)")
    .all() as unknown as Array<{
    readonly name: string;
    readonly unique: number;
    readonly partial: number;
  }>;
  return indexes.some((index) => {
    if (Number(index.unique) !== 1 || Number(index.partial) !== 0) return false;
    const columns = (
      database.prepare(`PRAGMA index_info(${index.name})`).all() as unknown as Array<{
        readonly seqno: number;
        readonly name: string;
      }>
    )
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((column) => column.name);
    return sameStrings(columns, ["project_id", "display_ordinal"]);
  });
}

function isExactStoredSessionMetadata(value: {
  readonly display_name: string | null;
  readonly display_name_source: string | null;
  readonly display_ordinal: number | null;
  readonly archived: number;
  readonly lifecycle_status: string;
}, version: number): boolean {
  if (
    (value.archived !== 0 && value.archived !== 1) ||
    (version === 6 &&
      (!Number.isSafeInteger(value.display_ordinal) ||
        Number(value.display_ordinal) <= 0)) ||
    (version !== 6 && value.display_ordinal !== null) ||
    (value.archived === 1 &&
      value.lifecycle_status !== "completed" &&
      value.lifecycle_status !== "failed")
  ) {
    return false;
  }
  if (value.display_name === null || value.display_name_source === null) {
    return value.display_name === null && value.display_name_source === null;
  }
  return (
    normalizeSessionDisplayName(value.display_name) === value.display_name &&
    (value.display_name_source === "default" ||
      value.display_name_source === "manual")
  );
}

function storedCommandInput(serialized: string | null): unknown {
  if (serialized === null) return undefined;
  try {
    const candidate: unknown = JSON.parse(serialized);
    return isPlainRecord(candidate) ? candidate.input : undefined;
  } catch {
    return undefined;
  }
}

function sameStrings(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function parseAuthenticationContext(
  value: unknown,
): DurableAuthenticationContext | undefined {
  let candidate = value;
  const serialized = typeof candidate === "string" ? candidate : undefined;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (
    !isPlainRecord(candidate) ||
    candidate.schemaVersion !== 1 ||
    !isEndpointId(candidate.endpointId)
  ) {
    return undefined;
  }
  if (candidate.management === "pristine-legacy") {
    const parsed = isExactRecord(candidate, [
      "endpointId",
      "management",
      "schemaVersion",
    ])
      ? Object.freeze({
          schemaVersion: 1 as const,
          endpointId: candidate.endpointId,
          management: "pristine-legacy" as const,
        })
      : undefined;
    return parsed !== undefined &&
      (serialized === undefined || JSON.stringify(parsed) === serialized)
      ? parsed
      : undefined;
  }
  if (
    candidate.management !== "managed" ||
    !isExactRecord(candidate, [
      "endpointId",
      "generation",
      "management",
      "schemaVersion",
    ]) ||
    typeof candidate.generation !== "string" ||
    !generationPattern.test(candidate.generation)
  ) {
    return undefined;
  }
  const parsed = Object.freeze({
    schemaVersion: 1 as const,
    endpointId: candidate.endpointId,
    management: "managed" as const,
    generation: candidate.generation,
  });
  return serialized === undefined || JSON.stringify(parsed) === serialized
    ? parsed
    : undefined;
}

function contextMatchesPristineOrLegacy(
  parsed: DurableAuthenticationContext | undefined,
  original: unknown,
  endpointId: DurableRuntimeEndpointId,
): boolean {
  if (original === null || original === undefined) return true;
  return (
    parsed?.management === "pristine-legacy" &&
    parsed.endpointId === endpointId
  );
}

function frozenBlockers(
  values: Partial<AuthenticationMutationBlockers> = {},
): AuthenticationMutationBlockers {
  return Object.freeze({
    accepted: values.accepted ?? 0,
    starting: values.starting ?? 0,
    inFlight: values.inFlight ?? 0,
    recoveryRequired: values.recoveryRequired ?? 0,
    unknown: values.unknown ?? 0,
  });
}

function frozenConsequences(
  values: Partial<AuthenticationMutationConsequences> = {},
): AuthenticationMutationConsequences {
  return Object.freeze({
    resumableSessionCount: values.resumableSessionCount ?? 0,
    projectCount: values.projectCount ?? 0,
  });
}

function blockedUnknown(): AuthenticationMutationPreparation {
  return Object.freeze({
    kind: "blocked" as const,
    blockers: frozenBlockers({ unknown: 1 }),
  });
}

function hasBlockers(blockers: AuthenticationMutationBlockers): boolean {
  return (
    blockers.accepted > 0 ||
    blockers.starting > 0 ||
    blockers.inFlight > 0 ||
    blockers.recoveryRequired > 0 ||
    blockers.unknown > 0
  );
}

function isAuthenticationAction(
  value: unknown,
): value is WorkbenchAuthenticationAction {
  return value === "login" || value === "logout";
}

function normalizeCanonicalDirectory(value: string): string | undefined {
  try {
    const canonical = resolve(value);
    const root = parse(canonical).root;
    return platformDirectoryIdentity(canonical) === platformDirectoryIdentity(root)
      ? canonical
      : canonical.replace(/[\\/]+$/u, "");
  } catch {
    return undefined;
  }
}

function platformDirectoryIdentity(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function coordinatorDirectoryDigest(value: string): string {
  const identity = process.platform === "win32" ? value.toLowerCase() : value;
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

function isEndpointId(value: unknown): value is DurableRuntimeEndpointId {
  return value === "codex-desktop" || value === "claude-code-desktop";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every(
      (key) => typeof key === "string" && expectedKeys.includes(key),
    ) &&
    expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    })
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}
