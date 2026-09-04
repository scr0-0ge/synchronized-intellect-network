export const WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL =
  "workbench:write-clipboard-text" as const;

export type WorkbenchClipboardWriteResult =
  | Readonly<{ readonly ok: true; readonly status: "copied" }>
  | Readonly<{
      readonly ok: false;
      readonly error: Readonly<{
        readonly category: "clipboard-write-unavailable";
        readonly message: "The system clipboard refused the copy request.";
      }>;
    }>;

export interface WorkbenchClipboardRendererBridge {
  writeClipboardText(text: string): Promise<WorkbenchClipboardWriteResult>;
}

export interface WorkbenchClipboardRendererIpc {
  invoke(
    channel: typeof WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL,
    ...values: unknown[]
  ): Promise<unknown>;
}

export function publicClipboardCopied(): Extract<
  WorkbenchClipboardWriteResult,
  { readonly ok: true }
> {
  return Object.freeze({ ok: true, status: "copied" });
}

export function publicClipboardWriteUnavailable(): Extract<
  WorkbenchClipboardWriteResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "clipboard-write-unavailable",
      message: "The system clipboard refused the copy request.",
    }),
  });
}

export function sanitizeWorkbenchClipboardWriteResult(
  value: unknown,
): WorkbenchClipboardWriteResult {
  try {
    if (!isExactRecord(value, ["ok", "status"])) {
      if (!isExactRecord(value, ["error", "ok"]) || value.ok !== false) {
        return publicClipboardWriteUnavailable();
      }
      const error = value.error;
      if (
        !isExactRecord(error, ["category", "message"]) ||
        error.category !== "clipboard-write-unavailable" ||
        error.message !== "The system clipboard refused the copy request."
      ) {
        return publicClipboardWriteUnavailable();
      }
      return publicClipboardWriteUnavailable();
    }
    if (value.ok !== true || value.status !== "copied") {
      return publicClipboardWriteUnavailable();
    }
    return publicClipboardCopied();
  } catch {
    return publicClipboardWriteUnavailable();
  }
}

export function createWorkbenchClipboardPreloadBridge(
  ipc: WorkbenchClipboardRendererIpc,
): WorkbenchClipboardRendererBridge {
  return Object.freeze({
    async writeClipboardText(
      text: string,
    ): Promise<WorkbenchClipboardWriteResult> {
      if (arguments.length !== 1 || typeof text !== "string") {
        return publicClipboardWriteUnavailable();
      }
      try {
        return sanitizeWorkbenchClipboardWriteResult(
          await ipc.invoke(WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL, text),
        );
      } catch {
        return publicClipboardWriteUnavailable();
      }
    },
  });
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string")
    ) {
      return false;
    }
    return (keys as string[])
      .sort()
      .every((key, index) => {
        if (key !== expectedKeys[index]) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          "value" in descriptor &&
          descriptor.enumerable
        );
      });
  } catch {
    return false;
  }
}
