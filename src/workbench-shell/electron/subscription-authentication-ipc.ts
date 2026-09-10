import { types as utilTypes } from "node:util";

import type {
  SubscriptionAuthenticationEndpointId,
  SubscriptionAuthenticationResult,
  SubscriptionAuthenticationSnapshot,
} from "../../agent-runtime/subscription-authentication.ts";
import {
  WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_CANCEL_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  publicSubscriptionAuthenticationEffect,
  publicSubscriptionAuthenticationSnapshot,
  publicSubscriptionAuthenticationUnavailable,
} from "../contract.ts";
import { reconstructSubscriptionAuthenticationRequest } from "../result-sanitizer.ts";
import type { WorkbenchSubscriptionAuthenticationCoordinator } from "../subscription-authentication-coordinator.ts";

type BoundaryListener = (...values: unknown[]) => unknown;
type SubscriptionAuthenticationChannel =
  | typeof WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL
  | typeof WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL
  | typeof WORKBENCH_CANCEL_SUBSCRIPTION_AUTHENTICATION_CHANNEL
  | typeof WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL
  | typeof WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL
  | typeof WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL;

export interface SubscriptionAuthenticationRendererSender {
  isDestroyed(): boolean;
  on(event: string, listener: BoundaryListener): void;
  removeListener(event: string, listener: BoundaryListener): void;
}

export interface SubscriptionAuthenticationBrowserWindowBoundary {
  readonly webContents: SubscriptionAuthenticationRendererSender;
  on(event: "closed", listener: BoundaryListener): void;
  removeListener(event: "closed", listener: BoundaryListener): void;
}

export interface SubscriptionAuthenticationIpcMainBoundary {
  handle(channel: SubscriptionAuthenticationChannel, listener: BoundaryListener): void;
  removeHandler(channel: SubscriptionAuthenticationChannel): void;
}

export interface WorkbenchSubscriptionAuthenticationSource {
  inspect(
    endpointId: SubscriptionAuthenticationEndpointId,
  ): Promise<SubscriptionAuthenticationSnapshot>;
  bind(
    endpointId: SubscriptionAuthenticationEndpointId,
  ): Promise<SubscriptionAuthenticationResult>;
  cancel(
    endpointId: SubscriptionAuthenticationEndpointId,
  ): Promise<SubscriptionAuthenticationResult>;
  close(): Promise<void>;
}

export interface WorkbenchSubscriptionAuthenticationIpcBinding {
  dispose(): Promise<void>;
}

export function installWorkbenchSubscriptionAuthenticationActionIpc(options: {
  readonly ipcMain: SubscriptionAuthenticationIpcMainBoundary;
  readonly window: SubscriptionAuthenticationBrowserWindowBoundary;
  readonly source: WorkbenchSubscriptionAuthenticationCoordinator;
}): WorkbenchSubscriptionAuthenticationIpcBinding {
  let disposed = false;
  let actionOpen = true;
  let closePromise: Promise<void> | undefined;
  const closeSource = (): Promise<void> =>
    (closePromise ??= Promise.resolve()
      .then(() => options.source.close())
      .catch(() => undefined));

  const requestHandler = (
    expected: "inspect" | "prepare" | "begin",
  ): BoundaryListener =>
    async (...values) => {
      const value = authorizedActionValue(
        values,
        options.window,
        disposed,
        actionOpen,
        expected,
        options.source,
      );
      if (value === undefined) {
        throw new TypeError("subscription-authentication-boundary-rejected");
      }
      const result = await options.source.request(value);
      if (
        !stillAuthorized(options.window, disposed, actionOpen) ||
        !result.accepted ||
        !options.source.sanitizePublicResponse(result.value).accepted
      ) {
        throw new TypeError("subscription-authentication-boundary-rejected");
      }
      return result.value;
    };

  const cancelHandler: BoundaryListener = async (...values) => {
    const value = authorizedActionValue(
      values,
      options.window,
      disposed,
      actionOpen,
      "begin",
      options.source,
    );
    if (value === undefined || !("preparationKey" in value)) {
      throw new TypeError("subscription-authentication-boundary-rejected");
    }
    if (!(await options.source.cancelPreparation(value.preparationKey))) {
      throw new TypeError("subscription-authentication-boundary-rejected");
    }
    return undefined;
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
    void closeSource();
  };

  options.ipcMain.handle(
    WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    requestHandler("inspect"),
  );
  options.ipcMain.handle(
    WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    requestHandler("prepare"),
  );
  options.ipcMain.handle(
    WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    requestHandler("begin"),
  );
  options.ipcMain.handle(
    WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    cancelHandler,
  );
  // Captured while the window is still alive. Reading the `webContents`
  // getter on a destroyed BrowserWindow throws `Object has been destroyed`,
  // and dispose() runs from the window's own "closed" handler, where the
  // window is destroyed by definition (issue 172). A reference taken here
  // keeps answering removeListener afterwards, so nothing has to be caught.
  const rendererSender = options.window.webContents;
  rendererSender.on("render-process-gone", terminalLifecycleListener);
  rendererSender.on("destroyed", terminalLifecycleListener);
  options.window.on("closed", terminalLifecycleListener);

  return Object.freeze({
    async dispose() {
      if (!disposed) {
        disposed = true;
        actionOpen = false;
        for (const channel of [
          WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
          WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
          WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
          WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        ] as const) {
          options.ipcMain.removeHandler(channel);
        }
        rendererSender.removeListener(
          "render-process-gone",
          terminalLifecycleListener,
        );
        rendererSender.removeListener(
          "destroyed",
          terminalLifecycleListener,
        );
        options.window.removeListener("closed", terminalLifecycleListener);
      }
      await closeSource();
    },
  });
}

