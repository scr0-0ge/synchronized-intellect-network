import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  CapturedLiveChild,
  LiveUserJourneyApplicationBoundary,
  LiveUserJourneyChildProcessBoundary,
  LiveUserJourneyFailureKind,
  LiveUserJourneyFailureOutcome,
  LiveUserJourneySystemBoundary,
  UserJourneyEvidenceSeal,
  UserJourneyRuntime,
} from "./contracts.ts";
import {
  assertSafeTemporaryRoot,
  removeTemporaryRoot,
  withTimeout,
} from "./shared.ts";

export function addLiveFailure(
  failures: LiveUserJourneyFailureKind[],
  failure: LiveUserJourneyFailureKind,
): void {
  if (!failures.includes(failure)) failures.push(failure);
}

export async function deleteGuardedLiveTemporaryRoot(
  temporaryRoot: string,
  boundary: LiveUserJourneySystemBoundary | undefined,
): Promise<void> {
  await assertSafeTemporaryRoot(temporaryRoot);
  if (boundary?.deleteGuardedTemporaryRoot === undefined) {
    await removeTemporaryRoot(temporaryRoot);
  } else {
    await boundary.deleteGuardedTemporaryRoot(temporaryRoot);
  }
}

export async function createLiveFailureOutcome(input: Readonly<{
  runtime: UserJourneyRuntime;
  failureKinds: readonly LiveUserJourneyFailureKind[];
  temporaryRoot: string;
  evidencePath: string | null;
  evidenceSeal: UserJourneyEvidenceSeal | undefined;
  launchChild: CapturedLiveChild | undefined;
  childState: LiveChildExitState;
}>): Promise<LiveUserJourneyFailureOutcome> {
  const rootDisposition = await inspectTemporaryRootDisposition(
    input.temporaryRoot,
  );
  const childState =
    input.launchChild === undefined
      ? "not-captured"
      : !input.childState.readable
        ? "unreadable"
        : input.childState.deathProved
          ? "exited"
          : "running";
  return Object.freeze({
    schema: "live-user-journey-failure-outcome-v1" as const,
    runtime: input.runtime,
    failureKinds: Object.freeze([...input.failureKinds]),
    rootDisposition,
    retainedRoot:
      rootDisposition === "retained" ? resolve(input.temporaryRoot) : null,
    evidencePath:
      input.evidencePath === null ? null : resolve(input.evidencePath),
    evidenceSeal:
      input.evidenceSeal === undefined
        ? null
        : Object.freeze({ ...input.evidenceSeal }),
    child: Object.freeze({
      capturedPid: input.launchChild?.pid ?? null,
      state: childState,
      deathProved: input.childState.deathProved,
      exitCode: input.childState.exitCode,
      signalCode: input.childState.signalCode,
    }),
  });
}

async function inspectTemporaryRootDisposition(
  temporaryRoot: string,
): Promise<LiveUserJourneyFailureOutcome["rootDisposition"]> {
  try {
    const status = await lstat(temporaryRoot);
    return status.isDirectory() && !status.isSymbolicLink()
      ? "retained"
      : "unproved";
  } catch (error) {
    return error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unproved";
  }
}

export function captureLiveChild(
  application: Pick<LiveUserJourneyApplicationBoundary, "process">,
): CapturedLiveChild {
  const child = application.process();
  const pid = child.pid;
  return Object.freeze({ process: child, pid });
}

