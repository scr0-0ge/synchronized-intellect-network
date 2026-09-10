import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} from "node:path";
import { posix } from "node:path";

const copyMarkerFileName = ".conversation-store-copy-v1.json";
const mergePrivateDirectoryName = ".conversation-store-merge";
const mergeManifestFileName = "conversation-store-merge-v1.json";
const maximumMergeManifestBytes = 1_048_576;
const maximumMergeConflicts = 512;
const sourceLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const ledgerRelativePathPattern = /^project-ledgers\/[^/]+\.sqlite$/u;
const transientLedgerArtifactPattern =
  /^project-ledgers\/[^/]+\.sqlite-(?:wal|shm|journal)$/u;

interface PreparedSeededCopyMarker {
  readonly schemaVersion: 1;
  readonly kind: "seeded-conversation-store-copy";
  readonly sourceLabel: string;
  readonly seeded: true;
}

interface PreparedMergedCopyMarker {
  readonly schemaVersion: 1;
  readonly kind: "merged-conversation-store-copy";
  /** Stable label derived from the sealed marker and manifest bytes. */
  readonly sourceLabel: string;
  readonly sourceLabels: readonly string[];
  readonly sourceMutationAllowed: false;
  readonly preservedFiles: readonly PreservedFileProof[];
}

type PreparedCopyMarker = PreparedSeededCopyMarker | PreparedMergedCopyMarker;

interface PreservedFileProof {
  readonly relativePath: string;
  readonly sha256: string;
  readonly ledger: boolean;
}

interface ValidatedMergedManifest {
  readonly conflicts: readonly ConversationStoreMergeConflict[];
  readonly preservedFiles: readonly PreservedFileProof[];
}

interface InventoriedFile {
  readonly sourceLabel: string;
  readonly sourceDirectory: string;
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly ledger: boolean;
  readonly activeLedger: boolean;
}

interface InventoriedSource {
  readonly directory: string;
  readonly marker: PreparedCopyMarker;
  readonly files: readonly InventoriedFile[];
}

export interface ConversationStoreMergeConflict {
  readonly kind: "different-bytes-at-same-path";
  readonly relativePath: string;
  readonly activeSourceLabel: string;
  readonly incomingSourceLabel: string;
  readonly activeSha256: string;
  readonly incomingSha256: string;
  readonly preservedRelativePath: string;
}

interface PlannedUniqueFileVersion extends InventoriedFile {
  readonly destinationRelativePath: string;
}

interface PlannedInputMapping {
  readonly sourceLabel: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly destinationRelativePath: string;
}

export interface ConversationStoreMergePlan {
  readonly planDigest: `sha256:${string}`;
  readonly sources: readonly {
    readonly sourceLabel: string;
    readonly ledgerFiles: number;
    readonly files: number;
  }[];
  readonly counts: {
    readonly sourceLedgerFiles: readonly number[];
    readonly inputLedgerFiles: number;
    readonly activeOutputLedgerFiles: number;
    readonly preservedLedgerVersions: number;
    readonly inputFiles: number;
    readonly preservedFileVersions: number;
    readonly identicalDuplicates: number;
    readonly conflicts: number;
    readonly unpreservedFileVersions: 0;
  };
  readonly conflicts: readonly ConversationStoreMergeConflict[];
  /** Private execution detail used to reject overlap and re-inventory drift. */
  readonly sourceDirectories: readonly string[];
  /** Private execution detail. It is exposed only so a frozen plan is replayable. */
  readonly uniqueFileVersions: readonly PlannedUniqueFileVersion[];
  /** One mapping per input file proves every observed byte version has a destination. */
  readonly inputMappings: readonly PlannedInputMapping[];
}

export const conversationStoreStagingAuthorizationStatement =
  "I authorize exactly one staged merged copy from this plan. This does not authorize installing, replacing, renaming, or deleting any live conversation store.";

export interface ConversationStoreStagingAuthorization {
  readonly schemaVersion: 1;
  readonly kind: "conversation-store-staging-authorization";
  readonly scope: "create-new-merged-copy-only";
  readonly planDigest: `sha256:${string}`;
  readonly outputDirectory: string;
  readonly approvedAt: string;
  readonly ownerStatement: typeof conversationStoreStagingAuthorizationStatement;
}

export interface ConversationStoreMergeAppliedResult {
  readonly outputDirectory: string;
  readonly copiedFileVersions: number;
  readonly unpreservedFileVersions: 0;
}

