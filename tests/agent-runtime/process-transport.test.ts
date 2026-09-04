import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type {
  CodexExecutableDiscoveryResult,
  CodexExecutableHandle,
} from "../../src/agent-runtime/codex/executable-discovery.ts";
import {
  createOfficialCodexTransport,
  removeCodexCleanupDirectory,
  stageCodexRuntime,
  type CodexTransportDiagnostic,
  type CodexProcessTransportDependencies,
} from "../../src/agent-runtime/codex/process-transport.ts";
import { CodexJsonlPeer } from "../../src/agent-runtime/codex/protocol.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";

test("transport matrix: not-located and ambiguous discovery never spawn or stage [8 assertions]", async () => {
  for (const kind of ["not-located", "ambiguous"] as const) {
    const dependencies = new FakeTransportDependencies({ kind });

    await assert.rejects(createOfficialCodexTransport(dependencies), (error) => {
      return error instanceof RuntimeAdapterError && error.category === "runtime-not-located";
    });
    assert.equal(dependencies.discoveryCalls, 1);
    assert.equal(dependencies.launchCalls, 0);
    assert.equal(dependencies.stageCalls, 0);
  }
});

test("transport matrix: a located candidate with a non-access spawn failure preserves runtime-unavailable and records the discarded cause", async () => {
  const dependencies = new FakeTransportDependencies(located());
  dependencies.launchResults.push(nativeFailure("ENOENT"));

  await assert.rejects(createOfficialCodexTransport(dependencies), (error) => {
    return error instanceof RuntimeAdapterError && error.category === "runtime-unavailable";
  });
  assert.equal(dependencies.discoveryCalls, 1);
  assert.equal(dependencies.launchCalls, 1);
  assert.equal(dependencies.stageCalls, 0);
  assert.equal(dependencies.cleanupCalls, 0);
  assert.deepEqual(dependencies.diagnostics, [
    {
      kind: "direct-launch-failed",
      errorCode: "ENOENT",
      fallbackEligible: false,
    },
  ]);
});

test("transport matrix: access failure stages once and removes the cleanup directory on stop [8 assertions]", async () => {
  const dependencies = new FakeTransportDependencies(located());
  dependencies.launchResults.push(nativeFailure("EACCES"), fakeChild());

  const transport = await createOfficialCodexTransport(dependencies);

  assert.equal(dependencies.discoveryCalls, 1);
  assert.equal(dependencies.launchCalls, 2);
  assert.equal(dependencies.stageCalls, 1);
  assert.equal(dependencies.cleanupCalls, 0);
  assert.notEqual(dependencies.launchedHandles[0], dependencies.launchedHandles[1]);
  await transport.stop();
  assert.equal(dependencies.cleanupCalls, 1);
  assert.deepEqual(dependencies.cleanedDirectories, ["opaque-cleanup-directory"]);
  assert.equal(dependencies.spawnedProcesses, 1);
  assert.deepEqual(dependencies.diagnostics, [
    {
      kind: "direct-launch-failed",
      errorCode: "EACCES",
      fallbackEligible: true,
    },
    { kind: "staging-started" },
    {
      kind: "staging-succeeded",
      files: ["codex.exe", "codex-code-mode-host.exe"],
    },
    { kind: "staged-launch-succeeded" },
    { kind: "cleanup-succeeded" },
  ]);
});

