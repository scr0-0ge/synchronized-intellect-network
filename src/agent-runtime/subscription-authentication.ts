import type { ChildProcess } from "node:child_process";

export type SubscriptionAuthenticationEndpointId =
  | "claude-code-desktop"
  | "codex-desktop";

export type SubscriptionAuthenticationStatus =
  | "bound"
  | "unbound"
  | "authentication-required"
  | "unknown";

export type SubscriptionAuthenticationState =
  | "bound"
  | "sign-in-required"
  | "unknown";

export type SubscriptionAuthenticationAction = "login" | "logout";

/**
 * Whether the provider CLI process was actually started for this action.
 *
 * `not-started` is a total promise: no provider process ran, so the device's
 * credential state is exactly what it was. Callers rely on that promise to
 * decide whether it is safe to skip an irreversible durable commit — see
 * {@link SubscriptionAuthenticationActionStart.request}.
 */
export type SubscriptionAuthenticationRequestEffect = "started" | "not-started";

export type SubscriptionAuthenticationEffect =
  | "pending"
  | "finished"
  | "cancelled"
  | "timed-out"
  | "launch-failed"
  | "shutdown-failed";

export interface SubscriptionAuthenticationResult {
  readonly endpointId: SubscriptionAuthenticationEndpointId;
  readonly effect: SubscriptionAuthenticationEffect;
  readonly authentication: SubscriptionAuthenticationStatus;
}

export interface SubscriptionAuthenticationActionResult {
  readonly endpointId: SubscriptionAuthenticationEndpointId;
  readonly action: SubscriptionAuthenticationAction;
  readonly effect: SubscriptionAuthenticationEffect;
  readonly request: SubscriptionAuthenticationRequestEffect;
  readonly authentication: SubscriptionAuthenticationState;
}

/**
 * The acknowledgement that an authentication action has, or has not, reached
 * the provider CLI.
 *
 * This is the seam a caller must gate irreversible durable work on. Launching
 * is the fallible half of a logout — the executable can be missing, the spawn
 * can fail, the service can already be busy or closed — and it reports that
 * failure as `request: "not-started"` rather than by throwing. A caller that
 * commits durable state *before* awaiting this value converts every launch
 * failure into a silent, unrecoverable loss, because the durable half cannot be
 * rolled back once written. Await `request === "started"` first, then commit.
 */
export interface SubscriptionAuthenticationActionStart {
  readonly endpointId: SubscriptionAuthenticationEndpointId;
  readonly action: SubscriptionAuthenticationAction;
  /** `started` only once the provider process exists; see the interface note. */
  readonly request: SubscriptionAuthenticationRequestEffect;
  readonly completion: Promise<SubscriptionAuthenticationActionResult>;
}

export interface SubscriptionAuthenticationSnapshot {
  readonly endpointId: SubscriptionAuthenticationEndpointId;
  readonly authentication: SubscriptionAuthenticationStatus;
}

export interface SubscriptionAuthenticationChild {
  readonly finished: Promise<void>;
  terminate(): Promise<void>;
}

