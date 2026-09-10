import { createContext } from "solid-js";
import type { WorkbenchCommandView, WorkbenchRendererBridge } from "../contract.ts";
import { statusCopy } from "./copy/session-status-copy.ts";
import { interruptedStatusLabel } from "./copy/session-status-copy.ts";
import { runtimeProfileCopy } from "./copy/runtime-profile-copy.ts";
import { subscribeLocale } from "./locale.ts";

export let fixedExecutionModeLabel: string =
  runtimeProfileCopy.fixedExecutionModeLabel;

export let fixedAccessModeLabel: string = runtimeProfileCopy.fixedAccessModeLabel;

export let workbenchFallbackControlLabel: string =
  runtimeProfileCopy.workbenchFallbackControlLabel;

export let workbenchFallbackControlLabelTitle: string =
  runtimeProfileCopy.workbenchFallbackControlLabelTitle;

subscribeLocale(() => {
  fixedExecutionModeLabel = runtimeProfileCopy.fixedExecutionModeLabel;
  fixedAccessModeLabel = runtimeProfileCopy.fixedAccessModeLabel;
  workbenchFallbackControlLabel =
    runtimeProfileCopy.workbenchFallbackControlLabel;
  workbenchFallbackControlLabelTitle =
    runtimeProfileCopy.workbenchFallbackControlLabelTitle;
});

export const WorkbenchRendererBridgeContext = createContext<
  Omit<WorkbenchRendererBridge, "observeProject">
>();

export function recordedRequestedProfile(
  command: WorkbenchCommandView | undefined,
) {
  const requested = command?.session?.profile.requested;
  return requested?.kind === "recorded" ? requested : undefined;
}

export function commandRuntimeFamily(
  command: WorkbenchCommandView | undefined,
): string {
  return recordedRequestedProfile(command)?.runtimeFamilyLabel ??
    command?.runtime ??
    runtimeProfileCopy.agentRuntimeFallback;
}

export function runtimeClass(runtimeFamily: string): string {
  const normalized = runtimeFamily.toLocaleLowerCase("en-US");
  if (normalized.includes("codex")) return "rt-codex";
  if (normalized.includes("claude")) return "rt-claude";
  return normalized.length === 0 ? "" : "rt-3";
}

function statusGlyphClass(status: WorkbenchCommandView["status"]): string {
  switch (status) {
    case "accepted":
    case "in-flight":
      return "st-running";
    case "completed":
      return "st-completed";
    case "quota-paused":
      return "st-interrupted";
    case "failed":
      return "st-failed";
    case "recovery-required":
      return "st-recovery";
  }
}

function statusGlyph(status: WorkbenchCommandView["status"]): string {
  switch (status) {
    case "accepted":
    case "in-flight":
      return "▸";
    case "completed":
      return "✓";
    case "quota-paused":
      return "Ⅱ";
    case "failed":
      return "✕";
    case "recovery-required":
      return "!";
  }
}

export function commandStatusLabel(command: WorkbenchCommandView): string {
  return command.failureCategory === "interrupted"
    ? interruptedStatusLabel
    : statusCopy[command.status];
}

export function commandStatusGlyph(command: WorkbenchCommandView): string {
  return command.failureCategory === "interrupted"
    ? "■"
    : statusGlyph(command.status);
}

export function commandStatusGlyphClass(command: WorkbenchCommandView): string {
  return command.failureCategory === "interrupted"
    ? "st-interrupted"
    : statusGlyphClass(command.status);
}
