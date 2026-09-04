import assert from "node:assert/strict";
import test from "node:test";

import { runtimeProfileProjectionPreservesLockedModes } from "../../src/agent-runtime/runtime-profile-projection.ts";

const selection = Object.freeze({
  model: "opaque-model",
  effortLevel: "opaque-ultracode-intensity",
  executionMode: "single-agent",
  accessMode: "full-access",
});
const nativeUltracode = Object.freeze({
  model: "opus-alias",
  effortLevel: "xhigh",
  executionMode: "ultracode",
  accessMode: "full-access",
});

test("the private execution projection admits only Claude xhigh plus ultracode", () => {
  assert.equal(
    runtimeProfileProjectionPreservesLockedModes(
      "claude-code-desktop",
      selection,
      nativeUltracode,
    ),
    true,
  );

  const rejected = [
    {
      endpointId: "codex-desktop",
      native: nativeUltracode,
    },
    {
      endpointId: "claude-code-desktop",
      native: { ...nativeUltracode, effortLevel: "max" },
    },
    {
      endpointId: "claude-code-desktop",
      native: { ...nativeUltracode, executionMode: "ultracode-future" },
    },
    {
      endpointId: "claude-code-desktop",
      native: { ...nativeUltracode, accessMode: "restricted" },
    },
  ];
  for (const row of rejected) {
    assert.equal(
      runtimeProfileProjectionPreservesLockedModes(
        row.endpointId,
        selection,
        row.native,
      ),
      false,
    );
  }
});