export interface LiveChildExitState {
  readonly readable: boolean;
  readonly deathProved: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

export interface LiveApplicationCloseOutcome extends LiveChildExitState {
  readonly failureKinds: readonly LiveUserJourneyFailureKind[];
}

export async function closeOwnedApplication(
  application:
    | Pick<LiveUserJourneyApplicationBoundary, "process" | "close">
    | undefined,
  launchChild: CapturedLiveChild | undefined,
): Promise<LiveApplicationCloseOutcome> {
  if (application === undefined) {
    return closeOutcome([], unreadableChildExitState());
  }
  const failureKinds: LiveUserJourneyFailureKind[] = [];
  try {
    await withTimeout(application.close(), 15_000, "owned-application-close-timeout");
  } catch {
    failureKinds.push("graceful-close");
  }
  if (launchChild === undefined) {
    addLiveFailure(failureKinds, "graceful-close");
    addLiveFailure(failureKinds, "fallback-death-proof");
    return closeOutcome(failureKinds, unreadableChildExitState());
  }

  const closedState = readChildExitState(launchChild.process);
  if (closedState.readable && closedState.deathProved) {
    return closeOutcome(failureKinds, closedState);
  }
  addLiveFailure(failureKinds, "graceful-close");
  if (!closedState.readable) {
    addLiveFailure(failureKinds, "fallback-death-proof");
    return closeOutcome(failureKinds, closedState);
  }

  let currentChild: LiveUserJourneyChildProcessBoundary;
  let currentPid: number | undefined;
  try {
    currentChild = application.process();
    currentPid = currentChild.pid;
  } catch {
    addLiveFailure(failureKinds, "fallback-death-proof");
    return closeOutcome(failureKinds, unreadableChildExitState());
  }
  if (
    launchChild.pid === undefined ||
    currentChild !== launchChild.process ||
    currentPid !== launchChild.pid
  ) {
    addLiveFailure(failureKinds, "fallback-death-proof");
    return closeOutcome(failureKinds, closedState);
  }

  const runningState = readChildExitState(launchChild.process);
  if (!runningState.readable) {
    addLiveFailure(failureKinds, "fallback-death-proof");
    return closeOutcome(failureKinds, runningState);
  }
  if (runningState.deathProved) {
    return closeOutcome(failureKinds, runningState);
  }

  const deathWait = beginCapturedChildDeathWait(launchChild.process, 5_000);
  if (!deathWait.armed) {
    addLiveFailure(failureKinds, "fallback-death-proof");
    return closeOutcome(failureKinds, runningState);
  }
  let killAccepted = false;
  try {
    killAccepted = launchChild.process.kill("SIGTERM");
  } catch {
    // The fixed failure kind below is deliberately the only exposed diagnostic.
  }
  if (!killAccepted) deathWait.cancel();
  const deathObservation = await deathWait.promise;
  const deathProved = killAccepted && deathObservation.deathProved;
  const finalState = readChildExitState(launchChild.process);
  if (
    !deathProved ||
    deathObservation.accessorFailed ||
    !finalState.readable ||
    !finalState.deathProved
  ) {
    addLiveFailure(failureKinds, "fallback-death-proof");
  }
  return closeOutcome(failureKinds, finalState);
}

function closeOutcome(
  failureKinds: readonly LiveUserJourneyFailureKind[],
  state: LiveChildExitState,
): LiveApplicationCloseOutcome {
  return Object.freeze({
    ...state,
    failureKinds: Object.freeze([...failureKinds]),
  });
}

export function unreadableChildExitState(): LiveChildExitState {
  return Object.freeze({
    readable: false,
    deathProved: false,
    exitCode: null,
    signalCode: null,
  });
}

function readChildExitState(
  child: LiveUserJourneyChildProcessBoundary,
): LiveChildExitState {
  try {
    const exitCode = child.exitCode;
    const signalCode = child.signalCode;
    return Object.freeze({
      readable: true,
      deathProved: exitCode !== null || signalCode !== null,
      exitCode,
      signalCode,
    });
  } catch {
    return unreadableChildExitState();
  }
}

function beginCapturedChildDeathWait(
  child: LiveUserJourneyChildProcessBoundary,
  milliseconds: number,
): Readonly<{
  armed: boolean;
  promise: Promise<
    Readonly<{ deathProved: boolean; accessorFailed: boolean }>
  >;
  cancel(): void;
}> {
  let settle: (proved: boolean) => void = () => undefined;
  let armed = false;
  let accessorFailed = false;
  const promise = new Promise<
    Readonly<{ deathProved: boolean; accessorFailed: boolean }>
  >((resolveWait) => {
    let settled = false;
    let listenerRegistered = false;
    const onExit = (): void => {
      const state = readChildExitState(child);
      finish(state.readable && state.deathProved);
    };
    const timer = setTimeout(() => {
      const state = readChildExitState(child);
      finish(state.readable && state.deathProved);
    }, milliseconds);
    const finish = (proved: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (listenerRegistered) {
        try {
          child.off("exit", onExit);
        } catch {
          accessorFailed = true;
        }
      }
      resolveWait(Object.freeze({ deathProved: proved, accessorFailed }));
    };
    settle = finish;
    try {
      child.once("exit", onExit);
      listenerRegistered = true;
      armed = true;
    } catch {
      accessorFailed = true;
      finish(false);
    }
  });
  return Object.freeze({
    armed,
    promise,
    cancel: () => settle(false),
  });
}
