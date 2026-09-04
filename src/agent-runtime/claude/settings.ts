import { types as nodeUtilTypes } from "node:util";

import { RuntimeAdapterError } from "../index.ts";

const appliedEffortLevels = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const settingSources = new Set([
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
]);

export interface ClaudeAppliedSettings {
  readonly model: string;
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  readonly advisor?: string | null;
  readonly ultracode?: boolean;
}

export interface ClaudeSettingsObservationCollector {
  readonly toleratedSettingSources: Set<string>;
  settingsErrorCount: number;
}

/**
 * Validate the documented `get_settings` response without forwarding any raw
 * setting, source, or error record. Unknown top-level/applied keys and malformed
 * source/error rows fail closed. Safe new source names and validated error rows
 * are counted on the private observation collector, then dropped. The two
 * record-valued setting fields remain opaque because the CLI explicitly
 * defines their contents as open setting maps.
 */
export function readClaudeAppliedSettings(
  value: unknown,
  observation?: ClaudeSettingsObservationCollector,
): ClaudeAppliedSettings | undefined {
  if (
    !isRecordWithKnownKeys(
      value,
      ["effective", "sources"],
      ["applied", "errors"],
    ) ||
    !isPlainDataRecord(value.effective) ||
    !isDenseArray(value.sources) ||
    value.sources.some(
      (source) =>
        !isExactDataRecord(source, ["settings", "source"]) ||
        !isSafeSettingSourceName(source.source) ||
        !isPlainDataRecord(source.settings),
    ) ||
    (value.errors !== undefined &&
      (!isDenseArray(value.errors) ||
        value.errors.some(
          (error) =>
            !isExactDataRecord(error, ["file", "message", "path"]) ||
            !isSafeText(error.file, 32_768) ||
            !isSafeText(error.path, 32_768) ||
            !isSafeText(error.message, 8_192),
        )))
  ) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  if (observation !== undefined) {
    // Source identifiers are vendor-owned namespace values. Safe unfamiliar
    // names are diagnostic drift, while each source record stays exact and
    // its opaque settings map is never forwarded.
    for (const sourceValue of value.sources) {
      const source = sourceValue as Record<string, unknown>;
      const sourceName = source.source as string;
      if (!settingSources.has(sourceName)) {
        observation.toleratedSettingSources.add(sourceName);
      }
    }
    // Validated errors describe source-specific settings problems. The applied
    // projection below is validated independently, so retain only a count and
    // discard file/path/message detail instead of taking the catalog down.
    observation.settingsErrorCount += value.errors?.length ?? 0;
  }
  if (value.applied === undefined) return undefined;
  if (
    !isRecordWithKnownKeys(
      value.applied,
      ["effort", "model"],
      ["advisor", "ultracode"],
    ) ||
    !isSafeText(value.applied.model, 240) ||
    (value.applied.effort !== null &&
      !appliedEffortLevels.has(value.applied.effort as string)) ||
    (value.applied.advisor !== undefined &&
      value.applied.advisor !== null &&
      !isSafeText(value.applied.advisor, 240)) ||
    (value.applied.ultracode !== undefined &&
      typeof value.applied.ultracode !== "boolean")
  ) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  return Object.freeze({
    model: value.applied.model,
    effort: value.applied.effort as ClaudeAppliedSettings["effort"],
    ...(value.applied.advisor === undefined
      ? {}
      : { advisor: value.applied.advisor as string | null }),
    ...(value.applied.ultracode === undefined
      ? {}
      : { ultracode: value.applied.ultracode }),
  });
}

function isRecordWithKnownKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainDataRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.every(
      (key) =>
        typeof key === "string" &&
        (required.includes(key) || optional.includes(key)),
    ) && required.every((key) => keys.includes(key))
  );
}

function isExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainDataRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every(
      (key) => typeof key === "string" && expectedKeys.includes(key),
    )
  );
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable &&
        Object.prototype.hasOwnProperty.call(descriptor, "value")
      );
    });
  } catch {
    return false;
  }
}

function isDenseArray(value: unknown): value is unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return false;
      }
    }
    return keys.every(
      (key) =>
        key === "length" ||
        (typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)),
    );
  } catch {
    return false;
  }
}

function isSafeText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim().length > 0 &&
    !value.includes("\0")
  );
}

function isSafeSettingSourceName(value: unknown): value is string {
  return (
    isSafeText(value, 120) &&
    [...value].length <= 120 &&
    !hasUnpairedSurrogate(value) &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