function authorizedActionValue(
  values: readonly unknown[],
  window: SubscriptionAuthenticationBrowserWindowBoundary,
  disposed: boolean,
  actionOpen: boolean,
  expected: "inspect" | "prepare" | "begin",
  source: WorkbenchSubscriptionAuthenticationCoordinator,
) {
  if (values.length !== 2 || disposed || !actionOpen) return undefined;
  if (owningSender(values[0], window) === undefined) return undefined;
  const reconstructed = source.sanitizePublicRequest(values[1]);
  if (!reconstructed.accepted) return undefined;
  const request = reconstructed.value;
  if (expected === "inspect") {
    return "endpointSelectionKey" in request && !("action" in request)
      ? request
      : undefined;
  }
  if (expected === "prepare") {
    return "endpointSelectionKey" in request && "action" in request
      ? request
      : undefined;
  }
  return "preparationKey" in request ? request : undefined;
}

export function installWorkbenchSubscriptionAuthenticationIpc(options: {
  readonly ipcMain: SubscriptionAuthenticationIpcMainBoundary;
  readonly window: SubscriptionAuthenticationBrowserWindowBoundary;
  readonly source: WorkbenchSubscriptionAuthenticationSource;
}): WorkbenchSubscriptionAuthenticationIpcBinding {
  let disposed = false;
  let actionOpen = true;
  let closePromise: Promise<void> | undefined;
  const inspections = new Map<
    SubscriptionAuthenticationEndpointId,
    Promise<SubscriptionAuthenticationSnapshot>
  >();
  const effectsInFlight = new Set<string>();

  const closeSource = (): Promise<void> => {
    closePromise ??= Promise.resolve()
      .then(() => options.source.close())
      .catch(() => undefined);
    return closePromise;
  };

  const inspectHandler: BoundaryListener = async (...values) => {
    const request = authorizedRequest(values, options.window, disposed, actionOpen);
    if (request === undefined) return publicSubscriptionAuthenticationUnavailable();
    let inspection = inspections.get(request.endpointId);
    if (inspection === undefined) {
      inspection = Promise.resolve().then(() =>
        options.source.inspect(request.endpointId),
      );
      inspections.set(request.endpointId, inspection);
    }
    try {
      const result = await inspection;
      if (
        !stillAuthorized(options.window, disposed, actionOpen) ||
        !isExactDataRecord(result, ["authentication", "endpointId"]) ||
        result.endpointId !== request.endpointId ||
        !isAuthenticationStatus(result.authentication)
      ) {
        return publicSubscriptionAuthenticationUnavailable();
      }
      return publicSubscriptionAuthenticationSnapshot(
        result.endpointId,
        result.authentication,
      );
    } catch {
      return publicSubscriptionAuthenticationUnavailable();
    } finally {
      if (inspections.get(request.endpointId) === inspection) {
        inspections.delete(request.endpointId);
      }
    }
  };

  const bindHandler = effectHandler("bind", (endpointId) =>
    options.source.bind(endpointId),
  );
  const cancelHandler = effectHandler("cancel", (endpointId) =>
    options.source.cancel(endpointId),
  );

  function effectHandler(
    action: "bind" | "cancel",
    effect: (
      endpointId: SubscriptionAuthenticationEndpointId,
    ) => Promise<SubscriptionAuthenticationResult>,
  ): BoundaryListener {
    return async (...values) => {
      const request = authorizedRequest(values, options.window, disposed, actionOpen);
      if (request === undefined) {
        return publicSubscriptionAuthenticationUnavailable();
      }
      const key = `${action}:${request.endpointId}`;
      if (effectsInFlight.has(key)) {
        return publicSubscriptionAuthenticationUnavailable();
      }
      effectsInFlight.add(key);
      try {
        const result = await effect(request.endpointId);
        if (
          !stillAuthorized(options.window, disposed, actionOpen) ||
          !isExactDataRecord(result, [
            "authentication",
            "effect",
            "endpointId",
          ]) ||
          result.endpointId !== request.endpointId ||
          !isAuthenticationStatus(result.authentication) ||
          !isAuthenticationEffect(result.effect)
        ) {
          return publicSubscriptionAuthenticationUnavailable();
        }
        return publicSubscriptionAuthenticationEffect(
          result.endpointId,
          result.effect,
          result.authentication,
        );
      } catch {
        return publicSubscriptionAuthenticationUnavailable();
      } finally {
        effectsInFlight.delete(key);
      }
    };
  }

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
    void closeSource();
  };

  options.ipcMain.handle(
    WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    inspectHandler,
  );
  options.ipcMain.handle(
    WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    bindHandler,
  );
  options.ipcMain.handle(
    WORKBENCH_CANCEL_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    cancelHandler,
  );
  // Captured while the window is still alive. Reading the `webContents`
  // getter on a destroyed BrowserWindow throws `Object has been destroyed`,
  // and dispose() runs from the window's own "closed" handler, where the
  // window is destroyed by definition (issue 172). A reference taken here
  // keeps answering removeListener afterwards, so nothing has to be caught.
  const rendererSender = options.window.webContents;
  rendererSender.on(
    "render-process-gone",
    terminalLifecycleListener,
  );
  rendererSender.on("destroyed", terminalLifecycleListener);
  options.window.on("closed", terminalLifecycleListener);

  return Object.freeze({
    async dispose(): Promise<void> {
      if (!disposed) {
        disposed = true;
        actionOpen = false;
        options.ipcMain.removeHandler(
          WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        );
        options.ipcMain.removeHandler(
          WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        );
        options.ipcMain.removeHandler(
          WORKBENCH_CANCEL_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        );
        rendererSender.removeListener(
          "render-process-gone",
          terminalLifecycleListener,
        );
        rendererSender.removeListener(
          "destroyed",
          terminalLifecycleListener,
        );
        options.window.removeListener("closed", terminalLifecycleListener);
      }
      await closeSource();
    },
  });
}

