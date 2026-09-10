/**
 * File-drop bridge (issue #6 case 1): dragging files into the Workbench.
 *
 * The renderer is context-isolated and `File.path` is gone from Electron, so
 * the only sanctioned way to learn a dropped file's absolute path is the
 * preload-side `webUtils.getPathForFile`. This module owns the bridge
 * surface plus the pure draft-insertion helpers the composer consumes, so
 * the behavior is testable without a DOM.
 */

/** The preload-exposed surface the renderer may call during a drop. */
export interface WorkbenchFilesRendererBridge {
  /**
   * Absolute filesystem path of a dropped file, or `undefined` when the
   * native layer cannot resolve one (the entry is not a local file).
   */
  getPathForFile(file: File): string | undefined;
}

/** What `webUtils` exposes in the preload world (Electron 37). */
export interface WorkbenchWebUtilsBoundary {
  getPathForFile(file: File): string;
}

export function createWorkbenchFilesPreloadBridge(
  webUtils: WorkbenchWebUtilsBoundary,
): WorkbenchFilesRendererBridge {
  return Object.freeze({
    getPathForFile(file: File): string | undefined {
      try {
        const path = webUtils.getPathForFile(file);
        return typeof path === "string" && path.length > 0 ? path : undefined;
      } catch {
        return undefined;
      }
    },
  });
}

/** A drop's file list narrowed to what the bridge needs (test seam). */
export interface DroppedFileLike {
  readonly file: File;
  /** Fallback label when no absolute path can be resolved. */
  readonly name: string;
}

export interface FileDropDataTransferLike {
  readonly files: ReadonlyArray<DroppedFileLike>;
}

/**
 * Resolve every dropped entry to a text insertion. Files whose absolute
 * path the native layer cannot resolve still insert their display name —
 * a dropped file must never vanish silently — and non-file drops resolve
 * to an empty list so the composer leaves the draft alone.
 */
export function resolveDroppedFileTexts(
  transfer: FileDropDataTransferLike,
  bridge: WorkbenchFilesRendererBridge,
): readonly string[] {
  const lines: string[] = [];
  for (const entry of transfer.files) {
    const path = bridge.getPathForFile(entry.file);
    lines.push(path ?? entry.name);
  }
  return Object.freeze(lines);
}

/**
 * Insert resolved drop lines into a composer draft. Each path lands on its
 * own line, after the draft's existing text when present, so a drop never
 * splices into the middle of a half-written sentence.
 */
export function appendDroppedFileTexts(
  draft: string,
  paths: readonly string[],
): string {
  if (paths.length === 0) return draft;
  const block = paths.join("\n");
  const trimmed = draft.trimEnd();
  return trimmed.length === 0 ? block : `${trimmed}\n${block}`;
}

/** The renderer-side view of the drop surface. */
export function readWorkbenchFilesBridge(
  candidate: unknown,
): WorkbenchFilesRendererBridge | undefined {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof Reflect.get(candidate, "getPathForFile") !== "function"
  ) {
    return undefined;
  }
  return candidate as WorkbenchFilesRendererBridge;
}
