import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ProductionEvidence } from "./evidence.ts";

export type FailureFact = Readonly<{
  step: string;
  category: string;
}>;

export type PreparedEvidence = Readonly<{
  pendingPath: string;
  expectedBytes: Uint8Array;
}>;

export type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;

export type FilePresence = "PRESENT" | "MISSING" | "UNKNOWN";
export type PublicationCleanupPhase = "PUBLICATION_FAILURE" | "ROUTINE_ROOT_ROLLBACK";

export type PublicationCleanupFact = Readonly<{
  phase: PublicationCleanupPhase;
  pendingPresence: FilePresence;
  finalPresence: "PRESENT" | "MISSING" | "UNKNOWN";
  pendingRetained: boolean;
  exactIdentityProved: boolean;
  finalRemovalAttempted: boolean;
}>;

export type PublicationCleanupOutcome = Readonly<{
  fact: PublicationCleanupFact;
  failures: readonly FailureFact[];
}>;

export type PublicationSealOutcome = Readonly<{
  published: boolean;
  failure: FailureFact | null;
  cleanup: PublicationCleanupOutcome | null;
}>;

type InspectedFile = Readonly<{
  presence: FilePresence;
  identity: FileIdentity | null;
}>;

export function createEvidencePublication(productionEvidencePath: string) {
  function assertExactProductionEvidence(
    value: unknown,
  ): asserts value is ProductionEvidence {
    assert.ok(hasExactKeys(value, ["schema", "dist", "settings", "providers", "cleanup"]));
    assert.equal(value.schema, "settings-subscription-authentication-production-v1");
    assert.ok(hasExactKeys(value.dist, ["fresh", "treeSha256"]));
    assert.equal(value.dist.fresh, true);
    if (typeof value.dist.treeSha256 !== "string") {
      assert.fail("dist-tree-digest-invalid");
    }
    assert.match(value.dist.treeSha256, /^[0-9a-f]{64}$/u);
    assert.ok(
      hasExactKeys(value.settings, [
        "heading",
        "sections",
        "railEntryUnique",
        "headingUnique",
        "current",
        "titlebarSettingsAbsent",
        "sensitiveFieldsAbsent",
        "unsupportedActionsAbsent",
        "modelTurnSent",
      ]),
    );
    assert.equal(value.settings.heading, "Settings");
    assert.deepEqual(value.settings.sections, [
      "Appearance",
      "Providers",
      "Tools",
      "Usage & resets",
      "Claude permissions",
    ]);
    assert.equal(value.settings.railEntryUnique, true);
    assert.equal(value.settings.headingUnique, true);
    assert.equal(value.settings.current, true);
    assert.equal(value.settings.titlebarSettingsAbsent, true);
    assert.equal(value.settings.sensitiveFieldsAbsent, true);
    assert.equal(value.settings.unsupportedActionsAbsent, true);
    assert.equal(value.settings.modelTurnSent, false);
    assert.ok(Array.isArray(value.providers));
    assert.equal(value.providers.length, 2);
    const expected = [
      {
        name: "Codex",
        availability: "Ready",
        status: "Catalog ready",
        catalog: "Available",
        subscription: "Bound",
        bindAbsent: true,
        cancelAbsent: true,
      },
      {
        name: "Claude",
        availability: "Ready",
        status: "Catalog ready",
        catalog: "Available",
        subscription: "Bound",
        bindAbsent: true,
        cancelAbsent: true,
      },
    ];
    for (const [index, provider] of value.providers.entries()) {
      assert.ok(
        hasExactKeys(provider, [
          "name",
          "availability",
          "status",
          "catalog",
          "subscription",
          "bindAbsent",
          "cancelAbsent",
        ]),
      );
      assert.deepEqual(provider, expected[index]);
    }
    assert.ok(
      hasExactKeys(value.cleanup, [
        "mainProcessCaptured",
        "gracefulCloseAttempted",
        "gracefulCloseSucceeded",
        "terminationFallbackUsed",
        "forcedExactChildTerminationRequested",
        "exactChildDeathProved",
        "routineRootRemoved",
      ]),
    );
    assert.deepEqual(value.cleanup, {
      mainProcessCaptured: true,
      gracefulCloseAttempted: true,
      gracefulCloseSucceeded: true,
      terminationFallbackUsed: false,
      forcedExactChildTerminationRequested: false,
      exactChildDeathProved: true,
      routineRootRemoved: true,
    });
  }

  async function writeProductionEvidence(
    evidence: ProductionEvidence,
  ): Promise<PreparedEvidence> {
    assert.equal(await isMissing(productionEvidencePath), true);
    const expectedBytes = Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8");
    const pendingPath = join(
      dirname(productionEvidencePath),
      `${basename(productionEvidencePath)}.${randomUUID()}.pending`,
    );
    await writeFile(pendingPath, expectedBytes, { flag: "wx" });
    const pendingReopened = await readFile(pendingPath);
    assert.equal(pendingReopened.byteLength, expectedBytes.byteLength);
    assert.equal(sha256(pendingReopened), sha256(expectedBytes));
    assertExactProductionEvidence(
      JSON.parse(pendingReopened.toString("utf8")),
    );
    return Object.freeze({ pendingPath, expectedBytes });
  }

  async function sealProductionEvidence(
    prepared: PreparedEvidence,
  ): Promise<PublicationSealOutcome> {
    const { pendingPath, expectedBytes } = prepared;
    try {
      const pendingIdentity = await captureRegularFileIdentity(pendingPath);
      await link(pendingPath, productionEvidencePath);
      const finalIdentity = await captureRegularFileIdentity(productionEvidencePath);
      assert.equal(sameFileIdentity(pendingIdentity, finalIdentity), true);
      await validateEvidenceFile(productionEvidencePath, expectedBytes);
      const reopened = await readFile(productionEvidencePath);
      assert.equal(reopened.byteLength, expectedBytes.byteLength);
      assert.equal(sha256(reopened), sha256(expectedBytes));
      assertExactProductionEvidence(JSON.parse(reopened.toString("utf8")));
      const finalIdentityAfterValidation =
        await captureRegularFileIdentity(productionEvidencePath);
      assert.equal(
        sameFileIdentity(pendingIdentity, finalIdentityAfterValidation),
        true,
      );
      await unlink(pendingPath);
      assert.equal(await isMissing(pendingPath), true);
      return Object.freeze({ published: true, failure: null, cleanup: null });
    } catch (caught) {
      const cleanup = await recoverPendingAndRemoveFinal(
        prepared,
        "PUBLICATION_FAILURE",
      );
      return Object.freeze({
        published: false,
        failure: runtimeFailureFact("success-evidence/seal", caught),
        cleanup,
      });
    }
  }

  async function recoverPendingAndRemoveFinal(
    prepared: PreparedEvidence,
    phase: PublicationCleanupPhase,
  ): Promise<PublicationCleanupOutcome> {
    const { pendingPath, expectedBytes } = prepared;
    const failures: FailureFact[] = [];
    let pending = await inspectRegularFile(pendingPath);
    let final = await inspectRegularFile(productionEvidencePath);
    let pendingRetained = false;
    let exactIdentityProved = false;
    let finalRemovalAttempted = false;

    if (pending.presence === "MISSING" && final.presence === "PRESENT") {
      try {
        await validateEvidenceFile(productionEvidencePath, expectedBytes);
        await link(productionEvidencePath, pendingPath);
      } catch {
        failures.push(
          failureFact("publication-cleanup/pending", "pending-recovery-failed"),
        );
      }
      pending = await inspectRegularFile(pendingPath);
      final = await inspectRegularFile(productionEvidencePath);
    }

    if (pending.presence === "PRESENT") {
      try {
        await validateEvidenceFile(pendingPath, expectedBytes);
        pendingRetained = true;
      } catch {
        failures.push(
          failureFact("publication-cleanup/pending", "pending-validation-failed"),
        );
      }
    } else {
      failures.push(
        failureFact("publication-cleanup/pending", "pending-presence-unproved"),
      );
    }

    if (pending.identity !== null && final.identity !== null) {
      const pendingIdentity = pending.identity;
      const finalIdentity = final.identity;
      exactIdentityProved = sameFileIdentity(pendingIdentity, finalIdentity);
    }

    if (
      final.presence === "PRESENT" &&
      exactIdentityProved &&
      pendingRetained
    ) {
      try {
        const pendingIdentity = await captureRegularFileIdentity(pendingPath);
        const finalIdentity =
          await captureRegularFileIdentity(productionEvidencePath);
        assert.equal(sameFileIdentity(pendingIdentity, finalIdentity), true);
        await validateEvidenceFile(pendingPath, expectedBytes);
        finalRemovalAttempted = true;
        await unlink(productionEvidencePath);
        assert.equal(await isMissing(productionEvidencePath), true);
      } catch {
        failures.push(
          failureFact("publication-cleanup/final", "final-removal-unproved"),
        );
      }
    } else if (final.presence === "PRESENT") {
      failures.push(
        failureFact("publication-cleanup/final", "exact-identity-unproved"),
      );
    }

    pending = await inspectRegularFile(pendingPath);
    final = await inspectRegularFile(productionEvidencePath);
    if (pending.presence === "PRESENT") {
      try {
        await validateEvidenceFile(pendingPath, expectedBytes);
        pendingRetained = true;
      } catch {
        pendingRetained = false;
        failures.push(
          failureFact("publication-cleanup/pending", "retained-pending-invalid"),
        );
      }
    } else {
      pendingRetained = false;
    }

    return Object.freeze({
      fact: Object.freeze({
        phase,
        pendingPresence: pending.presence,
        finalPresence: final.presence,
        pendingRetained,
        exactIdentityProved,
        finalRemovalAttempted,
      }),
      failures: Object.freeze(failures),
    });
  }

  async function validateEvidenceFile(
    target: string,
    expectedBytes: Uint8Array,
  ): Promise<void> {
    const reopened = await readFile(target);
    assert.equal(reopened.byteLength, expectedBytes.byteLength);
    assert.equal(sha256(reopened), sha256(expectedBytes));
    assertExactProductionEvidence(JSON.parse(reopened.toString("utf8")));
  }

  async function captureRegularFileIdentity(target: string): Promise<FileIdentity> {
    const status = await lstat(target, { bigint: true });
    assert.equal(status.isFile(), true);
    assert.equal(status.isSymbolicLink(), false);
    return fileIdentity(status.dev, status.ino);
  }

  async function inspectRegularFile(target: string): Promise<InspectedFile> {
    try {
      const status = await lstat(target, { bigint: true });
      if (!status.isFile() || status.isSymbolicLink()) {
        return Object.freeze({ presence: "UNKNOWN", identity: null });
      }
      return Object.freeze({
        presence: "PRESENT",
        identity: fileIdentity(status.dev, status.ino),
      });
    } catch (caught) {
      return Object.freeze({
        presence: isMissingFailure(caught) ? "MISSING" : "UNKNOWN",
        identity: null,
      });
    }
  }

  return Object.freeze({
    assertExactProductionEvidence,
    writeProductionEvidence,
    sealProductionEvidence,
    recoverPendingAndRemoveFinal,
  });
}

export function fileIdentity(dev: bigint, ino: bigint): FileIdentity {
  assert.ok(dev >= 0n);
  assert.ok(ino >= 0n);
  return Object.freeze({ dev, ino });
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function failureFact(step: string, category: string): FailureFact {
  return Object.freeze({ step, category });
}

export function runtimeFailureFact(step: string, caught: unknown): FailureFact {
  if (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    caught.code === "ERR_ASSERTION"
  ) {
    return failureFact(step, "assertion-failed");
  }
  if (
    caught instanceof Error &&
    caught.message === "operation-timeout"
  ) {
    return failureFact(step, "operation-timeout");
  }
  return failureFact(step, "runtime-failed");
}

export async function isMissing(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (caught) {
    return isMissingFailure(caught);
  }
}

export function isMissingFailure(caught: unknown): boolean {
  return (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    caught.code === "ENOENT"
  );
}

export function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every(
      (key) =>
        keys.includes(key) &&
        Object.getOwnPropertyDescriptor(value, key)?.value !== undefined,
    )
  );
}
