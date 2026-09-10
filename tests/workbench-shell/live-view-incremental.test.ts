import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { gunzipSync } from "node:zlib";
import type { ProjectChannel, ProjectSnapshot } from "../../src/coordinator/index.ts";
import type { NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";
import { createWorkbenchCoordinator } from "../../src/coordinator/index.ts";
import type { WorkbenchProjectResult } from "../../src/workbench-shell/contract.ts";
import {
  createWorkbenchProjectTransferDecoder,
  createWorkbenchProjectTransferEncoder,
  createWorkbenchProjectTransferSanitizer,
  sanitizeWorkbenchHostedProjectResult,
} from "../../src/workbench-shell/result-sanitizer.ts";
import { createWorkbenchLiveView } from "../../src/workbench-shell/live-view.ts";
import { createTestDirectory, registerTestClosable } from "../helpers/test-lifecycle.ts";

// Identity of the W139 ledger's Project, not a filesystem destination. Only
// the decompressed test-owned SQLite copy below is written or opened as a file.
const recordedProjectDirectory = String.raw`C:\Users\test-user\worktrees\sample\test-results\w139\equivalence-root\project`;

async function openRecordedProject(t: TestContext) {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw141-ledger-"));
  const databasePath = join(root, "ledger.sqlite");
  await writeFile(databasePath, gunzipSync(await readFile(new URL("./fixtures/w141-sixty-turn-ledger.sqlite.gz", import.meta.url))));
  let replay: readonly NormalizedRuntimeEvent[] = [];
  const channel = await createWorkbenchCoordinator({ databasePath, adapter: {
    async inspect() { throw new Error("No catalog or provider call expected"); },
    async start() { throw new Error("Only continuation of recorded local-fake history is expected"); },
    async resume(request) {
      return { profile: request.profile, opaqueSessionReference: request.opaqueSessionReference,
        async send() {},
        effectiveProfile() { return request.profile; },
        async *events() {
          for (const event of replay) {
            // Replay the recorded normalized events, never run a provider.
            yield event;
            await new Promise(resolve => setImmediate(resolve));
          }
        },
      };
    },
  } }).openProject(recordedProjectDirectory);
  registerTestClosable(t, channel);
  const initial = await channel.snapshot();
  assert.equal(initial.commands.length, 60);
  assert.equal(initial.commands.reduce((sum, command) => sum + (command.session?.events.length ?? 0), 0), 1740);
  replay = initial.commands.at(-1)!.session!.events.filter((event): event is NormalizedRuntimeEvent => event.kind !== "user-message");
  return { channel, initial };
}

test("a new turn on the actual sixty-turn ledger does not rehydrate all history on each update", async t => {
  const { channel, initial } = await openRecordedProject(t);
  let fullReads = 0;
  const observedChannel = new Proxy(channel, { get(target, key) {
    if (key === "snapshot") return () => { fullReads += 1; return target.snapshot(); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as ProjectChannel;
  const live = createWorkbenchLiveView({ channel: observedChannel, projectDirectory: recordedProjectDirectory });
  registerTestClosable(t, live);
  let first!: (result: WorkbenchProjectResult) => void;
  const firstView = new Promise<WorkbenchProjectResult>(resolve => { first = resolve; });
  let finish!: (result: WorkbenchProjectResult) => void;
  const completed = new Promise<WorkbenchProjectResult>(resolve => { finish = resolve; });
  const dispose = live.observe(result => {
    first(result);
    if (!result.ok || (result.view.observation.cursor > initial.cursor && result.view.commands[0]?.status === "completed")) finish(result);
  });
  t.after(dispose);
  assert.equal((await firstView).ok, true);
  const session = initial.commands.at(-1)!.session!;
  await channel.act({ kind: "direct", commandKind: "continue", runtime: "codex", idempotencyKey: "w141-replay-next-turn",
    input: "W141 next local-fake turn", targetSessionId: session.sessionId, profile: session.profile,
    runtimeResumeIdentity: { schemaVersion: 1, endpointId: "codex-desktop", nativeProfile: session.profile },
  }, { endpointId: "codex-desktop" });
  const result = await completed;
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.view.commands[0]?.session?.turns?.length, 61);
  assert.equal(fullReads, 1, "only the initial subscription should read the complete Project history");
  const renamed = await channel.mutateSessionMetadata({ sessionId: session.sessionId,
    operation: { kind: "rename", displayName: "Renamed recorded Session" } });
  assert.equal(renamed.status, "renamed");
  await live.refreshAfterSessionMutation();
  assert.equal(fullReads, 2, "same-cursor metadata mutation explicitly refreshes the base");
  const nextCompleted = new Promise<WorkbenchProjectResult>(resolve => { finish = resolve; });
  await channel.act({ kind: "direct", commandKind: "continue", runtime: "codex", idempotencyKey: "w141-after-rename",
    input: "W141 keep the renamed Session", targetSessionId: session.sessionId, profile: session.profile,
    runtimeResumeIdentity: { schemaVersion: 1, endpointId: "codex-desktop", nativeProfile: session.profile },
  }, { endpointId: "codex-desktop" });
  const next = await nextCompleted;
  assert.ok(next.ok);
  assert.equal(next.view.commands[0]?.label, "Renamed recorded Session");
  assert.equal(next.view.commands[0]?.session?.turns?.length, 62);
  assert.equal(fullReads, 2, "incremental updates continue from the refreshed metadata base");
});

for (const mismatch of [false, true]) {
  test(`sixty-turn incremental projection equals every cold full field${mismatch ? " after real mismatch recovery" : ""}`, async t => {
    const { channel, initial } = await openRecordedProject(t);
    const uuid = crypto.randomUUID;
    let entropy: ReturnType<typeof crypto.randomUUID>[] = [];
    let replayEntropy: ReturnType<typeof crypto.randomUUID>[] | undefined;
    t.mock.method(crypto, "randomUUID", () => {
      if (replayEntropy !== undefined) {
        const next = replayEntropy.shift();
        assert.ok(next, "cold full projection must consume exactly the same capability entropy");
        return next;
      }
      const next = uuid();
      entropy.push(next);
      return next;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
    let fullReads = 0;
    let changeReads = 0;
    let oracleSnapshot: ProjectSnapshot = initial;
    let checks = Promise.resolve();
    let failure: unknown;
    const observed = new Proxy(channel, { get(target, key) {
      if (key === "snapshot") return async () => {
        await checks;
        fullReads += 1;
        oracleSnapshot = await target.snapshot();
        entropy = [];
        return oracleSnapshot;
      };
      if (key === "snapshotChanges") return async (after: number) => {
        await checks;
        changeReads += 1;
        // Both SQLite reads execute synchronously before either promise is awaited.
        const changes = target.snapshotChanges!(after);
        const full = target.snapshot();
        const delta = await changes;
        oracleSnapshot = await full;
        assert.equal(delta.cursor, oracleSnapshot.cursor);
        entropy = [];
        return mismatch && changeReads === 1 ? { ...delta, after: after - 1 } : delta;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as ProjectChannel;
    const live = createWorkbenchLiveView({ channel: observed, projectDirectory: recordedProjectDirectory });
    registerTestClosable(t, live);
    let ready!: () => void;
    const first = new Promise<void>(resolve => { ready = resolve; });
    let done!: () => void;
    const finished = new Promise<void>(resolve => { done = resolve; });
    let compared = 0;
    let fullBytes = 0;
    let largestDelta = 0;
    let largestRendererDelta = 0;
    const encode = createWorkbenchProjectTransferEncoder();
    const sanitizeTransfer = createWorkbenchProjectTransferSanitizer();
    const decodeInRenderer = createWorkbenchProjectTransferDecoder();
    const dispose = live.observe(result => {
      const recordedEntropy = [...entropy];
      const snapshot = oracleSnapshot;
      checks = (async () => {
        assert.equal(result.ok, true);
        assert.ok(result.ok);
        const hosted = { ok: true as const, view: { ...result.view, projectSelection: { projects: [{
          label: result.view.project.label, availability: "available" as const, selected: true,
          selectionKey: "project-selection:00000000-0000-4000-8000-000000000021",
        }] } } };
        const packet = encode(hosted);
        const wire = JSON.stringify(packet);
        if (packet.kind === "snapshot") fullBytes = Buffer.byteLength(wire);
        else {
          largestDelta = Math.max(largestDelta, Buffer.byteLength(wire));
          assert.ok(packet.view.commands.flatMap(command => command.session?.turns ?? []).filter(turn => "reuse" in turn).length >= 60);
        }
        const preloadTransfer = sanitizeTransfer(JSON.parse(wire));
        assert.notEqual(preloadTransfer, undefined, "preload validates the compact transfer");
        const rendererWire = JSON.stringify(preloadTransfer);
        if (packet.kind === "delta") {
          largestRendererDelta = Math.max(
            largestRendererDelta,
            Buffer.byteLength(rendererWire),
          );
        }
        const rendererResult = decodeInRenderer(
          JSON.parse(rendererWire),
        );
        assert.deepEqual(
          rendererResult,
          sanitizeWorkbenchHostedProjectResult(hosted),
          "renderer reconstructs every public field after contextBridge",
        );
        const coldChannel = new Proxy(channel, { get(target, key) {
          if (key === "snapshot") return async () => snapshot;
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        } }) as ProjectChannel;
        const cold = createWorkbenchLiveView({ channel: coldChannel, projectDirectory: recordedProjectDirectory });
        replayEntropy = recordedEntropy;
        let cancel!: () => void;
        try {
          const full = await new Promise<WorkbenchProjectResult>(resolve => {
            cancel = cold.observe(value => { cancel(); resolve(value); });
          });
          assert.deepEqual(result, full, `all public fields at cursor ${snapshot.cursor}`);
          assert.equal(replayEntropy.length, 0);
          compared += 1;
        } finally { replayEntropy = undefined; await cold.close(); }
      })().catch(error => { failure = error; done(); }).finally(() => {
        ready();
        if (result.ok && result.view.observation.cursor > initial.cursor && result.view.commands[0]?.status === "completed") done();
      });
    });
    t.after(dispose);
    await first;
    if (failure) throw failure;
    const session = initial.commands.at(-1)!.session!;
    await channel.act({ kind: "direct", commandKind: "continue", runtime: "codex", idempotencyKey: "w141-equivalence",
      input: "W141 recorded local continuation", targetSessionId: session.sessionId, profile: session.profile,
      profileProjection: { version: 1, requested: {
        kind: "recorded", runtimeFamilyLabel: "Codex", endpointLabel: "Codex desktop", modelLabel: "Recorded local model",
        workIntensityControlLabel: { label: "Reasoning", provenance: "runtime-catalog" },
        workIntensityLabel: "High", executionModeLabel: "Single agent", accessModeLabel: "Full access",
      } },
      runtimeResumeIdentity: { schemaVersion: 1, endpointId: "codex-desktop", nativeProfile: session.profile },
    }, { endpointId: "codex-desktop" });
    await finished;
    await checks;
    if (failure) throw failure;
    assert.ok(compared > 3, "compare accepted, running, runtime events and terminal views");
    assert.equal(fullReads, mismatch ? 2 : 1);
    assert.equal(warnings.length, mismatch ? 1 : 0);
    if (mismatch) assert.match(String(warnings[0]), /mismatch; reloading the full snapshot/);
    assert.ok(changeReads > 2, "deltas continue after recovery");
    assert.ok(largestDelta < fullBytes / 10, `${largestDelta} delta bytes vs ${fullBytes} first full bytes`);
    assert.ok(
      largestRendererDelta < fullBytes / 10,
      `${largestRendererDelta} contextBridge delta bytes vs ${fullBytes} first full bytes`,
    );
    t.diagnostic(`compared ${compared} full/incremental views; first wire ${fullBytes} bytes; largest main/preload delta ${largestDelta} bytes; largest contextBridge delta ${largestRendererDelta} bytes`);
  });
}