export function assessConversationStoreRecoveryEvidence(evidence: unknown): {
  readonly kind: "insufficient-evidence";
  readonly reason: "store-roots-not-inventoried";
  readonly destructiveRecoveryAllowed: false;
  readonly nextRequiredEvidence: "complete-prepared-store-copy-inventories";
} {
  if (!isExactObject(evidence, ["kind", "missingLedgerCount"])) {
    throw new Error("invalid-conversation-store-recovery-evidence");
  }
  if (
    evidence.kind !== "missing-ledger-report" ||
    typeof evidence.missingLedgerCount !== "number" ||
    !Number.isSafeInteger(evidence.missingLedgerCount) ||
    evidence.missingLedgerCount < 0
  ) {
    throw new Error("invalid-conversation-store-recovery-evidence");
  }
  return Object.freeze({
    kind: "insufficient-evidence",
    reason: "store-roots-not-inventoried",
    destructiveRecoveryAllowed: false,
    nextRequiredEvidence: "complete-prepared-store-copy-inventories",
  });
}

export async function planConversationStoreMerge(options: {
  readonly copyDirectories: readonly string[];
}): Promise<ConversationStoreMergePlan> {
  if (
    !Array.isArray(options.copyDirectories) ||
    options.copyDirectories.length < 2 ||
    options.copyDirectories.length > 8
  ) {
    throw new Error("conversation-store-copy-set-invalid");
  }
  const sources: InventoriedSource[] = [];
  const sourceLabels = new Set<string>();
  const sourceDirectories = new Set<string>();
  for (const copyDirectory of options.copyDirectories) {
    const source = await inventoryPreparedCopy(copyDirectory);
    const directoryKey = pathKey(source.directory);
    if (
      sourceDirectories.has(directoryKey) ||
      sources.some((existing) =>
        pathsOverlap(existing.directory, source.directory),
      ) ||
      sourceLabels.has(source.marker.sourceLabel)
    ) {
      throw new Error("conversation-store-copy-set-invalid");
    }
    sourceDirectories.add(directoryKey);
    sourceLabels.add(source.marker.sourceLabel);
    sources.push(source);
  }

  const versionsByRelativePath = new Map<
    string,
    PlannedUniqueFileVersion[]
  >();
  const uniqueFileVersions: PlannedUniqueFileVersion[] = [];
  const inputMappings: PlannedInputMapping[] = [];
  const conflicts: ConversationStoreMergeConflict[] = [];
  let identicalDuplicates = 0;

  for (const source of sources) {
    for (const file of source.files) {
      const relativePathKey = portablePathKey(file.relativePath);
      const existingVersions = versionsByRelativePath.get(relativePathKey) ?? [];
      const identical = existingVersions.find(
        (version) => version.sha256 === file.sha256,
      );
      if (identical !== undefined) {
        identicalDuplicates += 1;
        inputMappings.push(
          Object.freeze({
            sourceLabel: file.sourceLabel,
            relativePath: file.relativePath,
            sha256: file.sha256,
            destinationRelativePath: identical.destinationRelativePath,
          }),
        );
        continue;
      }

      let destinationRelativePath = file.relativePath;
      if (existingVersions.length > 0) {
        destinationRelativePath = posix.join(
          mergePrivateDirectoryName,
          "conflicts",
          file.sourceLabel,
          file.relativePath,
        );
        const active = existingVersions[0]!;
        conflicts.push(
          Object.freeze({
            kind: "different-bytes-at-same-path",
            relativePath: file.relativePath,
            activeSourceLabel: active.sourceLabel,
            incomingSourceLabel: file.sourceLabel,
            activeSha256: active.sha256,
            incomingSha256: file.sha256,
            preservedRelativePath: destinationRelativePath,
          }),
        );
      }
      const plannedVersion = Object.freeze({
        ...file,
        destinationRelativePath,
      });
      existingVersions.push(plannedVersion);
      versionsByRelativePath.set(relativePathKey, existingVersions);
      uniqueFileVersions.push(plannedVersion);
      inputMappings.push(
        Object.freeze({
          sourceLabel: file.sourceLabel,
          relativePath: file.relativePath,
          sha256: file.sha256,
          destinationRelativePath,
        }),
      );
    }
  }

  const sourceSummary = sources.map((source) =>
    Object.freeze({
      sourceLabel: source.marker.sourceLabel,
      ledgerFiles: source.files.filter((file) => file.ledger).length,
      files: source.files.length,
    }),
  );
  if (conflicts.length > maximumMergeConflicts) {
    throw new Error("conversation-store-merge-manifest-too-large");
  }
  const sourceLedgerFiles = sourceSummary.map((source) => source.ledgerFiles);
  const preservedLedgerVersions = uniqueFileVersions.filter(
    (version) => version.ledger,
  ).length;
  const activeOutputLedgerFiles = uniqueFileVersions.filter(
    (version) =>
      version.activeLedger &&
      version.destinationRelativePath === version.relativePath,
  ).length;

  const frozenSources = Object.freeze(sourceSummary);
  const counts = Object.freeze({
    sourceLedgerFiles: Object.freeze(sourceLedgerFiles),
    inputLedgerFiles: sourceLedgerFiles.reduce((sum, count) => sum + count, 0),
    activeOutputLedgerFiles,
    preservedLedgerVersions,
    inputFiles: inputMappings.length,
    preservedFileVersions: uniqueFileVersions.length,
    identicalDuplicates,
    conflicts: conflicts.length,
    unpreservedFileVersions: 0 as const,
  });
  const frozenConflicts = Object.freeze(conflicts);
  const frozenInputMappings = Object.freeze(inputMappings);
  const planDigest = digestJson({
    schemaVersion: 1,
    kind: "conversation-store-merge-plan",
    sources: frozenSources,
    counts,
    conflicts: frozenConflicts,
    inputMappings: frozenInputMappings,
  });

  const plan = Object.freeze({
    planDigest,
    sources: frozenSources,
    counts,
    conflicts: frozenConflicts,
    sourceDirectories: Object.freeze(sources.map((source) => source.directory)),
    uniqueFileVersions: Object.freeze(uniqueFileVersions),
    inputMappings: frozenInputMappings,
  });
  assertMergeManifestFits(plan);
  return plan;
}

