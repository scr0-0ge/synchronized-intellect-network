// Manual, approved offline probe. Not part of the ordinary test glob.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverClaudeLaunch } from "../../../src/agent-runtime/claude/process-transport.ts";

const root = mkdtempSync(join(realpathSync(tmpdir()), "uaw114-native-"));
for (const name of ["config", "project", "home", "appdata"]) mkdirSync(join(root, name));
const calls: { phase: string; path: string; body: any }[] = [];
let phase = "refusal";
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : null;
  calls.push({ phase, path: request.url!, body });
  if (request.url?.includes("count_tokens")) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 0 }));
  } else if (phase === "refusal") {
    response.writeHead(429, { "content-type": "application/json", "x-should-retry": "false" });
    response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "[1310][Weekly/Monthly Limit Exhausted.][offline-request]" } }));
  } else {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of [
      { type: "message_start", message: { id: "offline-message", type: "message", role: "assistant", model: "glm-5.3", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OFFLINE_RESUMED" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ]) response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    response.end();
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };
const launch = await discoverClaudeLaunch();
const environment: NodeJS.ProcessEnv = {};
for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP"])
  if (process.env[key]) environment[key] = process.env[key];
Object.assign(environment, {
  HOME: join(root, "home"), USERPROFILE: join(root, "home"), APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "appdata"),
  CLAUDE_CONFIG_DIR: join(root, "config"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
  ANTHROPIC_AUTH_TOKEN: "offline-fake-token", ANTHROPIC_MODEL: "glm-5.3",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3", ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3", ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_MAX_RETRIES: "0", NO_PROXY: "127.0.0.1,localhost",
});
async function run(input: string, resume?: string) {
  const args = [...launch.prefixArguments, "--print", "--verbose", "--output-format", "stream-json", "--model", "glm-5.3",
    "--tools", "", "--setting-sources=", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions", "--max-turns", "1",
    ...(resume ? [`--resume=${resume}`] : [])];
  const child = spawn(launch.executable, args, { cwd: join(root, "project"), env: environment, windowsHide: true, stdio: "pipe" });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timeout);
  const frames = stdout.split(/\r?\n/u).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { raw: line }; } });
  writeFileSync(join(root, `${phase}.json`), JSON.stringify({ code, timedOut, frames, stderr }, null, 2));
  return { code, timedOut, frames, stderr };
}
try {
  const first = await run("OFFLINE_FIRST_INPUT");
  const id = first.frames.find(frame => frame.type === "system" && frame.subtype === "init")?.session_id;
  phase = "resume";
  const second = id && !first.timedOut ? await run("OFFLINE_EXPLICIT_NEW_INPUT", id) : undefined;
  writeFileSync(join(root, "requests.json"), JSON.stringify(calls, null, 2));
  assert.equal(first.code, 1);
  assert.equal(first.frames.at(-1).api_error_status, 429);
  assert.equal(first.frames.at(-1).is_error, true);
  assert.equal(second?.code, 0);
  assert.equal(second.frames.at(-1).session_id, id);
  assert.equal(second.frames.at(-1).result, "OFFLINE_RESUMED");
  const messages = calls.filter(call => call.path.startsWith("/v1/messages?") && call.phase === "resume");
  assert.equal(messages.length, 1, "one new request, not an automatic retry loop");
  const latestUser = messages[0].body.messages.filter((message: any) => message.role === "user").at(-1);
  assert.equal(latestUser.content, "OFFLINE_EXPLICIT_NEW_INPUT", "resume sends the new instruction, not the rejected prompt");
  console.log(JSON.stringify({ root, version: first.frames[0].claude_code_version, firstExit: first.code,
    firstTerminal: first.frames.at(-1).terminal_reason, secondExit: second.code,
    secondTerminal: second.frames.at(-1).terminal_reason, sameSession: second.frames.at(-1).session_id === id,
    resumedMessageRequests: messages.length, latestUser: latestUser.content, requestCount: calls.length }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
