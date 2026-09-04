import { isAbsolute, normalize } from "node:path";

import {
  publicCreateProjectResult,
  type WorkbenchCreateProjectResult,
  type WorkbenchProjectSelectionResult,
} from "./contract.ts";
import type { WorkbenchCreateProjectFilesystem } from "./create-project-filesystem.ts";
import type { WorkbenchCreateProjectStateStore } from "./create-project-store.ts";
import {
  createWorkbenchCreateProjectTargetToken,
  transitionWorkbenchCreateProject,
  validateWorkbenchCreateProjectState,
  type WorkbenchCreateProjectEffect,
  type WorkbenchCreateProjectRegistrationResult,
  type WorkbenchCreateProjectState,
} from "./create-project-transition.ts";
import type { WorkbenchProjectSaveTargetChooser } from "./electron/project-save-target-chooser.ts";

export interface WorkbenchCreateProjectHost {
  registerTrustedProject(
    directory: string,
  ): Promise<WorkbenchProjectSelectionResult>;
}

export interface WorkbenchCreateProjectControllerOptions {
  readonly chooser: WorkbenchProjectSaveTargetChooser;
  readonly filesystem: WorkbenchCreateProjectFilesystem;
  readonly stateStore: WorkbenchCreateProjectStateStore;
  readonly host: WorkbenchCreateProjectHost;
}

export interface WorkbenchCreateProjectController {
  createProject(): Promise<WorkbenchCreateProjectResult>;
  close(): Promise<void>;
}

export async function createWorkbenchCreateProjectController(
  options: WorkbenchCreateProjectControllerOptions,
): Promise<WorkbenchCreateProjectController> {
  let failedClosed = !validateWorkbenchCreateProjectState(
    options.stateStore.state,
  );
  let failedOutcome = publicCreateProjectResult("unavailable");
  if (!failedClosed) {
    const opened = transitionWorkbenchCreateProject(
      options.stateStore.state,
      { kind: "open-controller-lifecycle" },
    );
    if (opened.applied) {
      failedClosed = !(await safeWrite(options.stateStore, opened.state));
    } else if (opened.code !== "lifecycle-open") {
      failedClosed = true;
    }
  }
  if (!failedClosed) {
    const restarted = transitionWorkbenchCreateProject(
      options.stateStore.state,
      { kind: "restart" },
    );
    if (restarted.applied) {
      if (!(await safeWrite(options.stateStore, restarted.state))) {
        failedClosed = true;
        failedOutcome = terminalOutcome(options.stateStore.state);
      }
    } else if (restarted.code !== "restart-stable") {
      failedClosed = true;
      failedOutcome = terminalOutcome(options.stateStore.state);
    }
  }

  let closed = false;
  let operationPending = false;
  let closePromise: Promise<void> | undefined;
  let settleTerminal!: (result: WorkbenchCreateProjectResult) => void;
  const terminalResult = new Promise<WorkbenchCreateProjectResult>((resolve) => {
    settleTerminal = resolve;
  });

  const controller: WorkbenchCreateProjectController = Object.freeze({
    async createProject(): Promise<WorkbenchCreateProjectResult> {
      if (closed || failedClosed || operationPending) {
        return failedClosed
          ? failedOutcome
          : publicCreateProjectResult("unavailable");
      }
      operationPending = true;
      const failClosed = (state: WorkbenchCreateProjectState) => {
        failedOutcome = terminalOutcome(state);
        failedClosed = true;
        return failedOutcome;
      };
      const work = runCreateProject(
        options,
        () => closed || failedClosed,
        failClosed,
        terminalResult,
      );
      try {
        return await Promise.race([work, terminalResult]);
      } finally {
        operationPending = false;
      }
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        const invocationState = options.stateStore.state;
        let result = failedClosed
          ? failedOutcome
          : publicCreateProjectResult("unavailable");
        if (
          !failedClosed &&
          validateWorkbenchCreateProjectState(invocationState)
        ) {
          const invocationClose = transitionWorkbenchCreateProject(
            invocationState,
            { kind: "close" },
          );
          result = invocationClose.publicResults[0] ??
            terminalOutcome(invocationState);

          let closeBase = invocationState;
          while (validateWorkbenchCreateProjectState(closeBase)) {
            const closedTransition = transitionWorkbenchCreateProject(
              closeBase,
              { kind: "close" },
            );
            if (!closedTransition.applied) break;
            if (await safeWrite(options.stateStore, closedTransition.state)) {
              break;
            }
            const latest = options.stateStore.state;
            if (latest === closeBase) break;
            closeBase = latest;
          }
        }
        settleTerminal(result);
        await options.stateStore.close().catch(() => undefined);
      })();
      return closePromise;
    },
  });
  return controller;
}

