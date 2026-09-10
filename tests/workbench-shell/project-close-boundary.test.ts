import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createQuestionWorkbench, waitFor } from "./fixtures/user-input-loopback.ts";

for (const holdShutdown of [false, true]) {
  test(`production directory Project switch cancels blocked receive and drains shutdown held=${holdShutdown}`, { timeout: 10000 }, async (t) => {
    const workbench = await createQuestionWorkbench(t);
    workbench.ask();
    const sessionKey = workbench.view().commands[0].session!.metadataKey;
    await waitFor(async () => {
      const result = await workbench.host.readUserInput({ sessionKey });
      return result.ok && result.requests[0]?.state === "pending";
    });
    const server = workbench.servers[0];
    server.holdShutdown = holdShutdown;
    const second = join(workbench.root, "second");
    await mkdir(second);
    const started = performance.now();
    let settled = false;
    const switching = workbench.host.registerTrustedProject(second).then(result => { settled = true; return result; });
    if (holdShutdown) {
      await waitFor(() => server.stopCalls === 1);
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(settled, false, "close initiation is not transport exit confirmation");
      assert.equal(server.stopped, false);
      t.diagnostic(`shutdown still held after 200ms; switch settled=${settled}; stopCalls=${server.stopCalls}`);
      server.releaseShutdown();
    }
    const result = await switching;
    const elapsed = performance.now() - started;
    assert.ok(result.ok && result.status === "selected", JSON.stringify(result));
    assert.ok(elapsed < 2500, `Project switch took ${elapsed}ms`);
    assert.equal(server.stopCalls, 1, "the directory must forward close to the actual Codex binding");
    assert.equal(server.stopSawPendingReceive, true, "stop must start before receive settles");
    assert.equal(server.stopped, true, "the transport actually stopped before the Project switched");
    t.diagnostic(`Project switch returned in ${elapsed.toFixed(1)}ms; stopCalls=${server.stopCalls}; stopped=${server.stopped}`);

    const first = workbench.view().projectSelection.projects.find(project => !project.selected)!;
    assert.equal((await workbench.host.selectProject({ selectionKey: first.selectionKey })).ok, true);
    assert.equal(workbench.view().commands[0].status, "recovery-required", "close is not a successful turn receipt");
    assert.equal(workbench.servers.length, 2, "reopening measures resume on a fresh transport");
    await waitFor(() => workbench.servers[1].outbound.some(frame => frame.method === "thread/resume"));
    assert.equal(workbench.servers.flatMap(server => server.outbound).filter(frame => frame.method === "turn/start").length, 1,
      "the resume check must not replay the uncertain effect");
    await workbench.host.close();
    assert.equal(server.stopCalls, 1);
  });
}
