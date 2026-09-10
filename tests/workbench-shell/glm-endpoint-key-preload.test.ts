import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_ENDPOINT_KEY_CHANNELS,
  publicEndpointKeyInvalidValue,
  publicEndpointKeySaved,
  publicEndpointKeyUnavailable,
  publicEndpointProbed,
  publicEndpointKeyStatusLoaded,
  type WorkbenchEndpointKeyEndpointId,
} from "../../src/workbench-shell/contract.ts";
import { createWorkbenchPreloadBridge } from "../../src/workbench-shell/preload-bridge.ts";
import type { FixedProjectViewIpc } from "../../src/workbench-shell/preload-bridge.ts";

/**
 * Renderer-boundary discipline for the parameterized endpoint-key channels
 * (WO16 Part 1; the former GLM-only preload tests, updated in the same
 * batch): exact endpoint-scoped channels, sanitized results, and failures
 * collapsed to the fixed public result.
 */

class FakeInvokeIpc {
  readonly invocations: { channel: string; values: unknown[] }[] = [];
  readonly respond: (channel: string, values: unknown[]) => unknown;
  constructor(respond: (channel: string, values: unknown[]) => unknown) {
    this.respond = respond;
  }
  on(): void {}
  removeListener(): void {}
  send(): void {}
  async invoke(channel: string, ...values: unknown[]): Promise<unknown> {
    this.invocations.push({ channel, values });
    return this.respond(channel, values);
  }
}

const okStatus = publicEndpointKeyStatusLoaded({
  configured: false,
  maskedHint: null,
  isPersistent: true,
  environmentFallback: false,
});

function bridgeFor(respond: (channel: string, values: unknown[]) => unknown) {
  const ipc = new FakeInvokeIpc(respond);
  const bridge = createWorkbenchPreloadBridge(ipc as unknown as FixedProjectViewIpc);
  return { ipc, bridge };
}

const GLM = WORKBENCH_ENDPOINT_KEY_CHANNELS["glm-coding-plan"];
const KIMI = WORKBENCH_ENDPOINT_KEY_CHANNELS["kimi-code"];
const DEEPSEEK = WORKBENCH_ENDPOINT_KEY_CHANNELS["deepseek-api"];

test("the five GLM channels are invoked and their results sanitized", async () => {
  const { ipc, bridge } = bridgeFor((channel) => {
    if (channel === GLM.loadStatus) return okStatus;
    if (channel === GLM.save) {
      return publicEndpointKeySaved("••••4321", true);
    }
    if (channel === GLM.probe) {
      return publicEndpointProbed({ outcome: "success" });
    }
    if (channel === GLM.reveal) {
      return {
        ok: true,
        status: "revealed",
        value: "test-secret-888",
        snapshot: {
          configured: true,
          maskedHint: "••••4321",
          isPersistent: true,
          environmentFallback: false,
        },
      };
    }
    return {
      ok: true,
      status: "removed",
      snapshot: {
        configured: false,
        maskedHint: null,
        isPersistent: true,
        environmentFallback: false,
      },
    };
  });

  assert.deepEqual(await bridge.loadEndpointKeyStatus("glm-coding-plan"), okStatus);
  assert.deepEqual(
    await bridge.saveEndpointKey("glm-coding-plan", {
      keyValue: "test-secret-888",
    }),
    {
      ok: true,
      status: "saved",
      maskedHint: "••••4321",
      isPersistent: true,
    },
  );
  assert.deepEqual(
    await bridge.removeEndpointKey("glm-coding-plan"),
    {
      ok: true,
      status: "removed",
      snapshot: { configured: false, maskedHint: null, isPersistent: true, environmentFallback: false },
    },
  );
  const revealed = await bridge.revealEndpointKey("glm-coding-plan");
  assert.equal(revealed.ok, true);
  assert.equal(
    (revealed as { status: string }).status,
    "revealed",
  );
  assert.deepEqual(await bridge.probeEndpointKey("glm-coding-plan"), {
    ok: true,
    status: "probed",
    probe: { outcome: "success" },
  });

  assert.deepEqual(
    ipc.invocations.map(({ channel }) => channel),
    [GLM.loadStatus, GLM.save, GLM.remove, GLM.reveal, GLM.probe],
  );
  // The save request crosses with the exact agreed shape only.
  assert.deepEqual(ipc.invocations[1]!.values, [
    { keyValue: "test-secret-888" },
  ]);
});

test("each endpointId routes to its own channel set", async () => {
  const { ipc, bridge } = bridgeFor(() => okStatus);
  const endpoints: readonly WorkbenchEndpointKeyEndpointId[] = [
    "glm-coding-plan",
    "kimi-code",
    "deepseek-api",
  ];
  for (const endpointId of endpoints) {
    await bridge.loadEndpointKeyStatus(endpointId);
  }
  assert.deepEqual(
    ipc.invocations.map(({ channel }) => channel),
    [GLM.loadStatus, KIMI.loadStatus, DEEPSEEK.loadStatus],
  );
});

test("an invalid save value is refused locally without an invocation", async () => {
  const { ipc, bridge } = bridgeFor(() => {
    throw new Error("must not be invoked");
  });
  assert.deepEqual(
    await bridge.saveEndpointKey("kimi-code", { keyValue: " not trimmed " }),
    publicEndpointKeyInvalidValue(),
  );
  assert.equal(ipc.invocations.length, 0);
});

test("transport failures and malformed main results collapse to the fixed unavailable result", async () => {
  const { bridge } = bridgeFor((channel) => {
    if (channel === GLM.loadStatus) {
      throw new Error("bridge closed");
    }
    if (channel === GLM.probe) {
      return { ok: true, status: "probed", probe: { outcome: "junk" } };
    }
    return { ok: true, status: "saved", junk: true };
  });
  assert.deepEqual(
    await bridge.loadEndpointKeyStatus("glm-coding-plan"),
    publicEndpointKeyUnavailable(),
  );
  assert.deepEqual(
    await bridge.saveEndpointKey("deepseek-api", { keyValue: "test-secret-1" }),
    publicEndpointKeyUnavailable(),
  );
  assert.deepEqual(
    await bridge.removeEndpointKey("glm-coding-plan"),
    publicEndpointKeyUnavailable(),
  );
  assert.deepEqual(
    await bridge.revealEndpointKey("glm-coding-plan"),
    publicEndpointKeyUnavailable(),
  );
  assert.deepEqual(
    await bridge.probeEndpointKey("glm-coding-plan"),
    publicEndpointKeyUnavailable(),
  );
});
