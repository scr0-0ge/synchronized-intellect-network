// The escape hatch's seam into discovery.
//
// A user whose runtime discovery cannot find can say where the executable is.
// That answer is durable and lives in the Workbench's preference store, which
// is main-process state; discovery lives here. This registry is the one place
// the two meet, so that agent-runtime never reaches into the shell and the
// shell never reaches into a discovery internal.
//
// The stored string is UNTRUSTED INPUT that ends at a spawn, and this module
// deliberately does not validate it: validation belongs to
// `admitNativeExecutable` / `admitLaunchTarget`, which every candidate goes
// through no matter where it came from. Holding the string here unvalidated and
// admitting it at the point of use means there is exactly one gate rather than
// two that can disagree.

import type { RuntimeLookupSurface } from "./runtime-lookup-surface.ts";

export type ConfigurableRuntime = "codex" | "claude";

const maximumConfiguredLength = 4_096;
const configured = new Map<ConfigurableRuntime, string>();

/**
 * Record the executable path a user supplied, or clear it when they empty the
 * field. A value that is not a usable string at all is treated as cleared: the
 * product must not become unusable because a stored preference went bad.
 */
export function setConfiguredRuntimeExecutable(
  runtime: ConfigurableRuntime,
  value: string | undefined,
): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumConfiguredLength
  ) {
    configured.delete(runtime);
    return;
  }
  configured.set(runtime, value.trim());
}

export function configuredRuntimeExecutable(
  runtime: ConfigurableRuntime,
): string | undefined {
  return configured.get(runtime);
}

export function clearConfiguredRuntimeExecutables(): void {
  configured.clear();
}

/** The runtime a lookup surface describes, for callers that hold only the surface. */
export function configurableRuntimeFor(
  surface: RuntimeLookupSurface,
): ConfigurableRuntime {
  return surface.command === "codex" ? "codex" : "claude";
}
