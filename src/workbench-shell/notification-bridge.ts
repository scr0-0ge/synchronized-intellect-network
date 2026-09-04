export const WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL =
  "workbench:notify-turn-completed" as const;

/** Boundary truth for notification text size, measured in Unicode code points. */
export const WORKBENCH_TURN_NOTIFICATION_LIMITS = Object.freeze({
  maxTitleLength: 80,
  maxBodyLength: 240,
});

export interface WorkbenchTurnNotificationRequest {
  readonly title: string;
  readonly body: string;
}

export type WorkbenchTurnNotificationResult =
  | Readonly<{ readonly shown: true }>
  | Readonly<{
      readonly shown: false;
      readonly reason:
        | "window-focused"
        | "notifications-unavailable"
        | "invalid-request"
        | "bridge-closed";
    }>;

export interface WorkbenchNotificationRendererBridge {
  notifyTurnCompleted(
    request: WorkbenchTurnNotificationRequest,
  ): Promise<WorkbenchTurnNotificationResult>;
}

export interface WorkbenchNotificationRendererIpc {
  invoke(
    channel: typeof WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
    ...values: unknown[]
  ): Promise<unknown>;
}

export function publicTurnNotificationShown(): Extract<
  WorkbenchTurnNotificationResult,
  { readonly shown: true }
> {
  return Object.freeze({ shown: true });
}

export function publicTurnNotificationNotShown(
  reason: Extract<
    WorkbenchTurnNotificationResult,
    { readonly shown: false }
  >["reason"],
): Extract<WorkbenchTurnNotificationResult, { readonly shown: false }> {
  return Object.freeze({ shown: false, reason });
}

export function reconstructWorkbenchTurnNotificationRequest(
  request: unknown,
):
  | { readonly ok: true; readonly value: WorkbenchTurnNotificationRequest }
  | { readonly ok: false } {
  try {
    if (!isExactDataRecord(request, ["body", "title"])) {
      return { ok: false };
    }
    const title = request.title;
    const body = request.body;
    if (typeof title !== "string" || typeof body !== "string") {
      return { ok: false };
    }
    if (title.trim().length === 0 || body.trim().length === 0) {
      return { ok: false };
    }
    if (
      unicodeCodePointLength(title) >
        WORKBENCH_TURN_NOTIFICATION_LIMITS.maxTitleLength ||
      unicodeCodePointLength(body) >
        WORKBENCH_TURN_NOTIFICATION_LIMITS.maxBodyLength
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      value: Object.freeze({ title, body }),
    };
  } catch {
    return { ok: false };
  }
}

const TURN_NOTIFICATION_SKIP_REASONS = Object.freeze([
  "window-focused",
  "notifications-unavailable",
  "invalid-request",
  "bridge-closed",
] as const);

export function sanitizeWorkbenchTurnNotificationResult(
  value: unknown,
): WorkbenchTurnNotificationResult {
  try {
    if (
      !isExactDataRecord(value, ["shown"]) &&
      !isExactDataRecord(value, ["reason", "shown"])
    ) {
      return publicTurnNotificationNotShown("notifications-unavailable");
    }
    if (
      isExactDataRecord(value, ["shown"]) &&
      value.shown === true
    ) {
      return publicTurnNotificationShown();
    }
    if (
      !isExactDataRecord(value, ["reason", "shown"]) ||
      value.shown !== false
    ) {
      return publicTurnNotificationNotShown("notifications-unavailable");
    }
    const reason = value.reason;
    return TURN_NOTIFICATION_SKIP_REASONS.includes(
      reason as (typeof TURN_NOTIFICATION_SKIP_REASONS)[number],
    )
      ? publicTurnNotificationNotShown(
          reason as Exclude<
            WorkbenchTurnNotificationResult,
            { readonly shown: true }
          >["reason"],
        )
      : publicTurnNotificationNotShown("notifications-unavailable");
  } catch {
    return publicTurnNotificationNotShown("notifications-unavailable");
  }
}

export function createWorkbenchNotificationPreloadBridge(
  ipc: WorkbenchNotificationRendererIpc,
): Pick<WorkbenchNotificationRendererBridge, "notifyTurnCompleted"> {
  return Object.freeze({
    async notifyTurnCompleted(
      request: WorkbenchTurnNotificationRequest,
    ): Promise<WorkbenchTurnNotificationResult> {
      if (arguments.length !== 1) {
        return publicTurnNotificationNotShown("invalid-request");
      }
      const reconstructed =
        reconstructWorkbenchTurnNotificationRequest(request);
      if (!reconstructed.ok) {
        return publicTurnNotificationNotShown("invalid-request");
      }
      try {
        return sanitizeWorkbenchTurnNotificationResult(
          await ipc.invoke(
            WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
            reconstructed.value,
          ),
        );
      } catch {
        return publicTurnNotificationNotShown("notifications-unavailable");
      }
    },
  });
}

function unicodeCodePointLength(value: string): number {
  return Array.from(value).length;
}

function isExactDataRecord(
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
      keys.some((key) => typeof key !== "string") ||
      !(keys as string[])
        .slice()
        .sort()
        .every((key, index) => key === expectedKeys[index])
    ) {
      return false;
    }
    return (keys as string[]).every((key) => {
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