export async function waitForSubscriptionAuthenticationProcessSpawn(
  child: ChildProcess,
): Promise<void> {
  if (child.pid !== undefined) return;
  await new Promise<void>((resolveSpawn, reject) => {
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolveSpawn();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

export function ownSubscriptionAuthenticationProcess(
  child: ChildProcess,
  cleanup: () => Promise<void> = async () => undefined,
): SubscriptionAuthenticationChild {
  let cleaned: Promise<void> | undefined;
  const cleanOnce = (): Promise<void> => (cleaned ??= cleanup());
  const ignorePostSpawnError = () => undefined;
  child.on("error", ignorePostSpawnError);
  const exited = waitForOwnedProcessExit(child)
    .then(cleanOnce)
    .finally(() => child.off("error", ignorePostSpawnError));
  let termination: Promise<void> | undefined;
  return Object.freeze({
    finished: exited,
    terminate() {
      termination ??= terminateOwnedProcess(child, exited);
      return termination;
    },
  });
}

export interface SubscriptionAuthenticationProvider {
  readonly endpointId: SubscriptionAuthenticationEndpointId;
  launchLogin(signal: AbortSignal): Promise<SubscriptionAuthenticationChild>;
  /**
   * Start the provider's own log-out command. Rejecting means no process was
   * created and the device's credentials are untouched, so the service reports
   * `request: "not-started"` and callers may safely treat the whole action as
   * never having happened.
   */
  launchLogout(signal: AbortSignal): Promise<SubscriptionAuthenticationChild>;
  inspectAuthentication(
    signal: AbortSignal,
  ): Promise<SubscriptionAuthenticationState>;
}

export interface SubscriptionAuthenticationScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SubscriptionAuthenticationService {
  inspect(
    endpointId: SubscriptionAuthenticationEndpointId,
  ): Promise<SubscriptionAuthenticationSnapshot>;
  bind(
    endpointId: SubscriptionAuthenticationEndpointId,
  ): Promise<SubscriptionAuthenticationResult>;
  requestAction(
    endpointId: SubscriptionAuthenticationEndpointId,
    action: SubscriptionAuthenticationAction,
  ): Promise<SubscriptionAuthenticationActionResult>;
  /**
   * Ask the provider CLI to perform `action` and resolve as soon as it is known
   * whether the process was created. Resolving with `request: "not-started"`
   * guarantees no provider process ran; callers commit irreversible durable
   * state only after seeing `request: "started"`.
   */
  startAction(
    endpointId: SubscriptionAuthenticationEndpointId,
    action: SubscriptionAuthenticationAction,
  ): Promise<SubscriptionAuthenticationActionStart>;
  cancel(
    endpointId: SubscriptionAuthenticationEndpointId,
  ): Promise<SubscriptionAuthenticationResult>;
  close(): Promise<void>;
}

interface PendingBinding {
  readonly endpointId: SubscriptionAuthenticationEndpointId;
  readonly action: SubscriptionAuthenticationAction;
  readonly operation: number;
  readonly provider: SubscriptionAuthenticationProvider;
  readonly result: Promise<SubscriptionAuthenticationActionResult>;
  readonly resolveResult: (result: SubscriptionAuthenticationActionResult) => void;
  readonly start: Promise<SubscriptionAuthenticationActionStart>;
  readonly resolveStart: (start: SubscriptionAuthenticationActionStart) => void;
  readonly launchAbortController: AbortController;
  child: SubscriptionAuthenticationChild | undefined;
  launchSettled: boolean;
  requestStarted: boolean;
  requestedEffect: "cancelled" | "timed-out" | undefined;
  termination: Promise<void> | undefined;
  timer: unknown;
  settled: boolean;
  startSettled: boolean;
}

const productionScheduler: SubscriptionAuthenticationScheduler = Object.freeze({
  setTimeout: (callback: () => void, milliseconds: number) =>
    setTimeout(callback, milliseconds),
  clearTimeout: (handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

export function createSubscriptionAuthenticationService(options: {
  readonly providers: readonly SubscriptionAuthenticationProvider[];
  readonly timeoutMilliseconds: number;
  readonly inspectionTimeoutMilliseconds?: number;
  readonly scheduler?: SubscriptionAuthenticationScheduler;
}): SubscriptionAuthenticationService {
  const providers = new Map<
    SubscriptionAuthenticationEndpointId,
    SubscriptionAuthenticationProvider
  >();
  for (const provider of options.providers) {
    if (providers.has(provider.endpointId)) {
      throw new TypeError("Duplicate subscription authentication provider.");
    }
    providers.set(provider.endpointId, provider);
  }
  if (
    !Number.isSafeInteger(options.timeoutMilliseconds) ||
    options.timeoutMilliseconds <= 0
  ) {
    throw new TypeError("Subscription authentication timeout must be positive.");
  }
  const inspectionTimeoutMilliseconds =
    options.inspectionTimeoutMilliseconds ?? 5_000;
  if (
    !Number.isSafeInteger(inspectionTimeoutMilliseconds) ||
    inspectionTimeoutMilliseconds <= 0
  ) {
    throw new TypeError(
      "Subscription authentication inspection timeout must be positive.",
    );
  }
  return new NativeSubscriptionAuthenticationService(
    providers,
    options.timeoutMilliseconds,
    inspectionTimeoutMilliseconds,
    options.scheduler ?? productionScheduler,
  );
}

class NativeSubscriptionAuthenticationService
  implements SubscriptionAuthenticationService
{
  readonly #providers: ReadonlyMap<
    SubscriptionAuthenticationEndpointId,
    SubscriptionAuthenticationProvider
  >;
  readonly #timeoutMilliseconds: number;
  readonly #inspectionTimeoutMilliseconds: number;
  readonly #scheduler: SubscriptionAuthenticationScheduler;
  readonly #pending = new Map<
    SubscriptionAuthenticationEndpointId,
    PendingBinding
  >();
  readonly #ownedChildren = new Set<SubscriptionAuthenticationChild>();
  readonly #inspectionControllers = new Map<
    AbortController,
    Readonly<{
      endpointId: SubscriptionAuthenticationEndpointId;
      operation: number;
    }>
  >();
  readonly #operations = new Map<SubscriptionAuthenticationEndpointId, number>();
  readonly #lastAuthentication = new Map<
    SubscriptionAuthenticationEndpointId,
    SubscriptionAuthenticationState
  >();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    providers: ReadonlyMap<
      SubscriptionAuthenticationEndpointId,
      SubscriptionAuthenticationProvider
    >,
    timeoutMilliseconds: number,
    inspectionTimeoutMilliseconds: number,
    scheduler: SubscriptionAuthenticationScheduler,
  ) {
    this.#providers = providers;
    this.#timeoutMilliseconds = timeoutMilliseconds;
    this.#inspectionTimeoutMilliseconds = inspectionTimeoutMilliseconds;
    this.#scheduler = scheduler;
    for (const endpointId of providers.keys()) {
      this.#lastAuthentication.set(endpointId, "unknown");
      this.#operations.set(endpointId, 0);
    }
  }

  async inspect(
    endpointId: SubscriptionAuthenticationEndpointId,
  ): Promise<SubscriptionAuthenticationSnapshot> {
    const operation = this.#operations.get(endpointId) ?? 0;
    const actionPending = this.#pending.has(endpointId);
    const authentication =
      this.#closed || actionPending
        ? "unknown"
        : await this.#inspect(
            this.#provider(endpointId),
            endpointId,
            operation,
          );
    if (
      !this.#closed &&
      !actionPending &&
      this.#operations.get(endpointId) === operation
    ) {
      this.#lastAuthentication.set(endpointId, authentication);
    }
    return Object.freeze({
      endpointId,
      authentication: legacyAuthenticationStatus(authentication),
    });
  }

  bind(
    endpointId: SubscriptionAuthenticationEndpointId,
  ): Promise<SubscriptionAuthenticationResult> {
    return this.requestAction(endpointId, "login").then(legacyActionResult);
  }

  requestAction(
    endpointId: SubscriptionAuthenticationEndpointId,
    action: SubscriptionAuthenticationAction,
  ): Promise<SubscriptionAuthenticationActionResult> {
    return this.startAction(endpointId, action).then(
      (start) => start.completion,
    );
  }

  startAction(
    endpointId: SubscriptionAuthenticationEndpointId,
    action: SubscriptionAuthenticationAction,
  ): Promise<SubscriptionAuthenticationActionStart> {
    if (action !== "login" && action !== "logout") {
      throw new TypeError("Unknown subscription authentication action.");
    }
    if (this.#closed) {
      const completion = Promise.resolve(
        fixedActionResult(
          endpointId,
          action,
          "launch-failed",
          "not-started",
          "unknown",
        ),
      );
      return Promise.resolve(
        fixedActionStart(endpointId, action, "not-started", completion),
      );
    }
    const provider = this.#provider(endpointId);
    const pending = this.#pending.get(endpointId);
    if (pending !== undefined) {
      const completion = Promise.resolve(
        fixedActionResult(
          endpointId,
          action,
          "pending",
          "not-started",
          this.#lastAuthentication.get(endpointId) ?? "unknown",
        ),
      );
      return Promise.resolve(
        fixedActionStart(endpointId, action, "not-started", completion),
      );
    }
    const operation = this.#beginOperation(endpointId);

    let resolveResult!: (result: SubscriptionAuthenticationActionResult) => void;
    const result = new Promise<SubscriptionAuthenticationActionResult>(
      (resolve) => {
        resolveResult = resolve;
      },
    );
    let resolveStart!: (start: SubscriptionAuthenticationActionStart) => void;
    const start = new Promise<SubscriptionAuthenticationActionStart>((resolve) => {
      resolveStart = resolve;
    });
    const record: PendingBinding = {
      endpointId,
      action,
      operation,
      provider,
      result,
      resolveResult,
      start,
      resolveStart,
      launchAbortController: new AbortController(),
      child: undefined,
      launchSettled: false,
      requestStarted: false,
      requestedEffect: undefined,
      termination: undefined,
      timer: undefined,
      settled: false,
      startSettled: false,
    };
    this.#pending.set(endpointId, record);
    record.timer = this.#scheduler.setTimeout(() => {
      void this.#requestTermination(record, "timed-out");
    }, this.#timeoutMilliseconds);
    void this.#launch(record);
    return start;
  }

  cancel(
    endpointId: SubscriptionAuthenticationEndpointId,
  ): Promise<SubscriptionAuthenticationResult> {
    if (this.#closed) {
      return Promise.resolve(fixedResult(endpointId, "cancelled", "unknown"));
    }
    const record = this.#pending.get(endpointId);
    if (record === undefined) {
      return this.#fixedAfterInspection(endpointId, "cancelled");
    }
    void this.#requestTermination(record, "cancelled");
    return record.result.then(legacyActionResult);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#inspectionControllers.keys()) controller.abort();
    const pending = [...this.#pending.values()];
    await Promise.all(
      pending.map(async (record) => {
        await this.#requestTermination(record, "cancelled");
        await record.result;
      }),
    );
    const remainingOwnedChildren = [...this.#ownedChildren];
    await Promise.all(
      remainingOwnedChildren.map(async (child) => {
        try {
          await child.terminate();
          this.#ownedChildren.delete(child);
        } catch {
          // The service never broadens termination beyond its exact child handles.
        }
      }),
    );
  }

  async #launch(record: PendingBinding): Promise<void> {
    let child: SubscriptionAuthenticationChild;
    try {
      child = await (record.action === "login"
        ? record.provider.launchLogin(record.launchAbortController.signal)
        : record.provider.launchLogout(record.launchAbortController.signal));
    } catch {
      record.launchSettled = true;
      if (record.settled) {
        this.#releaseEndpointLane(record);
        return;
      }
      this.#acknowledge(record, "not-started");
      await this.#settle(record, "launch-failed");
      return;
    }
    record.launchSettled = true;
    if (record.settled) {
      record.child = child;
      record.requestStarted = true;
      this.#ownedChildren.add(child);
      void child.finished.then(
        () => this.#childFinished(record, child),
        () => this.#childFinished(record, child),
      );
      void child
        .terminate()
        .catch(() => undefined);
      return;
    }
    record.child = child;
    record.requestStarted = true;
    this.#acknowledge(record, "started");
    this.#ownedChildren.add(child);
    void child.finished.then(
      () => this.#childFinished(record, child),
      () => this.#childFinished(record, child),
    );
    if (record.requestedEffect !== undefined) {
      await this.#terminate(record);
    }
  }

  async #childFinished(
    record: PendingBinding,
    child: SubscriptionAuthenticationChild,
  ): Promise<void> {
    this.#ownedChildren.delete(child);
    if (record.settled) {
      if (this.#pending.get(record.endpointId) === record) {
        this.#pending.delete(record.endpointId);
      }
      return;
    }
    if (record.requestedEffect !== undefined) return;
    await this.#settle(record, "finished");
  }

  async #requestTermination(
    record: PendingBinding,
    effect: "cancelled" | "timed-out",
  ): Promise<void> {
    if (record.settled) return;
    record.requestedEffect ??= effect;
    record.launchAbortController.abort();
    if (record.child !== undefined) {
      await this.#terminate(record);
      return;
    }
    await this.#settle(record, record.requestedEffect);
  }

  async #terminate(record: PendingBinding): Promise<void> {
    record.termination ??= this.#terminateOnce(record);
    await record.termination;
  }

  async #terminateOnce(record: PendingBinding): Promise<void> {
    const child = record.child;
    if (child === undefined || record.settled) return;
    try {
      await child.terminate();
      this.#ownedChildren.delete(child);
      await this.#settle(record, record.requestedEffect ?? "cancelled");
    } catch {
      await this.#settle(record, "shutdown-failed");
    }
  }

  async #settle(
    record: PendingBinding,
    effect: Exclude<SubscriptionAuthenticationEffect, "pending">,
  ): Promise<void> {
    if (record.settled) return;
    record.settled = true;
    this.#acknowledge(
      record,
      record.requestStarted ? "started" : "not-started",
    );
    this.#scheduler.clearTimeout(record.timer);
    if (
      effect !== "shutdown-failed" &&
      record.launchSettled &&
      this.#pending.get(record.endpointId) === record
    ) {
      this.#pending.delete(record.endpointId);
    }
    const authentication =
      this.#closed ||
      (!record.requestStarted && effect !== "launch-failed")
        ? "unknown"
        : await this.#inspect(
            record.provider,
            record.endpointId,
            record.operation,
          );
    if (
      !this.#closed &&
      this.#operations.get(record.endpointId) === record.operation
    ) {
      this.#lastAuthentication.set(record.endpointId, authentication);
    }
    record.resolveResult(
      fixedActionResult(
        record.endpointId,
        record.action,
        effect,
        record.requestStarted ? "started" : "not-started",
        authentication,
      ),
    );
  }

  #acknowledge(
    record: PendingBinding,
    request: SubscriptionAuthenticationRequestEffect,
  ): void {
    if (record.startSettled) return;
    record.startSettled = true;
    record.resolveStart(
      fixedActionStart(
        record.endpointId,
        record.action,
        request,
        record.result,
      ),
    );
  }

  async #fixedAfterInspection(
    endpointId: SubscriptionAuthenticationEndpointId,
    effect: Exclude<SubscriptionAuthenticationEffect, "pending">,
  ): Promise<SubscriptionAuthenticationResult> {
    return fixedResult(
      endpointId,
      effect,
      legacyAuthenticationStatus(
        await this.#inspect(
          this.#provider(endpointId),
          endpointId,
          this.#operations.get(endpointId) ?? 0,
        ),
      ),
    );
  }

  async #inspect(
    provider: SubscriptionAuthenticationProvider,
    endpointId: SubscriptionAuthenticationEndpointId,
    operation: number,
  ): Promise<SubscriptionAuthenticationState> {
    return new Promise<SubscriptionAuthenticationState>((resolveStatus) => {
      const controller = new AbortController();
      this.#inspectionControllers.set(
        controller,
        Object.freeze({ endpointId, operation }),
      );
      let settled = false;
      let timeout: unknown;
      const finish = (status: SubscriptionAuthenticationState) => {
        if (settled) return;
        settled = true;
        this.#scheduler.clearTimeout(timeout);
        controller.signal.removeEventListener("abort", onAbort);
        this.#inspectionControllers.delete(controller);
        resolveStatus(
          !this.#closed && this.#operations.get(endpointId) === operation
            ? status
            : "unknown",
        );
      };
      const onAbort = () => finish("unknown");
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timeout = this.#scheduler.setTimeout(
        () => controller.abort(),
        this.#inspectionTimeoutMilliseconds,
      );
      void Promise.resolve()
        .then(() => provider.inspectAuthentication(controller.signal))
        .then(
          (status) => finish(isAuthenticationState(status) ? status : "unknown"),
          () => finish("unknown"),
        );
    });
  }

  #beginOperation(endpointId: SubscriptionAuthenticationEndpointId): number {
    const operation = (this.#operations.get(endpointId) ?? 0) + 1;
    this.#operations.set(endpointId, operation);
    for (const [controller, inspection] of this.#inspectionControllers) {
      if (
        inspection.endpointId === endpointId &&
        inspection.operation < operation
      ) {
        controller.abort();
      }
    }
    return operation;
  }

  #releaseEndpointLane(record: PendingBinding): void {
    if (this.#pending.get(record.endpointId) === record) {
      this.#pending.delete(record.endpointId);
    }
  }

  #provider(
    endpointId: SubscriptionAuthenticationEndpointId,
  ): SubscriptionAuthenticationProvider {
    const provider = this.#providers.get(endpointId);
    if (provider === undefined) {
      throw new TypeError("Unknown subscription authentication provider.");
    }
    return provider;
  }
}

