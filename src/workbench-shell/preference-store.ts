import { randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const maximumPreferenceDocumentBytes = 64 * 1024;
const maximumEndpointPreferences = 100;
const maximumModelPreferences = 100;

export const LEGACY_CODEX_DIRECT_SESSION_PROFILE_ENDPOINT_KEY =
  "codex-desktop";

export interface DirectSessionProfilePreferenceFields {
  readonly model?: string;
  readonly workIntensity?: string;
}

export interface DirectSessionProfileModelPreference {
  readonly model: string;
  readonly workIntensity: string;
}

export interface DirectSessionProfileEndpointPreference {
  readonly endpointKey: string;
  readonly model?: string;
  readonly models: readonly DirectSessionProfileModelPreference[];
}

export interface DirectSessionProfileDefaultPreference
  extends DirectSessionProfileModelPreference {
  readonly endpointKey: string;
}

export interface DirectSessionProfilePreferenceSnapshot {
  readonly global: DirectSessionProfilePreferenceFields;
  readonly endpoints: readonly DirectSessionProfileEndpointPreference[];
}

export type DirectSessionProfilePreferenceStoreFailureCategory =
  | "preferences-invalid"
  | "storage-unavailable"
  | "store-closed";

export class DirectSessionProfilePreferenceStoreError extends Error {
  readonly category: DirectSessionProfilePreferenceStoreFailureCategory;

  constructor(category: DirectSessionProfilePreferenceStoreFailureCategory) {
    super("Direct Session Profile preferences are unavailable.");
    this.name = "DirectSessionProfilePreferenceStoreError";
    this.category = category;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface DirectSessionProfilePreferenceStore {
  read(): Promise<DirectSessionProfilePreferenceSnapshot>;
  saveDefault(
    selection: DirectSessionProfileDefaultPreference,
  ): Promise<DirectSessionProfilePreferenceSnapshot>;
  close(): Promise<void>;
}

export type DirectSessionProfilePreferenceAtomicReplace = (
  temporaryPath: string,
  destinationPath: string,
) => Promise<void>;

export function createDirectSessionProfilePreferenceStore(options: {
  readonly filePath: string;
  readonly atomicReplace?: DirectSessionProfilePreferenceAtomicReplace;
}): DirectSessionProfilePreferenceStore {
  const atomicReplace = options.atomicReplace ?? rename;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let tail: Promise<void> = Promise.resolve();

  const enqueue = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (closing) {
      return Promise.reject(
        new DirectSessionProfilePreferenceStoreError("store-closed"),
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
    read(): Promise<DirectSessionProfilePreferenceSnapshot> {
      return enqueue(() => readSnapshot(options.filePath));
    },
    saveDefault(
      selection: DirectSessionProfileDefaultPreference,
    ): Promise<DirectSessionProfilePreferenceSnapshot> {
      let captured: DirectSessionProfileDefaultPreference;
      try {
        captured = captureSelection(selection);
      } catch {
        return Promise.reject(
          new DirectSessionProfilePreferenceStoreError(
            "preferences-invalid",
          ),
        );
      }
      return enqueue(async () => {
        const current = await readSnapshot(options.filePath);
        const endpoints = current.endpoints.map((endpoint) => ({
          endpointKey: endpoint.endpointKey,
          ...(endpoint.model === undefined ? {} : { model: endpoint.model }),
          models: endpoint.models.map((entry) => ({ ...entry })),
        }));
        let endpoint = endpoints.find(
          (entry) => entry.endpointKey === captured.endpointKey,
        );
        if (endpoint === undefined) {
          if (endpoints.length >= maximumEndpointPreferences) {
            throw new DirectSessionProfilePreferenceStoreError(
              "preferences-invalid",
            );
          }
          endpoint = {
            endpointKey: captured.endpointKey,
            model: captured.model,
            models: [],
          };
          endpoints.push(endpoint);
        }
        const models = endpoint.models;
        const existingIndex = models.findIndex(
          (entry) => entry.model === captured.model,
        );
        const replacement = {
          model: captured.model,
          workIntensity: captured.workIntensity,
        };
        if (existingIndex < 0) {
          if (models.length >= maximumModelPreferences) {
            throw new DirectSessionProfilePreferenceStoreError(
              "preferences-invalid",
            );
          }
          models.push(replacement);
        } else {
          models[existingIndex] = replacement;
        }
        endpoint.model = captured.model;
        const next = freezeSnapshot({
          global: current.global,
          endpoints,
        });
        await writeSnapshot(options.filePath, next, atomicReplace);
        return next;
      });
    },
    close(): Promise<void> {
      closing = true;
      closePromise ??= tail.then(() => undefined);
      return closePromise;
    },
  });
}

function emptySnapshot(): DirectSessionProfilePreferenceSnapshot {
  return freezeSnapshot({ global: {}, endpoints: [] });
}

async function readSnapshot(
  filePath: string,
): Promise<DirectSessionProfilePreferenceSnapshot> {
  try {
    const information = await lstat(filePath);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.size > maximumPreferenceDocumentBytes
    ) {
      throw new DirectSessionProfilePreferenceStoreError(
        "preferences-invalid",
      );
    }
  } catch (error) {
    if (isMissingFileError(error)) return emptySnapshot();
    if (error instanceof DirectSessionProfilePreferenceStoreError) throw error;
    throw new DirectSessionProfilePreferenceStoreError("storage-unavailable");
  }
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return emptySnapshot();
    throw new DirectSessionProfilePreferenceStoreError("storage-unavailable");
  }
  try {
    if (Buffer.byteLength(contents, "utf8") > maximumPreferenceDocumentBytes) {
      throw new Error("invalid-preferences");
    }
    assertNoDuplicateObjectKeys(contents);
    const value: unknown = JSON.parse(contents);
    if (!isRecord(value)) {
      throw new Error("invalid-preferences");
    }
    if (value.schemaVersion === 1) return readVersionOneSnapshot(value);
    if (value.schemaVersion === 2) return readVersionTwoSnapshot(value);
    throw new Error("invalid-preferences");
  } catch {
    throw new DirectSessionProfilePreferenceStoreError("preferences-invalid");
  }
}

function readVersionOneSnapshot(
  value: Record<string, unknown>,
): DirectSessionProfilePreferenceSnapshot {
  if (!hasOnlyKeys(value, ["schemaVersion", "global", "codex"])) {
    throw new Error("invalid-preferences");
  }
  const global = value.global === undefined ? {} : readGlobal(value.global);
  const codex =
    value.codex === undefined ? undefined : readEndpoint(value.codex);
  return freezeSnapshot({
    global,
    endpoints:
      codex === undefined
        ? []
        : [
            {
              endpointKey: LEGACY_CODEX_DIRECT_SESSION_PROFILE_ENDPOINT_KEY,
              ...(codex.model === undefined ? {} : { model: codex.model }),
              models: codex.models,
            },
          ],
  });
}

function readVersionTwoSnapshot(
  value: Record<string, unknown>,
): DirectSessionProfilePreferenceSnapshot {
  const endpointDocument = value.endpoints;
  if (
    !hasOnlyKeys(value, ["schemaVersion", "global", "endpoints"]) ||
    !Object.prototype.hasOwnProperty.call(value, "endpoints") ||
    !isRecord(endpointDocument)
  ) {
    throw new Error("invalid-preferences");
  }
  const endpointKeys = Object.keys(endpointDocument);
  if (endpointKeys.length > maximumEndpointPreferences) {
    throw new Error("invalid-preferences");
  }
  const endpoints = endpointKeys.map((endpointKey) => {
    if (!isSafeEndpointKey(endpointKey)) {
      throw new Error("invalid-preferences");
    }
    const endpoint = readEndpoint(endpointDocument[endpointKey]);
    return {
      endpointKey,
      ...(endpoint.model === undefined ? {} : { model: endpoint.model }),
      models: endpoint.models,
    };
  });
  return freezeSnapshot({
    global: value.global === undefined ? {} : readGlobal(value.global),
    endpoints,
  });
}

function readGlobal(value: unknown): DirectSessionProfilePreferenceFields {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["model", "workIntensity"]) ||
    (value.model !== undefined && typeof value.model !== "string") ||
    (value.workIntensity !== undefined &&
      typeof value.workIntensity !== "string") ||
    (typeof value.model === "string" && !isSafeModel(value.model)) ||
    (typeof value.workIntensity === "string" &&
      !isSafeWorkIntensity(value.workIntensity))
  ) {
    throw new Error("invalid-preferences");
  }
  return {
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.workIntensity === "string"
      ? { workIntensity: value.workIntensity }
      : {}),
  };
}

