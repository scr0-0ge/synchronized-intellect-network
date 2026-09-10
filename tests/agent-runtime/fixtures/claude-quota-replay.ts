import { readFileSync } from "node:fs";
import { ClaudeAdapter, type ClaudeEndpointContext } from "../../../src/agent-runtime/claude/adapter.ts";
import { createGlmEndpointContext } from "../../../src/agent-runtime/claude/glm-catalog.ts";
import type { ClaudeCatalogTransport } from "../../../src/agent-runtime/claude/transport.ts";
import type { SessionProfile } from "../../../src/agent-runtime/index.ts";

export const quotaFrames: Record<string, any>[] = JSON.parse(readFileSync(
  new URL("./claude-quota-wire.json", import.meta.url), "utf8",
)).glmQuotaFrames;
export const quotaProfile: SessionProfile = {
  model: "glm-5.3", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access",
};

/** Historical catalog profile matches the unchanged captured init frame. */
export const quotaEndpoint: ClaudeEndpointContext = {
  ...createGlmEndpointContext({ configDir: "offline-config", sourceEnvironment: {} }),
  staticCatalog: {
    runtime: "glm", models: [{ id: quotaProfile.model, effortLevels: [quotaProfile.effortLevel] }],
    executionModes: [quotaProfile.executionMode], accessModes: [quotaProfile.accessMode],
  },
};

/** Only CLI transport is replaced. Adapter init, native identity and parser stay real. */
export class QuotaReplayTransport implements ClaudeCatalogTransport {
  readonly sent: Record<string, any>[] = [];
  readonly lines: string[] = [];
  stopped = 0;
  received = 0;
  stopError = false;
  stopHook = "";
  readonly frames: readonly Record<string, any>[];
  constructor(frames: readonly Record<string, any>[] = quotaFrames) { this.frames = frames; }
  async send(line: string): Promise<void> {
    const message = JSON.parse(line);
    this.sent.push(message);
    if (message.type === "control_request") {
      if (message.request.subtype === "initialize") this.stopHook = message.request.hooks.Stop[0].hookCallbackIds[0];
      this.lines.push(JSON.stringify({
        type: "control_response", response: {
          subtype: "success", request_id: message.request_id,
          response: message.request.subtype === "get_settings" ? {
            effective: { effortLevel: "high" }, sources: [],
            applied: { model: quotaProfile.model, effort: "high", advisor: null, ultracode: false },
          } : { models: [] },
        },
      }));
    } else if (message.type === "user") {
      this.lines.push(...this.frames.map(frame => JSON.stringify(frame).replaceAll("OFFLINE_STOP_HOOK", this.stopHook)));
    }
  }
  async receive(): Promise<string | null> { this.received++; return this.lines.shift() ?? null; }
  async stop(): Promise<void> { this.stopped++; if (this.stopError) throw new Error("synthetic stop failed"); }
}

export const quotaResumedFrames: Record<string, any>[] = [
  quotaFrames[0],
  { type: "assistant", session_id: quotaFrames[0].session_id, parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "OFFLINE_RESUMED" }] } },
  { type: "control_request", request_id: "offline-stop", request: {
    subtype: "hook_callback", callback_id: "OFFLINE_STOP_HOOK", input: {
      hook_event_name: "Stop", session_id: quotaFrames[0].session_id, permission_mode: "default", effort: { level: "high" },
    },
  } },
  { type: "result", session_id: quotaFrames[0].session_id, subtype: "success", is_error: false,
    terminal_reason: "completed", result: "OFFLINE_RESUMED" },
];

export function quotaAdapter(transport: QuotaReplayTransport, endpoint = quotaEndpoint) {
  return new ClaudeAdapter(async () => transport, async () => transport, undefined,
    { readPermissionMode: async () => "manual" }, undefined, undefined, endpoint);
}
