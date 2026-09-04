import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  FIXED_CODEX_WEB_TOOL_INSTRUCTION,
  readCodexWebToolProductionEvidence,
  runCodexWebToolProduction,
} from "../e2e/codex-web-tool-production.ts";
import { ScriptedTransport } from "../agent-runtime/support/scripted-transport.ts";

const publicTitle = "A public OpenAI announcement";
const publicUrl = "https://openai.com/index/a-public-openai-announcement/";
const fixtureTimeoutMilliseconds = 15_000;

test("production driver proves one webSearch turn through the public Workbench seam", async () => {
  const controlRoot = await mkdtemp(
    join(resolve(tmpdir()), "worker-224-web-tool-test-"),
  );
  const evidencePath = join(controlRoot, "evidence.json");
  const diagnosticFilePath = join(controlRoot, "transport.jsonl");
  const allTransports = [
    new ScriptedTransport(catalogLifecycle()),
    new ScriptedTransport(catalogLifecycle()),
    new ScriptedTransport(successfulWebSearchLifecycle()),
  ];
  const transports = [...allTransports];
  const createdRoots: string[] = [];

  try {
    const result = await runCodexWebToolProduction({
      createTransport: async () => {
        await appendFile(
          diagnosticFilePath,
          `${JSON.stringify({
            recordedAt: "2026-08-13T00:00:00.000Z",
            kind: "direct-launch-succeeded",
          })}\n`,
          "utf8",
        );
        const transport = transports.shift();
        if (transport === undefined) {
          assert.fail("unexpected transport creation");
        }
        return transport;
      },
      diagnosticFilePath,
      evidencePath,
      stagingParentDirectory: controlRoot,
      temporaryParentDirectory: controlRoot,
      timeoutMilliseconds: fixtureTimeoutMilliseconds,
      onTemporaryRootCreated: (root) => createdRoots.push(root),
    });

    if (!result.ok) assert.fail(`unexpected failure category: ${result.category}`);
    assert.deepEqual(result.evidence, expectedEvidence());
    assert.equal(createdRoots.length, 1);
    await assertPathMissing(createdRoots[0]!);

    const evidenceBytes = await readFile(evidencePath);
    assert.deepEqual(result.seal, {
      bytes: evidenceBytes.byteLength,
      sha256: createHash("sha256").update(evidenceBytes).digest("hex"),
    });
    assert.deepEqual(
      await readCodexWebToolProductionEvidence(evidencePath),
      expectedEvidence(),
    );

    const serialized = evidenceBytes.toString("utf8");
    for (const forbidden of [
      FIXED_CODEX_WEB_TOOL_INSTRUCTION,
      controlRoot,
      "thread-worker-224",
      "turn-worker-224",
      "web-search-worker-224",
      "agent-message-worker-224",
      "jsonrpc",
      "tokenUsage",
      "gpt-5.6-sol",
      "recordedAt",
      "errorCode",
      "fallbackEligible",
    ]) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        `evidence must exclude ${forbidden}`,
      );
    }

    assert.deepEqual(
      allTransports.map((transport) => transport.recordedStopCalls()),
      [1, 1, 1],
    );
    const outboundProtocol = allTransports.flatMap((transport) =>
      transport.recordedOutboundJsonl().map(
        (message) => JSON.parse(message) as {
          readonly method?: string;
          readonly params?: { readonly input?: unknown };
        },
      ),
    );
    const turnStart = outboundProtocol.find(
      (message) => message.method === "turn/start",
    );
    assert.deepEqual(turnStart?.params?.input, [
      { type: "text", text: FIXED_CODEX_WEB_TOOL_INSTRUCTION },
    ]);
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("a missing webSearch stops after one lifecycle, retains the root, and writes no evidence", async () => {
  const controlRoot = await mkdtemp(
    join(resolve(tmpdir()), "worker-224-web-tool-failure-test-"),
  );
  const evidencePath = join(controlRoot, "evidence.json");
  const diagnosticFilePath = join(controlRoot, "transport.jsonl");
  const allTransports = [
    new ScriptedTransport(catalogLifecycle()),
    new ScriptedTransport(catalogLifecycle()),
    new ScriptedTransport(
      successfulWebSearchLifecycle().filter((serialized) => {
        const message = JSON.parse(serialized) as {
          readonly params?: { readonly item?: { readonly type?: string } };
        };
        return message.params?.item?.type !== "webSearch";
      }),
    ),
  ];
  const transports = [...allTransports];
  const createdRoots: string[] = [];
  let transportCreations = 0;

  try {
    const result = await runCodexWebToolProduction({
      createTransport: async () => {
        transportCreations += 1;
        await appendFile(
          diagnosticFilePath,
          `${JSON.stringify({ kind: "direct-launch-succeeded" })}\n`,
          "utf8",
        );
        const transport = transports.shift();
        if (transport === undefined) assert.fail("unexpected transport creation");
        return transport;
      },
      diagnosticFilePath,
      evidencePath,
      stagingParentDirectory: controlRoot,
      temporaryParentDirectory: controlRoot,
      timeoutMilliseconds: fixtureTimeoutMilliseconds,
      onTemporaryRootCreated: (root) => createdRoots.push(root),
    });

    assert.deepEqual(result, {
      ok: false,
      category: "web-search-not-observed",
      rootRetained: true,
      diagnosticArtifact: { retained: false },
    });
    assert.equal(transportCreations, 3, "the driver must not retry a live turn");
    assert.deepEqual(
      allTransports.map((transport) => transport.recordedStopCalls()),
      [1, 1, 1],
    );
    assert.equal(createdRoots.length, 1);
    await access(createdRoots[0]!);
    await assertPathMissing(evidencePath);
    await assertPathMissing(`${evidencePath}.retained.json`);
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("a post-root publication failure retains one exact non-PASS diagnostic artifact", async () => {
  const controlRoot = await mkdtemp(
    join(resolve(tmpdir()), "worker-224-web-tool-publication-test-"),
  );
  const evidencePath = join(controlRoot, "evidence.json");
  const retainedPath = `${evidencePath}.retained.json`;
  const diagnosticFilePath = join(controlRoot, "transport.jsonl");
  const allTransports = [
    new ScriptedTransport(catalogLifecycle()),
    new ScriptedTransport(catalogLifecycle()),
    new ScriptedTransport(successfulWebSearchLifecycle()),
  ];
  const transports = [...allTransports];
  const createdRoots: string[] = [];

  try {
    const result = await runCodexWebToolProduction({
      createTransport: async () => {
        await appendFile(
          diagnosticFilePath,
          `${JSON.stringify({ kind: "direct-launch-succeeded" })}\n`,
          "utf8",
        );
        const transport = transports.shift();
        if (transport === undefined) assert.fail("unexpected transport creation");
        return transport;
      },
      diagnosticFilePath,
      evidencePath,
      stagingParentDirectory: controlRoot,
      temporaryParentDirectory: controlRoot,
      timeoutMilliseconds: fixtureTimeoutMilliseconds,
      onTemporaryRootCreated: (root) => createdRoots.push(root),
      publishFinalEvidence: async (pendingPath, finalPath) => {
        assert.equal(createdRoots.length, 1);
        await assertPathMissing(createdRoots[0]!);
        await rename(pendingPath, finalPath);
        throw new Error("controlled-post-rename-reopen-failure");
      },
    });

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("publication failure unexpectedly passed");
    assert.equal(result.category, "evidence-write");
    assert.equal(result.rootRetained, false);
    assert.equal(result.diagnosticArtifact.retained, true);
    if (!result.diagnosticArtifact.retained) {
      assert.fail("missing retained diagnostic seal");
    }

    assert.equal(createdRoots.length, 1);
    await assertPathMissing(createdRoots[0]!);
    await assertPathMissing(evidencePath);
    const retainedBytes = await readFile(retainedPath);
    assert.deepEqual(result.diagnosticArtifact, {
      retained: true,
      bytes: retainedBytes.byteLength,
      sha256: createHash("sha256").update(retainedBytes).digest("hex"),
    });
    assert.deepEqual(
      JSON.parse(retainedBytes.toString("utf8")),
      expectedRetainedDiagnostic(),
    );

    const serialized = retainedBytes.toString("utf8");
    for (const forbidden of [
      "\"result\": \"passed\"",
      "controlled-post-rename-reopen-failure",
      FIXED_CODEX_WEB_TOOL_INSTRUCTION,
      controlRoot,
      "thread-worker-224",
      "turn-worker-224",
      "jsonrpc",
      "errorCode",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.deepEqual(
      allTransports.map((transport) => transport.recordedStopCalls()),
      [1, 1, 1],
    );
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("public evidence rejects C0/C1 controls and overlong titles before root cleanup", async () => {
  const unsafeTitles = [
    "C0\u0007title",
    "C1\u0085title",
    "T".repeat(301),
  ] as const;

  for (const [caseNumber, title] of unsafeTitles.entries()) {
    const controlRoot = await mkdtemp(
      join(resolve(tmpdir()), `worker-224-web-tool-title-${caseNumber}-`),
    );
    const evidencePath = join(controlRoot, "evidence.json");
    const diagnosticFilePath = join(controlRoot, "transport.jsonl");
    const allTransports = [
      new ScriptedTransport(catalogLifecycle()),
      new ScriptedTransport(catalogLifecycle()),
      new ScriptedTransport(successfulWebSearchLifecycle(title)),
    ];
    const transports = [...allTransports];
    const createdRoots: string[] = [];

    try {
      const result = await runCodexWebToolProduction({
        createTransport: async () => {
          await appendFile(
            diagnosticFilePath,
            `${JSON.stringify({ kind: "direct-launch-succeeded" })}\n`,
            "utf8",
          );
          const transport = transports.shift();
          if (transport === undefined) {
            assert.fail("unexpected transport creation");
          }
          return transport;
        },
        diagnosticFilePath,
        evidencePath,
        stagingParentDirectory: controlRoot,
        temporaryParentDirectory: controlRoot,
        timeoutMilliseconds: fixtureTimeoutMilliseconds,
        onTemporaryRootCreated: (root) => createdRoots.push(root),
      });

      assert.deepEqual(result, {
        ok: false,
        category: "agent-message-invalid",
        rootRetained: true,
        diagnosticArtifact: { retained: false },
      });
      assert.equal(createdRoots.length, 1);
      await access(createdRoots[0]!);
      await assertPathMissing(evidencePath);
      await assertPathMissing(`${evidencePath}.retained.json`);
      assert.deepEqual(
        allTransports.map((transport) => transport.recordedStopCalls()),
        [1, 1, 1],
      );
    } finally {
      await rm(controlRoot, { recursive: true, force: false });
    }
  }
});

test("reopened evidence fails closed on extra fields and contradictory fixed counts", async () => {
  const controlRoot = await mkdtemp(
    join(resolve(tmpdir()), "worker-224-web-tool-schema-test-"),
  );
  try {
    const variants: Array<
      readonly [string, (artifact: Record<string, unknown>) => void]
    > = [
      ["root-extra", (artifact) => {
        artifact.rawReply = "must-not-be-admitted";
      }],
      ["web-search-count", (artifact) => {
        nestedRecord(artifact, "observations", "protocol").webSearchStarted = 3;
      }],
      ["transport-route-count", (artifact) => {
        nestedRecord(artifact, "transportDiagnostics").directLaunchSucceeded = 2;
      }],
    ];

    for (const [name, mutate] of variants) {
      const artifact = structuredClone(expectedEvidence()) as unknown as Record<
        string,
        unknown
      >;
      mutate(artifact);
      const path = join(controlRoot, `${name}.json`);
      await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      await assert.rejects(
        readCodexWebToolProductionEvidence(path),
        /codex-web-tool-production-evidence-invalid/u,
      );
    }
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

function expectedEvidence() {
  return {
    schema: "codex-web-tool-production-v1" as const,
    source: "production-codex-subscription" as const,
    result: "passed" as const,
    observations: {
      durableAccepted: true as const,
      terminalCompleted: true as const,
      protocol: {
        itemStarted: 2,
        itemCompleted: 2,
        turnCompleted: 1,
        approvalRequests: 0,
        webSearchStarted: 1,
        webSearchCompleted: 1,
      },
      finalAgentMessages: 1 as const,
      title: publicTitle,
      url: publicUrl,
      projectManifestUnchanged: true as const,
    },
    lifecycle: {
      transportsCreated: 3,
      transportsStopped: 3,
      transportsActive: 0,
      transportStopFailures: 0,
      backendClosed: true as const,
      observationDisposed: true as const,
      stagingNewResidue: 0,
      guardedRootRemoved: true as const,
    },
    transportDiagnostics: {
      directLaunchSucceeded: 3,
      directLaunchFailed: 0,
      stagingStarted: 0,
      stagingSucceeded: 0,
      stagingFailed: 0,
      stagedLaunchSucceeded: 0,
      stagedLaunchFailed: 0,
      shutdownForced: 0,
      cleanupSucceeded: 0,
      cleanupFailed: 0,
    },
  };
}

function expectedRetainedDiagnostic() {
  const evidence = expectedEvidence();
  return {
    schema: "codex-web-tool-production-retained-v1",
    source: evidence.source,
    result: "final-pass-not-reopened",
    observations: evidence.observations,
    lifecycle: {
      transportsCreated: 3,
      transportsStopped: 3,
      transportsActive: 0,
      transportStopFailures: 0,
      backendClosed: true,
      observationDisposed: true,
      stagingNewResidue: 0,
      guardedRootRemovalReady: true,
    },
    transportDiagnostics: evidence.transportDiagnostics,
  };
}

function catalogLifecycle(): string[] {
  return [
    line({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    line({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    line({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [
          {
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            supportedReasoningEfforts: [
              { reasoningEffort: "ultra", description: "Ultra" },
            ],
          },
        ],
        nextCursor: null,
      },
    }),
  ];
}

function successfulWebSearchLifecycle(
  title: string = publicTitle,
  url: string = publicUrl,
): string[] {
  return [
    ...catalogLifecycle(),
    line({
      jsonrpc: "2.0",
      id: 4,
      result: {
        thread: { id: "thread-worker-224" },
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      },
    }),
    line({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "thread-worker-224" } },
    }),
    line({
      jsonrpc: "2.0",
      id: 5,
      result: { turn: { id: "turn-worker-224", status: "inProgress" } },
    }),
    line({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: "thread-worker-224",
        turn: { id: "turn-worker-224", status: "inProgress" },
      },
    }),
    line({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "thread-worker-224",
        turnId: "turn-worker-224",
        item: { id: "web-search-worker-224", type: "webSearch" },
      },
    }),
    line({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "thread-worker-224",
        turnId: "turn-worker-224",
        item: { id: "web-search-worker-224", type: "webSearch" },
      },
    }),
    line({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "thread-worker-224",
        turnId: "turn-worker-224",
        item: { id: "agent-message-worker-224", type: "agentMessage" },
      },
    }),
    line({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "thread-worker-224",
        turnId: "turn-worker-224",
        item: {
          id: "agent-message-worker-224",
          type: "agentMessage",
          phase: "final_answer",
          text: `TITLE: ${title}\nURL: ${url}`,
        },
      },
    }),
    line({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "thread-worker-224",
        turn: { id: "turn-worker-224", status: "completed" },
      },
    }),
  ];
}

function line(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function nestedRecord(
  root: Record<string, unknown>,
  ...keys: readonly string[]
): Record<string, unknown> {
  let value = root;
  for (const key of keys) {
    const next = value[key];
    assert.ok(typeof next === "object" && next !== null && !Array.isArray(next));
    value = next as Record<string, unknown>;
  }
  return value;
}

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(
    access(path),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}