async function runCreateProject(
  options: WorkbenchCreateProjectControllerOptions,
  isTerminal: () => boolean,
  failClosed: (
    state: WorkbenchCreateProjectState,
  ) => WorkbenchCreateProjectResult,
  terminalResult: Promise<WorkbenchCreateProjectResult>,
): Promise<WorkbenchCreateProjectResult> {
  let state = options.stateStore.state;
  if (state.active === null) {
    const accepted = transitionWorkbenchCreateProject(state, {
      kind: "renderer-create-intent",
    });
    if (!accepted.applied || !(await safeWrite(options.stateStore, accepted.state))) {
      return accepted.publicResults[0] ?? publicCreateProjectResult("unavailable");
    }
    state = accepted.state;
  }

  while (!isTerminal()) {
    state = options.stateStore.state;
    const active = state.active;
    if (active === null) return publicCreateProjectResult("unavailable");
    if (active.phase === "response-ready") {
      const delivered = transitionWorkbenchCreateProject(state, {
        kind: "deliver-result",
        operationNumber: active.operationNumber,
      });
      if (!delivered.applied) {
        return delivered.publicResults[0] ?? publicCreateProjectResult("unavailable");
      }
      if (!(await safeWrite(options.stateStore, delivered.state))) {
        return active.createCommitted
          ? failClosed(state)
          : terminalOutcome(state);
      }
      return delivered.publicResults[0] ?? publicCreateProjectResult("unavailable");
    }

    const effectKind = readyEffect(active.phase);
    if (effectKind === null) return publicCreateProjectResult("unavailable");
    const claimed = transitionWorkbenchCreateProject(state, {
      kind: "claim-effect",
      operationNumber: active.operationNumber,
      effectKind,
    });
    if (!claimed.applied || claimed.effects.length !== 1) {
      return active.createCommitted
        ? failClosed(state)
        : publicCreateProjectResult("unavailable");
    }
    if (!(await safeWrite(options.stateStore, claimed.state))) {
      return active.createCommitted
        ? failClosed(state)
        : publicCreateProjectResult("unavailable");
    }
    if (isTerminal()) return terminalOutcome(claimed.state);

    const effect = claimed.effects[0]!;
    const event = await executeEffect(options, effect);
    if (isTerminal()) return terminalOutcome(claimed.state);
    const recorded = transitionWorkbenchCreateProject(
      options.stateStore.state,
      event,
    );
    if (!recorded.applied) {
      return effect.kind === "choose-save-target"
        ? publicCreateProjectResult("unavailable")
        : failClosed(claimed.state);
    }
    if (!(await safeWrite(options.stateStore, recorded.state))) {
      return effect.kind === "choose-save-target"
        ? publicCreateProjectResult("unavailable")
        : failClosed(claimed.state);
    }
  }
  return terminalResult;
}

async function executeEffect(
  options: WorkbenchCreateProjectControllerOptions,
  effect: WorkbenchCreateProjectEffect,
): Promise<Record<string, unknown>> {
  if (effect.kind === "choose-save-target") {
    let nativeValue: unknown;
    try {
      nativeValue = await options.chooser.chooseProjectTarget();
    } catch {
      return {
        kind: "chooser-result",
        operationNumber: effect.operationNumber,
        result: "failed",
        targetPath: null,
        targetToken: null,
      };
    }
    return decodeChooserResult(effect.operationNumber, nativeValue);
  }
  if (effect.kind === "create-if-absent") {
    let result: string;
    try {
      result = await options.filesystem.createIfAbsent(effect.targetPath);
    } catch {
      result = "unknown";
    }
    return {
      kind: "create-result",
      operationNumber: effect.operationNumber,
      result,
    };
  }

  let result: WorkbenchCreateProjectRegistrationResult = "unknown";
  try {
    const hostResult = await options.host.registerTrustedProject(effect.targetPath);
    if (isCommittedHostResult(hostResult)) {
      result = "committed";
    } else {
      result = classifyKnownNoCommitHostResult(hostResult) ?? "unknown";
    }
  } catch {
    result = "unknown";
  }
  return {
    kind: "registration-result",
    operationNumber: effect.operationNumber,
    result,
  };
}

