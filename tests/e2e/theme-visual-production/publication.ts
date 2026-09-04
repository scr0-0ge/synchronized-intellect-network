import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { Page } from "playwright";

import { samePath } from "./launch-isolation.ts";
import { readPngDimensions } from "./visual-metrics.ts";

export type FailureFact = Readonly<{
  step: string;
  category: string;
}>;

export type PngSeal = Readonly<{
  file: string;
  bytes: number;
  sha256: string;
  dimensions: Readonly<{ width: number; height: number }>;
  reopened: true;
}>;

export type PendingPngCandidate = Readonly<{
  path: string;
  pendingFile: string;
  finalFile: string;
}>;

export type PendingPng = PendingPngCandidate & Readonly<{
  bytes: number;
  sha256: string;
  dimensions: Readonly<{ width: number; height: number }>;
  reopened: true;
}>;

export type PublishedPng = Readonly<{
  pending: PendingPng;
  finalPath: string;
}>;

export type EvidenceJsonSeal = Readonly<{
  bytes: Buffer;
  fact: Readonly<{
    file: string;
    bytes: number;
    sha256: string;
    encoding: "UTF-8";
    reopened: true;
  }>;
}>;

export type PublicationStaging = Readonly<{
  pngs: readonly Readonly<{
    pendingFile: string;
    pendingPresence: "PRESENT" | "MISSING" | "UNKNOWN";
    intendedFinalFile: string;
    finalPresence: "PRESENT" | "MISSING" | "UNKNOWN";
    expectedBytes: number | null;
    expectedSha256: string | null;
    expectedDimensions: Readonly<{ width: number; height: number }> | null;
  }>[];
  json: Readonly<{
    pendingFile: string;
    pendingPresence: "PRESENT" | "MISSING" | "UNKNOWN";
    finalFile: string;
    finalPresence: "PRESENT" | "MISSING" | "UNKNOWN";
  }>;
}>;

export type PublicationResult = Readonly<{
  evidence: EvidenceJsonSeal["fact"];
  pngs: readonly PngSeal[];
}>;

export class PublicationFailure extends Error {
  readonly code: string;
  readonly rollbackFailures: readonly FailureFact[];
  readonly staging: PublicationStaging;

  constructor(
    rollbackFailures: readonly FailureFact[],
    staging: PublicationStaging,
    category: string,
  ) {
    super("evidence-publication-failed");
    this.name = "PublicationFailure";
    this.code = category;
    this.rollbackFailures = rollbackFailures;
    this.staging = staging;
  }
}

export type ThemePublicationContext = Readonly<{
  evidenceDirectory: string;
  evidenceJsonPath: string;
  visualStates: readonly Readonly<{ screenshot: string }>[];
  viewport: Readonly<{ width: number; height: number }>;
  getActiveStep: () => string;
  setActiveStep: (step: string) => void;
}>;

