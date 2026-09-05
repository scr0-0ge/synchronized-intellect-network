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
  defaultWorkbenchRuntimeExecutablePaths,
  WORKBENCH_RUNTIME_EXECUTABLE_PATH_MAX_LENGTH,
  type WorkbenchRuntimeExecutablePaths,
  type WorkbenchClaudePermissionHandling,
  type WorkbenchAppearancePreference,
} from "./contract.ts";

export { defaultWorkbenchAppearancePreference } from "./contract.ts";

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
  readRuntimeExecutables(): Promise<WorkbenchRuntimeExecutablePaths>;
  saveRuntimeExecutables(
    executables: WorkbenchRuntimeExecutablePaths,
  ): Promise<WorkbenchRuntimeExecutablePaths>;
  close(): Promise<void>;
}

interface WorkbenchPreferenceDocument {
  readonly appearance: WorkbenchAppearancePreference;
  readonly claudePermissionHandling: WorkbenchClaudePermissionHandling;
  readonly runtimeExecutables: WorkbenchRuntimeExecutablePaths;
}

const defaultWorkbenchPreferenceDocument: WorkbenchPreferenceDocument =
  Object.freeze({
    appearance: defaultWorkbenchAppearancePreference,
    claudePermissionHandling: defaultWorkbenchClaudePermissionHandling,
    runtimeExecutables: defaultWorkbenchRuntimeExecutablePaths,
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
            current.runtimeExecutables,
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
            current.runtimeExecutables,
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
            captured,
          ),
          atomicReplace,
        );
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
          defaultWorkbenchRuntimeExecutablePaths,
        );
      }
      if (document.schemaVersion === 2) {
        return capturePreferenceDocument(
          captureVersionTwoAppearance(document.appearance),
          defaultWorkbenchClaudePermissionHandling,
          defaultWorkbenchRuntimeExecutablePaths,
        );
      }
      if (document.schemaVersion === 3) {
        return capturePreferenceDocument(
          captureAppearance(document.appearance),
          defaultWorkbenchClaudePermissionHandling,
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
        captureRuntimeExecutables(document.runtimeExecutables),
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
      schemaVersion: 5,
      appearance: preference.appearance,
      claudePermissionHandling: preference.claudePermissionHandling,
      runtimeExecutables: preference.runtimeExecutables,
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
  runtimeExecutables: WorkbenchRuntimeExecutablePaths,
): WorkbenchPreferenceDocument {
  return Object.freeze({
    appearance,
    claudePermissionHandling,
    runtimeExecutables,
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

function captureClaudePermissionHandling(
  value: unknown,
): WorkbenchClaudePermissionHandling {
  if (value !== "without-asking" && value !== "ask-when-needed") {
    throw new Error("invalid-appearance-preferences");
  }
  return value;
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
