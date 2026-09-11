import { reconstructWorkbenchSubscriptionUsage } from "./result-sanitizer.ts";
import type { WorkbenchSubscriptionUsageObservation } from "./contract.ts";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  defaultWorkbenchClaudePermissionHandling,
  defaultWorkbenchAppearancePreference,
  defaultWorkbenchBaseUrl,
  defaultWorkbenchFamilyEndpointPreferences,
  defaultWorkbenchRuntimeExecutablePaths,
  workbenchEndpointPreferenceFamily,
  WORKBENCH_BASE_URL_ENDPOINT_IDS,
  WORKBENCH_BASE_URL_MAX_LENGTH,
  WORKBENCH_RUNTIME_EXECUTABLE_PATH_MAX_LENGTH,
  type WorkbenchBaseUrlEndpointId,
  type WorkbenchRuntimeExecutablePaths,
  type WorkbenchClaudePermissionHandling,
  type WorkbenchAppearancePreference,
  type WorkbenchEndpointFamilyId,
  type WorkbenchClaudeEndpointPreference,
  type WorkbenchCodexEndpointPreference,
  type WorkbenchFamilyEndpointPreference,
  type WorkbenchFamilyEndpointPreferences,
  type WorkbenchKimiEndpointPreference,
} from "./contract.ts";

export { defaultWorkbenchAppearancePreference } from "./contract.ts";

/** One base URL override per base-URL endpoint (w232); "" means "not set". */
export type WorkbenchEndpointBaseUrls = Readonly<
  Record<WorkbenchBaseUrlEndpointId, string>
>;

export const defaultWorkbenchEndpointBaseUrls: WorkbenchEndpointBaseUrls =
  Object.freeze(
    Object.fromEntries(
      WORKBENCH_BASE_URL_ENDPOINT_IDS.map((endpointId) => [
        endpointId,
        defaultWorkbenchBaseUrl,
      ]),
    ) as Record<WorkbenchBaseUrlEndpointId, string>,
  );

const maximumPreferenceDocumentBytes = 64 * 1024;
const executablePathControlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

export type WorkbenchAppearancePreferenceStoreFailureCategory =
  | "preferences-invalid"
  | "storage-unavailable"
  | "store-closed";

export class WorkbenchAppearancePreferenceStoreError extends Error {
  readonly category: WorkbenchAppearancePreferenceStoreFailureCategory;

