import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import type { NormalizedRuntimeEvent, ResumableAgentRuntimeAdapter, SessionProfile } from "../../src/agent-runtime/index.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import { createWorkLedgerAuthGenerationModule } from "../../src/coordinator/work-ledger-auth-generation.ts";
import { createWorkbenchProjectTransferEncoder, createWorkbenchProjectTransferSanitizer, createWorkbenchProjectTransferDecoder } from "../../src/workbench-shell/result-sanitizer.ts";
import type { WorkbenchCatalogDefaultProfileResult, WorkbenchDirectInputRequest, WorkbenchProjectResult } from "../../src/workbench-shell/contract.ts";

test("composer-authored automatic continuation completes exactly the bounded steps with durable visible authorship", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-auto-continue-"));
  const projectDirectory = join(root, "project");
  const databasePath = join(root, "ledger.sqlite");
  await mkdir(projectDirectory);
  const sent: string[] = [];
  const binding = (profile: SessionProfile) => ({
    profile, opaqueSessionReference: "auto-continue-reference",
    async send(input: { text: string }) { sent.push(input.text); },
    async *events(): AsyncIterable<NormalizedRuntimeEvent> {
      yield { kind: "turn-started" };
      yield { kind: "agent-message", text: "One verified step finished. Next step is ready." };
      yield { kind: "turn-completed", status: "completed" };
    },
  });
  const adapter: ResumableAgentRuntimeAdapter = {
    async inspect() {
      return {
        runtime: "codex", models: [{ id: "gpt-5.6-sol", effortLevels: ["ultra"] }],
        executionModes: ["single-agent"], accessModes: ["full-access"],
      };
    },
    async start(request) { return binding(request.profile); },
    async resume(request) { return binding(request.profile); },
  };
  let backend = await createWorkbenchBackend({ projectDirectory, databasePath, adapter });
  t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
  let view: WorkbenchProjectResult | undefined;
  const currentView = () => view;
  backend.observeProject((result) => { view = result; });
  const profile = await backend.loadDirectSessionProfile();
  assert.equal((await backend.submitDirectInput(startRequest(profile, "/auto-continue 3\nDo the next verified step."))).ok, true);
  await waitFor(() => sent.length >= 1);
  assert.equal(sent[0], "Do the next verified step.");
  await waitFor(() => !!view?.ok && view.view.commands[0]?.session?.turns?.length === 3 && view.view.commands[0]?.status === "completed");
  const expected = [1, 2, 3].map(() => "Do the next verified step.");
  assert.deepEqual(sent, expected);
  assert.ok(view?.ok);
  const terminal = view;
  assert.equal(terminal.view.commands.length, 1, "all steps continue the same Session");
  assert.equal(terminal.view.commands[0]?.label, "Do the next verified step.",
    "the rail label derives from the user's own instruction, not a step-count marker");
  assert.deepEqual(terminal.view.commands[0]?.session?.turns?.map((turn) => turn.timeline[0]), expected.map((text) => ({ kind: "user-message", text })));
  await backend.loadDirectSessionProfile();
  await delay(0);
  assert.equal(sent.length, 3, "reaching the limit never schedules a fourth turn");
  await backend.close();
  view = undefined;
  backend = await createWorkbenchBackend({ projectDirectory, databasePath, adapter });
  backend.observeProject((result) => { view = result; });
  await waitFor(() => !!view?.ok && view.view.commands[0]?.session?.turns?.length === 3);
  const reopened = currentView();
  assert.ok(reopened?.ok);
  assert.deepEqual(reopened.view.commands[0]?.session?.turns, terminal.view.commands[0]?.session?.turns,
    "readback keeps every automatic step and terminal result");
  assert.equal(sent.length, 3, "opening stored history never restarts automation");
});

