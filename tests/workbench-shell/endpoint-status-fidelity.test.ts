import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkbenchPublicDirectSessionProfileResult,
  WorkbenchRuntimeEndpointDiscoveryCategory,
  WorkbenchRuntimeEndpointOption,
} from "../../src/workbench-shell/contract.ts";
import { publicRuntimeEndpointDiscovery } from "../../src/workbench-shell/contract.ts";
import {
  beginDirectSessionProfileLoad,
  completeDirectSessionProfileLoad,
  directEndpointStatusRows,
  initialRendererState,
} from "../../src/workbench-shell/renderer/view-model.ts";

test("endpoint status presentation keeps fixed order, exact copy, and ready-only catalogs", () => {
  const idleRows = directEndpointStatusRows(initialRendererState.profile);
  assert.deepEqual(
    idleRows.map((row) => [row.endpointId, row.statusLabel, row.endpoint]),
    [
      ["codex-desktop", "Not inspected", null],
      ["claude-code-desktop", "Not inspected", null],
    ],
  );

  const loading = beginDirectSessionProfileLoad(initialRendererState);
  assert.deepEqual(
    directEndpointStatusRows(loading.profile).map((row) => row.statusLabel),
    ["Not inspected", "Not inspected"],
  );

  const mixed = completeDirectSessionProfileLoad(
    loading,
    successfulResult(
      "runtime-not-located",
      "catalog-ready",
      [claudeEndpoint],
    ),
  );
  const mixedRows = directEndpointStatusRows(mixed.profile);
  assert.deepEqual(
    mixedRows.map((row) => ({
      endpointId: row.endpointId,
      endpointLabel: row.endpointLabel,
      statusLabel: row.statusLabel,
      selectableKey: row.endpoint?.key ?? null,
    })),
    [
      {
        endpointId: "codex-desktop",
        endpointLabel: "Codex desktop",
        statusLabel: "Runtime not located",
        selectableKey: null,
      },
      {
        endpointId: "claude-code-desktop",
        endpointLabel: "Claude Code desktop",
        statusLabel: "Catalog ready",
        selectableKey: "endpoint:claude",
      },
    ],
  );

  const categorized = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(initialRendererState),
    {
      ok: false,
      endpointDiscovery: publicRuntimeEndpointDiscovery(
        "authentication-required",
        "inspection-failed",
      ),
      error: {
        category: "profile-unavailable",
        message:
          "Codex Session Profile options are unavailable. Keep your draft and try again.",
      },
    },
  );
  const categorizedRows = directEndpointStatusRows(categorized.profile);
  assert.deepEqual(
    categorizedRows.map((row) => row.statusLabel),
    ["Authentication required", "Inspection failed"],
  );
  assert.equal(categorizedRows.some((row) => row.endpoint !== null), false);
  assert.equal(
    JSON.stringify(categorizedRows).includes("PRIVATE_NATIVE_ERROR"),
    false,
  );
});

test("endpoint status presentation never renders a contradictory ready claim", () => {
  const contradictory = {
    ...initialRendererState.profile,
    result: {
      ok: true,
      endpointDiscovery: publicRuntimeEndpointDiscovery(
        "catalog-ready",
        "not-inspected",
      ),
      profile: {
        snapshotKey: "snapshot:contradictory",
        endpoints: [],
        desiredDefault: { kind: "unavailable" },
      },
    } as WorkbenchPublicDirectSessionProfileResult,
  };

  assert.deepEqual(
    directEndpointStatusRows(contradictory).map((row) => row.statusLabel),
    ["Inspection failed", "Not inspected"],
  );
});

function successfulResult(
  codexCategory: WorkbenchRuntimeEndpointDiscoveryCategory,
  claudeCategory: Exclude<
    WorkbenchRuntimeEndpointDiscoveryCategory,
    "authentication-required"
  >,
  endpoints: readonly WorkbenchRuntimeEndpointOption[],
): WorkbenchPublicDirectSessionProfileResult {
  return {
    ok: true,
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      codexCategory,
      claudeCategory,
    ),
    profile: {
      snapshotKey: "snapshot:status-fidelity",
      endpoints,
      desiredDefault: { kind: "unavailable" },
    },
  };
}

const claudeEndpoint: WorkbenchRuntimeEndpointOption = Object.freeze({
  endpointId: "claude-code-desktop",
  key: "endpoint:claude",
  runtimeFamilyLabel: "Claude",
  endpointLabel: "Claude Code desktop",
  models: Object.freeze([]),
  executionModes: Object.freeze([]),
  accessModes: Object.freeze([]),
});
