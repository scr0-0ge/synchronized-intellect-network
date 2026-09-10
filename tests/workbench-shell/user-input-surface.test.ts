import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { before, after } from "node:test";
import { chromium, type Browser } from "playwright";
import solid from "vite-plugin-solid";
import type { ViteDevServer } from "vite";
import { createViteBrowserTestServer } from "../helpers/vite-server.ts";
import { createQuestionWorkbench, waitFor } from "./fixtures/user-input-loopback.ts";
import { questionIpc } from "./fixtures/user-input-ipc.ts";
import type { WorkbenchUserInputReadRequest, WorkbenchUserInputResponse } from "../../src/workbench-shell/contract.ts";

let server: ViteDevServer;
let browser: Browser;
let url: string;
before(async () => {
  server = await createViteBrowserTestServer({ appType: "custom", configFile: false, logLevel: "silent",
    root: fileURLToPath(new URL("../../", import.meta.url)), plugins: [solid()],
    server: { host: "127.0.0.1", port: 0 } });
  server.middlewares.use("/__user_input", (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end('<html lang="en"><body><div id="root"></div><script type="module" src="/tests/workbench-shell/visual-harness/user-input-probe.tsx"></script></body></html>');
  });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address === "object");
  url = `http://127.0.0.1:${address.port}/__user_input`;
  const executablePath = [chromium.executablePath(), "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
  assert.ok(executablePath);
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

for (const [state, text] of [
  ["timed-out", "Question timed out without an answer."],
  ["cancelled", "Question cancelled without an answer."],
  ["session-ended", "The turn or Session ended. This question can no longer be answered."],
] as const) test(`${state} removes the answer form and leaves an explicit exit`, async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  let resolved = state !== "cancelled";
  const responses: unknown[] = [];
  await page.exposeFunction("qaReadInput", () => ({ ok: true, requests: [resolved
    ? { requestKey: "question-exit", state }
    : { requestKey: "question-exit", state: "pending", expiresAt: Date.now() + 300000,
        isBlocking: true, questions: [{ id: "scope", header: "Scope", text: "Which scope?",
          kind: "free-text", allowFreeText: true, isSecret: false, options: [] }] }] }));
  await page.exposeFunction("qaRespond", (request: unknown) => {
    responses.push(request); resolved = true; return { status: "cancelled" };
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    if (state === "cancelled") await page.getByRole("button", { name: "Cancel question", exact: true }).click();
    await page.getByText(text, { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send answer", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    assert.equal(await page.getByText(text, { exact: true }).count(), 0);
    assert.deepEqual(responses, state === "cancelled" ? [{ kind: "cancel", requestKey: "question-exit" }] : []);
  } finally { await page.close(); }
});

test("a CLI question is visible and accepts an explicit choice plus free text", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.setDefaultTimeout(3000);
  const responses: unknown[] = [];
  await page.exposeFunction("qaReadInput", () => ({ ok: true, requests: [{
    requestKey: "question-1", state: "pending", expiresAt: Date.now() + 300000, isBlocking: true,
    questions: [
      { id: "scope", header: "Scope", text: "Which scope?", kind: "choice", allowFreeText: true, isSecret: false,
        options: [{ label: "Runtime", description: "Only the runtime" }, { label: "All", description: "Include UI" }] },
      { id: "details", header: "Details", text: "What else?", kind: "free-text", allowFreeText: true, isSecret: true, options: [] },
    ],
  }] }));
  await page.exposeFunction("qaRespond", (request: unknown) => { responses.push(request); return { status: "answered" }; });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.locator(".stage").waitFor();
    if (process.env.UAW_QA_EVIDENCE && process.env.UAW_QA_CAPTURE_RED === "1") {
      mkdirSync(process.env.UAW_QA_EVIDENCE, { recursive: true });
      await page.screenshot({ path: `${process.env.UAW_QA_EVIDENCE}/surface-before.png` });
    }
    await page.getByText("Which scope?", { exact: true }).waitFor();
    if (process.env.UAW_QA_EVIDENCE) {
      mkdirSync(process.env.UAW_QA_EVIDENCE, { recursive: true });
      await page.screenshot({ path: `${process.env.UAW_QA_EVIDENCE}/surface-question.png` });
    }
    assert.equal(await page.locator('input[type="radio"]:checked').count(), 0);
    assert.equal(await page.getByRole("button", { name: "Send answer", exact: true }).isDisabled(), true);
    await page.getByRole("radio", { name: "Runtime Only the runtime", exact: true }).check();
    await page.getByLabel("What else?", { exact: true }).fill("Only loopback tests");
    if (process.env.UAW_QA_EVIDENCE) await page.screenshot({ path: `${process.env.UAW_QA_EVIDENCE}/surface-selected.png` });
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await page.getByText("Answer sent.", { exact: true }).waitFor();
    if (process.env.UAW_QA_EVIDENCE) await page.screenshot({ path: `${process.env.UAW_QA_EVIDENCE}/surface-answered.png` });
    assert.deepEqual(responses, [{ kind: "answer", requestKey: "question-1", answers: [
      { questionId: "scope", values: ["Runtime"] }, { questionId: "details", values: ["Only loopback tests"] },
    ] }]);
  } finally { await page.close(); }
});

for (const width of [360, 480, 620, 900]) test(
  `Runtime question options and its sticky actions remain reachable at ${width}px`,
  async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(3000);
    await page.exposeFunction("qaReadInput", () => ({ ok: true, requests: [{
      requestKey: `question-narrow-${width}`, state: "pending", expiresAt: Date.now() + 300000,
      isBlocking: true,
      questions: [
        { id: "scope", header: "Scope", text: "Which scope?", kind: "choice", allowFreeText: true,
          isSecret: false, options: [{ label: "Runtime", description: "Only the runtime" }, { label: "All", description: "Include UI" }] },
        { id: "details", header: "Details", text: "What else?", kind: "free-text", allowFreeText: true,
          isSecret: false, options: [] },
      ],
    }] }));
    await page.exposeFunction("qaRespond", () => ({ status: "answered" }));
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      const radios = page.getByRole("radio");
      await radios.first().waitFor();
      const initial = await questionControlGeometry(page);
      assert.equal(initial.optionsReachable[0], true, `first option at ${width}px`);
      assert.equal(initial.actionsReachable, true, `initial actions at ${width}px`);
      if (process.env.UAW_QA_EVIDENCE) {
        mkdirSync(process.env.UAW_QA_EVIDENCE, { recursive: true });
        await page.screenshot({ path: `${process.env.UAW_QA_EVIDENCE}/runtime-question-${width}px-green.png` });
      }

      for (let index = 0; index < await radios.count(); index++) {
        const radio = radios.nth(index);
        await radio.evaluate((input) => input.closest("label")?.scrollIntoView({ block: "center" }));
        const geometry = await questionControlGeometry(page);
        assert.equal(geometry.optionsReachable[index], true, `option ${index + 1} at ${width}px`);
        assert.equal(geometry.actionsReachable, true, `actions after option ${index + 1} at ${width}px`);
        await radio.check();
      }
    } finally { await page.close(); }
  },
);

