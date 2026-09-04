/**
 * Renderer-owned prose keeps an identity and resolves through the live copy
 * layer only when it is presented. Plain strings are deliberately treated as
 * opaque caller/Runtime text and are returned byte-for-byte.
 */
export interface WorkbenchLocalizedText {
  readonly kind: "workbench-localized-text";
  readonly key: string;
  readonly resolve: () => string;
}

export type WorkbenchPresentationText = string | WorkbenchLocalizedText;

export function workbenchLocalizedText(
  key: string,
  resolve: () => string,
): WorkbenchLocalizedText {
  return Object.freeze({
    kind: "workbench-localized-text" as const,
    key,
    resolve,
  });
}

export function presentationText(
  value: WorkbenchPresentationText | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.resolve();
}