export function createThemePublication(context: ThemePublicationContext) {
  const {
    evidenceDirectory,
    evidenceJsonPath,
    visualStates: VISUAL_STATES,
    viewport: VIEWPORT,
    getActiveStep,
    setActiveStep,
  } = context;

  async function captureAndReopenPendingPng(
    page: Page,
    candidate: PendingPngCandidate,
  ): Promise<PendingPng> {
    assert.match(
      candidate.pendingFile,
      /^worker-226-theme-pending-[0-9a-f-]{36}-[a-z-]+\.png$/u,
    );
    assert.equal(basename(candidate.path), candidate.pendingFile);
    assert.equal(samePath(dirname(candidate.path), evidenceDirectory), true);
    assert.ok(VISUAL_STATES.some((state) => state.screenshot === candidate.finalFile));
    await assertMissing(candidate.path);
    await page.screenshot({
      path: candidate.path,
      type: "png",
      animations: "disabled",
      caret: "hide",
      fullPage: false,
      scale: "css",
    });
    const bytes = await readFile(candidate.path);
    const dimensions = readPngDimensions(bytes);
    assert.deepEqual(dimensions, VIEWPORT);
    return Object.freeze({
      ...candidate,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      dimensions,
      reopened: true,
    });
  }

  async function publishFinalEvidence(
    pendingPngs: readonly PendingPng[],
    pendingJsonPath: string,
    document: Record<string, unknown>,
  ): Promise<PublicationResult> {
    const publishedPngs: PublishedPng[] = [];
    let pendingJson: EvidenceJsonSeal | undefined;
    try {
      assert.equal(pendingPngs.length, VISUAL_STATES.length);
      const finalPngs: PngSeal[] = [];
      for (const pending of pendingPngs) {
        setActiveStep(`publish/${pending.finalFile}/link`);
        const finalPath = join(evidenceDirectory, pending.finalFile);
        await link(pending.path, finalPath);
        publishedPngs.push(Object.freeze({ pending, finalPath }));

        setActiveStep(`publish/${pending.finalFile}/reopen-seal`);
        const final = await reopenAndSealPng(finalPath, pending.finalFile);
        assertPngMatchesPending(final, pending);
        finalPngs.push(final);
      }
      assertDocumentPngSeals(document, finalPngs);

      setActiveStep("publish/json-pending-write");
      await writeFile(pendingJsonPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      setActiveStep("publish/json-pending-reopen-validate");
      pendingJson = await readAndValidateEvidenceJson(pendingJsonPath, document);

      setActiveStep("publish/png-pending-remove");
      for (const pending of pendingPngs) {
        await assertPngPathMatchesPending(pending.path, pending);
        await unlink(pending.path);
        await assertMissing(pending.path);
      }

      setActiveStep("publish/json-final-absence");
      await assertMissing(evidenceJsonPath);
      setActiveStep("publish/json-rename");
      await rename(pendingJsonPath, evidenceJsonPath);
      setActiveStep("publish/json-final-reopen-seal");
      const finalJson = await readAndValidateEvidenceJson(evidenceJsonPath, document);
      assert.deepEqual(finalJson.bytes, pendingJson.bytes);
      return Object.freeze({
        evidence: finalJson.fact,
        pngs: Object.freeze(finalPngs),
      });
    } catch (error) {
      const publicationStep = getActiveStep();
      const rollbackFailures = await rollbackPublishedEvidence(
        publishedPngs,
        pendingJsonPath,
        pendingJson,
      );
      const staging = await inspectPublicationStaging(
        pendingPngs,
        pendingJsonPath,
      );
      setActiveStep(publicationStep);
      throw new PublicationFailure(rollbackFailures, staging, errorCategory(error));
    }
  }

  async function rollbackPublishedEvidence(
    publishedPngs: readonly PublishedPng[],
    pendingJsonPath: string,
    pendingJson: EvidenceJsonSeal | undefined,
  ): Promise<readonly FailureFact[]> {
    const failures: FailureFact[] = [];
    const finalJsonPresence = await inspectPathPresence(evidenceJsonPath);
    if (finalJsonPresence === "PRESENT") {
      try {
        assert.ok(pendingJson);
        assert.equal(await inspectPathPresence(pendingJsonPath), "MISSING");
        const finalJson = await readAndValidateEvidenceJsonBytes(
          evidenceJsonPath,
          pendingJson.bytes,
        );
        assert.deepEqual(finalJson.bytes, pendingJson.bytes);
        await rename(evidenceJsonPath, pendingJsonPath);
        await assertMissing(evidenceJsonPath);
      } catch {
        failures.push(
          failureFact("publication-rollback-json", "exact-final-json-rollback-failed"),
        );
      }
    } else if (finalJsonPresence === "UNKNOWN") {
      failures.push(
        failureFact("publication-rollback-json", "final-json-presence-ambiguous"),
      );
    }

    try {
      await assertMissing(evidenceJsonPath);
    } catch {
      if (!failures.some((failure) => failure.step === "publication-rollback-json")) {
        failures.push(
          failureFact("publication-rollback-json", "final-json-absence-not-proved"),
        );
      }
      return Object.freeze(failures);
    }

    for (const published of [...publishedPngs].reverse()) {
      try {
        const finalPresence = await inspectPathPresence(published.finalPath);
        if (finalPresence === "MISSING") continue;
        assert.equal(finalPresence, "PRESENT");
        await assertPngPathMatchesPending(published.finalPath, published.pending);

        const pendingPresence = await inspectPathPresence(published.pending.path);
        if (pendingPresence === "MISSING") {
          await link(published.finalPath, published.pending.path);
        } else {
          assert.equal(pendingPresence, "PRESENT");
        }
        await assertPngPathMatchesPending(published.pending.path, published.pending);
        await unlink(published.finalPath);
        await assertMissing(published.finalPath);
      } catch {
        failures.push(
          failureFact("publication-rollback-png", "exact-final-png-rollback-failed"),
        );
      }
    }
    return Object.freeze(failures);
  }

  async function reopenAndSealPng(path: string, file: string): Promise<PngSeal> {
    const status = await lstat(path);
    assert.equal(status.isFile(), true);
    assert.equal(status.isSymbolicLink(), false);
    assert.equal(basename(path), file);
    assert.equal(samePath(dirname(path), evidenceDirectory), true);
    const bytes = await readFile(path);
    const dimensions = readPngDimensions(bytes);
    assert.deepEqual(dimensions, VIEWPORT);
    return Object.freeze({
      file,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      dimensions,
      reopened: true,
    });
  }

  function pngSeal(file: string, pending: PendingPng): PngSeal {
    return Object.freeze({
      file,
      bytes: pending.bytes,
      sha256: pending.sha256,
      dimensions: pending.dimensions,
      reopened: true,
    });
  }

  function assertPngMatchesPending(final: PngSeal, pending: PendingPng): void {
    assert.deepEqual(final, pngSeal(pending.finalFile, pending));
  }

  async function assertPngPathMatchesPending(
    path: string,
    pending: PendingPng,
  ): Promise<void> {
    const seal = await reopenAndSealPng(path, basename(path));
    assert.equal(seal.bytes, pending.bytes);
    assert.equal(seal.sha256, pending.sha256);
    assert.deepEqual(seal.dimensions, pending.dimensions);
  }

  function assertDocumentPngSeals(
    document: Record<string, unknown>,
    finalPngs: readonly PngSeal[],
  ): void {
    assert.ok(Array.isArray(document.states));
    assert.equal(document.states.length, finalPngs.length);
    for (const [index, state] of document.states.entries()) {
      assert.equal(typeof state, "object");
      assert.ok(state);
      assert.deepEqual((state as Record<string, unknown>).screenshot, finalPngs[index]);
    }
  }

  async function readAndValidateEvidenceJson(
    path: string,
    expectedDocument: Record<string, unknown>,
  ): Promise<EvidenceJsonSeal> {
    const bytes = await readFile(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert.equal(text.endsWith("\n"), true);
    const parsed = JSON.parse(text) as unknown;
    assert.deepEqual(parsed, expectedDocument);
    return Object.freeze({
      bytes,
      fact: Object.freeze({
        file: basename(path),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        encoding: "UTF-8",
        reopened: true,
      }),
    });
  }

  async function readAndValidateEvidenceJsonBytes(
    path: string,
    expectedBytes: Buffer,
  ): Promise<EvidenceJsonSeal> {
    const bytes = await readFile(path);
    assert.deepEqual(bytes, expectedBytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(text);
    return Object.freeze({
      bytes,
      fact: Object.freeze({
        file: basename(path),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        encoding: "UTF-8",
        reopened: true,
      }),
    });
  }

  async function assertFinalEvidenceAbsent(): Promise<void> {
    for (const path of [
      ...VISUAL_STATES.map((state) =>
        join(evidenceDirectory, state.screenshot)
      ),
      evidenceJsonPath,
    ]) {
      await assertMissing(path);
    }
  }

  async function assertMissing(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (error) {
      if (errorCategory(error) === "ENOENT") return;
      throw error;
    }
    throw codedError("evidence-path-already-exists");
  }

  async function inspectPublicationStaging(
    candidates: readonly PendingPngCandidate[],
    pendingJsonPath: string,
  ): Promise<PublicationStaging> {
    const pngs = await Promise.all(
      candidates.map(async (candidate) => {
        const sealed = "bytes" in candidate ? (candidate as PendingPng) : undefined;
        return Object.freeze({
          pendingFile: candidate.pendingFile,
          pendingPresence: await inspectPathPresence(candidate.path),
          intendedFinalFile: candidate.finalFile,
          finalPresence: await inspectPathPresence(
            join(evidenceDirectory, candidate.finalFile),
          ),
          expectedBytes: sealed?.bytes ?? null,
          expectedSha256: sealed?.sha256 ?? null,
          expectedDimensions: sealed?.dimensions ?? null,
        });
      }),
    );
    return Object.freeze({
      pngs: Object.freeze(pngs),
      json: Object.freeze({
        pendingFile: basename(pendingJsonPath),
        pendingPresence: await inspectPathPresence(pendingJsonPath),
        finalFile: basename(evidenceJsonPath),
        finalPresence: await inspectPathPresence(evidenceJsonPath),
      }),
    });
  }

  async function inspectPathPresence(
    path: string,
  ): Promise<"PRESENT" | "MISSING" | "UNKNOWN"> {
    try {
      await lstat(path);
      return "PRESENT";
    } catch (error) {
      return errorCategory(error) === "ENOENT" ? "MISSING" : "UNKNOWN";
    }
  }

  return Object.freeze({
    captureAndReopenPendingPng,
    publishFinalEvidence,
    rollbackPublishedEvidence,
    reopenAndSealPng,
    pngSeal,
    assertFinalEvidenceAbsent,
    assertMissing,
    inspectPublicationStaging,
  });
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function failureFact(step: string, category: string): FailureFact {
  return Object.freeze({ step, category });
}

export function runtimeFailureFact(step: string, error: unknown): FailureFact {
  return failureFact(step, errorCategory(error));
}

export function errorCategory(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : error instanceof Error
      ? error.name
      : "unknown";
}

export function codedError(code: string): Error & Readonly<{ code: string }> {
  return Object.assign(new Error(code), { code });
}
