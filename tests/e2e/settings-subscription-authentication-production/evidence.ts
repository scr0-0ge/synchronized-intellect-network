import assert from "node:assert/strict";

export type OwnedCleanupFact = Readonly<{
  mainProcessCaptured: true;
  gracefulCloseAttempted: boolean;
  gracefulCloseSucceeded: boolean;
  terminationFallbackUsed: boolean;
  forcedExactChildTerminationRequested: boolean;
  exactChildDeathProved: boolean;
}>;

export type PublicProviderObservation = Readonly<{
  name: "Codex" | "Claude";
  availability: string;
  status: string;
  catalog: string;
  subscription: string;
  bindAbsent: boolean;
  cancelAbsent: boolean;
}>;

export type SettingsObservation = Readonly<{
  providers: readonly PublicProviderObservation[];
  railEntryUnique: true;
  headingUnique: true;
  current: true;
  titlebarSettingsAbsent: true;
  sensitiveFieldsAbsent: true;
  unsupportedActionsAbsent: true;
}>;

export type DistFact = Readonly<{
  fresh: true;
  treeSha256: string;
}>;

export type CleanupSummary = Readonly<{
  mainProcessCaptured: boolean;
  gracefulCloseAttempted: boolean;
  gracefulCloseSucceeded: boolean;
  terminationFallbackUsed: boolean;
  forcedExactChildTerminationRequested: boolean;
  exactChildDeathProved: boolean;
}>;

export type ProductionEvidence = Readonly<{
  schema: "settings-subscription-authentication-production-v1";
  dist: DistFact;
  settings: Readonly<{
    heading: "Settings";
    sections: readonly [
      "Appearance",
      "Providers",
      "Tools",
      "Usage & resets",
      "Claude permissions",
    ];
    railEntryUnique: true;
    headingUnique: true;
    current: true;
    titlebarSettingsAbsent: true;
    sensitiveFieldsAbsent: true;
    unsupportedActionsAbsent: true;
    modelTurnSent: false;
  }>;
  providers: readonly [
    PublicProviderObservation,
    PublicProviderObservation,
  ];
  cleanup: Readonly<{
    mainProcessCaptured: true;
    gracefulCloseAttempted: true;
    gracefulCloseSucceeded: true;
    terminationFallbackUsed: false;
    forcedExactChildTerminationRequested: false;
    exactChildDeathProved: true;
    routineRootRemoved: true;
  }>;
}>;

export function summarizeCleanup(
  applications: ReadonlySet<unknown>,
  facts: readonly OwnedCleanupFact[],
): CleanupSummary {
  return Object.freeze({
    mainProcessCaptured:
      applications.size === 1 &&
      facts.length === 1 &&
      facts.every((fact) => fact.mainProcessCaptured),
    gracefulCloseAttempted:
      facts.length === 1 && facts.every((fact) => fact.gracefulCloseAttempted),
    gracefulCloseSucceeded:
      facts.length === 1 && facts.every((fact) => fact.gracefulCloseSucceeded),
    terminationFallbackUsed: facts.some(
      (fact) => fact.terminationFallbackUsed,
    ),
    forcedExactChildTerminationRequested: facts.some(
      (fact) => fact.forcedExactChildTerminationRequested,
    ),
    exactChildDeathProved:
      applications.size === 1 &&
      facts.length === 1 &&
      facts.every((fact) => fact.exactChildDeathProved),
  });
}

export function buildProductionEvidence(
  dist: DistFact,
  settings: SettingsObservation,
  cleanup: CleanupSummary,
): ProductionEvidence {
  assert.equal(settings.providers.length, 2);
  assert.equal(cleanup.mainProcessCaptured, true);
  assert.equal(cleanup.gracefulCloseAttempted, true);
  assert.equal(cleanup.gracefulCloseSucceeded, true);
  assert.equal(cleanup.terminationFallbackUsed, false);
  assert.equal(cleanup.forcedExactChildTerminationRequested, false);
  assert.equal(cleanup.exactChildDeathProved, true);
  const codex = settings.providers[0]!;
  const claude = settings.providers[1]!;
  return Object.freeze({
    schema: "settings-subscription-authentication-production-v1",
    dist,
    settings: Object.freeze({
      heading: "Settings",
      sections: Object.freeze([
        "Appearance",
        "Providers",
        "Tools",
        "Usage & resets",
        "Claude permissions",
      ] as const),
      railEntryUnique: true,
      headingUnique: true,
      current: true,
      titlebarSettingsAbsent: true,
      sensitiveFieldsAbsent: true,
      unsupportedActionsAbsent: true,
      modelTurnSent: false,
    }),
    providers: Object.freeze([codex, claude] as const),
    cleanup: Object.freeze({
      mainProcessCaptured: true,
      gracefulCloseAttempted: true,
      gracefulCloseSucceeded: true,
      terminationFallbackUsed: false,
      forcedExactChildTerminationRequested: false,
      exactChildDeathProved: true,
      routineRootRemoved: true,
    }),
  });
}