export async function applyConversationStoreMerge(options: {
  readonly plan: ConversationStoreMergePlan;
  readonly outputDirectory: string;
  /** Parsed at this boundary so JSON callers cannot bypass exact-shape validation. */
  readonly authorization?: unknown;
}): Promise<ConversationStoreMergeAppliedResult> {
  const outputDirectory = absoluteDirectory(
    options.outputDirectory,
    "conversation-store-output-invalid",
  );
  if (options.authorization === undefined) {
    throw new Error("conversation-store-owner-authorization-required");
  }
  const refreshedPlan = await planConversationStoreMerge({
    copyDirectories: options.plan.sourceDirectories,
  });
  if (refreshedPlan.planDigest !== options.plan.planDigest) {
    throw new Error("conversation-store-copy-drift");
  }
  if (
    JSON.stringify(refreshedPlan.sourceDirectories) !==
      JSON.stringify(options.plan.sourceDirectories) ||
    JSON.stringify(refreshedPlan.uniqueFileVersions) !==
      JSON.stringify(options.plan.uniqueFileVersions)
  ) {
    throw new Error("conversation-store-plan-drift");
  }
  assertStagingAuthorization(
    options.authorization,
    refreshedPlan,
    outputDirectory,
  );
  await assertDestinationOutsideSources(
    outputDirectory,
    refreshedPlan.sourceDirectories,
    "conversation-store-output-overlaps-source",
    "conversation-store-output-path-aliased",
  );
  try {
    await lstat(outputDirectory);
    throw new Error("conversation-store-output-exists");
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  const manifestText = mergeManifestText(refreshedPlan);
  const markerText = `${JSON.stringify({
    schemaVersion: 1,
    kind: "merged-conversation-store-copy",
    sourceLabels: refreshedPlan.sources.map((source) => source.sourceLabel),
    sourceMutationAllowed: false,
  })}\n`;
  const outputParent = dirname(outputDirectory);
  await mkdir(outputParent, { recursive: true });
  await assertDestinationOutsideSources(
    outputDirectory,
    refreshedPlan.sourceDirectories,
    "conversation-store-output-overlaps-source",
    "conversation-store-output-path-aliased",
  );
  let stagingDirectory: string | undefined = await mkdtemp(
    // mkdtemp needs the physical, extended-length spelling on Windows too.
    toNamespacedPath(join(await realpath(outputParent), ".conversation-store-merge-staging-")),
  );
  try {
    for (const version of refreshedPlan.uniqueFileVersions) {
      const currentSourceHash = await sha256File(version.sourcePath);
      if (currentSourceHash !== version.sha256) {
        throw new Error("conversation-store-copy-drift");
      }
      const destination = nativeDestination(
        stagingDirectory,
        version.destinationRelativePath,
      );
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(version.sourcePath, destination, constants.COPYFILE_EXCL);
      const [copiedHash, copiedStatus] = await Promise.all([
        sha256File(destination),
        stat(destination),
      ]);
      if (copiedHash !== version.sha256 || copiedStatus.size !== version.bytes) {
        throw new Error("conversation-store-copy-verification-failed");
      }
    }

    const outputHashes = new Map<string, string>();
    let unpreservedFileVersions = 0;
    for (const mapping of refreshedPlan.inputMappings) {
      let outputHash = outputHashes.get(mapping.destinationRelativePath);
      if (outputHash === undefined) {
        outputHash = await sha256File(
          nativeDestination(stagingDirectory, mapping.destinationRelativePath),
        );
        outputHashes.set(mapping.destinationRelativePath, outputHash);
      }
      if (outputHash !== mapping.sha256) unpreservedFileVersions += 1;
    }
    if (unpreservedFileVersions !== 0) {
      throw new Error("conversation-store-merge-data-loss-detected");
    }

    await writeFile(join(stagingDirectory, mergeManifestFileName), manifestText, {
      encoding: "utf8",
      flag: "wx",
    });
    await writeFile(join(stagingDirectory, copyMarkerFileName), markerText, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(stagingDirectory, outputDirectory);
    stagingDirectory = undefined;
  } catch (error) {
    if (stagingDirectory !== undefined) {
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "conversation-store-staging-cleanup-failed",
        );
      }
    }
    throw error;
  }

  return Object.freeze({
    outputDirectory,
    copiedFileVersions: refreshedPlan.uniqueFileVersions.length,
    unpreservedFileVersions: 0 as const,
  });
}