  constructor(category: WorkbenchAppearancePreferenceStoreFailureCategory) {
    super("Appearance preferences are unavailable.");
    this.name = "WorkbenchAppearancePreferenceStoreError";
    this.category = category;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface WorkbenchAppearancePreferenceStore {
  read(): Promise<WorkbenchAppearancePreference>;
  save(
    preference: WorkbenchAppearancePreference,
  ): Promise<WorkbenchAppearancePreference>;
  readClaudePermissionHandling(): Promise<WorkbenchClaudePermissionHandling>;
  saveClaudePermissionHandling(
    permissionHandling: WorkbenchClaudePermissionHandling,
  ): Promise<WorkbenchClaudePermissionHandling>;
  readEndpointPreferences(): Promise<WorkbenchFamilyEndpointPreferences>;
  saveEndpointPreference(
    preference: WorkbenchFamilyEndpointPreference,
  ): Promise<WorkbenchFamilyEndpointPreference>;
  readRuntimeExecutables(): Promise<WorkbenchRuntimeExecutablePaths>;
  saveRuntimeExecutables(
    executables: WorkbenchRuntimeExecutablePaths,
  ): Promise<WorkbenchRuntimeExecutablePaths>;
  /** Empty string means "not set" (that endpoint's own default applies). */
  readBaseUrl(endpointId: WorkbenchBaseUrlEndpointId): Promise<string>;
  saveBaseUrl(
    endpointId: WorkbenchBaseUrlEndpointId,
    baseUrl: string,
  ): Promise<string>;
  readClaudeSubscriptionUsage(): Promise<WorkbenchSubscriptionUsageObservation | null>;
  saveClaudeSubscriptionUsage(observation: WorkbenchSubscriptionUsageObservation): Promise<WorkbenchSubscriptionUsageObservation>;
  close(): Promise<void>;
}

interface WorkbenchPreferenceDocument {
  readonly claudeSubscriptionUsage: WorkbenchSubscriptionUsageObservation | null;
  readonly appearance: WorkbenchAppearancePreference;
  readonly claudePermissionHandling: WorkbenchClaudePermissionHandling;
  readonly endpointPreference: WorkbenchFamilyEndpointPreferences;
  readonly runtimeExecutables: WorkbenchRuntimeExecutablePaths;
  readonly endpointBaseUrls: WorkbenchEndpointBaseUrls;
}

const defaultWorkbenchPreferenceDocument: WorkbenchPreferenceDocument =
  Object.freeze({
    claudeSubscriptionUsage: null,
    appearance: defaultWorkbenchAppearancePreference,
    claudePermissionHandling: defaultWorkbenchClaudePermissionHandling,
    endpointPreference: defaultWorkbenchFamilyEndpointPreferences,
    runtimeExecutables: defaultWorkbenchRuntimeExecutablePaths,
    endpointBaseUrls: defaultWorkbenchEndpointBaseUrls,
  });

export type WorkbenchAppearancePreferenceAtomicReplace = (
  temporaryPath: string,
  destinationPath: string,
) => Promise<void>;

export function createWorkbenchAppearancePreferenceStore(options: {
  readonly filePath: string;
  readonly atomicReplace?: WorkbenchAppearancePreferenceAtomicReplace;
}): WorkbenchAppearancePreferenceStore {
  const atomicReplace = options.atomicReplace ?? rename;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let tail: Promise<void> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing) {
      return Promise.reject(
        new WorkbenchAppearancePreferenceStoreError("store-closed"),
      );
    }
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return Object.freeze({
    read(): Promise<WorkbenchAppearancePreference> {
      return enqueue(async () =>
        (await readPreferenceDocument(options.filePath)).appearance,
      );
    },
    save(
      preference: WorkbenchAppearancePreference,
    ): Promise<WorkbenchAppearancePreference> {
      let captured: WorkbenchAppearancePreference;
      try {
        captured = captureAppearance(preference);
      } catch {
        return Promise.reject(
          new WorkbenchAppearancePreferenceStoreError("preferences-invalid"),
        );
      }
      return enqueue(async () => {
        const current = await readPreferenceDocument(options.filePath);
        await writePreference(
          options.filePath,
          capturePreferenceDocument(
            captured,
            current.claudePermissionHandling,
            current.endpointPreference,
            current.runtimeExecutables,
            current.claudeSubscriptionUsage,
            current.endpointBaseUrls,
          ),
          atomicReplace,
        );
        return captured;
      });
    },
    readClaudePermissionHandling(): Promise<WorkbenchClaudePermissionHandling> {
      return enqueue(async () =>
        (await readPreferenceDocument(options.filePath))
          .claudePermissionHandling,
      );
    },
    saveClaudePermissionHandling(
      permissionHandling: WorkbenchClaudePermissionHandling,
    ): Promise<WorkbenchClaudePermissionHandling> {
      let captured: WorkbenchClaudePermissionHandling;
      try {
        captured = captureClaudePermissionHandling(permissionHandling);
      } catch {
        return Promise.reject(
          new WorkbenchAppearancePreferenceStoreError("preferences-invalid"),
        );
      }
      return enqueue(async () => {
        const current = await readPreferenceDocument(options.filePath);
        await writePreference(
          options.filePath,
          capturePreferenceDocument(
            current.appearance,
            captured,
            current.endpointPreference,
            current.runtimeExecutables,
            current.claudeSubscriptionUsage,
            current.endpointBaseUrls,
          ),
          atomicReplace,
        );
        return captured;
      });
    },
    readEndpointPreferences(): Promise<WorkbenchFamilyEndpointPreferences> {
      return enqueue(async () =>
        (await readPreferenceDocument(options.filePath)).endpointPreference,
      );
    },
    saveEndpointPreference(
      preference: WorkbenchFamilyEndpointPreference,
    ): Promise<WorkbenchFamilyEndpointPreference> {
      let captured: WorkbenchFamilyEndpointPreference;
      try {
        captured = captureFamilyEndpointPreference(preference);
      } catch {
        return Promise.reject(
          new WorkbenchAppearancePreferenceStoreError("preferences-invalid"),
        );
      }
      return enqueue(async () => {
        const current = await readPreferenceDocument(options.filePath);
        await writePreference(
          options.filePath,
          capturePreferenceDocument(
            current.appearance,
            current.claudePermissionHandling,
            captureFamilyEndpointPreferences(
              current.endpointPreference,
              workbenchEndpointPreferenceFamily(captured),
              captured,
            ),
            current.runtimeExecutables,
            current.claudeSubscriptionUsage,
            current.endpointBaseUrls,
          ),
          atomicReplace,
        );
        return captured;
      });
    },
    readRuntimeExecutables(): Promise<WorkbenchRuntimeExecutablePaths> {
      return enqueue(async () =>
        (await readPreferenceDocument(options.filePath)).runtimeExecutables,
      );
    },
    saveRuntimeExecutables(
      executables: WorkbenchRuntimeExecutablePaths,
    ): Promise<WorkbenchRuntimeExecutablePaths> {
      let captured: WorkbenchRuntimeExecutablePaths;
      try {
        captured = captureRuntimeExecutables(executables);
      } catch {
        return Promise.reject(
          new WorkbenchAppearancePreferenceStoreError("preferences-invalid"),
        );
      }
      return enqueue(async () => {
        const current = await readPreferenceDocument(options.filePath);
        await writePreference(
          options.filePath,
          capturePreferenceDocument(
            current.appearance,
            current.claudePermissionHandling,
            current.endpointPreference,
            captured,
            current.claudeSubscriptionUsage,
            current.endpointBaseUrls,
          ),
          atomicReplace,
        );
        return captured;
      });
    },
    readBaseUrl(endpointId: WorkbenchBaseUrlEndpointId): Promise<string> {
      return enqueue(async () =>
        (await readPreferenceDocument(options.filePath)).endpointBaseUrls[
          endpointId
        ],
      );
    },
    saveBaseUrl(
      endpointId: WorkbenchBaseUrlEndpointId,
      baseUrl: string,
    ): Promise<string> {
      let captured: string;
      try {
        captured = captureBaseUrl(baseUrl);
      } catch {
        return Promise.reject(
          new WorkbenchAppearancePreferenceStoreError("preferences-invalid"),
        );
      }
      return enqueue(async () => {
        const current = await readPreferenceDocument(options.filePath);
        await writePreference(
          options.filePath,
          Object.freeze({
            ...current,
            endpointBaseUrls: Object.freeze({
              ...current.endpointBaseUrls,
              [endpointId]: captured,
            }),
          }),
          atomicReplace,
        );
        return captured;
      });
    },
    readClaudeSubscriptionUsage() {
      return enqueue(async () => (await readPreferenceDocument(options.filePath)).claudeSubscriptionUsage);
    },
    saveClaudeSubscriptionUsage(observation: WorkbenchSubscriptionUsageObservation) {
      const captured = reconstructWorkbenchSubscriptionUsage(observation);
      if (captured === undefined) return Promise.reject(new WorkbenchAppearancePreferenceStoreError("preferences-invalid"));
      return enqueue(async () => {
        const current = await readPreferenceDocument(options.filePath);
        if (current.claudeSubscriptionUsage !== null && current.claudeSubscriptionUsage.observedAt > captured.observedAt) {
          return current.claudeSubscriptionUsage;
        }
        await writePreference(options.filePath, Object.freeze({ ...current, claudeSubscriptionUsage: captured }), atomicReplace);
        return captured;
      });
    },
    close(): Promise<void> {
      closing = true;
      closePromise ??= tail.then(() => undefined);
      return closePromise;
    },
  });
}

async function readPreferenceDocument(
  filePath: string,
): Promise<WorkbenchPreferenceDocument> {
  try {
    const information = await lstat(filePath);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.size > maximumPreferenceDocumentBytes
    ) {
      throw new WorkbenchAppearancePreferenceStoreError(
        "preferences-invalid",
      );
    }
  } catch (error) {
    if (isMissingFileError(error)) return defaultWorkbenchPreferenceDocument;
    if (error instanceof WorkbenchAppearancePreferenceStoreError) throw error;
    throw new WorkbenchAppearancePreferenceStoreError("storage-unavailable");
  }

  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return defaultWorkbenchPreferenceDocument;
    throw new WorkbenchAppearancePreferenceStoreError("storage-unavailable");
  }

  try {
    if (
      Buffer.byteLength(contents, "utf8") > maximumPreferenceDocumentBytes
    ) {
      throw new Error("invalid-appearance-preferences");
    }
    assertNoDuplicateObjectKeys(contents);
    const document: unknown = JSON.parse(contents);
    if (isExactDataRecord(document, ["appearance", "schemaVersion"])) {
      if (document.schemaVersion === 1) {
        return capturePreferenceDocument(
          captureLegacyAppearance(document.appearance),
          defaultWorkbenchClaudePermissionHandling,
          defaultWorkbenchFamilyEndpointPreferences,
          defaultWorkbenchRuntimeExecutablePaths,
        );
      }
      if (document.schemaVersion === 2) {
        return capturePreferenceDocument(
          captureVersionTwoAppearance(document.appearance),
          defaultWorkbenchClaudePermissionHandling,
          defaultWorkbenchFamilyEndpointPreferences,
          defaultWorkbenchRuntimeExecutablePaths,
        );
      }
      if (document.schemaVersion === 3) {
        return capturePreferenceDocument(
          captureAppearance(document.appearance),
          defaultWorkbenchClaudePermissionHandling,
          defaultWorkbenchFamilyEndpointPreferences,
          defaultWorkbenchRuntimeExecutablePaths,
        );
      }
    }
    if (
      isExactDataRecord(document, [
        "appearance",
        "claudePermissionHandling",
        "schemaVersion",
      ]) &&
      document.schemaVersion === 4
    ) {
      return capturePreferenceDocument(
        captureAppearance(document.appearance),
        captureClaudePermissionHandling(document.claudePermissionHandling),
        defaultWorkbenchFamilyEndpointPreferences,
        defaultWorkbenchRuntimeExecutablePaths,
      );
    }
    // main-resync: both lines of descent minted a schemaVersion 5 with their
    // own third field, so the two v5 shapes are told apart by exact key set —
    // the field the other line never wrote defaults in — and the merged writer
    // moved on to 6, which carries both fields.
    if (
      isExactDataRecord(document, [
        "appearance",
        "claudePermissionHandling",
        "kimiEndpointPreference",
        "schemaVersion",
      ]) &&
      document.schemaVersion === 5
    ) {
      return capturePreferenceDocument(
        captureAppearance(document.appearance),
        captureClaudePermissionHandling(document.claudePermissionHandling),
        captureFamilyEndpointPreferencesFromKimi(
          captureKimiEndpointPreference(document.kimiEndpointPreference),
        ),
        defaultWorkbenchRuntimeExecutablePaths,
      );
    }
    if (
      isExactDataRecord(document, [
        "appearance",
        "claudePermissionHandling",
        "runtimeExecutables",
        "schemaVersion",
      ]) &&
      document.schemaVersion === 5
    ) {
      return capturePreferenceDocument(
        captureAppearance(document.appearance),
        captureClaudePermissionHandling(document.claudePermissionHandling),
        defaultWorkbenchFamilyEndpointPreferences,
        captureRuntimeExecutables(document.runtimeExecutables),
      );
    }
    if (
      isExactDataRecord(document, [
        "appearance",
        "claudePermissionHandling",
        "kimiEndpointPreference",
        "runtimeExecutables",
        "schemaVersion",
      ]) &&
      document.schemaVersion === 6
    ) {
      // Ticket 25 migration: the pre-family v6 document carries the Kimi
      // facade preference under its old kimi-only key. The kimi value is
      // read verbatim; the claude/codex families take their defaults
      // (subscription first, exactly the automatic order).
      return capturePreferenceDocument(
        captureAppearance(document.appearance),
        captureClaudePermissionHandling(document.claudePermissionHandling),
        captureFamilyEndpointPreferencesFromKimi(
          captureKimiEndpointPreference(document.kimiEndpointPreference),
        ),
        captureRuntimeExecutables(document.runtimeExecutables),
      );
    }
    if (
      (isExactDataRecord(document, [
        "appearance", "claudePermissionHandling", "endpointPreference", "runtimeExecutables", "schemaVersion",
      ]) || isExactDataRecord(document, [
        "appearance", "claudePermissionHandling", "claudeSubscriptionUsage", "endpointPreference", "runtimeExecutables", "schemaVersion",
      ])) &&
      document.schemaVersion === 7
    ) {
      return capturePreferenceDocument(
        captureAppearance(document.appearance),
        captureClaudePermissionHandling(document.claudePermissionHandling),
        captureFamilyEndpointPreferencesRecord(document.endpointPreference),
        captureRuntimeExecutables(document.runtimeExecutables),
        document.claudeSubscriptionUsage === undefined ? null : captureSubscriptionUsage(document.claudeSubscriptionUsage),
      );
    }
    if (
      (isExactDataRecord(document, [
        "appearance", "claudePermissionHandling", "codexApiBaseUrl", "endpointPreference", "runtimeExecutables", "schemaVersion",
      ]) || isExactDataRecord(document, [
        "appearance", "claudePermissionHandling", "claudeSubscriptionUsage", "codexApiBaseUrl", "endpointPreference", "runtimeExecutables", "schemaVersion",
      ])) &&
      document.schemaVersion === 8
    ) {
      // w232 migration: the v8 document carries only the codex-api override
      // under its own key. That value carries over verbatim to the codex-api
      // slot of the new per-endpoint record; glm/deepseek/kimi-code start
      // unset (their default), exactly as a first launch on w232 would leave
      // them.
      return capturePreferenceDocument(
        captureAppearance(document.appearance),
        captureClaudePermissionHandling(document.claudePermissionHandling),
        captureFamilyEndpointPreferencesRecord(document.endpointPreference),
        captureRuntimeExecutables(document.runtimeExecutables),
        document.claudeSubscriptionUsage === undefined ? null : captureSubscriptionUsage(document.claudeSubscriptionUsage),
        Object.freeze({
          ...defaultWorkbenchEndpointBaseUrls,
          "codex-api": captureBaseUrl(document.codexApiBaseUrl),
        }),
      );
    }
    if (
      (isExactDataRecord(document, [
        "appearance", "claudePermissionHandling", "endpointBaseUrls", "endpointPreference", "runtimeExecutables", "schemaVersion",
      ]) || isExactDataRecord(document, [
        "appearance", "claudePermissionHandling", "claudeSubscriptionUsage", "endpointBaseUrls", "endpointPreference", "runtimeExecutables", "schemaVersion",
      ])) &&
      document.schemaVersion === 9
    ) {
      return capturePreferenceDocument(
        captureAppearance(document.appearance),
        captureClaudePermissionHandling(document.claudePermissionHandling),
        captureFamilyEndpointPreferencesRecord(document.endpointPreference),
        captureRuntimeExecutables(document.runtimeExecutables),
        document.claudeSubscriptionUsage === undefined ? null : captureSubscriptionUsage(document.claudeSubscriptionUsage),
        captureEndpointBaseUrls(document.endpointBaseUrls),
      );
    }
    throw new Error("invalid-appearance-preferences");
  } catch {
    throw new WorkbenchAppearancePreferenceStoreError("preferences-invalid");
  }
}