async function questionControlGeometry(page: import("playwright").Page): Promise<{
  readonly optionsReachable: readonly boolean[];
  readonly actionsReachable: boolean;
}> {
  return page.locator(".runtime-questions").evaluate((root) => {
    const isInViewAndHit = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (!/(auto|scroll|hidden)/u.test(style.overflowX + style.overflowY)) continue;
        const bounds = ancestor.getBoundingClientRect();
        clip = {
          left: Math.max(clip.left, bounds.left), top: Math.max(clip.top, bounds.top),
          right: Math.min(clip.right, bounds.right), bottom: Math.min(clip.bottom, bounds.bottom),
        };
      }
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(center.x, center.y);
      const epsilon = 1;
      return rect.left >= clip.left - epsilon && rect.top >= clip.top - epsilon &&
        rect.right <= clip.right + epsilon && rect.bottom <= clip.bottom + epsilon &&
        !!hit && (hit === element || element.contains(hit));
    };
    const optionsReachable = Array.from(root.querySelectorAll<HTMLElement>("input[type=radio]"))
      .map((input) => {
        const label = input.closest<HTMLElement>("label")!;
        const actions = Array.from(root.querySelectorAll<HTMLElement>(".runtime-question-actions button"));
        const labelBounds = label.getBoundingClientRect();
        return isInViewAndHit(label) && actions.every((action) => {
          const actionBounds = action.getBoundingClientRect();
          return labelBounds.right <= actionBounds.left || actionBounds.right <= labelBounds.left ||
            labelBounds.bottom <= actionBounds.top || actionBounds.bottom <= labelBounds.top;
        });
      });
    const actionsReachable = Array.from(root.querySelectorAll<HTMLElement>(".runtime-question-actions button"))
      .every(isInViewAndHit);
    return { optionsReachable, actionsReachable };
  });
}