export function renderConversationStoreMergeReport(
  plan: ConversationStoreMergePlan,
  options: { readonly dryRun: boolean },
): string {
  const lines = [
    "# Conversation store merge report",
    "",
    `Mode: **${options.dryRun ? "dry run — no merged store was created" : "applied to a new merged copy"}**`,
    `Plan: \`${plan.planDigest}\``,
    "",
    "No source file will be changed. No ledger is deleted, truncated, rewritten, or selected by this tool.",
    "",
    "## What was found",
    "",
  ];
  for (const source of plan.sources) {
    lines.push(`- **${source.sourceLabel}:** ${source.ledgerFiles} ledger files`);
  }
  lines.push(
    `- **${plan.counts.inputLedgerFiles} ledger versions observed** across all prepared copies`,
    `- **${plan.counts.activeOutputLedgerFiles} active ledger files** in the merged store`,
    `- **${plan.counts.conflicts} conflicting variant${plan.counts.conflicts === 1 ? "" : "s"} preserved separately**`,
    `- **${plan.counts.preservedLedgerVersions} distinct ledger byte versions preserved**`,
    `- **${plan.counts.unpreservedFileVersions} unpreserved file versions**`,
    "",
    "Byte-identical duplicates are stored once; that loses no distinct data. A different file at the same path is never chosen over another version: the first prepared copy remains active and every differing incoming version gets a separate conflict path.",
    "",
    "## Conflicts",
    "",
  );
  if (plan.conflicts.length === 0) {
    lines.push("No conflicts were found.");
  } else {
    plan.conflicts.forEach((conflict, index) => {
      lines.push(
        `${index + 1}. \`${conflict.relativePath}\` differs between **${conflict.activeSourceLabel}** and **${conflict.incomingSourceLabel}**.`,
        `   - Active-copy SHA-256: \`${conflict.activeSha256}\``,
        `   - Incoming SHA-256: \`${conflict.incomingSha256}\``,
        `   - Incoming bytes are preserved at \`${conflict.preservedRelativePath}\`.`,
        "   - No choice was made; the owner must decide which history to adopt after inspection.",
      );
    });
  }
  lines.push(
    "",
    "## Safety conclusion",
    "",
    plan.counts.unpreservedFileVersions === 0
      ? "Every inventoried byte version has a destination. Planned data loss: **zero**."
      : "The plan is incomplete and must not be applied.",
    "A missing-ledger count by itself cannot create this plan; complete inventories of at least two exact, seeded store copies are required.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function inventoryPreparedCopy(directory: string): Promise<InventoriedSource> {
  const lexicalDirectory = absoluteDirectory(
    directory,
    "conversation-store-copy-root-invalid",
  );
  const rootStatus = await lstat(lexicalDirectory);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("conversation-store-copy-root-invalid");
  }
  // The guard's target is aliasing introduced by filesystem objects: any
  // junction/symlink ancestor could redirect the walk to another physical
  // tree. Mere spelling differences (8.3 short names, SUBST drives, namespace
  // prefixes) carry no such redirection, so each lexical ancestor is probed
  // for reparse points instead of requiring the realpath to match lexically.
  await assertNoReparsePointAncestors(
    lexicalDirectory,
    "conversation-store-copy-root-invalid",
  );
  const physicalDirectory = await realpath(lexicalDirectory);
  let marker = await readPreparedCopyMarker(physicalDirectory);
  let files: InventoriedFile[] = [];
  await walkPreparedCopy(physicalDirectory, "", marker, files);
  if (marker.kind === "merged-conversation-store-copy") {
    assertPreservedFilesPresent(marker, physicalDirectory, files);
    const finalized = finalizeMergedInventory(marker, physicalDirectory, files);
    marker = finalized.marker;
    files = finalized.files;
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return Object.freeze({
    directory: physicalDirectory,
    marker,
    files: Object.freeze(files),
  });
}

async function walkPreparedCopy(
  root: string,
  relativeDirectory: string,
  marker: PreparedCopyMarker,
  files: InventoriedFile[],
): Promise<void> {
  const nativeDirectory = nativeDestination(root, relativeDirectory);
  const entries = await readdir(nativeDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory.length === 0
      ? entry.name
      : posix.join(relativeDirectory, entry.name);
    const relativePathKey = portablePathKey(relativePath);
    const copyMarker = relativePathKey === portablePathKey(copyMarkerFileName);
    if (copyMarker && marker.kind === "seeded-conversation-store-copy") continue;
    const reservedPath =
      relativePathKey === portablePathKey(mergePrivateDirectoryName) ||
      relativePathKey.startsWith(`${portablePathKey(mergePrivateDirectoryName)}/`) ||
      relativePathKey === portablePathKey(mergeManifestFileName);
    if (reservedPath && marker.kind === "seeded-conversation-store-copy") {
      throw new Error("conversation-store-copy-reserved-path");
    }
    if (transientLedgerArtifactPattern.test(relativePathKey)) {
      throw new Error("conversation-store-copy-not-quiescent");
    }
    const nativePath = nativeDestination(root, relativePath);
    const status = await lstat(nativePath);
    if (status.isSymbolicLink()) {
      throw new Error("conversation-store-copy-entry-invalid");
    }
    if (status.isDirectory()) {
      await walkPreparedCopy(root, relativePath, marker, files);
      continue;
    }
    if (!status.isFile()) {
      throw new Error("conversation-store-copy-entry-invalid");
    }
    const logicalRelativePath =
      marker.kind === "merged-conversation-store-copy" &&
      (copyMarker || reservedPath)
        ? posix.join(
            mergePrivateDirectoryName,
            "prior",
            marker.sourceLabel,
            relativePath,
          )
        : relativePath;
    const logicalRelativePathKey = portablePathKey(logicalRelativePath);
    files.push(
      Object.freeze({
        sourceLabel: marker.sourceLabel,
        sourceDirectory: root,
        sourcePath: nativePath,
        relativePath: logicalRelativePath,
        sha256: await sha256File(nativePath),
        bytes: status.size,
        ledger:
          ledgerRelativePathPattern.test(relativePathKey) ||
          (marker.kind === "merged-conversation-store-copy" &&
            marker.preservedFiles.some(
              (proof) =>
                proof.ledger &&
                portablePathKey(proof.relativePath) === relativePathKey,
            )),
        activeLedger: ledgerRelativePathPattern.test(logicalRelativePathKey),
      }),
    );
  }
}

async function readPreparedCopyMarker(
  directory: string,
): Promise<PreparedCopyMarker> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(directory, copyMarkerFileName));
  } catch (error) {
    if (isMissingPath(error)) {
      throw new Error("conversation-store-copy-marker-missing");
    }
    throw error;
  }
  if (bytes.length > 4_096) {
    throw new Error("conversation-store-copy-marker-invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("conversation-store-copy-marker-invalid");
  }
  if (
    !isExactObject(value, ["schemaVersion", "kind", "sourceLabel", "seeded"]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "seeded-conversation-store-copy" ||
    typeof value.sourceLabel !== "string" ||
    !sourceLabelPattern.test(value.sourceLabel) ||
    value.seeded !== true
  ) {
    return readMergedCopyMarker(directory, bytes, value);
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "seeded-conversation-store-copy",
    sourceLabel: value.sourceLabel,
    seeded: true,
  });
}

