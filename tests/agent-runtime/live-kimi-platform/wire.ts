// Manual-only receiver. The real credential lives in this process, never the CLI.
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export async function startWire(live: boolean, record: (kind: string, value: unknown) => void, toolCancellation = false) {
  const secret = live ? process.env.KIMI_PLATFORM_API_KEY : undefined;
  assert.ok(!live || secret, "explicit platform key required");
  let requests = 0;
  let providerRequests = 0;
  let failure: Error | undefined;
  let guidanceSeen = false;
  const active = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    active.add(abort);
    response.on("close", () => abort.abort());
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/responses");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(raw.toString());
      const ordinal = ++requests;
      const input = body.input.filter((item: any) => !["system", "developer"].includes(item.role));
      const users = input.filter((item: any) => item.role === "user");
      const lastUser = JSON.stringify(users.at(-1));
      guidanceSeen ||= lastUser.includes("Reply exactly GUIDED. Do not use tools.");
      record("http-request", { ordinal, model: body.model, stream: body.stream,
        reasoning: body.reasoning, input, tools: body.tools.map((tool: any) => ({ type: tool.type, name: tool.name })) });
      assert.equal(body.model, "kimi-k2.7-code");
      assert.equal(body.stream, true);
      assert.equal(body.reasoning.effort, "high");
      if (live) {
        assert.equal(failure, undefined, "do not retry failed provider calls");
        assert.ok(providerRequests < 8, "maximum eight real HTTP inference requests");
        providerRequests++;
        record("provider-request", { ordinal: providerRequests, url: "https://api.moonshot.cn/v1/responses" });
        const upstream = await fetch("https://api.moonshot.cn/v1/responses", {
          method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
          body: raw, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]),
        });
        record("provider-status", { ordinal: providerRequests, status: upstream.status });
        assert.equal(upstream.status, 200, "provider rejected request; no retry");
        response.writeHead(upstream.status, { "content-type": "text/event-stream" });
        let received = "";
        const decoder = new TextDecoder();
        const reader = upstream.body!.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          response.write(value);
          received += decoder.decode(value, { stream: true });
        }
        received += decoder.decode();
        // Only the response payload; neither request nor response headers are logged.
        for (const line of received.split("\n")) {
          if (!line.startsWith("data: {")) continue;
          const event = JSON.parse(line.slice(6));
          if (["response.completed", "response.failed", "error"].includes(event.type)) record("provider-result", event);
        }
        response.end();
      } else {
        assert.ok(requests <= 6, "unexpected local request loop");
        if (toolCancellation && ordinal === 1) {
          replySleepTool(response);
          return;
        }
        if (ordinal === 1 && lastUser.includes("then reply FIRST")) await delay(14000, undefined, { signal: abort.signal });
        if (lastUser.includes("CANCEL-MISSED")) await delay(30000, undefined, { signal: abort.signal });
        const text = lastUser.includes("SAME-SESSION") ? "SAME-SESSION"
          : lastUser.includes("SECOND") ? "SECOND" : lastUser.includes("GUIDED") ? "GUIDED" : "FIRST";
        reply(response, ordinal, text);
      }
    } catch (error) {
      if (abort.signal.aborted) record("http-cancelled", { requests, providerRequests });
      else {
        failure = error as Error;
        record("http-failure", String(error));
        if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "probe stopped; see sanitized observation" } }));
      }
    } finally { active.delete(abort); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    state: () => ({ requests, providerRequests, guidanceSeen, failure: failure?.message }),
    async close() {
      for (const abort of active) abort.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

// Same harmless tool call as live-cancel, including a completed model response
// before Stop. Resume must therefore handle the cancelled turn's saved usage.
function replySleepTool(response: ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  let sequence_number = 0;
  const emit = (type: string, fields: Record<string, unknown>) => response.write(
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence_number++, ...fields })}\n\n`);
  const item = { id: "fc_w80_sleep", type: "function_call", call_id: "call_w80_sleep", name: "exec_command",
    arguments: JSON.stringify({ cmd: "Start-Sleep -Seconds 18", shell: "powershell", yield_time_ms: 25000 }), status: "completed" };
  const result = { id: "resp_w80_sleep", object: "response", model: "kimi-k2.7-code", status: "completed", output: [item],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 } } };
  emit("response.created", { response: { ...result, status: "in_progress", output: [] } });
  emit("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
  emit("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: item.arguments });
  emit("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: item.arguments });
  emit("response.output_item.done", { output_index: 0, item });
  emit("response.completed", { response: result });
  response.end();
}

function reply(response: ServerResponse, ordinal: number, text: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  let sequence_number = 0;
  const emit = (type: string, fields: Record<string, unknown>) => response.write(
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence_number++, ...fields })}\n\n`);
  const item = { id: `msg_w80_${ordinal}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] };
  const result = { id: `resp_w80_${ordinal}`, object: "response", created_at: Math.floor(Date.now()/1000),
    model: "kimi-k2.7-code", status: "completed", output: [item],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 } } };
  emit("response.created", { response: { ...result, status: "in_progress", output: [] } });
  emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0,
    part: { type: "output_text", text: "", annotations: [] } });
  emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text });
  emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text });
  emit("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  emit("response.output_item.done", { output_index: 0, item });
  emit("response.completed", { response: result });
  response.end();
}