test("Other is user-authored, survives refreshes, and an unconfirmed send cannot latch the form", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.clock.install();
  const responses: unknown[] = [];
  await page.exposeFunction("qaReadInput", () => ({ ok: true, requests: [{
    requestKey: "question-other", state: "pending", expiresAt: Date.now() + 300000, isBlocking: true,
    questions: [{ id: "scope", header: "Scope", text: "Which scope?", kind: "choice", allowFreeText: true,
      isSecret: false, options: [{ label: "Runtime", description: "Only the runtime" }] }],
  }] }));
  await page.exposeFunction("qaRespond", (request: unknown) => {
    responses.push(request); return new Promise(() => undefined);
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.getByRole("radio", { name: "Write my own answer", exact: true }).check();
    await page.getByLabel("Which scope?", { exact: true }).fill("UI only");
    await page.evaluate(() => window.dispatchEvent(new Event("qa-input-changed")));
    await page.clock.fastForward(1000);
    assert.equal(await page.getByLabel("Which scope?", { exact: true }).inputValue(), "UI only");
    assert.equal(responses.length, 0);
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await page.clock.fastForward(10001);
    await page.getByRole("alert").getByText("The reply was not confirmed.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Cancel question", exact: true }).isEnabled(), true);
    assert.deepEqual(responses, [{ kind: "answer", requestKey: "question-other", answers: [{ questionId: "scope", values: ["UI only"] }] }]);
  } finally { await page.close(); }
});

test("production loopback: CLI question -> UI answer -> original peer -> completed turn", async (t) => {
  const workbench = await createQuestionWorkbench(t);
  const ipc = questionIpc(workbench.host);
  const input = ipc.bridge;
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  page.setDefaultTimeout(5000);
  await page.exposeFunction("qaReadView", workbench.view);
  await page.exposeFunction("qaReadInput", (request: WorkbenchUserInputReadRequest) => input.readUserInput?.(request) ?? { ok: false });
  await page.exposeFunction("qaRespond", (request: WorkbenchUserInputResponse) => input.respondToUserInput?.(request) ?? { status: "unavailable" });
  const unsubscribe = input.observeUserInput?.(() => { void page.evaluate(() => window.dispatchEvent(new Event("qa-input-changed"))).catch(() => undefined); });
  workbench.ask();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.locator(".user-message-text").getByText("Ask a question", { exact: true }).waitFor();
    if (process.env.UAW_QA_CAPTURE_RED === "1" && process.env.UAW_QA_EVIDENCE) {
      await page.screenshot({ path: `${process.env.UAW_QA_EVIDENCE}/loopback-red.png` });
    }
    await page.getByText("Which scope?", { exact: true }).waitFor();
    if (process.env.UAW_QA_EVIDENCE) await page.screenshot({ path: `${process.env.UAW_QA_EVIDENCE}/01-question.png` });
    assert.equal(workbench.servers[0].outbound.some(frame => "result" in frame), false);
    await page.getByRole("radio", { name: "Runtime Only the runtime", exact: true }).check();
    await page.getByLabel("What else?", { exact: true }).fill("Only loopback tests");
    if (process.env.UAW_QA_EVIDENCE) await page.screenshot({ path: `${process.env.UAW_QA_EVIDENCE}/02-selection.png` });
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await page.getByText("Answer sent.", { exact: true }).waitFor();
    assert.deepEqual(workbench.servers[0].outbound.at(-1), { jsonrpc: "2.0", id: "question-98", result: {
      answers: { scope: { answers: ["Runtime"] }, details: { answers: ["Only loopback tests"] } },
    } });
    if (process.env.UAW_QA_EVIDENCE) await page.screenshot({ path: `${process.env.UAW_QA_EVIDENCE}/03-answer-sent.png` });
    workbench.finish();
    await waitFor(() => workbench.view().commands[0]?.status === "completed");
    await page.locator(".turn:not(.turn-user) .turn-body.prose")
      .getByText("FIXED_MARKER", { exact: true })
      .waitFor();
    assert.doesNotMatch(await page.locator(".runtime-questions").innerText(), /Waiting for the Runtime to continue/);
    if (process.env.UAW_QA_EVIDENCE) await page.screenshot({ path: `${process.env.UAW_QA_EVIDENCE}/04-turn-completed.png` });
  } finally { unsubscribe?.(); ipc.dispose(); await page.close(); }
});

