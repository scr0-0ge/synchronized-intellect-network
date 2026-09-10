import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import {
  historyRecoveryProblem,
  type HistoryRecoveryActionResult,
  type HistoryRecoveryRendererBridge,
  type HistoryRecoverySnapshot,
  type HistoryRecoverySnapshotResult,
} from "../../../src/workbench-shell/history-recovery-contract.ts";
import { HistoryRecoverySettingsCard } from "../../../src/workbench-shell/renderer/history-recovery-settings.tsx";

const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "success";
const counts = Object.freeze({ projects: 1, sessions: 2, commands: 3, updates: 4 });

const availableSnapshot: HistoryRecoverySnapshot = Object.freeze({
  snapshotKey: "snapshot-available",
  attention: true,
  library: Object.freeze({
    libraryKey: "library-1",
    label: "Historical Recovery Library",
    generationCount: 0,
  }),
  sources: Object.freeze([
    Object.freeze({
      sourceKey: "historical-source-1",
      label: "Historical store 1",
      role: "historical",
      state: "available",
      action: "preserve",
      counts,
    }),
  ]),
});

const cleanSnapshot: HistoryRecoverySnapshot = Object.freeze({
  snapshotKey: "snapshot-clean",
  attention: false,
  library: Object.freeze({
    libraryKey: "library-1",
    label: "Historical Recovery Library",
    generationCount: 0,
  }),
  sources: Object.freeze([]),
});

const unavailableSnapshot: HistoryRecoverySnapshot = Object.freeze({
  snapshotKey: "snapshot-unavailable-source",
  attention: true,
  library: Object.freeze({
    libraryKey: "library-1",
    label: "Historical Recovery Library",
    generationCount: 0,
  }),
  sources: Object.freeze([
    Object.freeze({
      sourceKey: "historical-source-1",
      label: "Historical store 1",
      role: "historical",
      state: "unavailable",
      action: "none",
      counts: null,
    }),
  ]),
});

const preservedSnapshot: HistoryRecoverySnapshot = Object.freeze({
  snapshotKey: "snapshot-preserved",
  attention: false,
  library: Object.freeze({
    libraryKey: "library-1",
    label: "Historical Recovery Library",
    generationCount: 1,
  }),
  sources: Object.freeze([
    Object.freeze({
      sourceKey: "historical-source-1",
      label: "Historical store 1",
      role: "historical",
      state: "preserved",
      action: "none",
      counts,
    }),
  ]),
});

const initialResult: HistoryRecoverySnapshotResult = Object.freeze({
  version: 1,
  kind: "snapshot",
  requestKey: "snapshot-request-1",
  status: "ready",
  snapshot: scenario === "clean"
    ? cleanSnapshot
    : scenario === "permission-denied"
      ? unavailableSnapshot
      : availableSnapshot,
});

const libraryUnavailableResult: HistoryRecoverySnapshotResult = Object.freeze({
  version: 1,
  kind: "snapshot",
  requestKey: "snapshot-request-library-unavailable",
  status: "unavailable",
  problem: historyRecoveryProblem("library-unavailable"),
});

const [result, setResult] = createSignal(
  scenario === "library-unavailable" ? libraryUnavailableResult : initialResult,
);

const bridge: Partial<HistoryRecoveryRendererBridge> = Object.freeze({
  async browse(request) {
    return Object.freeze({
      version: 1 as const,
      kind: "browse" as const,
      requestKey: request.requestKey,
      status: "ready" as const,
      snapshotKey: request.snapshotKey,
      branch: request.kind,
      parentKey:
        request.kind === "generations"
          ? request.libraryKey
          : request.kind === "projects"
            ? request.generationKey
            : request.kind === "sessions"
              ? request.projectKey
              : request.sessionKey,
      page: Object.freeze({
        after: request.page.after,
        nextAfter: null,
        totalCount: 0,
        items: Object.freeze([]),
      }),
    });
  },
  async perform(request): Promise<HistoryRecoveryActionResult> {
    if (request.action !== "preserve") {
      throw new Error("The probe only supports preserve.");
    }
    const calls = Number(document.documentElement.dataset.preserveCalls ?? "0");
    document.documentElement.dataset.preserveCalls = String(calls + 1);
    if (scenario === "rejected") {
      throw new Error("C:\\Users\\owner\\AppData\\private-history.sqlite");
    }
    if (scenario === "failure") {
      return Object.freeze({
        version: 1,
        action: "preserve",
        requestKey: request.requestKey,
        operationKey: request.operationKey,
        status: "failed",
        problem: historyRecoveryProblem("verification-failed"),
      });
    }
    return Object.freeze({
      version: 1,
      action: "preserve",
      requestKey: request.requestKey,
      operationKey: request.operationKey,
      status: "preserved",
      snapshot: preservedSnapshot,
      generation: Object.freeze({
        ordinal: 1,
        label: "Recovery 1",
        generationKey: "generation-1",
        counts,
      }),
      cleanup: "complete",
    });
  },
});

render(
  () => (
    <HistoryRecoverySettingsCard
      bridge={bridge}
      result={result()}
      onSnapshot={setResult}
      onRefresh={() => undefined}
    />
  ),
  document.querySelector("#root")!,
);
