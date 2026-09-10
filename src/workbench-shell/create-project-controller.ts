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
  type WorkbenchCreateProjectCreateResult,
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

/** A selected Create target is only available for the result delivery that owns it. */
export interface WorkbenchCreateProjectFailureDiagnostic {
  readonly reason: Exclude<WorkbenchCreateProjectCreateResult, "created">;
  readonly targetPath: string;
}

/**
 * The diagnostic is deliberately non-enumerable: IPC can use it while the
 * result is in memory, but the public contract, JSON logs and the sidecar
 * state never receive a selected filesystem path.
 */
export type WorkbenchCreateProjectControllerResult =
  WorkbenchCreateProjectResult & {
    readonly diagnostic?: WorkbenchCreateProjectFailureDiagnostic;
  };

export interface WorkbenchCreateProjectController {
  createProject(): Promise<WorkbenchCreateProjectControllerResult>;
  close(): Promise<void>;
}

interface WorkbenchCreateProjectEffectExecution {
  readonly event: Record<string, unknown>;
  readonly selectedTargetPath?: string;
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
  const selectedTargets = new Map<number, string>();
  let closePromise: Promise<void> | undefined;
  let settleTerminal!: (result: WorkbenchCreateProjectControllerResult) => void;
  const terminalResult = new Promise<WorkbenchCreateProjectControllerResult>((resolve) => {
    settleTerminal = resolve;
  });

