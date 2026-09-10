// Offline Claude CLI stub: no provider calls and no installed Claude state.
import { createInterface } from "node:readline";

const expectedConfigDirectory = process.env.UAW_TEST_EXPECT_CLAUDE_CONFIG_DIR;
if (
  expectedConfigDirectory === undefined ||
  process.env.CLAUDE_CONFIG_DIR !== expectedConfigDirectory
) {
  process.stderr.write("isolated CLAUDE_CONFIG_DIR was not preserved\n");
  process.exit(31);
}

const mode = process.env.UAW_TEST_CLAUDE_MODE ?? "future-noise";
const sessionId = "offline-noisy-claude-session";
const reply = "UAW_CLAUDE_NOISE_SURVIVED";
let stopHookCallbackId;
let emittedFrames = 0;

function emit(message) {
  if (mode === "future-noise") {
    const notices = [
      "Claude Code 9999.0.0-future is available.",
      "",
      "\u001b[1mRun claude update to upgrade.\u001b[0m",
      "\r",
    ];
    process.stdout.write(notices[emittedFrames % notices.length] + "\n");
  } else if (mode === "noise-flood" && emittedFrames === 0) {
    for (let index = 0; index < 65; index += 1) {
      process.stdout.write("Claude is still starting\n");
    }
  } else if (mode === "damaged-frame" && emittedFrames === 0) {
    process.stdout.write('{"type":"control_response"\n');
  }
  const prefix = mode === "future-noise" && emittedFrames === 0 ? "\ufeff" : "";
  process.stdout.write(prefix + JSON.stringify(message) + "\n");
  emittedFrames += 1;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (message.request?.subtype === "initialize") {
      stopHookCallbackId = message.request.hooks.Stop[0].hookCallbackIds[0];
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {
            models: [{
              value: "opus-alias",
              resolvedModel: "claude-opus-canonical",
              displayName: "Opus",
              description: "Offline fixture",
              supportsEffort: true,
              supportedEffortLevels: ["high"],
            }],
          },
        },
      });
      return;
    }
    if (message.request?.subtype === "get_settings") {
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {
            effective: { effortLevel: "high", ultracode: false },
            sources: [{
              source: "flagSettings",
              settings: { effortLevel: "high", ultracode: false },
            }],
            applied: {
              model: "opus-alias",
              effort: "high",
              advisor: null,
              ultracode: false,
            },
          },
        },
      });
      return;
    }
  }
  if (message.type === "user") {
    emit({
      type: "system",
      subtype: "init",
      model: "claude-opus-canonical",
      permissionMode: "bypassPermissions",
      capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"],
      session_id: sessionId,
    });
    emit({
      type: "user",
      message: message.message,
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    emit({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: reply }],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    emit({
      type: "control_request",
      request_id: "offline-stop-hook",
      request: {
        subtype: "hook_callback",
        callback_id: stopHookCallbackId,
        input: {
          hook_event_name: "Stop",
          session_id: sessionId,
          permission_mode: "bypassPermissions",
          effort: { level: "high" },
        },
      },
    });
    return;
  }
  if (message.type === "control_response") {
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: reply,
      terminal_reason: "completed",
      session_id: sessionId,
    });
  }
});