async function writePreference(
  filePath: string,
  preference: WorkbenchPreferenceDocument,
  atomicReplace: WorkbenchAppearancePreferenceAtomicReplace,
): Promise<void> {
  const directory = dirname(filePath);
  try {
    await mkdir(directory, { recursive: true });
  } catch {
    throw new WorkbenchAppearancePreferenceStoreError("storage-unavailable");
  }
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const contents = `${JSON.stringify({
      schemaVersion: 9,
      ...(preference.claudeSubscriptionUsage === null ? {} : { claudeSubscriptionUsage: preference.claudeSubscriptionUsage }),
      appearance: preference.appearance,
      claudePermissionHandling: preference.claudePermissionHandling,
      endpointPreference: preference.endpointPreference,
      runtimeExecutables: preference.runtimeExecutables,
      endpointBaseUrls: preference.endpointBaseUrls,
    })}\n`;
    if (
      Buffer.byteLength(contents, "utf8") > maximumPreferenceDocumentBytes
    ) {
      throw new WorkbenchAppearancePreferenceStoreError(
        "preferences-invalid",
      );
    }
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await atomicReplace(temporaryPath, filePath);
  } catch (error) {
    if (error instanceof WorkbenchAppearancePreferenceStoreError) throw error;
    throw new WorkbenchAppearancePreferenceStoreError("storage-unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function capturePreferenceDocument(
  appearance: WorkbenchAppearancePreference,
  claudePermissionHandling: WorkbenchClaudePermissionHandling,
  endpointPreference: WorkbenchFamilyEndpointPreferences,
  runtimeExecutables: WorkbenchRuntimeExecutablePaths,
  claudeSubscriptionUsage: WorkbenchSubscriptionUsageObservation | null = null,
  endpointBaseUrls: WorkbenchEndpointBaseUrls = defaultWorkbenchEndpointBaseUrls,
): WorkbenchPreferenceDocument {
  return Object.freeze({
    appearance,
    claudePermissionHandling,
    endpointPreference,
    endpointBaseUrls,
    runtimeExecutables,
    claudeSubscriptionUsage,
  });
}

// The stored value is a path a USER typed. It is checked for shape here and for
// usability by admitLaunchTarget at the point of spawn; storing it does not
// bless it. An empty string is the cleared state, so the key set never varies.
function captureRuntimeExecutables(
  value: unknown,
): WorkbenchRuntimeExecutablePaths {
  if (
    !isExactDataRecord(value, ["claude", "codex"]) ||
    typeof value.codex !== "string" ||
    typeof value.claude !== "string" ||
    value.codex.length > WORKBENCH_RUNTIME_EXECUTABLE_PATH_MAX_LENGTH ||
    value.claude.length > WORKBENCH_RUNTIME_EXECUTABLE_PATH_MAX_LENGTH ||
    executablePathControlCharacters.test(value.codex) ||
    executablePathControlCharacters.test(value.claude)
  ) {
    throw new Error("invalid-appearance-preferences");
  }
  return Object.freeze({ codex: value.codex, claude: value.claude });
}

// Shape only (length, no control characters); the http(s):// scheme check
// lives at the IPC boundary (endpoint-base-url-ipc.ts), same split as the
// runtime-executable path's admission check.
function captureBaseUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > WORKBENCH_BASE_URL_MAX_LENGTH ||
    executablePathControlCharacters.test(value)
  ) {
    throw new Error("invalid-appearance-preferences");
  }
  return value;
}

