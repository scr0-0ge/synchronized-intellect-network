// Manual only: node tests/agent-runtime/live-kimi-platform/run.ts offline|live|prepare
// Opt-in live mode also requires UAW_W80_LIVE=kimi-platform; never a normal suite test.
import assert from "node:assert/strict";
import { existsSync, appendFileSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import solid from "vite-plugin-solid";
import { createViteBrowserTestServer } from "../../helpers/vite-server.ts";
import { CodexAdapter } from "../../../src/agent-runtime/codex-adapter.ts";
import { createKimiPlatformEndpointContext } from "../../../src/agent-runtime/codex/kimi-platform-catalog.ts";
import { resolveCodexEndpointProcessEnvironment } from "../../../src/agent-runtime/codex/endpoint-env-factory.ts";
import { createOfficialCodexTransport, discoverOfficialCodexLaunch } from "../../../src/agent-runtime/codex/process-transport.ts";
import { createWorkbenchBackend } from "../../../src/workbench-shell/backend.ts";
import { createProductionRuntimeEndpointAdapter } from "../../../src/workbench-shell/runtime-endpoint-composition.ts";
import { RuntimeAdapterError } from "../../../src/agent-runtime/index.ts";
import { startWire } from "./wire.ts";

const mode = process.argv[2];
assert.ok(["offline", "live", "prepare"].includes(mode));
const live = mode === "live";
const prepare = mode === "prepare";
const continuationOnly = process.argv.includes("--continuation-only");
const cancelOnly = process.argv.includes("--cancel-only");
const textGuidance = process.argv.includes("--text-guidance");
assert.ok(!(continuationOnly && cancelOnly));
assert.ok(!textGuidance || (!continuationOnly && !cancelOnly));
assert.ok(!live || process.env.UAW_W80_LIVE === "kimi-platform", "explicit live opt-in required");
const base = join(process.env.LOCALAPPDATA!, "uaw-w80");
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, `${mode}-`));
const temporary = join(root, "temp");
await mkdir(temporary);
process.env.TEMP = process.env.TMP = realpathSync(temporary);
const project = join(root, "project");
await mkdir(project);
const t0 = Date.now();
const logPath = join(root, "observations.jsonl");
function record(kind: string, value: unknown) {
  let row = JSON.stringify({ ms: Date.now() - t0, kind, value });
  const token = process.env.KIMI_PLATFORM_API_KEY;
  if (token) row = row.replaceAll(token, "[REDACTED]");
  appendFileSync(logPath, row + "\n");
  console.log(row);
}
record("setup", { mode, continuationOnly, cancelOnly, textGuidance, root, node: process.version, liveInferenceRequests: 0 });
const wire = await startWire(live, record, cancelOnly);
// Only machine plumbing is inherited. No GLM / Claude / OpenAI credentials or user config.
const sourceEnvironment: NodeJS.ProcessEnv = {};
for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "USERPROFILE", "HOME",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
  if (process.env[key] !== undefined) sourceEnvironment[key] = process.env[key];
}
sourceEnvironment.KIMI_PLATFORM_API_KEY = "w80-loopback-not-a-credential";
const endpoint = createKimiPlatformEndpointContext({
  codexHome: join(root, "cli"), baseUrl: wire.baseUrl, sourceEnvironment,
});
const launch = await discoverOfficialCodexLaunch();
const version = await promisify(execFile)(launch.executable, [...launch.prefixArguments, "--version"], { windowsHide: true });
record("cli", { executable: launch.executable, version: version.stdout.trim() });
let frames = 0, starts = 0, steers = 0;
let nativeThread: string | undefined;
let toolStarted = false;
const transports: { stop(): Promise<void> }[] = [];
const adapter = new CodexAdapter(async () => {
  await endpoint.prepareEndpoint?.();
  const environment = resolveCodexEndpointProcessEnvironment(sourceEnvironment, endpoint.environmentSource);
  const transport = await createOfficialCodexTransport(undefined, { environment });
  transports.push(transport);
  return {
    async send(line: string) {
      const value = JSON.parse(line);
      if (value.method === "thread/resume") assert.equal(value.params.threadId, nativeThread, "must resume the original native thread");
      if (["turn/start", "turn/steer"].includes(value.method)) {
        assert.ok(!prepare && frames < 5, "maximum five input frames");
        frames++;
        if (value.method === "turn/start") starts++; else steers++;
        record("input-frame", { ordinal: frames, value });
      } else if (["thread/start", "thread/resume", "turn/interrupt"].includes(value.method)) record("control-wire", value);
      await transport.send(line);
    },
    async receive() {
      const line = await transport.receive();
      if (line !== null) {
        const value = JSON.parse(line);
        if (value.method === "item/started" && value.params?.item?.type === "commandExecution") toolStarted = true;
        if (value.result?.thread?.id) {
          nativeThread ??= value.result.thread.id;
          assert.equal(value.result.thread.id, nativeThread);
        }
        if (value.id !== undefined || ["thread/started", "turn/started", "turn/completed", "item/started", "item/completed", "error", "thread/tokenUsage/updated"].includes(value.method)) record("native", value);
      }
      return line;
    },
    stop: () => transport.stop(),
  };
}, undefined, undefined, endpoint);
const absent = {
  async inspect() { throw new RuntimeAdapterError("runtime-not-located"); },
  async start(): Promise<never> { throw new Error("unauthorized provider"); },
  async resume(): Promise<never> { throw new Error("unauthorized provider"); },
};
const routed = await createProductionRuntimeEndpointAdapter({
  codexAdapter: absent, claudeAdapter: absent, glmAdapter: absent,
  kimiAdapter: absent,
  deepseekAdapter: absent,
  kimiPlatformAdapter: adapter, claudeApiAdapter: absent, codexApiAdapter: absent,
});
const backend = await createWorkbenchBackend({
  projectDirectory: project, databasePath: join(root, "ledger.sqlite"), adapter: routed,
});
record("backend-ready", true);
let latest: any;
const unsubscribe = backend.observeProject((result) => { if (result.ok) latest = result.view; });
const server = await createViteBrowserTestServer({
  configFile: false, root: resolve("."), logLevel: "error", appType: "custom",
  plugins: [{ name: "w80-live-probe", configureServer(server) {
    server.middlewares.use("/w80", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end('<html><body><div id="root"></div><script type="module" src="/tests/agent-runtime/live-kimi-platform/composer.tsx"></script></body></html>');
    });
  } }, solid()], server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
record("test-server-ready", true);
const address = server.httpServer!.address() as { port: number };
const executablePath = [chromium.executablePath(), "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
assert.ok(executablePath, "installed headless Chromium required");
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
page.on("pageerror", (error) => record("page-error", error.message));
let action: Promise<unknown> | undefined;
await page.exposeFunction("probeSteer", (input: string) => {
  action = backend.steerActiveTurn!({ steerKey: latest.commands[0].steer.steerKey, input }).then((result) => record("steer-receipt", result));
  return action;
});
await page.exposeFunction("probeInterrupt", () => {
  action = backend.interruptActiveTurn!({ interruptKey: latest.commands[0].interrupt.interruptKey }).then((result) => record("interrupt-receipt", result));
  return action;
});
async function refresh() {
  if (latest) await page.evaluate((view) => (window as any).updateProbe(view), latest);
}
async function waitFor(predicate: () => boolean, label: string, timeout = 90_000) {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (wire.state().failure) throw new Error(wire.state().failure);
    assert.ok(Date.now() < until, `timeout: ${label}`);
    await refresh();
    await delay(100);
  }
  await refresh();
}
async function submit(input: string, continuation = false) {
  const previousCursor = latest?.observation.cursor ?? -1;
  const selectionKey = latest?.commands[0]?.session?.selectionKey;
  const loaded = await backend.loadDirectSessionProfile(continuation ? { kind: "continuation-session", selectionKey } : { kind: "catalog-default" });
  assert.ok(loaded.ok, JSON.stringify(loaded));
  let keys: any;
  if (continuation) keys = (loaded.profile as any).continuationPrefill;
  else {
    const ep = loaded.profile.endpoints[0]!;
    const model = ep.models.find((m) => m.label === "kimi-k2.7-code")!;
    assert.ok(model, JSON.stringify(ep.models));
    keys = { endpointKey: ep.key, modelKey: model.key, workIntensityKey: model.workIntensities[0]!.key, executionModeKey: ep.executionModes[0]!.key, accessModeKey: ep.accessModes[0]!.key };
  }
  const { endpointKey, modelKey, workIntensityKey, executionModeKey, accessModeKey } = keys;
  const receipt = await backend.submitDirectInput({
    kind: continuation ? "continue" : "start", input,
    ...(continuation ? { selectionKey } : {}), snapshotKey: loaded.profile.snapshotKey,
    endpointKey, modelKey, workIntensityKey, executionModeKey, accessModeKey,
  } as any);
  record("submission", { input, continuation, receipt });
  assert.ok(receipt.ok);
  await waitFor(() => latest?.observation.cursor > previousCursor, "submission-visible");
}
async function terminal(label: string) {
  await waitFor(() => latest?.commands[0] && !["accepted", "in-flight"].includes(latest.commands[0].status), label);
  record(label, latest.commands[0]);
  assert.equal(latest.commands.length, 1, "must keep one Workbench session");
}
try {
  await page.goto(`http://127.0.0.1:${address.port}/w80`);
  await page.waitForFunction(() => typeof (window as any).updateProbe === "function");
  await waitFor(() => latest !== undefined, "backend-ready");
  assert.equal(await page.locator(".input-side").count(), 1, "Composer must react to the first backend view");
  const catalog = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  record("catalog", catalog);
  assert.ok(catalog.ok);
  if (!prepare) {
    if (!cancelOnly) {
      if (!continuationOnly) {
        await submit(textGuidance ? "Reply exactly FIRST. Do not use tools."
          : "Run Start-Sleep -Seconds 18 in PowerShell (foreground, yield_time_ms=25000), then reply FIRST.");
        await waitFor(() => latest.commands[0]?.steer?.status === "available" || latest.commands[0]?.status === "failed", "steer-attached");
        if (textGuidance) await waitFor(() => wire.state().requests === 1, "text-request-on-wire");
        // Text steering is a separate race probe, not the 11-second button check.
        for (let n = 0; n <= (textGuidance ? 0 : 11); n++) {
          if (wire.state().failure) throw new Error(wire.state().failure);
          await refresh();
          record("button-sample", { status: latest.commands[0]?.status, steer: latest.commands[0]?.steer?.status, count: await page.locator(".guide-button").count() });
          assert.equal(await page.locator(".guide-button").count(), 1);
          if (!textGuidance && n !== 11) await delay(1000);
        }
        assert.equal(latest.commands[0]?.steer?.status, "available");
        await page.locator(".guide-button").click();
        await waitFor(() => action !== undefined, "guide-click-dispatched");
        await action;
        await terminal("guided-terminal");
        assert.equal(wire.state().guidanceSeen, true, "guidance must reach the HTTP request");
        assert.equal(latest.commands[0].status, "completed");
        try {
          assert.ok(latest.commands[0].session.timeline.some((event: any) => event.kind === "agent-message" && event.text.includes("GUIDED")));
        } catch (error) {
          // Preserve this failed assertion and exit nonzero, but still exercise
          // independent checks when the backend offers continuation.
          record("guidance-assertion-failure", String(error));
          process.exitCode = 1;
        }
      } else {
        await submit("Reply exactly FIRST. Do not use tools.");
        await terminal("first-terminal");
        assert.equal(latest.commands[0].status, "completed");
      }
      // Keep going only when continuation is offered; never replace the Session.
      assert.ok(latest.commands[0]?.session?.selectionKey);
      await submit("Reply exactly SECOND. Do not use tools.", true);
      await terminal("second-terminal");
      assert.equal(latest.commands[0].status, "completed");
      assert.ok(latest.commands[0].session.timeline.some((event: any) => event.kind === "agent-message" && event.text.includes("SECOND")));
      }
    const priorRequests = wire.state().requests;
    toolStarted = false;
    await submit("Run Start-Sleep -Seconds 18 in PowerShell (foreground, yield_time_ms=25000), then reply CANCEL-MISSED.", !cancelOnly);
    await waitFor(() => latest.commands[0]?.interrupt?.status === "available", "cancel-attached");
    await waitFor(() => wire.state().requests > priorRequests, "cancel-request-on-wire");
    if (live || cancelOnly) await waitFor(() => toolStarted, "cancel-during-real-tool");
    await delay(1500);
    await refresh(); action = undefined;
    await page.locator(".stop-button").click();
    await waitFor(() => action !== undefined, "stop-click-dispatched");
    await action;
    await terminal("cancel-terminal");
    assert.equal(latest.commands[0].failureCategory, "interrupted");
    await submit("Reply exactly SAME-SESSION. Do not use tools.", true);
    await terminal("after-cancel-terminal");
    assert.equal(latest.commands[0].status, "completed");
    assert.ok(latest.commands[0].session.timeline.some((event: any) => event.kind === "agent-message" && event.text.includes("SAME-SESSION")));
  }
} catch (error) {
  record("probe-failure", { message: String(error), latest });
  process.exitCode = 1;
} finally {
  record("accounting", { mode, inferenceUserFrames: frames, starts, steers, nativeThread, ...wire.state(), logPath });
  unsubscribe();
  await Promise.allSettled(transports.map((transport) => transport.stop()));
  await backend.close();
  await browser.close();
  await server.close();
  await wire.close();
}