for (const failure of ["expired", "read-stalled"] as const) test(`${failure}: stale questions cannot remain answerable`, async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.clock.install();
  let reads = 0;
  let responses = 0;
  await page.exposeFunction("qaReadInput", () => {
    if (++reads > 1 && failure === "read-stalled") return new Promise(() => undefined);
    return { ok: true, requests: [{ requestKey: "question-expiry", state: "pending",
      expiresAt: Date.now() + (failure === "expired" ? 1000 : 300000), isBlocking: true,
      questions: [{ id: "scope", header: "Scope", text: "Which scope?", kind: "free-text", allowFreeText: true, isSecret: false, options: [] }],
    }] };
  });
  await page.exposeFunction("qaRespond", () => { responses++; return { status: "answered" }; });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.getByText("Which scope?", { exact: true }).waitFor();
    if (failure === "read-stalled") {
      await page.evaluate(() => window.dispatchEvent(new Event("qa-input-changed")));
      await waitFor(() => reads > 1);
      await page.clock.fastForward(5001);
      await page.getByText("Questions are unavailable. You can still stop the turn or change Sessions.", { exact: true }).waitFor();
    } else {
      await page.clock.fastForward(1500);
      await page.getByText("The answer window has expired. Check the Runtime status, or stop the turn.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    }
    assert.equal(await page.getByRole("button", { name: "Send answer", exact: true }).count(), 0);
    assert.equal(responses, 0);
  } finally { await page.close(); }
});

for (const [ending, message] of [
  ["timed-out", "Question timed out without an answer."],
  ["cancelled", "Question cancelled without an answer."],
  ["session-ended", "The turn or Session ended. This question can no longer be answered."],
] as const) test(`production loopback ${ending}: UI exits and Project turn settles`, async (t) => {
  const workbench = await createQuestionWorkbench(t);
  const ipc = questionIpc(workbench.host);
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.exposeFunction("qaReadView", workbench.view);
  await page.exposeFunction("qaReadInput", ipc.bridge.readUserInput!);
  await page.exposeFunction("qaRespond", ipc.bridge.respondToUserInput!);
  const unsubscribe = ipc.bridge.observeUserInput!(() => {
    void page.evaluate(() => window.dispatchEvent(new Event("qa-input-changed"))).catch(() => undefined);
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.locator(".user-message-text").getByText("Ask a question", { exact: true }).waitFor();
    workbench.ask(ending === "timed-out" ? 1500 : null);
    await page.getByText("Which scope?", { exact: true }).waitFor();
    const pending = await ipc.bridge.readUserInput!({ sessionKey: workbench.view().commands[0].session!.metadataKey });
    assert.ok(pending.ok && pending.requests[0].state === "pending");
    if (ending === "cancelled") await page.getByRole("button", { name: "Cancel question", exact: true }).click();
    if (ending === "session-ended") workbench.finish();
    await page.getByText(message, { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send answer", exact: true }).count(), 0);
    const replies = workbench.servers[0].outbound.filter(frame => "result" in frame);
    assert.deepEqual(replies, ending === "session-ended" ? [] : [{ jsonrpc: "2.0", id: "question-98", result: { answers: {} } }]);
    assert.deepEqual(await ipc.bridge.respondToUserInput!({ kind: "cancel", requestKey: pending.requests[0].requestKey }), { status: "unavailable" });
    if (process.env.UAW_QA_EVIDENCE) await page.screenshot({ path: `${process.env.UAW_QA_EVIDENCE}/${ending}-green.png` });
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    if (ending !== "session-ended") workbench.finish();
    await waitFor(() => workbench.view().commands[0].status === "completed");
    await page.locator(".turn:not(.turn-user) .turn-body.prose")
      .getByText("FIXED_MARKER", { exact: true })
      .waitFor();
    assert.equal(await page.getByText(message, { exact: true }).count(), 0);
  } finally { unsubscribe(); ipc.dispose(); await page.close(); }
});