/** The v9 endpointBaseUrls record: exact key set, every value a valid base URL string. */
function captureEndpointBaseUrls(value: unknown): WorkbenchEndpointBaseUrls {
  if (!isExactDataRecord(value, WORKBENCH_BASE_URL_ENDPOINT_IDS)) {
    throw new Error("invalid-appearance-preferences");
  }
  const entries = WORKBENCH_BASE_URL_ENDPOINT_IDS.map(
    (endpointId) => [endpointId, captureBaseUrl(value[endpointId])] as const,
  );
  return Object.freeze(
    Object.fromEntries(entries) as Record<WorkbenchBaseUrlEndpointId, string>,
  );
}

function captureClaudePermissionHandling(
  value: unknown,
): WorkbenchClaudePermissionHandling {
  if (value !== "without-asking" && value !== "ask-when-needed") {
    throw new Error("invalid-appearance-preferences");
  }
  return value;
}

function captureKimiEndpointPreference(
  value: unknown,
): WorkbenchKimiEndpointPreference {
  if (value !== "kimi-code" && value !== "kimi-platform") {
    throw new Error("invalid-appearance-preferences");
  }
  return value;
}

/**
 * The v5-kimi/v6 → v7 migration read: the Kimi value carries over verbatim,
 * the new claude/codex families start at their defaults (the automatic
 * order, so nothing observable changes for an untouched preference).
 */
