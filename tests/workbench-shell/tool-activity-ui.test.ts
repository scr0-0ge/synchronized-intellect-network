import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";

import type {
  WorkbenchCommandView,
  WorkbenchProjectResult,
  WorkbenchTimelineEvent,
} from "../../src/workbench-shell/contract.ts";
import { sanitizeWorkbenchProjectResult } from "../../src/workbench-shell/result-sanitizer.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import { visualFixture } from "./visual-harness/fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("tool progress is exactly reconstructed and rejects unadmitted input data", () => {
  const input = projectResult([
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "commandExecution",
        name: "Bash",
        parameter: {
          kind: "command",
          value: "pnpm test",
          truncated: false,
        },
      },
    },
  ]);
  const sanitized = sanitizeWorkbenchProjectResult(input);
  assert.equal(sanitized.ok, true);
  if (!sanitized.ok) assert.fail("Expected tool progress to be admitted.");

  const event = sanitized.view.commands[0]?.session?.timeline[0];
  assert.deepEqual(event, {
    kind: "progress",
    activity: "tool",
    tool: {
      type: "commandExecution",
      name: "Bash",
      parameter: {
        kind: "command",
        value: "pnpm test",
        truncated: false,
      },
    },
  });
  assert.notEqual(
    event,
    input.view.commands[0]?.session?.timeline[0],
    "the public event is rebuilt rather than passed through",
  );
  assert.equal(Object.isFrozen(event), true);
  assert.equal(
    event?.kind === "progress" && event.tool !== undefined
      ? Object.isFrozen(event.tool)
      : false,
    true,
  );
  assert.equal(
    event?.kind === "progress" && event.tool?.parameter !== undefined
      ? Object.isFrozen(event.tool.parameter)
      : false,
    true,
  );

  for (const mutate of [
    (tool: Record<string, unknown>) => {
      tool.input = { prompt: "PRIVATE_WHOLE_INPUT" };
    },
    (tool: Record<string, unknown>) => {
      const parameter = tool.parameter as Record<string, unknown>;
      parameter.prompt = "PRIVATE_USER_DATA";
    },
    (tool: Record<string, unknown>) => {
      tool.sourceType = "provider-private-type";
    },
  ]) {
    const hostile = structuredClone(input) as unknown as {
      view: {
        commands: Array<{
          session: { timeline: Array<{ tool: Record<string, unknown> }> };
        }>;
      };
    };
    mutate(hostile.view.commands[0]!.session.timeline[0]!.tool);
    const rejected = sanitizeWorkbenchProjectResult(hostile);
    assert.equal(rejected.ok, false);
    assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_|provider-private/u);
  }

  const overlongSourceType = projectResult([
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "unknown",
        name: "Future Tool",
        sourceType: "x".repeat(100_000),
      },
    },
  ]);
  assert.equal(
    sanitizeWorkbenchProjectResult(overlongSourceType).ok,
    false,
    "the public boundary rejects an unbounded unknown tool type",
  );
});

test("file change summaries are exactly cloned without admitting diff content", () => {
  const input = projectResult([
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "fileChange",
        name: "Edit",
        parameter: { kind: "path", value: "a.ts", truncated: false },
        fileChanges: {
          files: [
            {
              path: "a.ts",
              truncated: false,
              lines: { additions: 12, deletions: 4 },
            },
            { path: "b.ts", truncated: false },
          ],
          totalFiles: 2,
          truncated: false,
        },
      },
    },
  ]);
  const sanitized = sanitizeWorkbenchProjectResult(input);
  assert.equal(sanitized.ok, true);
  if (!sanitized.ok) assert.fail("Expected the file summary to be admitted.");
  const sourceEvent = input.view.commands[0]!.session!.timeline[0]!;
  const event = sanitized.view.commands[0]!.session!.timeline[0]!;
  assert.deepEqual(event, sourceEvent);
  assert.notEqual(event, sourceEvent);
  if (event.kind !== "progress" || sourceEvent.kind !== "progress") {
    assert.fail("Expected progress events.");
  }
  assert.notEqual(event.tool, sourceEvent.tool);
  assert.notEqual(event.tool?.fileChanges, sourceEvent.tool?.fileChanges);
  assert.notEqual(
    event.tool?.fileChanges?.files[0]?.lines,
    sourceEvent.tool?.fileChanges?.files[0]?.lines,
  );
  assert.equal(Object.isFrozen(event.tool?.fileChanges?.files), true);
  assert.equal(Object.isFrozen(event.tool?.fileChanges?.files[0]?.lines), true);

  for (const mutate of [
    (summary: Record<string, unknown>) => {
      summary.diff = "PRIVATE_DIFF_BODY";
    },
    (summary: Record<string, unknown>) => {
      const files = summary.files as Array<Record<string, unknown>>;
      files[0]!.content = "PRIVATE_CHANGED_LINE";
    },
    (summary: Record<string, unknown>) => {
      const files = summary.files as Array<Record<string, unknown>>;
      (files[0]!.lines as Record<string, unknown>).context = "PRIVATE_CONTEXT";
    },
    (summary: Record<string, unknown>) => {
      summary.totalFiles = 3;
      summary.truncated = false;
    },
  ]) {
    const hostile = structuredClone(input) as unknown as {
      view: {
        commands: Array<{
          session: {
            timeline: Array<{
              tool: { fileChanges: Record<string, unknown> };
            }>;
          };
        }>;
      };
    };
    mutate(
      hostile.view.commands[0]!.session.timeline[0]!.tool.fileChanges,
    );
    const rejected = sanitizeWorkbenchProjectResult(hostile);
    assert.equal(rejected.ok, false);
    assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_/u);
  }
});

