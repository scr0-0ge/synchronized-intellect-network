import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ClaudeRuntimeBinding } from "../../src/agent-runtime/claude/session.ts";
import type { NormalizedRuntimeEvent, SessionProfile } from "../../src/agent-runtime/index.ts";
import { claudeDiagnosticFilePath } from "../../src/agent-runtime/claude/diagnostics.ts";

const profile = Object.freeze({ model: "sonnet", effortLevel: "low", executionMode: "single-agent", accessMode: "full-access" });
const input = "今天几月几号、斯德哥尔摩什么天气";

test("real Claude 2.1.267 stdout completes the turn, including the Stop response echo", async t => {
  const replay = await replayCapture();
  t.diagnostic(JSON.stringify({ events: replay.events, lastLine: replay.lastLine, discriminator: replay.binding.correlationFailureDiscriminator() }));
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.deepEqual(replay.events.filter(event => event.kind === "agent-message"), [{ kind: "agent-message", text: "W176_OFFLINE_OK" }]);
  assert.equal(replay.identity, "9756ea50-062d-4291-afc5-d39ba4f621ba");
  assert.equal(replay.stops, 1);
});

test("real Claude 2.1.267 permission response echoes do not end a manual turn", async t => {
  const replay = await replayCapture({ name: "permission" });
  t.diagnostic(JSON.stringify({ events: replay.events, lastLine: replay.lastLine }));
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(replay.permissionRequests, 1);
});

test("single-variable control: removing only the captured Stop response echo restores completion", async () => {
  const replay = await replayCapture({ edit: lines => lines.filter((_, index) => index !== 13) });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
});

test("real CLI A/B without the replay flag still emits Stop but no response echo", async () => {
  const replay = await replayCapture({ name: "no-replay" });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(replay.sent.filter(line => JSON.parse(line).type === "control_response").length, 1);
});

test("missing non-init session echoes do not invalidate the captured turn", async () => {
  const replay = await replayCapture({ edit: lines => lines.map(line => {
    const frame = JSON.parse(line);
    if (frame.type !== "system" || frame.subtype !== "init") delete frame.session_id;
    return JSON.stringify(frame);
  }) });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
});

test("real Claude 2.1.270 pre-init session_state_changed notice does not kill the turn", async () => {
  // Captured live on 2026-09-14: CLI 2.1.270 emits this state notice BEFORE
  // the init frame (2.1.267 put init first). The notice carries no turn
  // content; init remains the frame that establishes session identity.
  const replay = await replayCapture({ edit: lines => {
    const initIndex = lines.findIndex(line => {
      const frame = JSON.parse(line);
      return frame.type === "system" && frame.subtype === "init";
    });
    const notice = JSON.stringify({
      type: "system",
      subtype: "session_state_changed",
      state: "running",
      uuid: "w265-pre-init-notice-uuid",
      session_id: JSON.parse(lines[initIndex]!).session_id,
    });
    return [...lines.slice(0, initIndex), notice, ...lines.slice(initIndex)];
  } });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(replay.events.filter(event => event.kind === "agent-message").length, 1);
});

