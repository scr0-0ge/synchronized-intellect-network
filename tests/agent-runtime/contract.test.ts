import assert from "node:assert/strict";
import test from "node:test";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";

const profile: SessionProfile = {
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
};

class FakeBinding implements ResumableRuntimeBinding {
  readonly profile = profile;
  readonly opaqueSessionReference = "opaque-fixed";
  private sent = false;

  async send(input: RuntimeInput): Promise<void> {
    assert.equal(input.text, "fixed input");
    this.sent = true;
  }

  async *events(): AsyncIterable<NormalizedRuntimeEvent> {
    assert.equal(this.sent, true);
    yield { kind: "session-started" };
    yield { kind: "turn-started" };
    yield { kind: "item-started", itemType: "agent-message" };
    yield { kind: "item-completed", itemType: "agent-message" };
    yield { kind: "agent-message", text: "FIXED_MARKER" };
    yield {
      kind: "turn-completed",
      status: "completed",
      context: {
        basis: "active-context",
        usedTokens: 144,
        windowTokens: 258_400,
      },
    };
  }
}

class FakeAdapter implements ResumableAgentRuntimeAdapter {
  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    return {
      runtime: "codex",
      models: [{ id: "gpt-5.6-sol", effortLevels: ["ultra"] }],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    assert.deepEqual(request.profile, profile);
    return new FakeBinding();
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    assert.deepEqual(request.profile, profile);
    assert.equal(request.opaqueSessionReference.length > 0, true);
    return new FakeBinding();
  }
}

test("a caller can use the runtime-neutral catalog and start/resume bindings", async () => {
  const adapter: ResumableAgentRuntimeAdapter = new FakeAdapter();
  const catalog = await adapter.inspect("synthetic-project");
  assert.equal(catalog.models[0]?.id, "gpt-5.6-sol");

  const binding = await adapter.start({
    projectDirectory: "synthetic-project",
    profile,
  });
  await binding.send({ text: "fixed input" });

  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of binding.events()) events.push(event);
  assert.deepEqual(events.at(-1), {
    kind: "turn-completed",
    status: "completed",
    context: {
      basis: "active-context",
      usedTokens: 144,
      windowTokens: 258_400,
    },
  });

  const resumed = await adapter.resume({
    projectDirectory: "synthetic-project",
    profile,
    opaqueSessionReference: binding.opaqueSessionReference,
  });
  assert.notEqual(resumed, binding);
  assert.equal(resumed.opaqueSessionReference === binding.opaqueSessionReference, true);
  await resumed.send({ text: "fixed input" });
  const resumedEvents: NormalizedRuntimeEvent[] = [];
  for await (const event of resumed.events()) resumedEvents.push(event);
  assert.deepEqual(resumedEvents.at(-1), {
    kind: "turn-completed",
    status: "completed",
    context: {
      basis: "active-context",
      usedTokens: 144,
      windowTokens: 258_400,
    },
  });
});
