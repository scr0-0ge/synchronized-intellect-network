import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL,
  createWorkbenchClipboardPreloadBridge,
  type WorkbenchClipboardRendererIpc,
} from "../../src/workbench-shell/clipboard-bridge.ts";

const exactCode =
  '  const greeting = "hello";\n\tconsole.log(greeting);\n\nreturn greeting;  ';
const unavailable = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    category: "clipboard-write-unavailable" as const,
    message: "The system clipboard refused the copy request." as const,
  }),
});

class FakeClipboardRendererIpc implements WorkbenchClipboardRendererIpc {
  readonly calls: Array<Readonly<{ channel: string; values: unknown[] }>> = [];
  response: unknown = { ok: true, status: "copied" };
  failure: unknown;

  async invoke(channel: string, ...values: unknown[]): Promise<unknown> {
    this.calls.push({ channel, values });
    if (this.failure !== undefined) throw this.failure;
    return this.response;
  }
}

test("preload sends the code-block string unchanged through one fixed clipboard channel", async () => {
  const ipc = new FakeClipboardRendererIpc();
  const bridge = createWorkbenchClipboardPreloadBridge(ipc);

  const result = await bridge.writeClipboardText(exactCode);

  assert.deepEqual(result, { ok: true, status: "copied" });
  assert.deepEqual(ipc.calls, [
    {
      channel: WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL,
      values: [exactCode],
    },
  ]);
  assert.equal(ipc.calls[0]?.values[0], exactCode);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge), ["writeClipboardText"]);
});

test("preload fails closed before transport for non-string or extra clipboard arguments", async () => {
  const ipc = new FakeClipboardRendererIpc();
  const bridge = createWorkbenchClipboardPreloadBridge(ipc);
  const writeUnknown = bridge.writeClipboardText as unknown as (
    ...values: unknown[]
  ) => Promise<unknown>;

  for (const values of [[null], [[]], [{}], [exactCode, "extra"]]) {
    assert.deepEqual(await writeUnknown(...values), unavailable);
  }
  assert.deepEqual(ipc.calls, []);
});

test("preload maps result-shape drift and transport failures to one fixed clipboard failure", async () => {
  const ipc = new FakeClipboardRendererIpc();
  const bridge = createWorkbenchClipboardPreloadBridge(ipc);

  for (const response of [
    null,
    { ok: true, status: "copied", extra: true },
    { ok: true, status: "copied", [Symbol("extra")]: true },
    { ok: true, status: "done" },
    { ok: false },
    {
      ok: false,
      error: {
        category: "clipboard-write-unavailable",
        message: "private drift",
      },
    },
  ]) {
    ipc.response = response;
    assert.deepEqual(await bridge.writeClipboardText(exactCode), unavailable);
  }

  const accessorResult = Object.defineProperty(
    { ok: true },
    "status",
    {
      enumerable: true,
      get(): string {
        return "copied";
      },
    },
  );
  ipc.response = accessorResult;
  assert.deepEqual(await bridge.writeClipboardText(exactCode), unavailable);

  ipc.failure = new Error("PRIVATE_CLIPBOARD_TRANSPORT_FAILURE");
  assert.deepEqual(await bridge.writeClipboardText(exactCode), unavailable);
  assert.equal(JSON.stringify(unavailable).includes("PRIVATE_"), false);
});