async function readMergedCopyMarker(
  directory: string,
  markerBytes: Buffer,
  value: unknown,
): Promise<PreparedMergedCopyMarker> {
  if (
    !isExactObject(value, [
      "schemaVersion",
      "kind",
      "sourceLabels",
      "sourceMutationAllowed",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "merged-conversation-store-copy" ||
    !isSourceLabelArray(value.sourceLabels) ||
    value.sourceMutationAllowed !== false
  ) {
    throw new Error("conversation-store-copy-marker-invalid");
  }
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(join(directory, mergeManifestFileName));
  } catch {
    throw new Error("conversation-store-copy-marker-invalid");
  }
  if (manifestBytes.length > maximumMergeManifestBytes) {
    throw new Error("conversation-store-copy-marker-invalid");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("conversation-store-copy-marker-invalid");
  }
  const validatedManifest = validateMergedManifest(
    manifest,
    value.sourceLabels,
  );
  if (validatedManifest === undefined) {
    throw new Error("conversation-store-copy-marker-invalid");
  }
  const sourceLabel = `merged-${createHash("sha256")
    .update(markerBytes)
    .update("\0", "utf8")
    .update(manifestBytes)
    .digest("hex")
    .slice(0, 16)}`;
  return Object.freeze({
    schemaVersion: 1,
    kind: "merged-conversation-store-copy",
    sourceLabel,
    sourceLabels: Object.freeze([...value.sourceLabels]),
    sourceMutationAllowed: false,
    preservedFiles: validatedManifest.preservedFiles,
  });
}

function validateMergedManifest(
  value: unknown,
  markerSourceLabels: readonly string[],
): ValidatedMergedManifest | undefined {
  const legacyKeys = [
    "schemaVersion",
    "kind",
    "sourceLabels",
    "counts",
    "conflicts",
    "sourceMutationAllowed",
    "destructiveRecoveryAllowed",
  ];
  const digestKeys = [...legacyKeys, "planDigest"];
  const proofKeys = [...digestKeys, "preservedFiles"];
  const legacy = isExactObject(value, legacyKeys);
  const digestOnly = isExactObject(value, digestKeys);
  const withProofs = isExactObject(value, proofKeys);
  if (!legacy && !digestOnly && !withProofs) return undefined;
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "conversation-store-merge" ||
    !isSourceLabelArray(manifest.sourceLabels) ||
    JSON.stringify(manifest.sourceLabels) !== JSON.stringify(markerSourceLabels) ||
    manifest.sourceMutationAllowed !== false ||
    manifest.destructiveRecoveryAllowed !== false ||
    (!legacy &&
      (typeof manifest.planDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(manifest.planDigest))) ||
    !Array.isArray(manifest.conflicts)
  ) {
    return undefined;
  }
  const conflicts: ConversationStoreMergeConflict[] = [];
  for (const candidate of manifest.conflicts) {
    const conflict = validatedConflict(candidate, markerSourceLabels);
    if (conflict === undefined) return undefined;
    conflicts.push(conflict);
  }
  const counts = validatedManifestCounts(
    manifest.counts,
    markerSourceLabels.length,
    conflicts.length,
  );
  if (counts === undefined) return undefined;

  const preservedFiles = withProofs
    ? validatedPreservedFiles(manifest.preservedFiles)
    : conflicts.map((conflict) =>
        Object.freeze({
          relativePath: conflict.preservedRelativePath,
          sha256: conflict.incomingSha256,
          ledger: ledgerRelativePathPattern.test(
            portablePathKey(conflict.relativePath),
          ),
        }),
      );
  if (preservedFiles === undefined) return undefined;
  const proofByPath = new Map(
    preservedFiles.map((proof) => [portablePathKey(proof.relativePath), proof]),
  );
  if (
    conflicts.some((conflict) => {
      const proof = proofByPath.get(
        portablePathKey(conflict.preservedRelativePath),
      );
      return proof === undefined || proof.sha256 !== conflict.incomingSha256;
    }) ||
    counts.preservedLedgerVersions - counts.activeOutputLedgerFiles !==
      preservedFiles.filter((proof) => proof.ledger).length
  ) {
    return undefined;
  }
  return Object.freeze({
    conflicts: Object.freeze(conflicts),
    preservedFiles: Object.freeze(preservedFiles),
  });
}

