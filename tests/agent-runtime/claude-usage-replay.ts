import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ClaudeRuntimeBinding } from "../../src/agent-runtime/claude/session.ts";
import type { NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";

export const captureNames = ["claude-web", "claude-web-allowed", "claude-deferred", "claude-deferred-resume"] as const;

// Public projection of the consumed fields from the private captures. Owner
// paths, Session identities and every unconsumed provider field are omitted.
const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/claude-quota-wire.json", import.meta.url), "utf8",
));

export function usageCapture(name: string) {
  const model = fixture.usageCaptureModels[name];
  assert.equal(typeof model, "string", `unknown usage capture: ${name}`);
  const init = { ...fixture.glmQuotaFrames[0], model };
  const rate = { ...fixture.allowedRateEvent, session_id: init.session_id };
  return {
    init,
    rate,
  };
}

export async function replayUsage(
  name: string,
  observeSubscriptionUsage: (value: any) => void | Promise<void>,
  changeRate?: (rate: any) => any,
) {
  const { init, rate } = usageCapture(name);
  // Init and rate frames are unchanged captured input. The successful suffix
  // only supplies the parser's existing completion evidence, not usage data.
  const frames = [init, changeRate ? changeRate(rate) : rate,
    { type: "assistant", session_id: init.session_id, parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    { type: "control_request", request_id: "stop-request", request: {
      subtype: "hook_callback", callback_id: "stop-hook", input: {
        hook_event_name: "Stop", session_id: init.session_id,
        permission_mode: init.permissionMode, effort: { level: "xhigh" },
      },
    } },
    { type: "result", session_id: init.session_id, subtype: "success",
      is_error: false, terminal_reason: "completed", result: "done" },
  ].map(frame => JSON.stringify(frame));
  const sent: any[] = [];
  const options = {
    transport: {
      async send(line: string) { sent.push(JSON.parse(line)); },
      async receive() { return frames.shift() ?? null; },
      async stop() {},
    },
    profile: { model: init.model, effortLevel: "xhigh", executionMode: "ultracode" as const, accessMode: "full-access" as const },
    opaqueSessionReference: "offline-capability", expectedModel: init.model,
    stopHookCallbackId: "stop-hook", permissionMode: "manual" as const,
    observeSessionIdentity: (identity: string) => assert.equal(identity, init.session_id),
    ultracodeConfirmed: true, observeSubscriptionUsage,
  };
  const binding = new ClaudeRuntimeBinding(options);
  await binding.send({ text: "offline replay input" });
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of binding.events()) events.push(event);
  return { events, sent };
}
