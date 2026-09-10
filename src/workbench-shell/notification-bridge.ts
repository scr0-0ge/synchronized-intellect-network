export const WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL =
  "workbench:notify-turn-completed" as const;
export const WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL =
  "workbench:notification-activated" as const;

/** Boundary truth for notification text size, measured in Unicode code points. */
export const WORKBENCH_TURN_NOTIFICATION_LIMITS = Object.freeze({
  maxTitleLength: 80,
  maxBodyLength: 240,
  maxCommandKeyLength: 80,
});

export interface WorkbenchTurnNotificationRequest {
  readonly title: string;
  readonly body: string;
  readonly commandKey: string;
  readonly projectScopeEpoch: number;
  readonly rendererInstanceKey: string;
}

export interface WorkbenchNotificationActivation {
  readonly commandKey: string;
  readonly projectScopeEpoch: number;
  readonly rendererInstanceKey: string;
}

export interface WorkbenchNotificationSelectionScope {
  readonly projectScopeEpoch: number;
  readonly rendererInstanceKey: string;
  readonly commands: readonly Readonly<{
    readonly key: string;
    readonly session?: Readonly<{ readonly archived: boolean }>;
  }>[];
}

export interface WorkbenchNotificationRendererBridge {
  notifyTurnCompleted(
    request: WorkbenchTurnNotificationRequest,
  ): Promise<void>;
  observeNotificationActivation(
    listener: (activation: WorkbenchNotificationActivation) => void,
  ): () => void;
}

export interface WorkbenchNotificationRendererIpc {
  invoke(
    channel: typeof WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
    ...values: unknown[]
  ): Promise<unknown>;
}

export function reconstructWorkbenchTurnNotificationRequest(
  request: unknown,
):
  | { readonly ok: true; readonly value: WorkbenchTurnNotificationRequest }
  | { readonly ok: false } {
  try {
    if (
      !isExactDataRecord(request, [
        "body",
        "commandKey",
        "projectScopeEpoch",
        "rendererInstanceKey",
        "title",
      ])
    ) {
      return { ok: false };
    }
    const title = request.title;
    const body = request.body;
    const commandKey = request.commandKey;
    const projectScopeEpoch = request.projectScopeEpoch;
    const rendererInstanceKey = request.rendererInstanceKey;
    if (typeof title !== "string" || typeof body !== "string") {
      return { ok: false };
    }
    if (
      typeof commandKey !== "string" ||
      !isWorkbenchCommandKey(commandKey) ||
      typeof projectScopeEpoch !== "number" ||
      !Number.isSafeInteger(projectScopeEpoch) ||
      projectScopeEpoch < 0 ||
      typeof rendererInstanceKey !== "string" ||
      !isWorkbenchRendererInstanceKey(rendererInstanceKey)
    ) {
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
      value: Object.freeze({
        title,
        body,
        commandKey,
        projectScopeEpoch,
        rendererInstanceKey,
      }),
    };
  } catch {
    return { ok: false };
  }
}

export function reconstructWorkbenchNotificationActivation(
  value: unknown,
):
  | { readonly ok: true; readonly value: WorkbenchNotificationActivation }
  | { readonly ok: false } {
  try {
    if (
      !isExactDataRecord(value, [
        "commandKey",
        "projectScopeEpoch",
        "rendererInstanceKey",
      ])
    ) {
      return { ok: false };
    }
    const commandKey = value.commandKey;
    const projectScopeEpoch = value.projectScopeEpoch;
    const rendererInstanceKey = value.rendererInstanceKey;
    return typeof commandKey === "string" &&
      isWorkbenchCommandKey(commandKey) &&
      typeof projectScopeEpoch === "number" &&
      Number.isSafeInteger(projectScopeEpoch) &&
      projectScopeEpoch >= 0 &&
      typeof rendererInstanceKey === "string" &&
      isWorkbenchRendererInstanceKey(rendererInstanceKey)
      ? {
          ok: true,
          value: Object.freeze({
            commandKey,
            projectScopeEpoch,
            rendererInstanceKey,
          }),
        }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function notificationActivationCommandKey(
  activation: WorkbenchNotificationActivation,
  scope: WorkbenchNotificationSelectionScope,
): string | undefined {
  if (
    activation.rendererInstanceKey !== scope.rendererInstanceKey ||
    activation.projectScopeEpoch !== scope.projectScopeEpoch
  ) {
    return undefined;
  }
  const target = scope.commands.find(
    (command) => command.key === activation.commandKey,
  );
  return target?.session !== undefined && !target.session.archived
    ? target.key
    : undefined;
}

export function createWorkbenchNotificationPreloadBridge(
  ipc: WorkbenchNotificationRendererIpc,
): Pick<
  WorkbenchNotificationRendererBridge,
  "notifyTurnCompleted" | "observeNotificationActivation"
> {
  return Object.freeze({
    async notifyTurnCompleted(
      request: WorkbenchTurnNotificationRequest,
    ): Promise<void> {
      if (arguments.length !== 1) {
        return;
      }
      const reconstructed =
        reconstructWorkbenchTurnNotificationRequest(request);
      if (!reconstructed.ok) {
        return;
      }
      try {
        await ipc.invoke(
          WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
          reconstructed.value,
        );
      } catch {
        // Notification delivery is best-effort; callers have no delivery result.
      }
    },
    observeNotificationActivation(
      listener: (activation: WorkbenchNotificationActivation) => void,
    ): () => void {
      if (arguments.length !== 1 || typeof listener !== "function") {
        return () => undefined;
      }
      const activationIpc = ipc as WorkbenchNotificationRendererIpc & {
        on(
          channel: typeof WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL,
          listener: (event: unknown, value: unknown) => void,
        ): void;
        removeListener(
          channel: typeof WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL,
          listener: (event: unknown, value: unknown) => void,
        ): void;
      };
      let active = true;
      const dispose = (): void => {
        if (!active) return;
        active = false;
        try {
          activationIpc.removeListener(
            WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL,
            handler,
          );
        } catch {
          // The renderer surface stays inert when transport teardown fails.
        }
      };
      const handler = (_event: unknown, value: unknown): void => {
        if (!active) return;
        const activation = reconstructWorkbenchNotificationActivation(value);
        if (!activation.ok) return;
        try {
          listener(activation.value);
        } catch {
          dispose();
        }
      };
      try {
        activationIpc.on(WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL, handler);
      } catch {
        active = false;
      }
      return dispose;
    },
  });
}

function isWorkbenchCommandKey(value: string): boolean {
  return (
    value.length <= WORKBENCH_TURN_NOTIFICATION_LIMITS.maxCommandKeyLength &&
    /^command-[1-9]\d*$/u.test(value)
  );
}

function isWorkbenchRendererInstanceKey(value: string): boolean {
  return /^renderer-instance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
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