function validatedManifestCounts(
  value: unknown,
  sourceCount: number,
  conflictCount: number,
):
  | {
      readonly activeOutputLedgerFiles: number;
      readonly preservedLedgerVersions: number;
    }
  | undefined {
  if (
    !isExactObject(value, [
      "sourceLedgerFiles",
      "inputLedgerFiles",
      "activeOutputLedgerFiles",
      "preservedLedgerVersions",
      "inputFiles",
      "preservedFileVersions",
      "identicalDuplicates",
      "conflicts",
      "unpreservedFileVersions",
    ]) ||
    !Array.isArray(value.sourceLedgerFiles) ||
    value.sourceLedgerFiles.length !== sourceCount ||
    !value.sourceLedgerFiles.every(nonnegativeSafeInteger) ||
    !nonnegativeSafeInteger(value.inputLedgerFiles) ||
    !nonnegativeSafeInteger(value.activeOutputLedgerFiles) ||
    !nonnegativeSafeInteger(value.preservedLedgerVersions) ||
    !nonnegativeSafeInteger(value.inputFiles) ||
    !nonnegativeSafeInteger(value.preservedFileVersions) ||
    !nonnegativeSafeInteger(value.identicalDuplicates) ||
    !nonnegativeSafeInteger(value.conflicts) ||
    value.unpreservedFileVersions !== 0
  ) {
    return undefined;
  }
  const sourceLedgerTotal = value.sourceLedgerFiles.reduce(
    (sum: number, count: number) => sum + count,
    0,
  );
  if (
    !Number.isSafeInteger(sourceLedgerTotal) ||
    value.inputLedgerFiles !== sourceLedgerTotal ||
    value.inputLedgerFiles > value.inputFiles ||
    value.activeOutputLedgerFiles > value.preservedLedgerVersions ||
    value.preservedLedgerVersions > value.inputLedgerFiles ||
    value.preservedLedgerVersions > value.preservedFileVersions ||
    value.preservedFileVersions > value.inputFiles ||
    value.identicalDuplicates !== value.inputFiles - value.preservedFileVersions ||
    value.conflicts !== conflictCount ||
    value.conflicts > value.preservedFileVersions
  ) {
    return undefined;
  }
  return Object.freeze({
    activeOutputLedgerFiles: value.activeOutputLedgerFiles,
    preservedLedgerVersions: value.preservedLedgerVersions,
  });
}