function captureFamilyEndpointPreferencesFromKimi(
  kimi: WorkbenchKimiEndpointPreference,
): WorkbenchFamilyEndpointPreferences {
  return Object.freeze({
    ...defaultWorkbenchFamilyEndpointPreferences,
    kimi,
  });
}

/** One family's saved preference (fail-closed on any non-member value). */
function captureFamilyEndpointPreference(
  value: unknown,
): WorkbenchFamilyEndpointPreference {
  const allowed: readonly unknown[] = [
    "kimi-code",
    "kimi-platform",
    "claude-code-desktop",
    "claude-api",
    "codex-desktop",
    "codex-api",
  ];
  if (!allowed.includes(value)) {
    throw new Error("invalid-appearance-preferences");
  }
  return value as WorkbenchFamilyEndpointPreference;
}

/** The v7 endpointPreference record: exact key set, every value a member. */
function captureFamilyEndpointPreferencesRecord(
  value: unknown,
): WorkbenchFamilyEndpointPreferences {
  if (!isExactDataRecord(value, ["claude", "codex", "kimi"])) {
    throw new Error("invalid-appearance-preferences");
  }
  return Object.freeze({
    claude: captureClaudeEndpointPreference(value.claude),
    codex: captureCodexEndpointPreference(value.codex),
    kimi: captureKimiEndpointPreference(value.kimi),
  });
}