  const controller: WorkbenchCreateProjectController = Object.freeze({
    async createProject(): Promise<WorkbenchCreateProjectControllerResult> {
      if (closed || failedClosed || operationPending) {
        return controllerResult(failedClosed
          ? failedOutcome
          : publicCreateProjectResult("unavailable"));
      }
      operationPending = true;
      const failClosed = (state: WorkbenchCreateProjectState) => {
        failedOutcome = terminalOutcome(state);
        failedClosed = true;
        return controllerResult(failedOutcome);
      };
      const work = runCreateProject(
        options,
        () => closed || failedClosed,
        failClosed,
        terminalResult,
        selectedTargets,
      );
      try {
        return await Promise.race([work, terminalResult]);
      } finally {
        operationPending = false;
        selectedTargets.clear();
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
        settleTerminal(controllerResult(result));
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
  ) => WorkbenchCreateProjectControllerResult,
  terminalResult: Promise<WorkbenchCreateProjectControllerResult>,
  selectedTargets: Map<number, string>,
): Promise<WorkbenchCreateProjectControllerResult> {
  let diagnostic: WorkbenchCreateProjectFailureDiagnostic | undefined;
  let state = options.stateStore.state;
  if (state.active === null) {
    const accepted = transitionWorkbenchCreateProject(state, {
      kind: "renderer-create-intent",
    });
    if (!accepted.applied || !(await safeWrite(options.stateStore, accepted.state))) {
      return controllerResult(
        accepted.publicResults[0] ?? publicCreateProjectResult("unavailable"),
      );
    }
    state = accepted.state;
  }

  while (!isTerminal()) {
    state = options.stateStore.state;
    const active = state.active;
    if (active === null) return controllerResult(publicCreateProjectResult("unavailable"));
    if (active.phase === "response-ready") {
      const delivered = transitionWorkbenchCreateProject(state, {
        kind: "deliver-result",
        operationNumber: active.operationNumber,
      });
      if (!delivered.applied) {
        return controllerResult(
          delivered.publicResults[0] ?? publicCreateProjectResult("unavailable"),
        );
      }
      if (!(await safeWrite(options.stateStore, delivered.state))) {
        return active.createCommitted
          ? failClosed(state)
          : controllerResult(terminalOutcome(state));
      }
      const result = delivered.publicResults[0] ??
        publicCreateProjectResult("unavailable");
      return controllerResult(
        result,
        result.outcome === "unavailable" ? diagnostic : undefined,
      );
    }

    const effectKind = readyEffect(active.phase);
    if (effectKind === null) return controllerResult(publicCreateProjectResult("unavailable"));
    const claimed = transitionWorkbenchCreateProject(state, {
      kind: "claim-effect",
      operationNumber: active.operationNumber,
      effectKind,
    });
    if (!claimed.applied || claimed.effects.length !== 1) {
      return active.createCommitted
        ? failClosed(state)
          : controllerResult(publicCreateProjectResult("unavailable"));
    }
    if (!(await safeWrite(options.stateStore, claimed.state))) {
      return active.createCommitted
        ? failClosed(state)
          : controllerResult(publicCreateProjectResult("unavailable"));
    }
    if (isTerminal()) return controllerResult(terminalOutcome(claimed.state));

    const effect = claimed.effects[0]!;
    const selectedTargetPath = selectedTargets.get(effect.operationNumber);
    const execution = await executeEffect(options, effect, selectedTargetPath);
    if (execution.selectedTargetPath !== undefined) {
      selectedTargets.set(effect.operationNumber, execution.selectedTargetPath);
    }
    if (isTerminal()) return controllerResult(terminalOutcome(claimed.state));
    const recorded = transitionWorkbenchCreateProject(
      options.stateStore.state,
      execution.event,
    );
    if (!recorded.applied) {
      return effect.kind === "choose-save-target"
        ? controllerResult(publicCreateProjectResult("unavailable"))
        : failClosed(claimed.state);
    }
    if (!(await safeWrite(options.stateStore, recorded.state))) {
      return effect.kind === "choose-save-target"
        ? controllerResult(publicCreateProjectResult("unavailable"))
        : failClosed(claimed.state);
    }
    if (effect.kind === "create-if-absent") {
      diagnostic = createFailureDiagnostic(
        selectedTargetPath ?? "",
        recorded.state.active?.createResult,
      );
    }
  }
  return terminalResult;
}

async function executeEffect(
  options: WorkbenchCreateProjectControllerOptions,
  effect: WorkbenchCreateProjectEffect,
  selectedTargetPath: string | undefined,
): Promise<WorkbenchCreateProjectEffectExecution> {
  if (effect.kind === "choose-save-target") {
    let nativeValue: unknown;
    try {
      nativeValue = await options.chooser.chooseProjectTarget();
    } catch {
      return { event: chooserResult(effect.operationNumber, "failed", null) };
    }
    return decodeChooserResult(effect.operationNumber, nativeValue);
  }
  if (effect.kind === "create-if-absent") {
    let result: string;
    try {
      result = selectedTargetPath === undefined
        ? "create-failed-known-no-commit"
        : await options.filesystem.createIfAbsent(selectedTargetPath);
    } catch {
      result = "unknown";
    }
    return { event: { kind: "create-result", operationNumber: effect.operationNumber, result } };
  }

  let result: WorkbenchCreateProjectRegistrationResult = "unknown";
  try {
    if (selectedTargetPath === undefined) {
      return {
        event: {
          kind: "registration-result",
          operationNumber: effect.operationNumber,
          result,
        },
      };
    }
    const hostResult = await options.host.registerTrustedProject(selectedTargetPath);
    if (isCommittedHostResult(hostResult)) {
      result = "committed";
    } else {
      result = classifyKnownNoCommitHostResult(hostResult) ?? "unknown";
    }
  } catch {
    result = "unknown";
  }
  return {
    event: {
      kind: "registration-result",
      operationNumber: effect.operationNumber,
      result,
    },
  };
}

function decodeChooserResult(
  operationNumber: number,
  value: unknown,
): WorkbenchCreateProjectEffectExecution {
  try {
    if (!hasExactDataProperties(value, ["canceled", "filePath"])) {
      throw new Error("malformed-native-result");
    }
    const result = value as { readonly canceled: unknown; readonly filePath: unknown };
    if (result.canceled === true && result.filePath === "") {
      return { event: chooserResult(operationNumber, "cancelled", null) };
    }
    if (
      result.canceled === false &&
      isSafeAbsoluteTarget(result.filePath)
    ) {
      const targetPath = normalize(result.filePath);
      return {
        event: chooserResult(
          operationNumber,
          "selected",
          createWorkbenchCreateProjectTargetToken(targetPath),
        ),
        selectedTargetPath: targetPath,
      };
    }
  } catch {
    // Malformed, accessor-like, and proxy values are normalized below.
  }
  return { event: chooserResult(operationNumber, "malformed", null) };
}

function chooserResult(
  operationNumber: number,
  result: "selected" | "cancelled" | "failed" | "malformed",
  targetToken: string | null,
): Record<string, unknown> {
  return {
    kind: "chooser-result",
    operationNumber,
    result,
    targetToken,
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

function controllerResult(
  result: WorkbenchCreateProjectResult,
  diagnostic?: WorkbenchCreateProjectFailureDiagnostic,
): WorkbenchCreateProjectControllerResult {
  if (diagnostic === undefined) return result;
  const privateResult = { outcome: result.outcome };
  Object.defineProperty(privateResult, "diagnostic", {
    value: diagnostic,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(privateResult);
}

function createFailureDiagnostic(
  targetPath: string,
  result: WorkbenchCreateProjectCreateResult | null | undefined,
): WorkbenchCreateProjectFailureDiagnostic | undefined {
  if (
    targetPath === "" ||
    result === undefined ||
    result === null ||
    result === "created"
  ) {
    return undefined;
  }
  return Object.freeze({ reason: result, targetPath });
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