test("staging fallback preserves the code-mode helper required by tool calls", async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "codex-runtime-source-"));
  const sourceExecutable = join(sourceDirectory, "codex.exe");
  const helperBytes = Buffer.from("synthetic code-mode helper", "utf8");
  await writeFile(sourceExecutable, "synthetic codex executable", "utf8");
  await writeFile(join(sourceDirectory, "codex-code-mode-host.exe"), helperBytes);

  let cleanupDirectory: string | undefined;
  try {
    const staged = await stageCodexRuntime(sourceExecutable);
    cleanupDirectory = staged.cleanupDirectory;
    assert.deepEqual(staged.stagedFiles, [
      "codex.exe",
      "codex-code-mode-host.exe",
    ]);
    assert.deepEqual(
      await readFile(join(cleanupDirectory, "codex-code-mode-host.exe")),
      helperBytes,
    );
  } finally {
    if (cleanupDirectory !== undefined) {
      await removeCodexCleanupDirectory(cleanupDirectory);
    }
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

test("staging fallback copies the recognized runtime companion set and no unrelated sibling", async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "codex-runtime-source-"));
  const sourceFiles = new Map<string, Buffer>([
    ["codex.exe", Buffer.from("codex", "utf8")],
    ["codex-code-mode-host.exe", Buffer.from("code mode", "utf8")],
    ["codex-command-runner.exe", Buffer.from("command runner", "utf8")],
    ["codex-windows-sandbox-setup.exe", Buffer.from("sandbox setup", "utf8")],
    ["rg.exe", Buffer.from("ripgrep", "utf8")],
  ]);
  for (const [name, bytes] of sourceFiles) {
    await writeFile(join(sourceDirectory, name), bytes);
  }
  await writeFile(join(sourceDirectory, "unrelated.exe"), "unrelated", "utf8");

  let cleanupDirectory: string | undefined;
  try {
    const staged = await stageCodexRuntime(join(sourceDirectory, "codex.exe"));
    cleanupDirectory = staged.cleanupDirectory;
    assert.deepEqual(staged.stagedFiles, [...sourceFiles.keys()]);
    for (const [name, bytes] of sourceFiles) {
      assert.deepEqual(await readFile(join(cleanupDirectory, name)), bytes, name);
    }
    await assert.rejects(readFile(join(cleanupDirectory, "unrelated.exe")), {
      code: "ENOENT",
    });
  } finally {
    if (cleanupDirectory !== undefined) {
      await removeCodexCleanupDirectory(cleanupDirectory);
    }
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

test("staging fallback fails closed when the tool-call helper is absent", async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "codex-runtime-source-"));
  const sourceExecutable = join(sourceDirectory, "codex.exe");
  await writeFile(sourceExecutable, "synthetic codex executable", "utf8");

  try {
    await assert.rejects(stageCodexRuntime(sourceExecutable), (error) => {
      return (
        error instanceof RuntimeAdapterError &&
        error.category === "runtime-unavailable" &&
        error.stack === "RuntimeAdapterError: Agent Runtime operation failed."
      );
    });
  } finally {
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

test("Codex request writer emits the exact UTF-8 bytes for Chinese input", async () => {
  const child = fakeChild();
  const dependencies = new FakeTransportDependencies(located());
  dependencies.launchResults.push(child);
  const transport = await createOfficialCodexTransport(dependencies);
  const peer = new CodexJsonlPeer(transport);
  const exactInput = "用中文回答一下试试";
  const outboundChunk = new Promise<Buffer>((resolve) => {
    child.stdin.once("data", (chunk: Buffer) => resolve(Buffer.from(chunk)));
  });

  const response = peer.request("turn/start", {
    threadId: "thread-fixed",
    input: [{ type: "text", text: exactInput }],
  });
  const outbound = await outboundChunk;
  const expectedOutbound = Buffer.from(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "turn/start",
      params: {
        threadId: "thread-fixed",
        input: [{ type: "text", text: exactInput }],
      },
    })}\n`,
    "utf8",
  );
  assert.deepEqual(outbound, expectedOutbound);

  (child.stdout as PassThrough).write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`,
  );
  assert.deepEqual(await response, {});
  await peer.stop();
});

