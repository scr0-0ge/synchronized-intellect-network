import {
  publicHostedProjectFailure,
  type WorkbenchHostedProjectListener,
} from "../contract.ts";
import type { WorkbenchRendererTransferBridge } from "../preload-bridge.ts";
import { createWorkbenchProjectTransferDecoder } from "../result-sanitizer.ts";

/** Reconstructs the complete immutable view on the renderer side of contextBridge. */
export function observeWorkbenchProjectTransfers(
  bridge: Pick<WorkbenchRendererTransferBridge, "observeProject">,
  listener: WorkbenchHostedProjectListener,
): () => void {
  let active = true;
  let observation = 0;
  let disposeCurrent: (() => void) | undefined;
  let decode = createWorkbenchProjectTransferDecoder();
  let recoveryQueued = false;

  const subscribe = (): void => {
    const ownObservation = ++observation;
    const dispose = bridge.observeProject(transfer => {
      if (!active || ownObservation !== observation) return;
      const result = decode(transfer);
      if (result !== undefined) {
        recoveryQueued = false;
        listener(result);
        return;
      }
      if (recoveryQueued) return;
      recoveryQueued = true;
      console.warn(
        "Renderer Project transfer mismatch; requesting a full snapshot.",
      );
      listener(publicHostedProjectFailure());
      queueMicrotask(() => {
        if (!active || ownObservation !== observation) return;
        observation += 1;
        disposeCurrent?.();
        decode = createWorkbenchProjectTransferDecoder();
        recoveryQueued = false;
        subscribe();
      });
    });
    if (!active || ownObservation !== observation) {
      dispose();
      return;
    }
    disposeCurrent = dispose;
  };

  subscribe();
  return () => {
    if (!active) return;
    active = false;
    observation += 1;
    disposeCurrent?.();
    disposeCurrent = undefined;
  };
}