test("a different session id fails visibly with the frame and both identities in the private log", async t => {
  const summaries: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { summaries.push(String(chunk)); return true; });
  const replay = await replayCapture({ edit: lines => lines.map((line, index) => index === 3
    ? JSON.stringify({ ...JSON.parse(line), session_id: "foreign-w176-session" }) : line) });
  assert.deepEqual(replay.events.at(-1), { kind: "failed", category: "correlation-invalid" });
  const diagnostics = (await readFile(claudeDiagnosticFilePath(), "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  const row = diagnostics.at(-1);
  assert.equal(row.kind, "correlation-rejected");
  assert.equal(row.category, "correlation-invalid");
  const detail = JSON.parse(row.detail);
  assert.equal(detail.frameNumber, 2);
  assert.equal(detail.frameType, "system");
  assert.equal(detail.frameSubtype, "status");
  assert.equal(detail.expectedSessionId, replay.identity);
  assert.equal(detail.receivedSessionId, "foreign-w176-session");
  assert.match(summaries.join(""), /correlation-invalid/u);
  assert.doesNotMatch(summaries.join(""), /foreign-w176-session|9756ea50/u);
  assert.doesNotMatch(JSON.stringify(replay.events), /foreign-w176-session|9756ea50/u);
});

test("unrelated control responses are ignored once per turn, without consuming an interrupt receipt", async () => {
  const before = (await readFile(claudeDiagnosticFilePath(), "utf8")).trim().split(/\r?\n/u).length;
  const replay = await replayCapture({ interrupt: "valid" });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(await replay.interruption, "confirmed");
  const diagnostics = (await readFile(claudeDiagnosticFilePath(), "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.equal(diagnostics.length, before + 1, "unrelated response and captured hook echo coalesce to one diagnostic");
  assert.equal(diagnostics.at(-1).gate, "control-response");
  const detail = JSON.parse(diagnostics.at(-1).detail);
  assert.equal(detail.receivedRequestId, "foreign-request");
  const request = replay.sent.map(line => JSON.parse(line)).find(frame => frame.request?.subtype === "interrupt");
  assert.equal(detail.expectedRequestId, request.request_id);
});

test("a foreign request id cannot claim the user's stop succeeded", async () => {
  const replay = await replayCapture({ interrupt: "foreign-only" });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(await replay.interruption, "correlation-invalid");
  assert.equal(replay.events.some(event => event.kind === "turn-interrupted"), false);
});

test("missing init identity is still refused before session-started", async () => {
  const replay = await replayCapture({ edit: lines => lines.map((line, index) => {
    if (index !== 2) return line;
    const frame = JSON.parse(line);
    delete frame.session_id;
    return JSON.stringify(frame);
  }) });
  assert.deepEqual(replay.events, [{ kind: "failed", category: "unsupported-selection" }]);
});

test("a permission-mode drift is still fail-closed even without a session echo", async () => {
  const replay = await replayCapture({ edit: lines => lines.map((line, index) => {
    if (index !== 3) return line;
    const frame = JSON.parse(line);
    delete frame.session_id;
    frame.permissionMode = "default";
    return JSON.stringify(frame);
  }) });
  assert.deepEqual(replay.events.at(-1), { kind: "failed", category: "unsupported-selection" });
});

for (const defect of ["missing-stop", "terminal-reason", "result-text"] as const) {
  test(`completion evidence remains fail-closed: ${defect}`, async () => {
    const replay = await replayCapture({ edit: lines => defect === "missing-stop"
      ? lines.filter((_, index) => index !== 12 && index !== 13)
      : lines.map(line => {
        const frame = JSON.parse(line);
        if (frame.type === "result") {
          if (defect === "terminal-reason") frame.terminal_reason = "unknown-future-terminal";
          else frame.result = "not-the-assistant-text";
        }
        return JSON.stringify(frame);
      }) });
    assert.deepEqual(replay.events.at(-1), { kind: "failed", category: "turn-failed" });
  });
}

test("a mid-turn upstream 401 classifies as authentication-required, not turn-failed", async () => {
  // Result shape captured live 2026-09-14 (w280): real Claude CLI 2.1.270 driven
  // through the production ClaudeAdapter/session-transport composition against a
  // fake local HTTP server answering /v1/messages with 401. The CLI retries
  // internally (system/api_retry, ~10 attempts) then settles on this exact
  // terminal result frame -- is_error true, terminal_reason "api_error",
  // api_error_status 401, result text "Not logged in · Please run /login".
  const replay = await replayCapture({ edit: lines => lines.map(line => {
    const frame = JSON.parse(line);
    if (frame.type === "result") {
      frame.is_error = true;
      frame.terminal_reason = "api_error";
      frame.api_error_status = 401;
      frame.result = "Not logged in · Please run /login";
    }
    return JSON.stringify(frame);
  }) });
  assert.deepEqual(replay.events.at(-1), { kind: "failed", category: "authentication-required" });
});

// w287: a real Claude CLI 2.1.270 against a fake HTTP 401 retries internally
// (system/api_retry, ~10 attempts, ~174s wire time) before ever reaching a
// terminal result -- the key is wrong, so nothing about waiting can help.
// Shape below is the literal captured frame (probe-auth-failure-401.ts,
// evidence ao-0914-w287-auth-fail-fast.md): error_status is a top-level
// number on the api_retry frame itself, not on the eventual result.
function apiRetryFrame(sessionId: string, errorStatus: number) {
  return JSON.stringify({
    type: "system", subtype: "api_retry", attempt: 1, max_retries: 10,
    retry_delay_ms: 577, error_status: errorStatus, error: "authentication_failed",
    session_id: sessionId, uuid: "w287-api-retry-uuid",
  });
}
function insertAfterStatusFrame(lines: string[], frame: string): string[] {
  const statusIndex = lines.findIndex(line => {
    const parsed = JSON.parse(line);
    return parsed.type === "system" && parsed.subtype === "status";
  });
  return [...lines.slice(0, statusIndex + 1), frame, ...lines.slice(statusIndex + 1)];
}

for (const errorStatus of [401, 403] as const) {
  test(`api_retry carrying a ${errorStatus} classifies as authentication-required without waiting out the CLI's retries`, async () => {
    const replay = await replayCapture({ edit: lines => {
      const sessionId = JSON.parse(lines[2]!).session_id as string;
      return insertAfterStatusFrame(lines, apiRetryFrame(sessionId, errorStatus));
    } });
    assert.deepEqual(replay.events.at(-1), { kind: "failed", category: "authentication-required" });
    // The fixture has ~15 lines total; stopping at the first api_retry frame
    // (instead of reading through to the captured result) is the fail-fast
    // behavior itself, not just its outcome.
    assert.ok(replay.lastLine < 10, `expected an early stop, read up to line ${replay.lastLine}`);
  });
}

test("api_retry carrying a 429 keeps the existing behavior: the CLI's own retry is left to run, turn still completes", async () => {
  const replay = await replayCapture({ edit: lines => {
    const sessionId = JSON.parse(lines[2]!).session_id as string;
    return insertAfterStatusFrame(lines, apiRetryFrame(sessionId, 429));
  } });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(replay.events.some(event => event.kind === "progress" && event.activity === "retrying"), true);
});

// w306: real Claude CLI (2.1.267 and 2.1.270) against a fake HTTP 429, same
// production transport (probe-429-capture.ts). The CLI exhausts its own
// retry budget (system/api_retry x10, ~178s wire time in the live capture)
// then settles on the same terminal result shape as the 401 fixture above,
// with api_error_status 429. The only field difference between the two CLI
// versions is 2.1.270's additive `result_index` on the result frame, which
// this classification never reads.
//
// w355: each captured api_retry frame yields its own retrying progress row
// whose payload changes with the attempt (attempt/max, backoff seconds,
// error_status), so the user watches the retry budget drain instead of one
// static note for ~3 minutes. Rounded whole seconds per captured frame.
const retryingProgressEvent = (attempt: number, delaySeconds: number) => ({
  kind: "progress" as const,
  activity: "retrying" as const,
  tool: {
    type: "unknown" as const,
    sourceType: "api_retry",
    name: "429",
    parameter: {
      kind: "command" as const,
      value: `${attempt}/10 · ${delaySeconds}s`,
      truncated: false,
    },
  },
});
const capturedRetryDelaySeconds = {
  "2.1.267": [1, 1, 2, 4, 8, 17, 38, 34, 35, 36],
  "2.1.270": [1, 1, 2, 4, 9, 19, 38, 33, 38, 33],
} as const;
for (const version of ["2.1.267", "2.1.270"] as const) {
  test(`real Claude ${version} stdout after a 429-exhausted retry budget classifies as rate-limited, not turn-failed`, async t => {
    const replay = await replayCapture({ name: "429", version, expectedModel: "glm-5.3[1m]" });
    t.diagnostic(JSON.stringify({ events: replay.events }));
    // The full sequence is the measured answer to "what does the user see":
    // one status update, one retrying row per captured api_retry frame with
    // attempt-counting content (w355), an item that never produced text,
    // then the failure.
    assert.deepEqual(replay.events, [
      { kind: "session-started" },
      { kind: "turn-started" },
      { kind: "progress", activity: "status" },
      ...capturedRetryDelaySeconds[version].map((seconds, index) =>
        retryingProgressEvent(index + 1, seconds)),
      { kind: "item-started", itemType: "agent-message" },
      { kind: "failed", category: "rate-limited" },
    ]);
    const retrying = replay.events.filter((event): event is Extract<NormalizedRuntimeEvent, { kind: "progress" }> =>
      event.kind === "progress" && event.activity === "retrying");
    assert.equal(retrying.length, 10);
    assert.equal(
      new Set(retrying.map(event => JSON.stringify(event.tool))).size,
      10,
      "each of the 10 captured api_retry frames carries distinct content",
    );
  });
}
for (const interrupt of ["missing-queue", "nonempty-queue", "error", "malformed-body"] as const) {
  test(`a matching interrupt id still rejects ${interrupt}`, async () => {
    const replay = await replayCapture({ interrupt });
    const category = interrupt === "malformed-body" ? "protocol-invalid" : "correlation-invalid";
    assert.deepEqual(replay.events.at(-1), { kind: "failed", category });
    assert.equal(await replay.interruption, category);
    assert.equal(replay.events.some(event => event.kind === "turn-interrupted"), false);
  });
}

const w289Profile = Object.freeze({ model: "glm-5.3[1m]", effortLevel: "default", executionMode: "single-agent" as const, accessMode: "full-access" as const });
const w289ExpectedModel = "glm-5.3[1m]";

test("real Claude 2.1.270 new session completes on the current wire shape (w289)", async t => {
  const replay = await replayCapture({
    name: "new-session", version: "2.1.270",
    prompt: "W289 new-session probe: say hi",
    stopHookCallbackId: "stop-32802d9f-18ff-4e63-943a-2434f32a3b35",
    profile: w289Profile, expectedModel: w289ExpectedModel,
  });
  t.diagnostic(JSON.stringify({ events: replay.events }));
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.deepEqual(replay.events.filter(event => event.kind === "agent-message"), [{ kind: "agent-message", text: "W289_OK" }]);
});

test("real Claude 2.1.270 thinking + a real tool call + Stop hook completes (w289)", async t => {
  const replay = await replayCapture({
    name: "tool-call", version: "2.1.270",
    prompt: "W289_TOOL_CALL probe: run the echo tool",
    stopHookCallbackId: "stop-2ceaca74-1748-45c0-a955-a7b60e2114d6",
    profile: w289Profile, expectedModel: w289ExpectedModel,
  });
  t.diagnostic(JSON.stringify({ events: replay.events }));
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.ok(replay.events.some(event => event.kind === "progress" && event.activity === "tool" && event.tool?.name === "Bash"),
    "the Bash tool_use block surfaces as tool progress");
  assert.deepEqual(replay.events.filter(event => event.kind === "agent-message"), [{ kind: "agent-message", text: "W289_TOOL_FOLLOWUP_OK" }]);
});

test("real Claude 2.1.270 interrupt confirms mid-turn on the current wire shape (w289)", async t => {
  const replay = await replayCapture({
    name: "interrupt", version: "2.1.270", interrupt: "valid", interruptAt: "turn-started",
    prompt: "W289_SLOW probe: think slowly",
    profile: w289Profile, expectedModel: w289ExpectedModel,
  });
  t.diagnostic(JSON.stringify({ events: replay.events }));
  assert.deepEqual(replay.events.at(-1), { kind: "turn-interrupted", status: "interrupted" });
  assert.equal(await replay.interruption, "confirmed");
});

test("real Claude 2.1.270 same-id resume completes on the current wire shape (w289)", async t => {
  const replay = await replayCapture({
    name: "resume", version: "2.1.270",
    prompt: "W289 resume leg2: second turn, same session id",
    stopHookCallbackId: "stop-1d1f20c7-427c-490a-8dc0-7085449fd3be",
    profile: w289Profile, expectedModel: w289ExpectedModel,
    expectedSessionIdentity: "478e4ebb-3e51-4865-87a4-b328e55b4d1c",
  });
  t.diagnostic(JSON.stringify({ events: replay.events }));
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(replay.identity, "478e4ebb-3e51-4865-87a4-b328e55b4d1c");
});

test("real Claude 2.1.270 upstream 401 classifies as authentication-required on its own captured wire (w289)", async t => {
  const replay = await replayCapture({
    name: "401", version: "2.1.270",
    prompt: "W289 401 probe: say hi",
    profile: w289Profile, expectedModel: w289ExpectedModel,
  });
  t.diagnostic(JSON.stringify({ events: replay.events }));
  assert.deepEqual(replay.events.at(-1), { kind: "failed", category: "authentication-required" });
});

test("real Claude 2.1.270 upstream 429 classifies as rate-limited on its captured wire (w289)", async t => {
  const replay = await replayCapture({
    name: "429", version: "2.1.270",
    prompt: "W289 429 probe: say hi",
    profile: w289Profile, expectedModel: w289ExpectedModel,
  });
  t.diagnostic(JSON.stringify({ events: replay.events }));
  assert.deepEqual(replay.events.at(-1), { kind: "failed", category: "rate-limited" });
});

type InterruptCase = "valid" | "foreign-only" | "missing-queue" | "nonempty-queue" | "error" | "malformed-body";
async function replayCapture(options: {
  name?: string;
  version?: "2.1.267" | "2.1.270";
  edit?: (lines: string[]) => string[];
  interrupt?: InterruptCase;
  interruptAt?: "turn-started" | "item-started";
  prompt?: string;
  profile?: SessionProfile;
  expectedModel?: string;
  expectedSessionIdentity?: string;
  stopHookCallbackId?: string;
} = {}) {
  const version = options.version ?? "2.1.267";
  let lines = (await readFile(new URL(`./fixtures/claude-${version}-${options.name ?? "text"}.jsonl`, import.meta.url), "utf8")).trimEnd().split(/\r?\n/u);
  if (options.edit) lines = options.edit(lines);
  // initialize/get_settings are consumed before the binding is constructed.
  // Replay the subsequent stdout bytes unchanged, not hand-authored vendor frames.
  // The one edit made to the captures is the capturing machine's Windows 8.3
  // home name, rewritten to TESTUS~1 in cwd/transcript/memory/tool-input paths.
  // No frame this suite asserts on reads those paths.
  let cursor = 2;
  let stops = 0;
  let identity: string | undefined;
  let permissionRequests = 0;
  const sent: string[] = [];
  const injected: string[] = [];
  let interruption: Promise<string> | undefined;
  const binding = new ClaudeRuntimeBinding({
    transport: {
      async send(line) {
        sent.push(line);
        const request = JSON.parse(line);
        if (request.request?.subtype !== "interrupt") return;
        // The captured hook echo may arrive while an interrupt is pending.
        // An unrelated response need not have the interrupt-specific payload.
        if (options.interrupt === "valid" || options.interrupt === "foreign-only") {
          injected.push(JSON.stringify({ type: "control_response", response: { request_id: "foreign-request", subtype: "error", response: null } }));
        }
        if (options.interrupt === "foreign-only") return;
        const payload = options.interrupt === "malformed-body" ? null
          : options.interrupt === "missing-queue" ? {}
          : { still_queued: options.interrupt === "nonempty-queue" ? ["queued-input"] : [], cancelled: [] };
        injected.push(JSON.stringify({ type: "control_response", response: {
          subtype: options.interrupt === "error" ? "error" : "success", request_id: request.request_id, response: payload,
        } }));
      },
      async receive() { return injected.shift() ?? lines[cursor++] ?? null; },
      async stop() { stops += 1; },
    },
    profile: options.profile ?? profile,
    opaqueSessionReference: "w176-replay",
    expectedModel: options.expectedModel ?? "claude-sonnet-5",
    expectedSessionIdentity: options.expectedSessionIdentity,
    stopHookCallbackId: options.stopHookCallbackId ?? "w176-stop",
    observeSessionIdentity(value) { identity = value; },
    permissionMode: options.name === "permission" ? "manual" : "bypassPermissions",
    async requestToolPermission() { permissionRequests += 1; return { behavior: "deny", message: "Offline probe denies write." }; },
    ultracodeConfirmed: false,
  });
  await binding.send({ text: options.prompt ?? input });
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of binding.events()) {
    events.push(event);
    if (event.kind === (options.interruptAt ?? "item-started") && options.interrupt) {
      interruption = binding.interrupt().then(() => "confirmed", error => error.category);
    }
  }
  return { binding, events, lastLine: cursor, stops, identity, sent, permissionRequests, interruption };
}
