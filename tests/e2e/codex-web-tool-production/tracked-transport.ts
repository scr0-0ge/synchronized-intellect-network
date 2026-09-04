import type {
  OfficialRuntimeTransport,
  OfficialRuntimeTransportFactory,
} from "../../../src/agent-runtime/codex/transport.ts";
import type { WorkbenchBackend } from "../../../src/workbench-shell/backend.ts";
import type {
  WorkbenchCommandView,
  WorkbenchProjectResult,
} from "../../../src/workbench-shell/contract.ts";

import {
  DriverFailure,
  isRecord,
  type ProtocolCounts,
} from "./contract.ts";

const maximumPublicTitleCodePoints = 300;
const c0OrC1ControlPattern = /[\u0000-\u001f\u007f-\u009f]/u;

const approvalProtocolMethods = new Set([
  "applyPatchApproval",
  "execCommandApproval",
  "item/autoApprovalReview/completed",
  "item/autoApprovalReview/started",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export type TransportMetrics = {
  created: number;
  stopped: number;
  stopFailures: number;
  readonly active: Set<OfficialRuntimeTransport>;
  readonly protocol: ProtocolCounts;
};

export type Observation = {
  readonly results: WorkbenchProjectResult[];
  waitFor(
    predicate: (result: WorkbenchProjectResult) => boolean,
  ): Promise<WorkbenchProjectResult>;
  dispose(): void;
  readonly disposed: boolean;
};

export function emptyProtocolCounts(): ProtocolCounts {
  return {
    itemStarted: 0,
    itemCompleted: 0,
    turnCompleted: 0,
    approvalRequests: 0,
    webSearchStarted: 0,
    webSearchCompleted: 0,
  };
}

export function createTrackedTransportFactory(
  metrics: TransportMetrics,
  createTransport: OfficialRuntimeTransportFactory,
): OfficialRuntimeTransportFactory {
  return async () => {
    const transport = await createTransport();
    metrics.created += 1;
    let stopResult: Promise<void> | undefined;
    const tracked: OfficialRuntimeTransport = {
      send: (line) => transport.send(line),
      async receive(): Promise<string | null> {
        const line = await transport.receive();
        if (line !== null) observeProtocolLine(line, metrics.protocol);
        return line;
      },
      stop(): Promise<void> {
        stopResult ??= (async () => {
          try {
            await transport.stop();
          } catch (error) {
            metrics.stopFailures += 1;
            throw error;
          } finally {
            metrics.stopped += 1;
            metrics.active.delete(tracked);
          }
        })();
        return stopResult;
      },
    };
    metrics.active.add(tracked);
    return tracked;
  };
}

function observeProtocolLine(line: string, counts: ProtocolCounts): void {
  try {
    const message = JSON.parse(line) as unknown;
    if (!isRecord(message) || typeof message.method !== "string") return;
    if (message.method === "item/started") counts.itemStarted += 1;
    if (message.method === "item/completed") counts.itemCompleted += 1;
    if (message.method === "turn/completed") counts.turnCompleted += 1;
    if (approvalProtocolMethods.has(message.method)) {
      counts.approvalRequests += 1;
    }
    if (
      (message.method === "item/started" ||
        message.method === "item/completed") &&
      isRecord(message.params) &&
      isRecord(message.params.item) &&
      message.params.item.type === "webSearch"
    ) {
      if (message.method === "item/started") counts.webSearchStarted += 1;
      else counts.webSearchCompleted += 1;
    }
  } catch {
    // The production Adapter receives the original line and remains authoritative.
  }
}

export async function stopTrackedTransports(
  metrics: TransportMetrics,
): Promise<void> {
  const results = await Promise.allSettled(
    [...metrics.active].map((transport) => transport.stop()),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw new DriverFailure("runtime-shutdown");
  }
}

export function observeWorkbench(
  backend: WorkbenchBackend,
  timeoutMilliseconds: number,
): Observation {
  const results: WorkbenchProjectResult[] = [];
  const waiters = new Set<{
    readonly predicate: (result: WorkbenchProjectResult) => boolean;
    readonly resolve: (result: WorkbenchProjectResult) => void;
    readonly reject: (error: DriverFailure) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();
  let disposed = false;
  const sourceDispose = backend.observeProject((result) => {
    if (disposed) return;
    results.push(result);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(result)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(result);
    }
  });

  return {
    results,
    waitFor(predicate) {
      const existing = results.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<WorkbenchProjectResult>((resolveWait, rejectWait) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          reject: rejectWait,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            rejectWait(new DriverFailure("terminal-outcome"));
          }, timeoutMilliseconds),
        };
        waiters.add(waiter);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sourceDispose();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new DriverFailure("terminal-outcome"));
      }
      waiters.clear();
    },
    get disposed() {
      return disposed;
    },
  };
}

export function correlatedTerminalCommand(
  result: WorkbenchProjectResult,
  initialKeys: ReadonlySet<string>,
): WorkbenchCommandView {
  if (!result.ok) throw new DriverFailure("terminal-outcome");
  const commands = result.view.commands.filter(
    (command) => !initialKeys.has(command.key),
  );
  if (commands.length !== 1) throw new DriverFailure("terminal-outcome");
  return commands[0]!;
}

export function parsePublicAnswer(
  text: string,
): Readonly<{ title: string; url: string }> {
  const lines = text.split("\n");
  if (lines.length !== 2 || lines.some((line) => line.includes("\r"))) {
    throw new DriverFailure("agent-message-invalid");
  }
  const titlePrefix = "TITLE: ";
  const urlPrefix = "URL: ";
  if (!lines[0]!.startsWith(titlePrefix) || !lines[1]!.startsWith(urlPrefix)) {
    throw new DriverFailure("agent-message-invalid");
  }
  const title = lines[0]!.slice(titlePrefix.length);
  const url = lines[1]!.slice(urlPrefix.length);
  if (
    title.length === 0 ||
    title.trim() !== title ||
    c0OrC1ControlPattern.test(title) ||
    Array.from(title).length > maximumPublicTitleCodePoints ||
    url.trim() !== url
  ) {
    throw new DriverFailure("agent-message-invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DriverFailure("agent-message-invalid");
  }
  if (
    parsed.origin !== "https://openai.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname === "/" ||
    parsed.href !== url
  ) {
    throw new DriverFailure("agent-message-invalid");
  }
  return Object.freeze({ title, url });
}
