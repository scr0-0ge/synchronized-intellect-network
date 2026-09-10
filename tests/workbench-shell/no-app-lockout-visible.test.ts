import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";
import type { ProjectChannel } from "../../src/coordinator/index.ts";
import type { WorkbenchProjectResult } from "../../src/workbench-shell/contract.ts";
import { createWorkbenchLiveView } from "../../src/workbench-shell/live-view.ts";
import { sanitizeWorkbenchProjectResult } from "../../src/workbench-shell/result-sanitizer.ts";
import { directInputMode, initialRendererState, replaceProjectResult } from "../../src/workbench-shell/renderer/view-model.ts";
import { appFailureProject, continuation, terminal } from "../helpers/no-app-lockout.ts";
import { createTestDirectory, registerTestClosable } from "../helpers/test-lifecycle.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";

async function publicView(t: TestContext, channel: ProjectChannel, root: string) {
  const live = createWorkbenchLiveView({ channel, projectDirectory: root });
  registerTestClosable(t, live);
  let resolve!: (value: WorkbenchProjectResult) => void;
  const first = new Promise<WorkbenchProjectResult>(r => { resolve = r; });
  const dispose = live.observe(resolve);
  const result = sanitizeWorkbenchProjectResult(await first);
  dispose();
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected a visible recovery result");
  return result;
}

for (const rejectResume of [false, true]) {
  test(`unknown turn stays visible through the real renderer; CLI resume ${rejectResume ? "refused" : "confirmed"}`, async t => {
    const root = await createTestDirectory(t, join(tmpdir(), "uaw148-ui-"));
    const { channel, command, open } = await appFailureProject(t, root, "send", rejectResume);
    const initial = await publicView(t, channel, root);
    assert.equal(initial.view.commands[0]?.session?.resumable, !rejectResume);
    const state = replaceProjectResult(initialRendererState, { ok: true, view: { ...initial.view,
      projectSelection: { projects: [{ label: "Offline Project", selected: true, availability: "available", selectionKey: "project-selection:00000000-0000-4000-8000-000000000148" }] } } });
    assert.equal(directInputMode(state), rejectResume ? "unavailable" : "continue", "the actual composer mode admits the next message only after resume confirmation");
    const server = await createViteSsrTestServer({ appType: "custom", configFile: false, logLevel: "silent", plugins: [solid({ ssr: true })], root: fileURLToPath(new URL("../..", import.meta.url)), server: { middlewareMode: true } });
    try {
      const { SessionTranscript } = await server.ssrLoadModule("/src/workbench-shell/renderer/transcript.tsx");
      const { setLocale } = await server.ssrLoadModule("/src/workbench-shell/renderer/locale.ts");
      const renderHtml = (result: typeof initial) => renderToString(() => SessionTranscript({ command: result.view.commands[0] }));
      const render = (result: typeof initial) => renderHtml(result).replace(/<[^>]*>/gu, "");
      for (const locale of ["en", "zh-CN"]) {
        setLocale(locale);
        const text = render(initial);
        assert.match(text, locale === "en" ? /outcome.*unknown/iu : /结果未知/u);
        assert.match(text, rejectResume
          ? (locale === "en" ? /Resume was not confirmed.*runtime refused/iu : /未能确认恢复.*运行时拒绝/u)
          : (locale === "en" ? /CLI resume was confirmed/iu : /已实测确认 CLI 可恢复/u));
      }
      if (!rejectResume) {
        const receipt = await channel.act(continuation(command.session!.sessionId));
        await terminal(channel, receipt.commandId);
        await channel.close();
        const reopened = await open();
        registerTestClosable(t, reopened);
        const later = await publicView(t, reopened, root);
        assert.equal(later.view.commands[0]?.status, "completed");
        setLocale("en");
        const laterHtml = renderHtml(later);
        const laterText = laterHtml.replace(/<[^>]*>/gu, "");
        assert.match(laterText, /Turn 1.*outcome.*unknown/iu, "a later success cannot hide the earlier unknown outcome");
        const turnGroup = (turnOrdinal: number): string => {
          const match = laterHtml.match(
            new RegExp(
              `<section[^>]*data-transcript-group-key="turn:${turnOrdinal}:group:[0-9]+"[^>]*>([\\s\\S]*?)<\\/section>`,
              "u",
            ),
          );
          assert.ok(match?.[1], `Turn ${turnOrdinal} must render its own timeline group`);
          return match[1];
        };
        assert.match(
          turnGroup(1),
          /class="turn-state is-recovery"[^>]*>outcome unknown<\/span>/u,
          "the earlier unknown turn header must stay outcome unknown after a later success",
        );
        assert.match(
          turnGroup(2),
          /class="turn-state is-done"[^>]*>completed<\/span>/u,
          "the later turn with a real completion event must still render completed",
        );
        assert.deepEqual(later.view.commands[0]?.session?.turns?.[0]?.recovery, { resume: "confirmed" });
      }
      for (const recovery of [{ resume: "confirmed", rawError: root }, { resume: "unconfirmed", reason: root }, { resume: "unconfirmed" }]) {
        const view = structuredClone(initial.view);
        Object.assign(view.commands[0]!.session!.turns![0]!, { recovery });
        assert.equal(sanitizeWorkbenchProjectResult({ ok: true, view }).ok, false, "recovery remains exact-key and admits no raw errors");
      }
    } finally { await server.close(); }
  });
}
