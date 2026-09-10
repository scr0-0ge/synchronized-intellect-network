import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkbenchHostedProjectResult,
  WorkbenchProjectTransfer,
  WorkbenchSessionProfileProjection,
  WorkbenchTurnView,
} from "../../src/workbench-shell/contract.ts";
import type {
  WorkbenchProjectTransferListener,
  WorkbenchRendererTransferBridge,
} from "../../src/workbench-shell/preload-bridge.ts";
import { observeWorkbenchProjectTransfers } from "../../src/workbench-shell/renderer/project-transfer.ts";
import {
  createWorkbenchProjectTransferEncoder,
  sanitizeWorkbenchHostedProjectResult,
} from "../../src/workbench-shell/result-sanitizer.ts";

class FakeTransferBridge
  implements Pick<WorkbenchRendererTransferBridge, "observeProject">
{
  readonly listeners = new Set<WorkbenchProjectTransferListener>();
  observeCalls = 0;
  disposeCalls = 0;

  observeProject(listener: WorkbenchProjectTransferListener): () => void {
    this.observeCalls += 1;
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.disposeCalls += 1;
      this.listeners.delete(listener);
    };
  }

  emit(transfer: unknown): void {
    for (const listener of [...this.listeners]) {
      listener(structuredClone(transfer) as WorkbenchProjectTransfer);
    }
  }
}

const profile: WorkbenchSessionProfileProjection = Object.freeze({
  requested: Object.freeze({
    kind: "recorded" as const,
    runtimeFamilyLabel: "Codex",
    endpointLabel: "Codex desktop",
    modelLabel: "Solution 5.6",
    workIntensityControlLabel: Object.freeze({
      label: "Reasoning",
      provenance: "runtime-catalog" as const,
    }),
    workIntensityLabel: "Maximum",
    executionModeLabel: "Single agent",
    accessModeLabel: "Full access",
  }),
  effective: Object.freeze({ kind: "unknown" as const }),
});

function turn(text: string): WorkbenchTurnView {
  return Object.freeze({
    profile,
    timeline: Object.freeze([
      Object.freeze({ kind: "user-message" as const, text }),
      Object.freeze({
        kind: "turn-completed" as const,
        status: "completed" as const,
      }),
    ]),
  });
}

function result(
  turns: readonly WorkbenchTurnView[],
): WorkbenchHostedProjectResult {
  return sanitizeWorkbenchHostedProjectResult({
    ok: true,
    view: {
      project: { label: "Atlas Fieldnotes" },
      observation: { cursor: turns.length, live: true },
      commands: [
        {
          key: "command-1",
          label: "Agent Session 01",
          runtime: "Codex",
          status: "completed",
          session: {
            profile,
            timeline: turns.flatMap(value => value.timeline),
            turns,
            archived: false,
            metadataKey:
              "session-metadata:00000000-0000-4000-8000-000000000703",
            removalKey:
              "session-removal:00000000-0000-4000-8000-000000000704",
            selectionKey:
              "session-selection:00000000-0000-4000-8000-000000000705",
            resumable: true,
          },
        },
      ],
      initialSelectionKey: "command-1",
      projectSelection: {
        projects: [
          {
            label: "Atlas Fieldnotes",
            availability: "available",
            selected: true,
            selectionKey:
              "project-selection:00000000-0000-4000-8000-000000000706",
          },
        ],
      },
    },
  });
}

test("renderer reconstructs every field and reuses immutable history from compact transfers", () => {
  const bridge = new FakeTransferBridge();
  const observed: WorkbenchHostedProjectResult[] = [];
  const dispose = observeWorkbenchProjectTransfers(bridge, value =>
    observed.push(value),
  );
  const encode = createWorkbenchProjectTransferEncoder();
  const first = result([turn("old history must cross only once")]);
  assert.ok(first.ok && "view" in first);
  const oldTurn = first.view.commands[0]!.session!.turns![0]!;
  const second = result([oldTurn, turn("new renderer delta")]);
  const snapshot = encode(first);
  const delta = encode(second);
  assert.equal(delta.kind, "delta");

  bridge.emit(snapshot);
  bridge.emit(delta);

  assert.deepEqual(observed, [first, second]);
  assert.ok(observed[0]!.ok && "view" in observed[0]);
  assert.ok(observed[1]!.ok && "view" in observed[1]);
  assert.strictEqual(
    observed[1].view.commands[0]!.session!.turns![0],
    observed[0].view.commands[0]!.session!.turns![0],
  );
  assert.equal(
    JSON.stringify(delta).includes("old history must cross only once"),
    false,
  );
  dispose();
  assert.equal(bridge.disposeCalls, 1);
});

test(
  "renderer mismatch shows unavailable and obtains a real fresh snapshot before resuming deltas",
  async t => {
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...values: unknown[]) =>
      warnings.push(values),
    );
    const bridge = new FakeTransferBridge();
    const observed: WorkbenchHostedProjectResult[] = [];
    const dispose = observeWorkbenchProjectTransfers(bridge, value =>
      observed.push(value),
    );
    t.after(dispose);

    const initialEncoder = createWorkbenchProjectTransferEncoder();
    const initial = result([turn("initial")]);
    bridge.emit(initialEncoder(initial));
    const invalid = structuredClone(initialEncoder(initial)) as Record<
      string,
      unknown
    >;
    invalid.extra = true;
    bridge.emit(invalid);
    bridge.emit(invalid);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(observed.at(-1)?.ok, false);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /requesting a full snapshot/);
    assert.equal(bridge.observeCalls, 2);
    assert.equal(bridge.disposeCalls, 1);

    const recoveredEncoder = createWorkbenchProjectTransferEncoder();
    const recovered = result([turn("recovered full")]);
    assert.ok(recovered.ok && "view" in recovered);
    const recoveredTurn = recovered.view.commands[0]!.session!.turns![0]!;
    const continued = result([recoveredTurn, turn("after recovery")]);
    bridge.emit(recoveredEncoder(recovered));
    bridge.emit(recoveredEncoder(continued));

    assert.deepEqual(observed.slice(-2), [recovered, continued]);
  },
);