test("Codex response reader preserves Chinese JSON split inside one UTF-8 character", async () => {
  const child = fakeChild();
  const dependencies = new FakeTransportDependencies(located());
  dependencies.launchResults.push(child);
  const transport = await createOfficialCodexTransport(dependencies);
  const peer = new CodexJsonlPeer(transport);
  const exactResponse = "中文响应保持原样";
  const response = peer.request("synthetic/read", { text: "ASCII input" });

  const responseBytes = Buffer.from(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: exactResponse } })}\n`,
    "utf8",
  );
  const splitCharacter = Buffer.from("响", "utf8");
  const characterOffset = responseBytes.indexOf(splitCharacter);
  assert.notEqual(characterOffset, -1);
  const splitOffset = characterOffset + 1;
  (child.stdout as PassThrough).write(responseBytes.subarray(0, splitOffset));
  await new Promise<void>((resolve) => setImmediate(resolve));
  (child.stdout as PassThrough).write(responseBytes.subarray(splitOffset));

  assert.deepEqual(await response, { text: exactResponse });
  await peer.stop();
});

test("Codex stdio preserves an ASCII control round trip", async () => {
  const child = fakeChild();
  const dependencies = new FakeTransportDependencies(located());
  dependencies.launchResults.push(child);
  const transport = await createOfficialCodexTransport(dependencies);
  const peer = new CodexJsonlPeer(transport);
  const exactInput = "answer in English";
  const exactResponse = "ASCII response remains exact";
  const outboundChunk = new Promise<Buffer>((resolve) => {
    child.stdin.once("data", (chunk: Buffer) => resolve(Buffer.from(chunk)));
  });

  const response = peer.request("synthetic/roundTrip", { text: exactInput });
  assert.deepEqual(
    await outboundChunk,
    Buffer.from(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "synthetic/roundTrip",
        params: { text: exactInput },
      })}\n`,
      "utf8",
    ),
  );
  (child.stdout as PassThrough).write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: exactResponse } })}\n`,
  );

  assert.deepEqual(await response, { text: exactResponse });
  await peer.stop();
});

test("transport matrix: failed staging reports a fixed failure after its private cleanup [6 assertions]", async () => {
  const dependencies = new FakeTransportDependencies(located());
  dependencies.launchResults.push(nativeFailure("EPERM"));
  dependencies.failStaging = true;

  await assert.rejects(createOfficialCodexTransport(dependencies), (error) => {
    return error instanceof RuntimeAdapterError && error.category === "runtime-unavailable";
  });
  assert.equal(dependencies.discoveryCalls, 1);
  assert.equal(dependencies.launchCalls, 1);
  assert.equal(dependencies.stageCalls, 1);
  assert.equal(dependencies.stageInternalCleanupCalls, 1);
  assert.equal(dependencies.cleanupCalls, 0);
  assert.deepEqual(dependencies.diagnostics, [
    {
      kind: "direct-launch-failed",
      errorCode: "EPERM",
      fallbackEligible: true,
    },
    { kind: "staging-started" },
    { kind: "staging-failed", reason: "runtime-unavailable" },
  ]);
});

test("transport matrix: a staged launch failure removes the cleanup directory and reports a fixed failure [7 assertions]", async () => {
  const dependencies = new FakeTransportDependencies(located());
  dependencies.launchResults.push(nativeFailure("EACCES"), nativeFailure("ENOEXEC"));

  await assert.rejects(createOfficialCodexTransport(dependencies), (error) => {
    return error instanceof RuntimeAdapterError && error.category === "runtime-unavailable";
  });
  assert.equal(dependencies.discoveryCalls, 1);
  assert.equal(dependencies.launchCalls, 2);
  assert.equal(dependencies.stageCalls, 1);
  assert.equal(dependencies.stageInternalCleanupCalls, 0);
  assert.equal(dependencies.cleanupCalls, 1);
  assert.deepEqual(dependencies.cleanedDirectories, ["opaque-cleanup-directory"]);
  assert.deepEqual(dependencies.diagnostics, [
    {
      kind: "direct-launch-failed",
      errorCode: "EACCES",
      fallbackEligible: true,
    },
    { kind: "staging-started" },
    {
      kind: "staging-succeeded",
      files: ["codex.exe", "codex-code-mode-host.exe"],
    },
    { kind: "staged-launch-failed", errorCode: "ENOEXEC" },
    { kind: "cleanup-succeeded" },
  ]);
});

test("a forced staged shutdown succeeds when termination, exit, and cleanup all succeed", async () => {
  const dependencies = new FakeTransportDependencies(located());
  let killCalls = 0;
  dependencies.launchResults.push(
    nativeFailure("EACCES"),
    fakeChild({
      running: true,
      onKill: () => {
        killCalls += 1;
      },
    }),
  );
  dependencies.waitForExitResults.push(false, true);

  const transport = await createOfficialCodexTransport(dependencies);
  await transport.stop();

  assert.equal(killCalls, 1);
  assert.equal(dependencies.waitForExitCalls, 2);
  assert.deepEqual(dependencies.cleanedDirectories, ["opaque-cleanup-directory"]);
  assert.deepEqual(dependencies.diagnostics.slice(-2), [
    { kind: "shutdown-forced", gracefulWaitMilliseconds: 5_000 },
    { kind: "cleanup-succeeded" },
  ]);
});

test("a staged cleanup failure keeps its fixed public category and a private diagnostic reason", async () => {
  const dependencies = new FakeTransportDependencies(located());
  dependencies.launchResults.push(nativeFailure("EACCES"), fakeChild());
  dependencies.cleanupFailure = new RuntimeAdapterError("temp-cleanup");

  const transport = await createOfficialCodexTransport(dependencies);
  await assert.rejects(transport.stop(), (error) => {
    return error instanceof RuntimeAdapterError && error.category === "temp-cleanup";
  });
  assert.deepEqual(dependencies.diagnostics.at(-1), {
    kind: "cleanup-failed",
    reason: "temp-cleanup",
  });
});

test("temporary executable cleanup accepts only its exact OS-temp child shape", async () => {
  const invalidDirectory = await mkdtemp(join(tmpdir(), "worker6-invalid-"));
  const validDirectory = join(tmpdir(), `codex-adapter-${randomUUID().replaceAll("-", "")}`);
  await mkdir(validDirectory);
  await writeFile(join(validDirectory, "synthetic.exe"), "synthetic", "utf8");

  try {
    await assert.rejects(removeCodexCleanupDirectory(invalidDirectory), (error) => {
      if (!(error instanceof RuntimeAdapterError)) return false;
      return error.category === "temp-cleanup-guard" && !error.stack?.includes(invalidDirectory);
    });
    assert.equal((await stat(invalidDirectory)).isDirectory(), true);

    await removeCodexCleanupDirectory(validDirectory);
    await assert.rejects(stat(validDirectory), { code: "ENOENT" });
  } finally {
    await rm(invalidDirectory, { recursive: true, force: true });
    await rm(validDirectory, { recursive: true, force: true });
  }
});

test("temporary executable cleanup retries transient locks with deterministic backoff", async () => {
  const validDirectory = join(
    tmpdir(),
    `codex-adapter-${randomUUID().replaceAll("-", "")}`,
  );
  await mkdir(validDirectory);
  await writeFile(join(validDirectory, "codex-code-mode-host.exe"), "synthetic", "utf8");
  let removeCalls = 0;
  const waits: number[] = [];

  try {
    await removeCodexCleanupDirectory(validDirectory, {
      async removeDirectory(directory) {
        removeCalls += 1;
        if (removeCalls <= 2) {
          throw Object.assign(new Error("PRIVATE_TRANSIENT_LOCK"), { code: "EPERM" });
        }
        await rm(directory, { recursive: true, force: false });
      },
      async wait(milliseconds) {
        waits.push(milliseconds);
      },
    });
    assert.equal(removeCalls, 3);
    assert.deepEqual(waits, [100, 200]);
    await assert.rejects(stat(validDirectory), { code: "ENOENT" });
  } finally {
    await rm(validDirectory, { recursive: true, force: true });
  }
});

class FakeTransportDependencies implements CodexProcessTransportDependencies {
  discoveryCalls = 0;
  launchCalls = 0;
  stageCalls = 0;
  cleanupCalls = 0;
  stageInternalCleanupCalls = 0;
  spawnedProcesses = 0;
  failStaging = false;
  readonly launchResults: (ChildProcessWithoutNullStreams | Error)[] = [];
  readonly launchedHandles: CodexExecutableHandle[] = [];
  readonly cleanedDirectories: string[] = [];
  readonly diagnostics: CodexTransportDiagnostic[] = [];
  readonly waitForExitResults: boolean[] = [];
  waitForExitCalls = 0;
  cleanupFailure: Error | undefined;
  readonly discoveryResult: CodexExecutableDiscoveryResult;

  constructor(discoveryResult: CodexExecutableDiscoveryResult) {
    this.discoveryResult = discoveryResult;
  }

  async discoverExecutable(): Promise<CodexExecutableDiscoveryResult> {
    this.discoveryCalls += 1;
    return this.discoveryResult;
  }

  async launchExecutable(
    executable: CodexExecutableHandle,
  ): Promise<ChildProcessWithoutNullStreams> {
    this.launchCalls += 1;
    this.launchedHandles.push(executable);
    const result = this.launchResults.shift();
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error("PRIVATE_FAKE_LAUNCH_RESULT_MISSING");
    this.spawnedProcesses += 1;
    return result;
  }

  async stageExecutable(): Promise<{
    readonly executable: CodexExecutableHandle;
    readonly cleanupDirectory: string;
    readonly stagedFiles: readonly string[];
  }> {
    this.stageCalls += 1;
    if (this.failStaging) {
      this.stageInternalCleanupCalls += 1;
      throw new RuntimeAdapterError("runtime-unavailable");
    }
    return {
      executable: handle(),
      cleanupDirectory: "opaque-cleanup-directory",
      stagedFiles: ["codex.exe", "codex-code-mode-host.exe"],
    };
  }

  async removeCleanupDirectory(directory: string): Promise<void> {
    this.cleanupCalls += 1;
    this.cleanedDirectories.push(directory);
    if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
  }

  recordDiagnostic(diagnostic: CodexTransportDiagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  async waitForExit(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    this.waitForExitCalls += 1;
    return (
      this.waitForExitResults.shift() ??
      (child.exitCode !== null || child.signalCode !== null)
    );
  }
}

function located(): CodexExecutableDiscoveryResult {
  return { kind: "located", executable: handle() };
}

function handle(): CodexExecutableHandle {
  return Object.freeze({}) as CodexExecutableHandle;
}

function nativeFailure(code: string): Error {
  return Object.assign(new Error("PRIVATE_NATIVE_FAILURE"), { code });
}

function fakeChild(
  options: { readonly running?: boolean; readonly onKill?: () => void } = {},
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(): boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = options.running === true ? null : 0;
  child.signalCode = null;
  child.kill = () => {
    options.onKill?.();
    if (options.running === true) child.signalCode = "SIGTERM";
    return true;
  };
  return child as unknown as ChildProcessWithoutNullStreams;
}