function authorizedRequest(
  values: readonly unknown[],
  window: SubscriptionAuthenticationBrowserWindowBoundary,
  disposed: boolean,
  actionOpen: boolean,
): Readonly<{ endpointId: SubscriptionAuthenticationEndpointId }> | undefined {
  if (values.length !== 2 || disposed || !actionOpen) return undefined;
  if (owningSender(values[0], window) === undefined) return undefined;
  const reconstructed = reconstructSubscriptionAuthenticationRequest(values[1]);
  return reconstructed.ok ? reconstructed.request : undefined;
}

function stillAuthorized(
  window: SubscriptionAuthenticationBrowserWindowBoundary,
  disposed: boolean,
  actionOpen: boolean,
): boolean {
  try {
    return !disposed && actionOpen && !window.webContents.isDestroyed();
  } catch {
    return false;
  }
}

function owningSender(
  value: unknown,
  window: SubscriptionAuthenticationBrowserWindowBoundary,
): SubscriptionAuthenticationRendererSender | undefined {
  try {
    if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "sender");
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const owner = window.webContents;
    return descriptor.value === owner && !owner.isDestroyed() ? owner : undefined;
  } catch {
    return undefined;
  }
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
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    return (
      keys.length === expectedKeys.length &&
      expectedKeys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          keys.includes(key) &&
          descriptor !== undefined &&
          "value" in descriptor &&
          descriptor.enumerable
        );
      })
    );
  } catch {
    return false;
  }
}

function isAuthenticationStatus(value: unknown): value is
  | "bound"
  | "unbound"
  | "authentication-required"
  | "unknown" {
  return (
    value === "bound" ||
    value === "unbound" ||
    value === "authentication-required" ||
    value === "unknown"
  );
}

function isAuthenticationEffect(value: unknown): value is
  | "pending"
  | "finished"
  | "cancelled"
  | "timed-out"
  | "launch-failed"
  | "shutdown-failed" {
  return (
    value === "pending" ||
    value === "finished" ||
    value === "cancelled" ||
    value === "timed-out" ||
    value === "launch-failed" ||
    value === "shutdown-failed"
  );
}
