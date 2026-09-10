import { types as nodeUtilTypes } from "node:util";

/** Inspect the object shape without invoking getters or proxy traps. */
export function vendorRecordOwnKeys(value: unknown): readonly string[] | undefined {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      nodeUtilTypes.isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (!keys.every((key) => typeof key === "string")) return undefined;
    return keys as readonly string[];
  } catch {
    return undefined;
  }
}

/**
 * Prototype-pollution vectors are refused as key names rather than tolerated.
 * This is a correctness rule, not a threat model: a record carrying one of these
 * as an own key cannot be reasoned about safely by ordinary key arithmetic.
 */
const forbiddenVendorKeyNames: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
];

/**
 * Shared F110 vendor-wire predicate, extracted from catalogModelExtraKeys.
 * Required keys remain mandatory. Extra key values are never read: consumers
 * rebuild their own projections and drop everything they do not use.
 *
 * Every own property must be enumerable data, including additions. Printable,
 * bounded key names and the existing prototype-name exclusion remain enforced.
 */
export function vendorRecordExtraKeys(
  value: unknown,
  requiredKeys: readonly string[],
): readonly string[] | undefined {
  const keys = vendorRecordOwnKeys(value);
  if (keys === undefined) return undefined;
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return undefined;
      }
    }
    if (!requiredKeys.every((key) => keys.includes(key))) return undefined;
    const extraKeys = keys.filter((key) => !requiredKeys.includes(key));
    if (
      extraKeys.some(
        (key) =>
          !isSafeVendorText(key, 120) ||
          forbiddenVendorKeyNames.includes(key),
      )
    ) {
      return undefined;
    }
    return Object.freeze([...extraKeys].sort());
  } catch {
    return undefined;
  }
}

export function isSafeVendorText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    [...value].length <= maximum &&
    value.trim() === value &&
    !hasUnpairedSurrogate(value) &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function isVendorRecord(
  value: unknown,
  requiredKeys: readonly string[] = [],
): value is Record<string, unknown> {
  return vendorRecordExtraKeys(value, requiredKeys) !== undefined;
}