function startRequest(result: WorkbenchCatalogDefaultProfileResult, input: string): WorkbenchDirectInputRequest {
  assert.ok(result.ok && result.profile.desiredDefault.kind === "resolved");
  return {
    kind: "start", input, snapshotKey: result.profile.snapshotKey,
    endpointKey: result.profile.desiredDefault.endpointKey,
    modelKey: result.profile.desiredDefault.modelKey,
    workIntensityKey: result.profile.desiredDefault.workIntensityKey,
    executionModeKey: result.profile.desiredDefault.executionModeKey,
    accessModeKey: result.profile.desiredDefault.accessModeKey,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "expected product state before deadline");
    await delay(5);
  }
}

type Outcome = "completed" | "failed" | "interrupted" | "unknown-confirmed" | "unknown-unconfirmed";

async function controlledBackend(t: TestContext, options: { outcome?: Outcome; heldStep?: number; observeAuthentication?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "uaw-auto-control-"));
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory);
  const sent: string[] = [];
  const steered: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let unknown = false;
  const binding = (profile: SessionProfile) => {
    let step = 0;
    let interrupted = false;
    return {
      profile, opaqueSessionReference: "controlled-continuation",
      async send(input: { text: string }) { sent.push(input.text); step = sent.length; },
      steerAvailability: () => "available" as const,
      async steer(input: { text: string }) { steered.push(input.text); },
      interruptAvailability: () => "available" as const,
      async interrupt() { interrupted = true; release(); },
      close() { release(); },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        if (step === 0) return; // A fresh resume probe must not execute a turn.
        yield { kind: "turn-started" };
        if (step === options.heldStep) await held;
        const outcome = interrupted ? "interrupted" : step === 2 ? options.outcome : "completed";
        if (outcome?.startsWith("unknown")) { unknown = true; throw new Error("app-events-unavailable"); }
        if (outcome === "failed") yield { kind: "failed", category: "turn-failed" };
        else if (outcome === "interrupted") yield { kind: "turn-interrupted", status: "interrupted" };
        else {
          yield { kind: "agent-message", text: "Step summary: verified one change." };
          yield { kind: "turn-completed", status: "completed" };
        }
      },
    };
  };
  const adapter: ResumableAgentRuntimeAdapter = {
    async inspect() {
      return { runtime: "codex", models: [{ id: "gpt-5.6-sol", effortLevels: ["ultra"] }],
        executionModes: ["single-agent"], accessModes: ["full-access"] };
    },
    async start(request) { return binding(request.profile); },
    async resume(request) {
      if (unknown && options.outcome === "unknown-unconfirmed") throw new Error("cli-resume-refused");
      return binding(request.profile);
    },
  };
  const authGeneration = options.observeAuthentication ? createWorkLedgerAuthGenerationModule({ dataDirectory: root }) : undefined;
  authGeneration?.observeEndpointAuthentication({ endpointId: "codex-desktop", state: "bound" });
  const backend = await createWorkbenchBackend({ projectDirectory, databasePath: join(root, "ledger.sqlite"), adapter, authGeneration });
  t.after(async () => { release(); await backend.close(); await rm(root, { recursive: true, force: true }); });
  let latest: WorkbenchProjectResult | undefined;
  backend.observeProject((result) => { latest = result; });
  return { backend, sent, steered, release, authGeneration,
    command: () => latest?.ok ? latest.view.commands[0] : undefined,
    async start(input: string) { return backend.submitDirectInput(startRequest(await backend.loadDirectSessionProfile(), input)); },
  };
}

