import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ClaudeRuntimeBinding } from "../../src/agent-runtime/claude/session.ts";
import type { ContextUsageObservation } from "../../src/coordinator/auto-iteration/contract.ts";
import {
  setCapabilityProbeSinks,
} from "../../src/coordinator/auto-iteration/capability-probe.ts";

/**
 * w338, issue #8 Lane C: the active `get_context_usage` control probe.
 *
 * The fixture is real captured wire: Claude CLI 2.1.270 on the loopback fake
 * HTTP server (zero provider inference, isolated profile, sanitized at
 * capture), with the probe issued at the validated Stop-hook boundary. On
 * this build the CLI answers AFTER the terminal `result` frame, so the
 * replay also proves the post-result read window. Every degraded shape
 * completes the turn: a probe answer is optional telemetry, never a failure.
 */

const fixtureUrl = new URL(
  "./fixtures/claude-2.1.270-get-context-usage.jsonl",
  import.meta.url,
);

const replayProfile = Object.freeze({
  model: "glm-5.3[1m]",
  // The captured Stop-hook echo reports the CLI's own effective level; the
  // unpinned tier tolerates whatever the CLI resolved.
  effortLevel: "default",
  executionMode: "single-agent",
  accessMode: "full-access",
});

interface ReplayOptions {
  readonly edit?: (lines: string[]) => string[];
}

async function replayCapture(options: ReplayOptions = {}) {
  let lines = (await readFile(fixtureUrl, "utf8")).trimEnd().split(/\r?\n/u);
  if (options.edit) lines = options.edit(lines);
  let cursor = 2; // the two init control responses are consumed pre-binding
  let stops = 0;
  let identity: string | undefined;
  let sentProbeRequestId: string | undefined;
  const sent: string[] = [];
  const observations: ContextUsageObservation[] = [];
  setCapabilityProbeSinks({
    contextUsage: (observation) => {
      observations.push(observation);
    },
  });
  const binding = new ClaudeRuntimeBinding({
    transport: {
      async send(line) {
        sent.push(line);
        const frame = JSON.parse(line) as {
          readonly type?: string;
          readonly request?: { readonly subtype?: string };
          readonly request_id?: string;
        };
        if (frame.type === "control_request" && frame.request?.subtype === "get_context_usage") {
          sentProbeRequestId = frame.request_id;
        }
      },
      async receive() {
        const line = lines[cursor++] ?? null;
        if (line === null) return null;
        // The captured CLI reply echoes the capturing run's probe request id;
        // live, the CLI echoes the id the binding sent. Rewrite only that
        // correlation id -- the same class of edit the interrupt replays make.
        const frame = JSON.parse(line) as {
          readonly response?: { readonly request_id?: string };
        };
        if (frame.response?.request_id === "probe-w338-context-usage" && sentProbeRequestId !== undefined) {
          return JSON.stringify({
            ...frame,
            response: { ...frame.response, request_id: sentProbeRequestId },
          });
        }
        return line;
      },
      // The probe answer may arrive after `result` (observed on 2.1.270);
      // the post-result read window only exists when the transport can be
      // finished, exactly like the production wire.
      finishInput() {},
      async stop() {
        stops += 1;
      },
    },
    profile: replayProfile,
    opaqueSessionReference: "w338-replay",
    expectedModel: "glm-5.3[1m]",
    stopHookCallbackId: "stop-9883f53c-7849-48ba-8102-08bc960d0bc9",
    observeSessionIdentity(value) {
      identity = value;
    },
    permissionMode: "bypassPermissions",
    ultracodeConfirmed: false,
  });
  try {
    await binding.send({ text: "w338 replay input" });
    const events = [];
    for await (const event of binding.events()) events.push(event);
    return { events, sent, observations, identity, stops };
  } finally {
    setCapabilityProbeSinks(undefined);
  }
}

function probeRequestId(sent: readonly string[]): string | undefined {
  for (const line of sent) {
    const frame = JSON.parse(line) as {
      readonly type?: string;
      readonly request?: { readonly subtype?: string };
      readonly request_id?: string;
    };
    if (frame.type === "control_request" && frame.request?.subtype === "get_context_usage") {
      return frame.request_id;
    }
  }
  return undefined;
}

function findProbeResponseLine(
  lines: readonly string[],
): number {
  return lines.findIndex((line) => {
    const frame = JSON.parse(line) as {
      readonly response?: { readonly request_id?: string };
    };
    return frame.response?.request_id === "probe-w338-context-usage";
  });
}

test("the real 2.1.270 probe wire feeds one authoritative observation and completes the turn", async (t) => {
  const replay = await replayCapture();
  t.diagnostic(JSON.stringify({ events: replay.events, observations: replay.observations }));
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  const requestId = probeRequestId(replay.sent);
  assert.ok(requestId, "the binding must issue one get_context_usage control request");
  assert.equal(
    replay.sent.filter((line) =>
      JSON.parse(line).request?.subtype === "get_context_usage",
    ).length,
    1,
    "exactly one probe request per completed turn",
  );
  assert.equal(replay.observations.length, 1);
  assert.deepEqual(replay.observations[0], {
    source: "claude-control:get_context_usage",
    observedAt: (replay.observations[0] as ContextUsageObservation).observedAt,
    sessionId: replay.identity,
    model: "glm-5.3[1m]",
    quality: "authoritative",
    totalTokens: 100,
    maxTokens: 1_000_000,
    fraction: 100 / 1_000_000,
  });
});

test("a malformed probe answer degrades to an unknown observation without failing the turn", async (t) => {
  const replay = await replayCapture({
    edit: (lines) => lines.map((line, index) => {
      if (index !== findProbeResponseLine(lines)) return line;
      const frame = JSON.parse(line) as { response: { response: unknown } };
      frame.response.response = { totalTokens: "not-a-number" };
      return JSON.stringify(frame);
    }),
  });
  t.diagnostic(JSON.stringify({ events: replay.events, observations: replay.observations }));
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(replay.observations.length, 1);
  assert.equal(replay.observations[0]?.quality, "unknown");
  assert.equal(replay.observations[0]?.fraction, null);
});

test("a CLI that never answers the probe completes the turn with no observation", async (t) => {
  const replay = await replayCapture({
    edit: (lines) => lines.filter((_, index) => index !== findProbeResponseLine(lines)),
  });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(replay.observations.length, 0);
  assert.equal(replay.stops, 1);
});

test("a probe answer naming a different model than the session selection is not authoritative", async (t) => {
  const replay = await replayCapture({
    edit: (lines) => lines.map((line, index) => {
      if (index !== findProbeResponseLine(lines)) return line;
      const frame = JSON.parse(line) as { response: { response: { model: string } } };
      frame.response.response.model = "claude-opus-5[1m]";
      return JSON.stringify(frame);
    }),
  });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(replay.observations.length, 1);
  assert.equal(replay.observations[0]?.quality, "unknown");
});