function captureClaudeEndpointPreference(
  value: unknown,
): WorkbenchClaudeEndpointPreference {
  if (value !== "claude-code-desktop" && value !== "claude-api") {
    throw new Error("invalid-appearance-preferences");
  }
  return value;
}

function captureCodexEndpointPreference(
  value: unknown,
): WorkbenchCodexEndpointPreference {
  if (value !== "codex-desktop" && value !== "codex-api") {
    throw new Error("invalid-appearance-preferences");
  }
  return value;
}

/** Replace one family's slot, keeping the other two exactly as they were. */
function captureFamilyEndpointPreferences(
  current: WorkbenchFamilyEndpointPreferences,
  family: WorkbenchEndpointFamilyId,
  preference: WorkbenchFamilyEndpointPreference,
): WorkbenchFamilyEndpointPreferences {
  return Object.freeze({
    ...current,
    [family]: preference,
  });
}

function captureAppearance(value: unknown): WorkbenchAppearancePreference {
  if (
    !isExactDataRecord(value, [
      "crt",
      "language",
      "phosphor",
      "phosphorTier",
      "tone",
    ]) ||
    (value.tone !== "dark" && value.tone !== "light") ||
    (value.crt !== "off" &&
      value.crt !== "blocks" &&
      value.crt !== "screen" &&
      value.crt !== "full") ||
    (value.phosphor !== "neutral" &&
      value.phosphor !== "green" &&
      value.phosphor !== "amber") ||
    (value.phosphorTier !== "a" &&
      value.phosphorTier !== "b" &&
      value.phosphorTier !== "c") ||
    (value.language !== "en" && value.language !== "zh-CN")
  ) {
    throw new Error("invalid-appearance-preferences");
  }
  return Object.freeze({
    tone: value.tone,
    crt: value.crt,
    phosphor: value.phosphor,
    phosphorTier: value.phosphorTier,
    language: value.language,
  });
}