for (const outcome of ["failed", "interrupted", "unknown-confirmed", "unknown-unconfirmed"] as const) {
  test(`automatic step 2 ${outcome} stops step 3 and keeps the cause visible`, async (t) => {
    const fixture = await controlledBackend(t, { outcome });
    assert.equal((await fixture.start("/auto-continue 4\nDo one next step and summarize it.")).ok, true);
    const terminal = outcome.startsWith("unknown") ? "recovery-required" : "failed";
    await waitFor(() => fixture.command()?.status === terminal);
    await waitFor(() => fixture.command()?.continuationStop?.reason === "turn-not-completed");
    assert.equal(fixture.sent.length, 2);
    const turn = fixture.command()?.session?.turns?.[1];
    assert.deepEqual(turn?.timeline[0], { kind: "user-message", text: "Do one next step and summarize it." });
    if (outcome === "failed") assert.ok(turn?.timeline.some((event) => event.kind === "failed" && event.category === "turn-failed"));
    if (outcome === "interrupted") assert.ok(turn?.timeline.some((event) => event.kind === "turn-interrupted"));
    if (outcome.startsWith("unknown")) assert.equal(turn?.recovery?.resume, outcome === "unknown-confirmed" ? "confirmed" : "unconfirmed");
    assert.equal(fixture.command()?.session?.resumable, outcome === "interrupted" || outcome === "unknown-confirmed");
    await fixture.backend.loadDirectSessionProfile();
    await delay(0);
    assert.equal(fixture.sent.length, 2, "neither catalog refresh nor resume confirmation restarts automation");

    if (outcome === "unknown-confirmed" || outcome === "interrupted") {
      const selectionKey = fixture.command()?.session?.selectionKey;
      assert.ok(selectionKey);
      const loaded = await fixture.backend.loadDirectSessionProfile({ kind: "continuation-session", selectionKey });
      assert.ok(loaded.ok && loaded.profile.continuationPrefill?.kind === "resolved");
      const p = loaded.profile.continuationPrefill;
      assert.equal((await fixture.backend.submitDirectInput({
        kind: "continue", selectionKey, snapshotKey: loaded.profile.snapshotKey,
        endpointKey: p.endpointKey, modelKey: p.modelKey, workIntensityKey: p.workIntensityKey,
        executionModeKey: p.executionModeKey, accessModeKey: p.accessModeKey, input: "Human chooses to resume.",
      })).ok, true);
      await waitFor(() => fixture.command()?.status === "completed");
      assert.equal(fixture.command()?.continuationStop, undefined, "a new human turn does not inherit the previous plan stop");
      assert.equal(fixture.sent[2], "Human chooses to resume.");
      assert.equal(fixture.sent.length, 3);
      if (outcome === "unknown-confirmed") assert.equal(fixture.command()?.session?.turns?.[1]?.recovery?.resume, "confirmed",
        "later human success preserves the earlier unknown outcome");
    }
  });
}

for (const takeover of ["steer", "interrupt", "composer"] as const) {
  test(`human ${takeover} takes over an active automatic plan without waiting for its terminal`, async (t) => {
    const fixture = await controlledBackend(t, { heldStep: 2 });
    assert.equal((await fixture.start("/auto-continue 4\nProceed one step.")).ok, true);
    await waitFor(() => fixture.command()?.steer?.status === "available" && fixture.sent.length === 2);
    if (takeover === "steer") {
      const control = fixture.command()?.steer;
      assert.ok(control?.status === "available");
      assert.equal((await fixture.backend.steerActiveTurn!({ steerKey: control.steerKey, input: "Human correction now." })).ok, true);
      assert.deepEqual(fixture.steered, ["Human correction now."]);
      await waitFor(() => !!fixture.command()?.session?.timeline.some((event) => event.kind === "user-message" && event.text === "Human correction now."));
    } else if (takeover === "interrupt") {
      const control = fixture.command()?.interrupt;
      assert.ok(control?.status === "available");
      assert.equal((await fixture.backend.interruptActiveTurn!({ interruptKey: control.interruptKey })).ok, true);
    } else {
      assert.equal((await fixture.start("Human starts a separate Session.")).ok, true);
    }
    fixture.release();
    await waitFor(() => fixture.backend.readTurnActivity() === "idle");
    assert.deepEqual(fixture.sent, ["Proceed one step.", "Proceed one step.",
      ...(takeover === "composer" ? ["Human starts a separate Session."] : [])]);
  });
}