function validatedConflict(
  value: unknown,
  sourceLabels: readonly string[],
): ConversationStoreMergeConflict | undefined {
  if (
    !isExactObject(value, [
      "kind",
      "relativePath",
      "activeSourceLabel",
      "incomingSourceLabel",
      "activeSha256",
      "incomingSha256",
      "preservedRelativePath",
    ]) ||
    value.kind !== "different-bytes-at-same-path" ||
    !validPortableRelativePath(value.relativePath) ||
    typeof value.activeSourceLabel !== "string" ||
    typeof value.incomingSourceLabel !== "string" ||
    value.activeSourceLabel === value.incomingSourceLabel ||
    !sourceLabels.includes(value.activeSourceLabel) ||
    !sourceLabels.includes(value.incomingSourceLabel) ||
    typeof value.activeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.activeSha256) ||
    typeof value.incomingSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.incomingSha256) ||
    !validPortableRelativePath(value.preservedRelativePath) ||
    portablePathKey(value.preservedRelativePath) !==
      portablePathKey(
        posix.join(
          mergePrivateDirectoryName,
          "conflicts",
          value.incomingSourceLabel,
          value.relativePath,
        ),
      )
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "different-bytes-at-same-path",
    relativePath: value.relativePath,
    activeSourceLabel: value.activeSourceLabel,
    incomingSourceLabel: value.incomingSourceLabel,
    activeSha256: value.activeSha256,
    incomingSha256: value.incomingSha256,
    preservedRelativePath: value.preservedRelativePath,
  });
}

function validatedPreservedFiles(
  value: unknown,
): readonly PreservedFileProof[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const proofs: PreservedFileProof[] = [];
  const paths = new Set<string>();
  for (const candidate of value) {
    if (
      !isExactObject(candidate, ["relativePath", "sha256", "ledger"]) ||
      !validPortableRelativePath(candidate.relativePath) ||
      !portablePathKey(candidate.relativePath).startsWith(
        `${portablePathKey(mergePrivateDirectoryName)}/`,
      ) ||
      typeof candidate.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(candidate.sha256) ||
      typeof candidate.ledger !== "boolean"
    ) {
      return undefined;
    }
    const key = portablePathKey(candidate.relativePath);
    if (paths.has(key)) return undefined;
    paths.add(key);
    proofs.push(
      Object.freeze({
        relativePath: candidate.relativePath,
        sha256: candidate.sha256,
        ledger: candidate.ledger,
      }),
    );
  }
  return Object.freeze(proofs);
}

function validPortableRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    value.split("/").every((segment) =>
      segment.length > 0 && segment !== "." && segment !== "..",
    )
  );
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSourceLabelArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 8 &&
    value.every((label) =>
      typeof label === "string" && sourceLabelPattern.test(label),
    ) &&
    new Set(value).size === value.length
  );
}

function assertPreservedFilesPresent(
  marker: PreparedMergedCopyMarker,
  root: string,
  files: readonly InventoriedFile[],
): void {
  const physicalFiles = new Map(
    files.map((file) => [
      portablePathKey(physicalRelativePath(root, file.sourcePath)),
      file,
    ]),
  );
  for (const proof of marker.preservedFiles) {
    const file = physicalFiles.get(portablePathKey(proof.relativePath));
    if (file === undefined || file.sha256 !== proof.sha256) {
      throw new Error("conversation-store-copy-marker-invalid");
    }
  }
}