function captureVersionTwoAppearance(
  value: unknown,
): WorkbenchAppearancePreference {
  if (
    !isExactDataRecord(value, ["crt", "phosphor", "phosphorTier", "tone"]) ||
    (value.tone !== "dark" && value.tone !== "light") ||
    (value.crt !== "off" &&
      value.crt !== "blocks" &&
      value.crt !== "screen" &&
      value.crt !== "full") ||
    (value.phosphor !== "neutral" &&
      value.phosphor !== "green" &&
      value.phosphor !== "amber") ||
    (value.phosphorTier !== "a" &&
      value.phosphorTier !== "b" &&
      value.phosphorTier !== "c")
  ) {
    throw new Error("invalid-appearance-preferences");
  }
  return Object.freeze({
    tone: value.tone,
    crt: value.crt,
    phosphor: value.phosphor,
    phosphorTier: value.phosphorTier,
    language: "en",
  });
}

function captureLegacyAppearance(value: unknown): WorkbenchAppearancePreference {
  if (
    !isExactDataRecord(value, ["crt", "phosphor", "tone"]) ||
    (value.tone !== "dark" && value.tone !== "light") ||
    (value.crt !== "off" &&
      value.crt !== "blocks" &&
      value.crt !== "screen" &&
      value.crt !== "full") ||
    (value.phosphor !== "neutral" &&
      value.phosphor !== "green" &&
      value.phosphor !== "amber")
  ) {
    throw new Error("invalid-appearance-preferences");
  }
  return Object.freeze({
    tone: value.tone,
    crt: value.crt,
    phosphor: value.phosphor,
    phosphorTier: "b",
    language: "en",
  });
}

function isExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string")
    ) {
      return false;
    }
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.enumerable &&
        keys.includes(key)
      );
    });
  } catch {
    return false;
  }
}

function isMissingFileError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "ENOENT"
  );
}

function assertNoDuplicateObjectKeys(contents: string): void {
  let index = 0;

  const skipWhitespace = (): void => {
    while (/\s/u.test(contents[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    if (contents[index] !== '"') {
      throw new Error("invalid-appearance-preferences");
    }
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
    throw new Error("invalid-appearance-preferences");
  };
  const parsePrimitive = (): void => {
    const start = index;
    while (
      index < contents.length &&
      !/[\s,}\]]/u.test(contents[index] ?? "")
    ) {
      index += 1;
    }
    if (index === start) throw new Error("invalid-appearance-preferences");
  };
  const parseValue = (): void => {
    skipWhitespace();
    if (contents[index] === "{") {
      parseObject();
    } else if (contents[index] === "[") {
      parseArray();
    } else if (contents[index] === '"') {
      parseString();
    } else {
      parsePrimitive();
    }
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
      if (keys.has(key)) throw new Error("invalid-appearance-preferences");
      keys.add(key);
      skipWhitespace();
      if (contents[index] !== ":") {
        throw new Error("invalid-appearance-preferences");
      }
      index += 1;
      parseValue();
      skipWhitespace();
      if (contents[index] === "}") {
        index += 1;
        return;
      }
      if (contents[index] !== ",") {
        throw new Error("invalid-appearance-preferences");
      }
      index += 1;
    }
    throw new Error("invalid-appearance-preferences");
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
      if (contents[index] !== ",") {
        throw new Error("invalid-appearance-preferences");
      }
      index += 1;
    }
    throw new Error("invalid-appearance-preferences");
  };

  parseValue();
  skipWhitespace();
  if (index !== contents.length) {
    throw new Error("invalid-appearance-preferences");
  }
}

function captureSubscriptionUsage(value: unknown): WorkbenchSubscriptionUsageObservation {
  const observation = reconstructWorkbenchSubscriptionUsage(value);
  if (observation === undefined) throw new WorkbenchAppearancePreferenceStoreError("preferences-invalid");
  return observation;
}
