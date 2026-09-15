import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeRuntimeBinding } from "../../src/agent-runtime/claude/session.ts";
import type { RuntimeInput, SessionProfile } from "../../src/agent-runtime/index.ts";
import {
  RUNTIME_INPUT_IMAGE_MAX_BYTES,
  RUNTIME_INPUT_IMAGE_MAX_COUNT,
} from "../../src/agent-runtime/index.ts";

const profile: SessionProfile = Object.freeze({
  model: "sonnet",
  effortLevel: "low",
  executionMode: "single-agent",
  accessMode: "full-access",
});

/** A 1x1 transparent PNG, the smallest well-formed PNG commonly used as a test fixture. */
const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function fakeBinding(): { binding: ClaudeRuntimeBinding; sent: string[]; stops: number } {
  const sent: string[] = [];
  let stops = 0;
  const binding = new ClaudeRuntimeBinding({
    transport: {
      async send(line) {
        sent.push(line);
      },
      async receive() {
        return null;
      },
      async stop() {
        stops += 1;
      },
    },
    profile,
    opaqueSessionReference: "w329-fake",
    expectedModel: "claude-sonnet-5",
    stopHookCallbackId: "w329-stop",
    observeSessionIdentity() {},
    permissionMode: "bypassPermissions",
    ultracodeConfirmed: false,
  });
  return { binding, sent, stops };
}

test("send with no images writes the exact historical wire bytes (red line: unchanged when there is no attachment)", async () => {
  const { binding, sent } = fakeBinding();
  await binding.send({ text: "hello there" });
  assert.deepEqual(sent, [
    JSON.stringify({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello there" }],
      },
      parent_tool_use_id: null,
    }),
  ]);
});

test("send with an empty images array also writes the exact historical wire bytes", async () => {
  const { binding, sent } = fakeBinding();
  await binding.send({ text: "hello there", images: [] });
  assert.deepEqual(sent, [
    JSON.stringify({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello there" }],
      },
      parent_tool_use_id: null,
    }),
  ]);
});

test("send with a legal image attaches an image content block after the text block", async () => {
  const { binding, sent } = fakeBinding();
  await binding.send({
    text: "read the page image",
    images: [{ mediaType: "image/png", base64: onePixelPngBase64 }],
  });
  assert.equal(sent.length, 1);
  const written = JSON.parse(sent[0]!);
  assert.deepEqual(written.message.content, [
    { type: "text", text: "read the page image" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: onePixelPngBase64 },
    },
  ]);
});

test("send accepts the maximum image count", async () => {
  const { binding, sent } = fakeBinding();
  const images = Array.from({ length: RUNTIME_INPUT_IMAGE_MAX_COUNT }, () => ({
    mediaType: "image/png" as const,
    base64: onePixelPngBase64,
  }));
  await binding.send({ text: "many pages", images });
  const written = JSON.parse(sent[0]!);
  assert.equal(written.message.content.length, 1 + RUNTIME_INPUT_IMAGE_MAX_COUNT);
});

test("send rejects one more image than the cap, invalid-input, before any wire bytes", async () => {
  const { binding, sent, stops } = fakeBinding();
  const images = Array.from({ length: RUNTIME_INPUT_IMAGE_MAX_COUNT + 1 }, () => ({
    mediaType: "image/png" as const,
    base64: onePixelPngBase64,
  }));
  await assert.rejects(
    binding.send({ text: "too many pages", images }),
    (error: unknown) => (error as { category?: string }).category === "invalid-input",
  );
  assert.deepEqual(sent, []);
  assert.equal(stops, 0);
});

test("send rejects an image over the per-image byte cap, invalid-input, before any wire bytes", async () => {
  const { binding, sent } = fakeBinding();
  const oversizedBase64 = Buffer.alloc(RUNTIME_INPUT_IMAGE_MAX_BYTES + 1).toString("base64");
  await assert.rejects(
    binding.send({
      text: "oversized page",
      images: [{ mediaType: "image/png", base64: oversizedBase64 }],
    }),
    (error: unknown) => (error as { category?: string }).category === "invalid-input",
  );
  assert.deepEqual(sent, []);
});

test("send accepts an image exactly at the per-image byte cap", async () => {
  const { binding, sent } = fakeBinding();
  const exactBase64 = Buffer.alloc(RUNTIME_INPUT_IMAGE_MAX_BYTES).toString("base64");
  await binding.send({
    text: "exact size page",
    images: [{ mediaType: "image/png", base64: exactBase64 }],
  });
  assert.equal(sent.length, 1);
});

test("send rejects an unrecognized media type, invalid-input, before any wire bytes", async () => {
  const { binding, sent } = fakeBinding();
  const input = {
    text: "bad media type",
    images: [{ mediaType: "image/gif", base64: onePixelPngBase64 }],
  } as unknown as RuntimeInput;
  await assert.rejects(
    binding.send(input),
    (error: unknown) => (error as { category?: string }).category === "invalid-input",
  );
  assert.deepEqual(sent, []);
});

test("steer keeps its pre-existing strict text-only contract: an images-carrying input is still rejected", async () => {
  const { binding, sent } = fakeBinding();
  // steerAvailability requires a started session identity; reaching invalid-input
  // for a shape violation happens before that check, same as the pre-existing
  // isRuntimeInput guard steer has always used.
  const steerInput = {
    text: "steer with an image",
    images: [{ mediaType: "image/png", base64: onePixelPngBase64 }],
  } as unknown as RuntimeInput;
  await assert.rejects(
    binding.steer(steerInput),
    (error: unknown) => (error as { category?: string }).category === "invalid-input",
  );
  assert.deepEqual(sent, []);
});