function finalizeMergedInventory(
  marker: PreparedMergedCopyMarker,
  root: string,
  files: readonly InventoriedFile[],
): {
  readonly marker: PreparedMergedCopyMarker;
  readonly files: InventoriedFile[];
} {
  const inventory = files
    .map((file) => ({
      relativePath: physicalRelativePath(root, file.sourcePath),
      sha256: file.sha256,
      bytes: file.bytes,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const sourceLabel = `merged-${digestJson(inventory).slice("sha256:".length, 39)}`;
  const oldPrefix = `${posix.join(
    mergePrivateDirectoryName,
    "prior",
    marker.sourceLabel,
  )}/`;
  const newPrefix = `${posix.join(
    mergePrivateDirectoryName,
    "prior",
    sourceLabel,
  )}/`;
  return Object.freeze({
    marker: Object.freeze({
      ...marker,
      sourceLabel,
    }),
    files: files.map((file) =>
      Object.freeze({
        ...file,
        sourceLabel,
        relativePath: file.relativePath.startsWith(oldPrefix)
          ? `${newPrefix}${file.relativePath.slice(oldPrefix.length)}`
          : file.relativePath,
      }),
    ),
  });
}

function physicalRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function mergeManifest(plan: ConversationStoreMergePlan): object {
  return {
    schemaVersion: 1,
    kind: "conversation-store-merge",
    planDigest: plan.planDigest,
    sourceLabels: plan.sources.map((source) => source.sourceLabel),
    counts: plan.counts,
    conflicts: plan.conflicts,
    preservedFiles: plan.uniqueFileVersions
      .filter((version) =>
        portablePathKey(version.destinationRelativePath).startsWith(
          `${portablePathKey(mergePrivateDirectoryName)}/`,
        ),
      )
      .map((version) => ({
        relativePath: version.destinationRelativePath,
        sha256: version.sha256,
        ledger: version.ledger,
      })),
    sourceMutationAllowed: false,
    destructiveRecoveryAllowed: false,
  };
}

function mergeManifestText(plan: ConversationStoreMergePlan): string {
  return `${JSON.stringify(mergeManifest(plan), null, 2)}\n`;
}

function assertMergeManifestFits(plan: ConversationStoreMergePlan): void {
  if (Buffer.byteLength(mergeManifestText(plan), "utf8") > maximumMergeManifestBytes) {
    throw new Error("conversation-store-merge-manifest-too-large");
  }
}

export async function assertConversationStoreReportPathSafe(options: {
  readonly reportPath: string;
  readonly sourceDirectories: readonly string[];
}): Promise<void> {
  await assertDestinationOutsideSources(
    absoluteDirectory(
      options.reportPath,
      "conversation-store-report-path-invalid",
    ),
    options.sourceDirectories,
    "conversation-store-report-overlaps-source",
    "conversation-store-report-path-aliased",
  );
}

function assertStagingAuthorization(
  authorization: unknown,
  plan: ConversationStoreMergePlan,
  outputDirectory: string,
): void {
  if (authorization === undefined) {
    throw new Error("conversation-store-owner-authorization-required");
  }
  if (
    !isExactObject(authorization, [
      "schemaVersion",
      "kind",
      "scope",
      "planDigest",
      "outputDirectory",
      "approvedAt",
      "ownerStatement",
    ]) ||
    authorization.schemaVersion !== 1 ||
    authorization.kind !== "conversation-store-staging-authorization" ||
    authorization.scope !== "create-new-merged-copy-only" ||
    authorization.planDigest !== plan.planDigest ||
    typeof authorization.outputDirectory !== "string" ||
    !isAbsolute(authorization.outputDirectory) ||
    pathKey(authorization.outputDirectory) !== pathKey(outputDirectory) ||
    typeof authorization.approvedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(
      authorization.approvedAt,
    ) ||
    !Number.isFinite(Date.parse(authorization.approvedAt)) ||
    authorization.ownerStatement !==
      conversationStoreStagingAuthorizationStatement
  ) {
    throw new Error("conversation-store-owner-authorization-invalid");
  }
}

function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")}`;
}

function isExactObject(
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
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function nativeDestination(root: string, portableRelativePath: string): string {
  if (portableRelativePath.length === 0) return root;
  const segments = portableRelativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("conversation-store-relative-path-invalid");
  }
  const destination = resolve(root, ...segments);
  const pathFromRoot = relative(root, destination);
  if (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  ) {
    return destination;
  }
  throw new Error("conversation-store-relative-path-invalid");
}

function absoluteDirectory(value: string, error: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(error);
  return resolve(value);
}

async function assertDestinationOutsideSources(
  destination: string,
  sourceDirectories: readonly string[],
  overlapError: string,
  aliasError: string,
): Promise<void> {
  let existingAncestor = destination;
  while (true) {
    try {
      await lstat(existingAncestor);
      break;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw new Error(aliasError);
      existingAncestor = parent;
    }
  }
  const physicalAncestor = await realpath(existingAncestor);
  const physicalDestination = resolve(
    physicalAncestor,
    relative(existingAncestor, destination),
  );
  if (
    sourceDirectories.some((sourceDirectory) =>
      pathsOverlap(physicalDestination, sourceDirectory),
    )
  ) {
    throw new Error(overlapError);
  }
  // Overlap was judged on physical destinations, so spelling aliases (8.3
  // short names, SUBST drives, namespace prefixes) must not fail here; only
  // reparse-point ancestors can redirect the tree and they are rejected.
  await assertNoReparsePointAncestors(destination, aliasError);
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

async function assertNoReparsePointAncestors(
  lexicalDirectory: string,
  error: string,
): Promise<void> {
  const rooted = resolve(lexicalDirectory);
  const parsed = parse(rooted);
  let cursor = parsed.root;
  for (const segment of parsed.dir
    .slice(parsed.root.length)
    .split(sep)
    .filter((segment) => segment.length > 0)) {
    cursor = join(cursor, segment);
    let status: Awaited<ReturnType<typeof lstat>>;
    try {
      status = await lstat(cursor);
    } catch (error) {
      // A not-yet-existing segment cannot be a reparse point; deeper
      // segments are checked the same way once they exist.
      if (isMissingPath(error)) continue;
      throw error;
    }
    if (status.isSymbolicLink()) {
      throw new Error(error);
    }
  }
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32"
    ? toNamespacedPath(normalized).toLowerCase()
    : normalized;
}

function portablePathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
