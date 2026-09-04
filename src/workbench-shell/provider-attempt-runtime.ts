import { types as nodeUtilTypes } from "node:util";
import { basename, isAbsolute, resolve } from "node:path";

import {
  openProviderRequestBudget,
  ProviderRequestBudgetError,
  type ProviderRequestBudget,
} from "../agent-runtime/provider-request-budget.ts";
import {
  PROVIDER_ATTEMPT_BUILD_MARKER,
  PROVIDER_ATTEMPT_PROTOCOL,
} from "./provider-attempt-plan.ts";

export const PROVIDER_ATTEMPT_LOCATOR_SWITCH =
  "uaw-provider-attempt-locator" as const;
export const PROVIDER_ATTEMPT_PROTOCOL_SWITCH =
  "uaw-provider-attempt-protocol" as const;
export const PROVIDER_ATTEMPT_BUILD_MARKER_SWITCH =
  "uaw-provider-attempt-build-marker" as const;

export function loadProviderRequestBudgetForElectronMain(
  input: unknown,
): ProviderRequestBudget | undefined {
  if (!isExactDataRecord(input, ["buildMarker", "locator", "protocol"])) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  const values = [input.locator, input.protocol, input.buildMarker];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => typeof value !== "string")) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  if (input.protocol !== PROVIDER_ATTEMPT_PROTOCOL) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  if (input.buildMarker !== PROVIDER_ATTEMPT_BUILD_MARKER) {
    throw new ProviderRequestBudgetError("build-marker-mismatch");
  }
  if (
    typeof input.locator !== "string" ||
    !isAbsolute(input.locator) ||
    resolve(input.locator) !== input.locator ||
    !/^provider-request-attempt-[a-z0-9-]{1,80}$/u.test(
      basename(input.locator),
    )
  ) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  return openProviderRequestBudget({
    locator: input.locator as string,
    expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
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
      nodeUtilTypes.isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    return (
      keys.length === expectedKeys.length &&
      keys.every(
        (key) => typeof key === "string" && expectedKeys.includes(key),
      ) &&
      expectedKeys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          descriptor.enumerable &&
          Object.prototype.hasOwnProperty.call(descriptor, "value")
        );
      })
    );
  } catch {
    return false;
  }
}