function decodeChooserResult(
  operationNumber: number,
  value: unknown,
): Record<string, unknown> {
  try {
    if (!hasExactDataProperties(value, ["canceled", "filePath"])) {
      throw new Error("malformed-native-result");
    }
    const result = value as { readonly canceled: unknown; readonly filePath: unknown };
    if (result.canceled === true && result.filePath === "") {
      return {
        kind: "chooser-result",
        operationNumber,
        result: "cancelled",
        targetPath: null,
        targetToken: null,
      };
    }
    if (
      result.canceled === false &&
      isSafeAbsoluteTarget(result.filePath)
    ) {
      const targetPath = normalize(result.filePath);
      return {
        kind: "chooser-result",
        operationNumber,
        result: "selected",
        targetPath,
        targetToken: createWorkbenchCreateProjectTargetToken(targetPath),
      };
    }
  } catch {
    // Malformed, accessor-like, and proxy values are normalized below.
  }
  return {
    kind: "chooser-result",
    operationNumber,
    result: "malformed",
    targetPath: null,
    targetToken: null,
  };
}

function isCommittedHostResult(
  value: unknown,
): value is Extract<WorkbenchProjectSelectionResult, { readonly ok: true }> {
  try {
    if (!hasExactDataProperties(value, ["message", "ok", "status"])) return false;
    const result = value as Record<string, unknown>;
    return result.ok === true &&
      result.status === "selected" &&
      (result.message === "Project was opened." ||
        result.message ===
          "Project was opened with its existing conversation history.");
  } catch {
    return false;
  }
}

function classifyKnownNoCommitHostResult(
  value: unknown,
): WorkbenchCreateProjectRegistrationResult | null {
  try {
    if (!hasExactDataProperties(value, ["error", "ok"])) return null;
    const result = value as Record<string, unknown>;
    if (result.ok !== false ||
      !hasExactDataProperties(result.error, ["category", "message"])) {
      return null;
    }
    if (result.error.category === "project-unavailable" &&
      result.error.message ===
        "This Project is unavailable. Choose another Project or restore its directory.") {
      return "unavailable-known-no-commit";
    }
    return result.error.category === "invalid-project-selection" &&
        result.error.message ===
          "Reload the Project list and choose an available Project."
      ? "rejected-known-no-commit"
      : null;
  } catch {
    return null;
  }
}

function readyEffect(
  phase: string,
): WorkbenchCreateProjectEffect["kind"] | null {
  if (phase === "chooser-ready") return "choose-save-target";
  if (phase === "create-ready") return "create-if-absent";
  if (phase === "register-ready") return "register-trusted-project";
  return null;
}

function terminalOutcome(
  state: WorkbenchCreateProjectState,
): WorkbenchCreateProjectResult {
  const active = state.active;
  return publicCreateProjectResult(
    active !== null &&
      (active.phase === "create-claimed" ||
        active.phase === "register-ready" ||
        active.phase === "register-claimed" ||
        active.createCommitted ||
        active.outcome === "created-recovery-required")
      ? "created-recovery-required"
      : "unavailable",
  );
}

async function safeWrite(
  store: WorkbenchCreateProjectStateStore,
  state: WorkbenchCreateProjectState,
): Promise<boolean> {
  try {
    return await store.write(state);
  } catch {
    return false;
  }
}

function isSafeAbsoluteTarget(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32_768 &&
    isAbsolute(value) &&
    (process.platform === "win32"
      ? /^[A-Za-z]:[\\/]/u.test(value)
      : value.startsWith("/") && !value.startsWith("//")) &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function hasExactDataProperties(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return false;
    const keys = (ownKeys as string[]).sort();
    const wanted = [...expected].sort();
    return keys.length === wanted.length &&
      keys.every((key, index) => key === wanted[index]) &&
      wanted.every((key) => {
        const descriptor = descriptors[key];
        return descriptor !== undefined &&
          "value" in descriptor &&
          descriptor.enumerable === true;
      });
  } catch {
    return false;
  }
}
