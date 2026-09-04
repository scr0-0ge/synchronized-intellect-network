import type { SessionProfile } from "../agent-runtime/index.ts";

export type WorkIntensityControlLabelProjection =
  | {
      readonly label: string;
      readonly provenance: "runtime-catalog";
    }
  | {
      readonly label: null;
      readonly provenance: "not-recorded";
    };

export interface RequestedSessionProfileProjection {
  readonly kind: "recorded";
  readonly runtimeFamilyLabel: string;
  readonly endpointLabel: string;
  readonly modelLabel: string;
  readonly workIntensityControlLabel: WorkIntensityControlLabelProjection;
  readonly workIntensityLabel: string;
  readonly executionModeLabel: string;
  readonly accessModeLabel: string;
}

export interface EffectiveSessionProfileDisplayValue {
  readonly label: string;
  readonly comparison: "matches-requested" | "differs-from-requested";
}

export type EffectiveSessionProfileProjection =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "observed";
      readonly provenance: "post-turn-observation";
      readonly model: EffectiveSessionProfileDisplayValue;
      readonly workIntensity: EffectiveSessionProfileDisplayValue;
      readonly accessMode: EffectiveSessionProfileDisplayValue;
    };

export const observedDifferentProfileValueLabel = "Observed different value";

export function cloneRequestedSessionProfileProjection(
  value: unknown,
): RequestedSessionProfileProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "accessModeLabel",
      "endpointLabel",
      "executionModeLabel",
      "kind",
      "modelLabel",
      "runtimeFamilyLabel",
      "workIntensityControlLabel",
      "workIntensityLabel",
    ]) ||
    value.kind !== "recorded" ||
    !isSafeDisplayText(value.runtimeFamilyLabel, 160) ||
    !isSafeDisplayText(value.endpointLabel, 160) ||
    !isSafeDisplayText(value.modelLabel, 240) ||
    !isSafeDisplayText(value.workIntensityLabel, 240) ||
    !isSafeDisplayText(value.executionModeLabel, 160) ||
    !isSafeDisplayText(value.accessModeLabel, 160)
  ) {
    throw new Error("invalid-requested-profile-projection");
  }
  const workIntensityControlLabel = cloneWorkIntensityControlLabel(
    value.workIntensityControlLabel,
  );
  return deepFreeze({
    kind: "recorded" as const,
    runtimeFamilyLabel: value.runtimeFamilyLabel,
    endpointLabel: value.endpointLabel,
    modelLabel: value.modelLabel,
    workIntensityControlLabel,
    workIntensityLabel: value.workIntensityLabel,
    executionModeLabel: value.executionModeLabel,
    accessModeLabel: value.accessModeLabel,
  });
}

export function cloneEffectiveSessionProfileProjection(
  value: unknown,
): EffectiveSessionProfileProjection {
  if (!isRecord(value)) {
    throw new Error("invalid-effective-profile-projection");
  }
  if (hasExactKeys(value, ["kind"]) && value.kind === "unknown") {
    return Object.freeze({ kind: "unknown" as const });
  }
  if (
    !hasExactKeys(value, [
      "accessMode",
      "kind",
      "model",
      "provenance",
      "workIntensity",
    ]) ||
    value.kind !== "observed" ||
    value.provenance !== "post-turn-observation"
  ) {
    throw new Error("invalid-effective-profile-projection");
  }
  return deepFreeze({
    kind: "observed" as const,
    provenance: "post-turn-observation" as const,
    model: cloneEffectiveDisplayValue(value.model),
    workIntensity: cloneEffectiveDisplayValue(value.workIntensity),
    accessMode: cloneEffectiveDisplayValue(value.accessMode),
  });
}

export function unknownEffectiveSessionProfileProjection(): EffectiveSessionProfileProjection {
  return Object.freeze({ kind: "unknown" as const });
}

export function projectEffectiveSessionProfile(options: {
  readonly requestedProfile: SessionProfile;
  readonly requestedProjection: RequestedSessionProfileProjection;
  readonly observedProfile: unknown;
}): EffectiveSessionProfileProjection {
  const observed = cloneObservedProfile(options.observedProfile);
  if (observed === undefined) return unknownEffectiveSessionProfileProjection();
  return deepFreeze({
    kind: "observed" as const,
    provenance: "post-turn-observation" as const,
    model: projectObservedValue(
      observed.model === options.requestedProfile.model,
      options.requestedProjection.modelLabel,
    ),
    workIntensity: projectObservedValue(
      observed.effortLevel === options.requestedProfile.effortLevel,
      options.requestedProjection.workIntensityLabel,
    ),
    accessMode: projectObservedValue(
      observed.accessMode === options.requestedProfile.accessMode,
      options.requestedProjection.accessModeLabel,
    ),
  });
}

function cloneWorkIntensityControlLabel(
  value: unknown,
): WorkIntensityControlLabelProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["label", "provenance"])
  ) {
    throw new Error("invalid-work-intensity-control-label");
  }
  if (
    value.provenance === "runtime-catalog" &&
    isSafeDisplayText(value.label, 160)
  ) {
    return Object.freeze({
      label: value.label,
      provenance: "runtime-catalog" as const,
    });
  }
  if (value.provenance === "not-recorded" && value.label === null) {
    return Object.freeze({
      label: null,
      provenance: "not-recorded" as const,
    });
  }
  throw new Error("invalid-work-intensity-control-label");
}

function cloneEffectiveDisplayValue(
  value: unknown,
): EffectiveSessionProfileDisplayValue {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["comparison", "label"]) ||
    (value.comparison !== "matches-requested" &&
      value.comparison !== "differs-from-requested") ||
    !isSafeDisplayText(value.label, 240) ||
    (value.comparison === "differs-from-requested" &&
      value.label !== observedDifferentProfileValueLabel)
  ) {
    throw new Error("invalid-effective-profile-display-value");
  }
  return Object.freeze({
    label: value.label,
    comparison: value.comparison,
  });
}

function projectObservedValue(
  matchesRequested: boolean,
  requestedLabel: string,
): EffectiveSessionProfileDisplayValue {
  return Object.freeze({
    label: matchesRequested
      ? requestedLabel
      : observedDifferentProfileValueLabel,
    comparison: matchesRequested
      ? ("matches-requested" as const)
      : ("differs-from-requested" as const),
  });
}

function cloneObservedProfile(value: unknown): SessionProfile | undefined {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "accessMode",
        "effortLevel",
        "executionMode",
        "model",
      ]) ||
      !isBoundedNativeValue(value.model) ||
      !isBoundedNativeValue(value.effortLevel) ||
      !isBoundedNativeValue(value.executionMode) ||
      !isBoundedNativeValue(value.accessMode)
    ) {
      return undefined;
    }
    return Object.freeze({
      model: value.model,
      effortLevel: value.effortLevel,
      executionMode: value.executionMode,
      accessMode: value.accessMode,
    });
  } catch {
    return undefined;
  }
}

function isBoundedNativeValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 1_024 &&
    !value.includes("\0")
  );
}

function isSafeDisplayText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    [...value].length <= maximumLength &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.includes("\\") &&
    !value.includes("://") &&
    !/^[A-Za-z0-9_-]{40,}$/u.test(value) &&
    !/^(?:Bearer|Basic)\s+\S+/iu.test(value) &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