for (const steps of [1, 10]) {
  test(`the composer accepts ${steps} total steps and stops at that exact limit`, async (t) => {
    const fixture = await controlledBackend(t);
    assert.equal((await fixture.start(`/auto-continue ${steps}\nOne step.`)).ok, true);
    await waitFor(() => fixture.command()?.status === "completed" && fixture.sent.length === steps);
    assert.deepEqual(fixture.sent, Array.from({ length: steps }, () => "One step."));
  });
}

test("invalid explicit plans and overlong inputs never reach Runtime", async (t) => {
  const fixture = await controlledBackend(t);
  for (const input of ["/auto-continue", "/auto-continue 0\nOne step.", "/auto-continue 11\nOne step.",
    "/auto-continue Infinity\nOne step.", "/auto-continue 2", "/auto-continue 2\n   ", `/auto-continue 2\n${"x".repeat(8001)}`]) {
    const result = await fixture.start(input);
    assert.ok(!result.ok && result.error.category === "invalid-input", input.slice(0, 40));
  }
  assert.deepEqual(fixture.sent, []);
});

test("closing an active automatic plan does not wait for more Runtime output or continue it", async (t) => {
  const fixture = await controlledBackend(t, { heldStep: 2 });
  await fixture.start("/auto-continue 3\nOne step.");
  await waitFor(() => fixture.sent.length === 2);
  await fixture.backend.close();
  assert.equal(fixture.sent.length, 2);
});

test("a changed account stops continuation after completion without inventing a failed Runtime turn", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  const fixture = await controlledBackend(t, { heldStep: 2, observeAuthentication: true });
  const encode = createWorkbenchProjectTransferEncoder();
  const crossPreload = createWorkbenchProjectTransferSanitizer();
  const decode = createWorkbenchProjectTransferDecoder();
  let renderer: WorkbenchProjectResult | undefined;
  const renderedCommand = () => renderer?.ok ? renderer.view.commands[0] : undefined;
  t.after(fixture.backend.observeProject((result) => {
    if (!result.ok) return;
    const hosted = { ok: true as const, view: { ...result.view, projectSelection: { projects: [{
      label: result.view.project.label, selected: true, availability: "available" as const,
      selectionKey: "project-selection:00000000-0000-4000-8000-000000000021",
    }] } } };
    renderer = decode(structuredClone(crossPreload(structuredClone(encode(hosted))))) as WorkbenchProjectResult | undefined;
  }));
  await fixture.start("/auto-continue 3\nOne step.");
  await waitFor(() => fixture.sent.length === 2 && fixture.command()?.status === "in-flight");
  fixture.authGeneration!.observeEndpointAuthentication({ endpointId: "codex-desktop", state: "sign-in-required" });
  fixture.authGeneration!.observeEndpointAuthentication({ endpointId: "codex-desktop", state: "bound" });
  fixture.release();
  await waitFor(() => fixture.command()?.status === "completed" && warning.mock.callCount() > 0);
  assert.equal(fixture.sent.length, 2);
  assert.equal(fixture.command()?.session?.resumable, false);
  assert.equal(fixture.command()?.failureCategory, undefined);
  assert.partialDeepStrictEqual(fixture.command(), {
    continuationStop: { step: 2, limit: 3, reason: "continuation-unavailable" },
  }, "the product observation must explain why automatic continuation stopped");
  assert.partialDeepStrictEqual(renderedCommand(), {
    status: "completed", continuationStop: { step: 2, limit: 3, reason: "continuation-unavailable" },
  }, "same-cursor stop state survives main encoding, strict preload cloning and renderer reconstruction");
  assert.ok(fixture.command()?.session?.turns?.every((turn) => !turn.recovery && !turn.timeline.some((event) => event.kind === "failed")));
  assert.deepEqual(warning.mock.calls[0]?.arguments, ["[coordinator] Automatic continuation stopped", {
    step: 2, limit: 3, reason: "continuation-unavailable",
  }]);
});