function fixedResult(
  endpointId: SubscriptionAuthenticationEndpointId,
  effect: SubscriptionAuthenticationEffect,
  authentication: SubscriptionAuthenticationStatus,
): SubscriptionAuthenticationResult {
  return Object.freeze({ endpointId, effect, authentication });
}

function fixedActionResult(
  endpointId: SubscriptionAuthenticationEndpointId,
  action: SubscriptionAuthenticationAction,
  effect: SubscriptionAuthenticationEffect,
  request: SubscriptionAuthenticationRequestEffect,
  authentication: SubscriptionAuthenticationState,
): SubscriptionAuthenticationActionResult {
  return Object.freeze({ endpointId, action, effect, request, authentication });
}

function fixedActionStart(
  endpointId: SubscriptionAuthenticationEndpointId,
  action: SubscriptionAuthenticationAction,
  request: SubscriptionAuthenticationRequestEffect,
  completion: Promise<SubscriptionAuthenticationActionResult>,
): SubscriptionAuthenticationActionStart {
  return Object.freeze({ endpointId, action, request, completion });
}

function legacyActionResult(
  result: SubscriptionAuthenticationActionResult,
): SubscriptionAuthenticationResult {
  return fixedResult(
    result.endpointId,
    result.effect,
    legacyAuthenticationStatus(result.authentication),
  );
}

function legacyAuthenticationStatus(
  state: SubscriptionAuthenticationState,
): SubscriptionAuthenticationStatus {
  return state === "sign-in-required" ? "unbound" : state;
}

function isAuthenticationState(
  value: unknown,
): value is SubscriptionAuthenticationState {
  return (
    value === "bound" ||
    value === "sign-in-required" ||
    value === "unknown"
  );
}

function waitForOwnedProcessExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveExit) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.off("exit", finish);
      resolveExit();
    };
    child.once("exit", finish);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

async function terminateOwnedProcess(
  child: ChildProcess,
  exited: Promise<void>,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    let signalled: boolean;
    try {
      signalled = child.kill();
    } catch {
      throw new Error("Subscription authentication child shutdown failed.");
    }
    if (!signalled && child.exitCode === null && child.signalCode === null) {
      throw new Error("Subscription authentication child shutdown failed.");
    }
  }
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Subscription authentication child shutdown failed.")),
      5_000,
    );
    void exited.then(
      () => {
        clearTimeout(timeout);
        resolveExit();
      },
      () => {
        clearTimeout(timeout);
        reject(new Error("Subscription authentication child shutdown failed."));
      },
    );
  });
}