function readEndpoint(value: unknown): {
  readonly model?: string;
  readonly models: readonly DirectSessionProfileModelPreference[];
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["model", "workIntensities"]) ||
    (value.model !== undefined && typeof value.model !== "string") ||
    (typeof value.model === "string" && !isSafeModel(value.model)) ||
    (value.workIntensities !== undefined &&
      !Array.isArray(value.workIntensities)) ||
    (Array.isArray(value.workIntensities) &&
      value.workIntensities.length > maximumModelPreferences)
  ) {
    throw new Error("invalid-preferences");
  }
  const modelIds = new Set<string>();
  const models = (value.workIntensities ?? []).map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["model", "workIntensity"]) ||
      typeof entry.model !== "string" ||
      typeof entry.workIntensity !== "string" ||
      !isSafeModel(entry.model) ||
      !isSafeWorkIntensity(entry.workIntensity) ||
      modelIds.has(entry.model)
    ) {
      throw new Error("invalid-preferences");
    }
    modelIds.add(entry.model);
    return { model: entry.model, workIntensity: entry.workIntensity };
  });
  return {
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    models,
  };
}

async function writeSnapshot(
  filePath: string,
  snapshot: DirectSessionProfilePreferenceSnapshot,
  atomicReplace: DirectSessionProfilePreferenceAtomicReplace,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const endpointDocument = Object.fromEntries(
      snapshot.endpoints.map((endpoint) => [
        endpoint.endpointKey,
        {
          ...(endpoint.model === undefined ? {} : { model: endpoint.model }),
          workIntensities: endpoint.models,
        },
      ]),
    );
    const contents = `${JSON.stringify({
      schemaVersion: 2,
      ...(Object.keys(snapshot.global).length === 0
        ? {}
        : { global: snapshot.global }),
      endpoints: endpointDocument,
    })}\n`;
    if (Buffer.byteLength(contents, "utf8") > maximumPreferenceDocumentBytes) {
      throw new DirectSessionProfilePreferenceStoreError(
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
    if (error instanceof DirectSessionProfilePreferenceStoreError) throw error;
    throw new DirectSessionProfilePreferenceStoreError("storage-unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function freezeSnapshot(value: {
  readonly global: DirectSessionProfilePreferenceFields;
  readonly endpoints: readonly DirectSessionProfileEndpointPreference[];
}): DirectSessionProfilePreferenceSnapshot {
  return Object.freeze({
    global: Object.freeze({ ...value.global }),
    endpoints: Object.freeze(
      value.endpoints.map((endpoint) =>
        Object.freeze({
          endpointKey: endpoint.endpointKey,
          ...(endpoint.model === undefined ? {} : { model: endpoint.model }),
          models: Object.freeze(
            endpoint.models.map((entry) => Object.freeze({ ...entry })),
          ),
        }),
      ),
    ),
  });
}

function isMissingFileError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function captureSelection(
  value: DirectSessionProfileDefaultPreference,
): DirectSessionProfileDefaultPreference {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["endpointKey", "model", "workIntensity"]) ||
    !isSafeEndpointKey(value.endpointKey) ||
    !isSafeModel(value.model) ||
    !isSafeWorkIntensity(value.workIntensity)
  ) {
    throw new Error("invalid-preferences");
  }
  return Object.freeze({
    endpointKey: value.endpointKey,
    model: value.model,
    workIntensity: value.workIntensity,
  });
}

function isSafeEndpointKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function isSafeModel(value: unknown): value is string {
  return isSafePreferenceValue(value, 80);
}

function isSafeWorkIntensity(value: unknown): value is string {
  return isSafePreferenceValue(value, 32);
}

function isSafePreferenceValue(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9][A-Za-z0-9 .+_-]*$/u.test(value)
  );
}

function assertNoDuplicateObjectKeys(contents: string): void {
  let index = 0;

  const skipWhitespace = (): void => {
    while (/\s/u.test(contents[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    if (contents[index] !== '"') throw new Error("invalid-preferences");
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
    throw new Error("invalid-preferences");
  };
  const parsePrimitive = (): void => {
    const start = index;
    while (
      index < contents.length &&
      !/[\s,}\]]/u.test(contents[index] ?? "")
    ) {
      index += 1;
    }
    if (index === start) throw new Error("invalid-preferences");
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
      if (keys.has(key)) throw new Error("invalid-preferences");
      keys.add(key);
      skipWhitespace();
      if (contents[index] !== ":") throw new Error("invalid-preferences");
      index += 1;
      parseValue();
      skipWhitespace();
      if (contents[index] === "}") {
        index += 1;
        return;
      }
      if (contents[index] !== ",") throw new Error("invalid-preferences");
      index += 1;
    }
    throw new Error("invalid-preferences");
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
      if (contents[index] !== ",") throw new Error("invalid-preferences");
      index += 1;
    }
    throw new Error("invalid-preferences");
  };

  parseValue();
  skipWhitespace();
  if (index !== contents.length) throw new Error("invalid-preferences");
}