test("the live progress row follows tool name, safe parameter, truncation and fallback copy", async (t) => {
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  t.after(async () => server.close());
  const transcript = await server.ssrLoadModule(
    "/src/workbench-shell/renderer/transcript.tsx",
  );
  const locale = await server.ssrLoadModule(
    "/src/workbench-shell/renderer/locale.ts",
  );

  const rolling = sanitizedCommand([
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "tool_use",
        name: "Bash",
        parameter: { kind: "command", value: "npm test", truncated: false },
      },
    },
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "tool_use",
        name: "Read",
        parameter: { kind: "path", value: "foo.ts", truncated: false },
      },
    },
  ]);

  locale.setLocale("en");
  const rollingHtml = renderToString(() =>
    transcript.SessionTranscript({ command: rolling }),
  );
  assert.equal(progressText(rollingHtml), "Read foo.ts");
  assert.match(rollingHtml, />Bash npm test</u);
  assert.match(rollingHtml, />Read foo\.ts</u);

  const truncated = sanitizedCommand([
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "fileChange",
        name: "Read",
        parameter: {
          kind: "path",
          value: "src/components/very-long-file…",
          truncated: true,
        },
      },
    },
  ]);
  assert.equal(
    progressText(
      renderToString(() => transcript.SessionTranscript({ command: truncated })),
    ),
    "Read src/components/very-long-file… (truncated)",
  );

  locale.setLocale("zh-CN");
  assert.equal(
    progressText(
      renderToString(() => transcript.SessionTranscript({ command: truncated })),
    ),
    "Read src/components/very-long-file… （已截断）",
  );

  const unknown = sanitizedCommand([
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "unknown",
        name: "未知工具",
        sourceType: "futureAction",
      },
    },
  ]);
  assert.equal(
    progressText(
      renderToString(() => transcript.SessionTranscript({ command: unknown })),
    ),
    "未知工具 （未识别类型：futureAction）",
  );

  const legacy = sanitizedCommand([{ kind: "progress", activity: "tool" }]);
  assert.equal(
    progressText(
      renderToString(() => transcript.SessionTranscript({ command: legacy })),
    ),
    "正在调用工具",
  );

  const completedChanges = sanitizedCommand([
    { kind: "turn-started" },
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "fileChange",
        name: "Edit",
        parameter: { kind: "path", value: "a.ts", truncated: false },
        fileChanges: {
          files: [
            {
              path: "a.ts",
              truncated: false,
              lines: { additions: 12, deletions: 4 },
            },
            { path: "b.ts", truncated: false },
            {
              path: "long/path/to/c…",
              truncated: true,
              lines: { additions: 1, deletions: 0 },
            },
          ],
          totalFiles: 4,
          truncated: true,
        },
      },
    },
    { kind: "turn-completed", status: "completed" },
  ]);
  assert.equal(
    fileChangeText(
      renderToString(() =>
        transcript.SessionTranscript({ command: completedChanges }),
      ),
    ),
    "改了 4 个文件：a.ts +12/-4；b.ts；long/path/to/c… （已截断） +1/-0；另有 1 个文件",
  );

  const noChanges = sanitizedCommand([
    { kind: "turn-started" },
    { kind: "progress", activity: "thinking" },
    { kind: "turn-completed", status: "completed" },
  ]);
  const noChangesHtml = renderToString(() =>
    transcript.SessionTranscript({ command: noChanges }),
  );
  assert.doesNotMatch(noChangesHtml, /turn-file-changes/u);
  assert.doesNotMatch(noChangesHtml, /改了 \d+ 个文件|Changed \d+ files?/u);
});

function projectResult(
  timeline: readonly WorkbenchTimelineEvent[],
): Extract<WorkbenchProjectResult, { readonly ok: true }> {
  const seed = visualFixture.commands[0]!;
  return {
    ok: true,
    view: {
      project: visualFixture.project,
      observation: visualFixture.observation,
      commands: [
        {
          ...seed,
          status: "in-flight",
          session: {
            ...seed.session!,
            timeline,
          },
        },
      ],
      initialSelectionKey: seed.key,
    },
  };
}

function sanitizedCommand(
  timeline: readonly WorkbenchTimelineEvent[],
): WorkbenchCommandView {
  const result = sanitizeWorkbenchProjectResult(projectResult(timeline));
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("Expected the renderer fixture to sanitize.");
  return result.view.commands[0]!;
}

function progressText(html: string): string {
  const progress = html.match(
    /<p[^>]*class="turn-progress"[^>]*>[\s\S]*?<\/p>/u,
  )?.[0];
  assert.ok(progress, "an active turn exposes its live progress row");
  return progress.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
}

function fileChangeText(html: string): string {
  const summary = html.match(
    /<p[^>]*class="turn-file-changes"[^>]*>[\s\S]*?<\/p>/u,
  )?.[0];
  assert.ok(summary, "a fileChange event exposes a persistent turn summary");
  return summary.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
}
