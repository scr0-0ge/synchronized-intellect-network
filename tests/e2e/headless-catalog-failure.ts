import { isNativeError } from "node:util/types";

import {
  RuntimeAdapterError,
  type RuntimeFailureCategory,
} from "../../src/agent-runtime/index.ts";

export type HeadlessCatalogFailureEvidence = Readonly<{
  runtimeAdapterFailureCategory: RuntimeFailureCategory | "unknown";
}>;

const unknownHeadlessCatalogFailureEvidence: HeadlessCatalogFailureEvidence =
  Object.freeze({
    runtimeAdapterFailureCategory: "unknown",
  });

const runtimeFailureCategoryAllowlist = Object.freeze({
  "approval-required": true,
  "authentication-required": true,
  "catalog-invalid": true,
  "correlation-invalid": true,
  "invalid-input": true,
  "protocol-invalid": true,
  "protocol-rejected": true,
  "runtime-shutdown": true,
  "runtime-not-located": true,
  "runtime-unavailable": true,
  "temp-cleanup": true,
  "temp-cleanup-guard": true,
  "transport-failed": true,
  "turn-failed": true,
  "unexpected-server-request": true,
  "unsupported-selection": true,
} as const satisfies Readonly<Record<RuntimeFailureCategory, true>>);

const fixedRuntimeErrorMessage = "Agent Runtime operation failed.";
const fixedRuntimeErrorStack =
  "RuntimeAdapterError: Agent Runtime operation failed.";
const fixedRuntimeErrorStackDescriptor = Object.getOwnPropertyDescriptor(
  new RuntimeAdapterError("invalid-input"),
  "stack",
);

function isExpectedDataProperty(
  descriptor: PropertyDescriptor | undefined,
  expectedValue: unknown,
  enumerable: boolean,
): boolean {
  return (
    descriptor !== undefined &&
    Object.hasOwn(descriptor, "value") &&
    descriptor.value === expectedValue &&
    descriptor.writable === true &&
    descriptor.enumerable === enumerable &&
    descriptor.configurable === true
  );
}

function isExpectedStackProperty(
  descriptor: PropertyDescriptor | undefined,
): boolean {
  if (
    descriptor === undefined ||
    fixedRuntimeErrorStackDescriptor === undefined ||
    descriptor.enumerable !== false ||
    descriptor.configurable !== true
  ) {
    return false;
  }
  if (Object.hasOwn(fixedRuntimeErrorStackDescriptor, "value")) {
    return isExpectedDataProperty(
      descriptor,
      fixedRuntimeErrorStack,
      false,
    );
  }
  return (
    !Object.hasOwn(descriptor, "value") &&
    descriptor.get === fixedRuntimeErrorStackDescriptor.get &&
    descriptor.set === fixedRuntimeErrorStackDescriptor.set
  );
}

function readRuntimeAdapterFailureCategory(
  error: unknown,
): RuntimeFailureCategory | undefined {
  try {
    if (!isNativeError(error) || !(error instanceof RuntimeAdapterError)) {
      return undefined;
    }
    if (
      !isExpectedDataProperty(
        Object.getOwnPropertyDescriptor(error, "name"),
        "RuntimeAdapterError",
        true,
      ) ||
      !isExpectedDataProperty(
        Object.getOwnPropertyDescriptor(error, "message"),
        fixedRuntimeErrorMessage,
        false,
      ) ||
      !isExpectedStackProperty(Object.getOwnPropertyDescriptor(error, "stack"))
    ) {
      return undefined;
    }

    const categoryDescriptor = Object.getOwnPropertyDescriptor(error, "category");
    if (
      categoryDescriptor === undefined ||
      !Object.hasOwn(categoryDescriptor, "value") ||
      categoryDescriptor.writable !== true ||
      categoryDescriptor.enumerable !== true ||
      categoryDescriptor.configurable !== true ||
      typeof categoryDescriptor.value !== "string" ||
      !Object.hasOwn(runtimeFailureCategoryAllowlist, categoryDescriptor.value)
    ) {
      return undefined;
    }
    return categoryDescriptor.value as RuntimeFailureCategory;
  } catch {
    return undefined;
  }
}

export function sanitizeHeadlessCatalogFailure(
  error: unknown,
): HeadlessCatalogFailureEvidence {
  const runtimeAdapterFailureCategory =
    readRuntimeAdapterFailureCategory(error);
  return runtimeAdapterFailureCategory === undefined
    ? unknownHeadlessCatalogFailureEvidence
    : Object.freeze({ runtimeAdapterFailureCategory });
}
