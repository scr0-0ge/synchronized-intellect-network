import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";

import type {
  ProjectChannel,
  ProjectSnapshot,
  ProjectUpdate,
} from "../../src/coordinator/index.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import type {
  WorkbenchCommandView,
  WorkbenchTimelineEvent,
} from "../../src/workbench-shell/contract.ts";
import { createWorkbenchLiveView } from "../../src/workbench-shell/live-view.ts";
import { runtimeProfileCopy } from "../../src/workbench-shell/renderer/copy/runtime-profile-copy.ts";
import { steerCopy } from "../../src/workbench-shell/renderer/copy/composer-copy.ts";
import {
  eventTitleCopy,
  statusCopy,
} from "../../src/workbench-shell/renderer/copy/session-status-copy.ts";
import {
  copyLocaleDictionaries,
  transcriptCopy,
  turnStateCopy,
  turnOrdinalCopy,
  turnNotStartedOrdinalCopy,
} from "../../src/workbench-shell/renderer/copy/transcript-copy.ts";
import { copyLocaleDictionaries as inspectorCopyLocaleDictionaries } from "../../src/workbench-shell/renderer/copy/inspector-copy.ts";
import { eventTitle } from "../../src/workbench-shell/renderer/view-model.ts";
import { visualFixture } from "./visual-harness/fixture.ts";

interface UserMessageRendererModule {
  readonly SessionInspector: (
    props: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly SessionTranscript: (
    props: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly groupTimelineEvents: (
    events: readonly WorkbenchTimelineEvent[],
  ) => readonly TimelineEventGroup[];
}

interface TimelineEventGroup {
  readonly userMessage?: Extract<
    WorkbenchTimelineEvent,
    { readonly kind: "user-message" }
  >;
  readonly events: readonly Exclude<
    WorkbenchTimelineEvent,
    { readonly kind: "user-message" }
  >[];
}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("exact persisted user input renders as one literal You turn outside agent Markdown and raw disclosure", async () => {
  assert.deepEqual(
    {
      actorUser: transcriptCopy.actorUser,
      sessionStarted: transcriptCopy.sessionStartedRule,
      runtimeWorking: transcriptCopy.runtimeWorking,
      failedTitle: transcriptCopy.failedTitle,
      recoveryTitle: transcriptCopy.recoveryTitle,
      noAgentMessage: transcriptCopy.noAgentMessageRecorded,
      acceptedStatus: statusCopy.accepted,
      userEventTitle: eventTitleCopy["user-message"],
      executionMode: runtimeProfileCopy.fixedExecutionModeLabel,
      accessMode: runtimeProfileCopy.fixedAccessModeLabel,
    },
    {
      actorUser: "You",
      sessionStarted: "Session started",
      runtimeWorking: "The Agent Runtime is working",
      failedTitle: "The Agent Session failed",
      recoveryTitle: "Recovery required",
      noAgentMessage: "No agent message text was recorded for this turn.",
      acceptedStatus: "Accepted",
      userEventTitle: "User message",
      executionMode: "Single agent",
      accessMode: "Full access",
    },
  );
  await withUserMessageRendererModule(async ({ SessionTranscript }) => {
    const literal = [
      "C:\\Users\\Ada\\project\\file.ts",
      "Bearer token-123",
      '<script>alert("x")</script>',
      "# Markdown heading",
      "- markdown list",
      "**bold** & `code`",
      "```ts",
      'const secret = "<tag>";',
      "```",
    ].join("\n");
    const timeline = Object.freeze([
      Object.freeze({ kind: "user-message" as const, text: literal }),
      Object.freeze({ kind: "session-started" as const }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({
        kind: "item-started" as const,
        itemType: "agent-message" as const,
      }),
      Object.freeze({
        kind: "agent-message" as const,
        text: "Agent stream",
      }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const command = commandWith({ status: "in-flight", timeline });
    const html = renderToString(() => SessionTranscript({ command }));

    const userTurns = [...html.matchAll(
      /<article[^>]*class="turn turn-user"[^>]*>[\s\S]*?<\/article>/gu,
    )].map((match) => match[0] ?? "");
    assert.equal(userTurns.length, 1, html);
    const userTurn = userTurns[0] ?? "";
    assert.match(
      userTurn,
      new RegExp(
        `<span class="turn-actor actor-user">${transcriptCopy.actorUser}</span>`,
        "u",
      ),
    );
    const userBody = userTurn.match(
      /<div class="turn-body user-message-text(?: is-clamped)?"[^>]*>([\s\S]*?)<\/div>/u,
    )?.[1];
    assert.ok(userBody, "the user text has its own literal text container");
    assert.equal(decodeText(userBody), literal);
    assert.match(userBody, /&lt;script>alert\("x"\)&lt;\/script>/u);
    assert.doesNotMatch(
      userTurn,
      /<(?:script|h1|h2|h3|ul|ol|li|pre|code|strong)\b/iu,
    );

    assertOrdered(withoutSolidMarkers(html), [
      transcriptCopy.sessionStartedRule,
      `<span class="turn-actor actor-user">${transcriptCopy.actorUser}</span>`,
      "Turn 1",
      '<span class="turn-actor rt-name rt-codex">Codex</span>',
    ]);

    const disclosure = html.match(
      /<button[^>]*class="disclosure"[^>]*>[\s\S]*?<\/button>/u,
    )?.[0];
    assert.ok(disclosure);
    assert.equal(plainText(disclosure), "4 events ▴");
    const eventLog = html.match(
      /<ol[^>]*class="event-log"[^>]*>[\s\S]*?<\/ol>/u,
    )?.[0];
    assert.ok(eventLog, "the active agent event log is mounted and open");
    assert.doesNotMatch(eventLog, /user-message|token-123|C:\\Users/u);
  });
});

test("user messages own their following runtime slices while no-user history keeps repeated-turn fallback", async () => {
  await withUserMessageRendererModule(async ({ groupTimelineEvents }) => {
    const first = Object.freeze({ kind: "user-message" as const, text: "first" });
    const second = Object.freeze({ kind: "user-message" as const, text: "second" });
    const grouped = groupTimelineEvents(Object.freeze([
      first,
      Object.freeze({ kind: "session-started" as const }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({ kind: "agent-message" as const, text: "one" }),
      Object.freeze({
        kind: "turn-completed" as const,
        status: "completed" as const,
      }),
      second,
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({
        kind: "item-started" as const,
        itemType: "agent-message" as const,
      }),
    ]));

    assert.equal(grouped.length, 2);
    assert.equal(grouped[0]?.userMessage, first);
    assert.deepEqual(grouped[0]?.events.map((event) => event.kind), [
      "session-started",
      "turn-started",
      "agent-message",
      "turn-completed",
    ]);
    assert.equal(grouped[1]?.userMessage, second);
    assert.deepEqual(grouped[1]?.events.map((event) => event.kind), [
      "turn-started",
      "item-started",
    ]);
    assert.equal(
      grouped.every(
        (group) =>
          Object.isFrozen(group) &&
          Object.isFrozen(group.events) &&
          group.events.every((event) => String(event.kind) !== "user-message"),
      ),
      true,
    );

    const legacy = groupTimelineEvents(Object.freeze([
      Object.freeze({ kind: "session-started" as const }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({ kind: "agent-message" as const, text: "legacy one" }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({ kind: "agent-message" as const, text: "legacy two" }),
    ]));
    assert.equal(legacy.length, 2);
    assert.deepEqual(legacy.map((group) => group.events.map((event) => event.kind)), [
      ["session-started", "turn-started", "agent-message"],
      ["turn-started", "agent-message"],
    ]);
    assert.equal(
      legacy.some((group) => Object.hasOwn(group, "userMessage")),
      false,
    );

    const mixedPrefix = groupTimelineEvents(Object.freeze([
      Object.freeze({ kind: "session-started" as const }),
      Object.freeze({ kind: "user-message" as const, text: "modern" }),
      Object.freeze({ kind: "turn-started" as const }),
    ]));
    assert.equal(mixedPrefix.length, 2);
    assert.deepEqual(mixedPrefix[0]?.events.map((event) => event.kind), [
      "session-started",
    ]);
    assert.equal(mixedPrefix[1]?.userMessage?.text, "modern");
  });
});

test("multi-turn rendering orders each You turn before its runtime turn and preserves legacy rendering", async () => {
  await withUserMessageRendererModule(async ({ SessionTranscript }) => {
    const timeline = Object.freeze([
      Object.freeze({ kind: "user-message" as const, text: "first input" }),
      Object.freeze({ kind: "session-started" as const }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({ kind: "agent-message" as const, text: "first response" }),
      Object.freeze({
        kind: "turn-completed" as const,
        status: "completed" as const,
      }),
      Object.freeze({
        kind: "user-message" as const,
        text: "second\ninput",
      }),
      Object.freeze({ kind: "turn-started" as const }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const html = withoutSolidMarkers(renderToString(() =>
      SessionTranscript({
        command: commandWith({ status: "in-flight", timeline }),
      }),
    ));

    assert.equal(html.match(/class="turn turn-user"/gu)?.length, 2);
    assert.equal(html.match(/<span class="rule-label">Turn \d<\/span>/gu)?.length, 2);
    assertOrdered(html, [
      transcriptCopy.sessionStartedRule,
      `<span class="turn-actor actor-user">${transcriptCopy.actorUser}</span>`,
      "first input",
      "Turn 1",
      "first response",
      `<span class="turn-actor actor-user">${transcriptCopy.actorUser}</span>`,
      "second\ninput",
      "Turn 2",
      transcriptCopy.runtimeWorking,
    ]);
    const disclosures = [...html.matchAll(
      /<button[^>]*class="disclosure"[^>]*>[\s\S]*?<\/button>/gu,
    )].map((match) => plainText(match[0] ?? ""));
    assert.deepEqual(disclosures, ["4 events ▾", "1 event ▴"]);

    const legacyTimeline = Object.freeze([
      Object.freeze({ kind: "session-started" as const }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({ kind: "agent-message" as const, text: "legacy one" }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({ kind: "agent-message" as const, text: "legacy two" }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const legacyHtml = withoutSolidMarkers(renderToString(() =>
      SessionTranscript({
        command: commandWith({ status: "completed", timeline: legacyTimeline }),
      }),
    ));
    assert.equal(legacyHtml.match(/class="turn turn-user"/gu)?.length ?? 0, 0);
    assert.equal(
      legacyHtml.match(
        new RegExp(`>${transcriptCopy.sessionStartedRule}<`, "gu"),
      )?.length,
      1,
    );
    assert.equal(legacyHtml.match(/<span class="rule-label">Turn \d<\/span>/gu)?.length, 2);
    assertOrdered(legacyHtml, [
      transcriptCopy.sessionStartedRule,
      "Turn 1",
      "legacy one",
      "Turn 2",
      "legacy two",
    ]);
  });
});

test("same-turn guidance keeps the durable command's turn number", async () => {
  assert.match(steerCopy.availableFoot, /current turn/u);
  await withUserMessageRendererModule(async ({ SessionInspector, SessionTranscript }) => {
    const timeline = Object.freeze([
      Object.freeze({ kind: "user-message" as const, text: "initial request" }),
      Object.freeze({ kind: "session-started" as const }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({ kind: "agent-message" as const, text: "waiting for guidance" }),
      Object.freeze({ kind: "user-message" as const, text: "same-turn guidance" }),
      Object.freeze({ kind: "agent-message" as const, text: "guidance accepted" }),
      Object.freeze({
        kind: "turn-completed" as const,
        status: "completed" as const,
      }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const seed = commandWith({ status: "completed", timeline });
    assert.ok(seed.session);
    const command: WorkbenchCommandView = Object.freeze({
      ...seed,
      session: Object.freeze({
        ...seed.session,
        turns: Object.freeze([
          Object.freeze({ profile: seed.session.profile, timeline }),
        ]),
      }),
    });
    const html = withoutSolidMarkers(
      renderToString(() => SessionTranscript({ command })),
    );

    assertOrdered(html, [
      "initial request",
      "Turn 1",
      "waiting for guidance",
      "same-turn guidance",
      "Guidance · Turn 1",
      "guidance accepted",
    ]);
    assert.doesNotMatch(html, /Turn 2/u);

    const inspectorHtml = withoutSolidMarkers(
      renderToString(() =>
        SessionInspector({
          command,
          view: Object.freeze({
            ...visualFixture,
            commands: Object.freeze([command]),
            initialSelectionKey: command.key,
          }),
          onCollapse: (): void => undefined,
        }),
      ),
    );
    assert.match(inspectorHtml, /<dt>Turns<\/dt><dd[^>]*>1<\/dd>/u);
  });
});

test("each rendered reply keeps the effective model of its own durable command after a model switch", async () => {
  const firstRequested = requestedProjection("Solution 5.6", "Maximum");
  const secondRequested = requestedProjection("Terra 5.6", "High");
  const snapshot: ProjectSnapshot = Object.freeze({
    projectId: "hidden-project",
    cursor: 6,
    commands: Object.freeze([
      durableCommand({
        commandId: "hidden-first-command",
        input: "first input",
        model: "gpt-5.6-sol",
        effortLevel: "ultra",
        reply: "first response",
        requested: firstRequested,
        effective: effectiveProjection("Solution 5.6", "Maximum"),
        sessionStarted: true,
      }),
      durableCommand({
        commandId: "hidden-second-command",
        input: "second input",
        model: "gpt-5.6-terra",
        effortLevel: "high",
        reply: "second response",
        requested: secondRequested,
        effective: effectiveProjection("Terra 5.6", "High"),
        sessionStarted: false,
      }),
    ]),
  });
  const liveView = createWorkbenchLiveView({
    channel: staticProjectChannel(snapshot),
    projectDirectory: join(tmpdir(), "Per reply attribution"),
  });
  let dispose = (): void => undefined;
  try {
    const projected = await new Promise<WorkbenchCommandView>((resolve, reject) => {
      dispose = liveView.observe((result) => {
        if (!result.ok) {
          reject(new Error(result.error.category));
          return;
        }
        const command = result.view.commands[0];
        if (command === undefined) {
          reject(new Error("missing-command"));
          return;
        }
        resolve(command);
      });
    });
    await withUserMessageRendererModule(async ({ SessionTranscript }) => {
      const html = withoutSolidMarkers(renderToString(() =>
        SessionTranscript({ command: projected }),
      ));
      const replyModels = [...html.matchAll(
        /<span class="turn-model [^"]*">([^<]*)<\/span>/gu,
      )].map((match) => decodeText(match[1] ?? ""));
      assert.deepEqual(replyModels, ["Solution 5.6", "Terra 5.6"]);
      const replyIntensities = [...html.matchAll(
        /<span class="turn-intensity [^"]*">([^<]*)<\/span>/gu,
      )].map((match) => decodeText(match[1] ?? "").replace(/^·\s*/u, ""));
      assert.deepEqual(replyIntensities, ["Maximum", "High"]);
      assert.match(
        html,
        /Session started[\s\S]*?Codex · Codex desktop · Solution 5\.6 · Maximum/u,
      );
      assertOrdered(html, [
        "first response",
        "second input",
        "Terra 5.6",
        "second response",
      ]);
    });
  } finally {
    dispose();
    await liveView.close();
  }
});

test("reply attribution distinguishes observed mismatch, unobserved, and not-recorded profiles", async () => {
  await withUserMessageRendererModule(async ({ SessionTranscript }) => {
    const requested = requestedProjection("Requested model", "Requested intensity");
    const mismatch = Object.freeze({
      requested,
      effective: Object.freeze({
        kind: "observed" as const,
        provenance: "post-turn-observation" as const,
        model: Object.freeze({
          label: "Observed different value",
          comparison: "differs-from-requested" as const,
        }),
        workIntensity: Object.freeze({
          label: "Requested intensity",
          comparison: "matches-requested" as const,
        }),
        accessMode: Object.freeze({
          label: runtimeProfileCopy.fixedAccessModeLabel,
          comparison: "matches-requested" as const,
        }),
      }),
    });
    const unobserved = Object.freeze({
      requested,
      effective: Object.freeze({ kind: "unknown" as const }),
    });
    const notRecorded = Object.freeze({
      requested: Object.freeze({ kind: "not-recorded" as const }),
      effective: Object.freeze({ kind: "not-recorded" as const }),
    });
    const turnTimelines = [
      turnTimeline("mismatch input", "mismatch response", true),
      turnTimeline("unobserved input", "unobserved response", false),
      turnTimeline("legacy input", "legacy response", false),
    ] as const;
    const seed = commandWith({
      status: "completed",
      timeline: Object.freeze(turnTimelines.flat()),
    });
    assert.ok(seed.session);
    const command: WorkbenchCommandView = Object.freeze({
      ...seed,
      session: Object.freeze({
        ...seed.session,
        profile: notRecorded,
        turns: Object.freeze([
          Object.freeze({ profile: mismatch, timeline: turnTimelines[0] }),
          Object.freeze({ profile: unobserved, timeline: turnTimelines[1] }),
          Object.freeze({ profile: notRecorded, timeline: turnTimelines[2] }),
        ]),
      }),
    });
    const html = withoutSolidMarkers(renderToString(() =>
      SessionTranscript({ command }),
    ));
    const labels = [...html.matchAll(
      /<span class="turn-model [^"]*">([^<]*)<\/span>/gu,
    )].map((match) => decodeText(match[1] ?? ""));
    assert.deepEqual(labels, [
      "Observed different value · differs from requested Requested model",
      "Model not observed · requested Requested model",
      "Model not recorded",
    ]);
    const intensities = [...html.matchAll(
      /<span class="turn-intensity [^"]*">([^<]*)<\/span>/gu,
    )].map((match) => decodeText(match[1] ?? "").replace(/^·\s*/u, ""));
    assert.deepEqual(intensities, [
      "Requested intensity",
      "Work Intensity not observed · requested Requested intensity",
      "Work Intensity not recorded",
    ]);
  });
});

/**
 * Issue #6 case 2. The owner read
 * "模型未知 · 请求值为 glm-5.3[1m] · 工作强度未知 · 请求值为 default"
 * on a GLM turn that never finished and concluded the stored API key had gone
 * bad. The selection was never unknown -- it is right there in the same line --
 * and the effective projection's `unknown` arm carries no per-field data, so the
 * word describes the *observation*, not the model and not the work intensity.
 * Both nouns must say that no effective value was observed, and a turn that is
 * still running must be distinguishable from one that ended without ever
 * reporting: the first is normal, the second is the anomaly worth chasing.
 */
test("an unobserved turn never claims the model or work intensity is unknown", async () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const dictionary = copyLocaleDictionaries[locale];
    for (const noun of ["Model", "模型"]) {
      for (const text of [
        dictionary.effectiveUnobservedCopy(noun),
        dictionary.effectiveUnobservedRequestedCopy(noun, "glm-5.3[1m]"),
        dictionary.effectivePendingObservationCopy(noun),
        dictionary.effectivePendingObservationRequestedCopy(noun, "glm-5.3[1m]"),
      ]) {
        assert.ok(
          !/unknown/iu.test(text) && !text.includes("未知"),
          `${locale} copy must not call the selection unknown: ${text}`,
        );
        assert.ok(text.includes(noun), `${locale} copy names the field: ${text}`);
      }
    }
    assert.ok(
      dictionary
        .effectiveUnobservedRequestedCopy("Model", "glm-5.3[1m]")
        .includes("glm-5.3[1m]"),
      `${locale} still echoes the requested value`,
    );
  }
  await withUserMessageRendererModule(async ({ SessionInspector, SessionTranscript }) => {
    const requested = requestedProjection("glm-5.3[1m]", "default");
    const unobserved = Object.freeze({
      requested,
      effective: Object.freeze({ kind: "unknown" as const }),
    });
    // Turn 1 ended without a post-turn observation; turn 2 is still running,
    // so no observation can exist yet. Same projection, different truths.
    const endedTimeline = Object.freeze([
      Object.freeze({ kind: "user-message" as const, text: "ended input" }),
      Object.freeze({ kind: "session-started" as const }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({ kind: "failed" as const }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const runningTimeline = Object.freeze([
      Object.freeze({ kind: "user-message" as const, text: "running input" }),
      Object.freeze({ kind: "turn-started" as const }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const seed = commandWith({
      status: "in-flight",
      timeline: Object.freeze([...endedTimeline, ...runningTimeline]),
    });
    assert.ok(seed.session);
    const command: WorkbenchCommandView = Object.freeze({
      ...seed,
      session: Object.freeze({
        ...seed.session,
        profile: unobserved,
        turns: Object.freeze([
          Object.freeze({ profile: unobserved, timeline: endedTimeline }),
          Object.freeze({ profile: unobserved, timeline: runningTimeline }),
        ]),
      }),
    });
    const html = withoutSolidMarkers(renderToString(() =>
      SessionTranscript({ command }),
    ));
    const models = [...html.matchAll(
      /<span class="turn-model [^"]*">([^<]*)<\/span>/gu,
    )].map((match) => decodeText(match[1] ?? ""));
    assert.deepEqual(models, [
      "Model not observed · requested glm-5.3[1m]",
      "Model pending observation · requested glm-5.3[1m]",
    ]);
    const intensities = [...html.matchAll(
      /<span class="turn-intensity [^"]*">([^<]*)<\/span>/gu,
    )].map((match) => decodeText(match[1] ?? "").replace(/^·\s*/u, ""));
    assert.deepEqual(intensities, [
      "Work Intensity not observed · requested default",
      "Work Intensity pending observation · requested default",
    ]);
    assert.ok(
      !/unknown/iu.test(models.join(" ") + intensities.join(" ")),
      html,
    );
    // The Inspector's "Effective (post-turn)" section carries the same three
    // values and must not call them unknown either.
    for (const locale of ["en", "zh-CN"] as const) {
      const dictionary = inspectorCopyLocaleDictionaries[locale].inspectorCopy;
      for (const text of [
        dictionary.unobservedValue,
        dictionary.pendingObservationValue,
      ]) {
        assert.ok(
          !/unknown/iu.test(text) && !text.includes("未知"),
          `${locale} Inspector copy must not call the selection unknown: ${text}`,
        );
      }
    }
    for (const [status, expected] of [
      ["in-flight", "Pending observation"],
      ["failed", "Not observed"],
    ] as const) {
      const inspected: WorkbenchCommandView = Object.freeze({
        ...command,
        status,
      });
      const inspectorHtml = withoutSolidMarkers(renderToString(() =>
        SessionInspector({
          command: inspected,
          view: Object.freeze({
            ...visualFixture,
            commands: Object.freeze([inspected]),
            initialSelectionKey: inspected.key,
          }),
          onCollapse: (): void => undefined,
        }),
      ));
      assert.equal(
        inspectorHtml.split(expected).length - 1,
        3,
        `${status}: model, work intensity and access mode all read ${expected}`,
      );
      assert.doesNotMatch(inspectorHtml, /<dd[^>]*>Unknown<[/]dd>/u);
    }
  });
});

test("message-only accepted, failed, recovery, and not-yet-attached commands stay honest", async () => {
  await withUserMessageRendererModule(async ({ SessionTranscript }) => {
    const acceptedTimeline = Object.freeze([
      Object.freeze({
        kind: "user-message" as const,
        text: "accepted only",
      }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const acceptedHtml = withoutSolidMarkers(renderToString(() =>
      SessionTranscript({
        command: commandWith({ status: "accepted", timeline: acceptedTimeline }),
      }),
    ));
    assert.doesNotMatch(acceptedHtml, /Session started/u);
    assertOrdered(acceptedHtml, [
      transcriptCopy.actorUser,
      "accepted only",
      "Turn 1",
      turnStateCopy["in-flight"],
    ]);
    assert.match(
      acceptedHtml,
      new RegExp(transcriptCopy.runtimeWorking, "u"),
    );
    assert.equal(
      plainText(acceptedHtml.match(/<button[^>]*class="disclosure"[^>]*>[\s\S]*?<\/button>/u)?.[0] ?? ""),
      "0 events ▴",
    );

    const failedTimeline = Object.freeze([
      Object.freeze({ kind: "user-message" as const, text: "failed input" }),
      Object.freeze({ kind: "failed" as const }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const failedHtml = withoutSolidMarkers(renderToString(() =>
      SessionTranscript({
        command: commandWith({ status: "failed", timeline: failedTimeline }),
      }),
    ));
    assert.doesNotMatch(failedHtml, /Session started/u);
    assertOrdered(failedHtml, [
      transcriptCopy.actorUser,
      "failed input",
      turnNotStartedOrdinalCopy(1),
      turnStateCopy.failed,
    ]);
    assert.match(failedHtml, new RegExp(transcriptCopy.failedTitle, "u"));
    assert.equal(
      plainText(failedHtml.match(/<button[^>]*class="disclosure"[^>]*>[\s\S]*?<\/button>/u)?.[0] ?? ""),
      "1 event ▾",
    );
    const failedEventLog = failedHtml.match(
      /<ol[^>]*class="event-log"[^>]*>[\s\S]*?<\/ol>/u,
    )?.[0];
    assert.ok(failedEventLog);
    assert.match(failedEventLog, /\shidden(?:="")?/u);
    assert.doesNotMatch(
      failedEventLog,
      /<li(?:\s|>)/u,
      "the closed failed-event disclosure reports its count without mounting its row",
    );

    const recoveryTimeline = Object.freeze([
      Object.freeze({ kind: "user-message" as const, text: "recover input" }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const recoveryHtml = withoutSolidMarkers(renderToString(() =>
      SessionTranscript({
        command: commandWith({
          status: "recovery-required",
          timeline: recoveryTimeline,
        }),
      }),
    ));
    assert.doesNotMatch(recoveryHtml, /Session started/u);
    assertOrdered(recoveryHtml, [
      transcriptCopy.actorUser,
      "recover input",
      turnNotStartedOrdinalCopy(1),
      turnStateCopy["recovery-required"],
      transcriptCopy.recoveryTitle,
    ]);
    assert.match(
      recoveryHtml,
      new RegExp(transcriptCopy.noAgentMessageRecorded.replace(".", "\\."), "u"),
    );
    assert.equal(
      plainText(recoveryHtml.match(/<button[^>]*class="disclosure"[^>]*>[\s\S]*?<\/button>/u)?.[0] ?? ""),
      "0 events ▾",
    );

    const startedThenFailedTimeline = Object.freeze([
      Object.freeze({ kind: "user-message" as const, text: "started input" }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({ kind: "failed" as const }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const startedThenFailedHtml = withoutSolidMarkers(renderToString(() =>
      SessionTranscript({
        command: commandWith({
          status: "failed",
          timeline: startedThenFailedTimeline,
        }),
      }),
    ));
    assertOrdered(startedThenFailedHtml, [
      transcriptCopy.actorUser,
      "started input",
      "Turn 1",
      turnStateCopy.failed,
    ]);
    assert.doesNotMatch(startedThenFailedHtml, /Turn not started/u);

    const unattached: WorkbenchCommandView = Object.freeze({
      key: "command-awaiting-session",
      label: "Agent Session pending",
      runtime: "Codex",
      status: "accepted",
    });
    const unattachedHtml = renderToString(() =>
      SessionTranscript({ command: unattached }),
    );
    assert.match(unattachedHtml, new RegExp(`>${statusCopy.accepted}`, "u"));
    assert.match(
      unattachedHtml,
      /No Agent Session was durably attached to this command\./u,
    );
  });
});

test("Inspector total includes user events while Turns and agent disclosure stay runtime-specific", async () => {
  await withUserMessageRendererModule(async ({ SessionInspector, SessionTranscript }) => {
    const timeline = Object.freeze([
      Object.freeze({ kind: "user-message" as const, text: "inspect me" }),
      Object.freeze({ kind: "session-started" as const }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({
        kind: "item-started" as const,
        itemType: "agent-message" as const,
      }),
      Object.freeze({ kind: "agent-message" as const, text: "visible" }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const command = commandWith({ status: "in-flight", timeline });
    const view = Object.freeze({
      ...visualFixture,
      commands: Object.freeze([command]),
      initialSelectionKey: command.key,
    });
    const inspectorHtml = withoutSolidMarkers(renderToString(() =>
      SessionInspector({
        command,
        view,
        onCollapse: (): void => undefined,
      }),
    ));
    assert.match(inspectorHtml, /<dt>Turns<\/dt><dd[^>]*>1<\/dd>/u);
    assert.match(inspectorHtml, /<dt>Events<\/dt><dd[^>]*>5<\/dd>/u);
    assert.doesNotMatch(inspectorHtml, /inspect me|user-message/u);

    const transcriptHtml = renderToString(() => SessionTranscript({ command }));
    const disclosure = transcriptHtml.match(
      /<button[^>]*class="disclosure"[^>]*>[\s\S]*?<\/button>/u,
    )?.[0];
    assert.equal(plainText(disclosure ?? ""), "4 events ▴");
  });
});

test("a turn that died before turn-started agrees with its own recovery card on the turn number", async () => {
  await withUserMessageRendererModule(async ({ SessionTranscript }) => {
    const seed = visualFixture.commands[0];
    assert.ok(seed?.session);
    // The input reached the runtime and the command was accepted, but the
    // process died before a turn-started event landed: zero events recorded.
    const timeline = Object.freeze([
      Object.freeze({ kind: "user-message" as const, text: "died before turn-started" }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const command: WorkbenchCommandView = Object.freeze({
      ...seed,
      key: "command-crashed-before-turn-started",
      label: "Agent Session crashed early",
      status: "recovery-required",
      session: Object.freeze({
        ...seed.session,
        timeline,
        resumable: false,
        selectionKey: null,
        turns: Object.freeze([
          Object.freeze({
            profile: seed.session.profile,
            recovery: Object.freeze({
              resume: "unconfirmed",
              reason: "resume-timeout",
            } as const),
            timeline,
          }),
        ]),
      }),
    });
    const html = withoutSolidMarkers(renderToString(() => SessionTranscript({ command })));
    // Both the rule-label title and the recovery card below it must name the
    // same turn (issue w195): neither "Turn not started" bare nor a mismatched
    // ordinal may appear.
    assertOrdered(html, [
      transcriptCopy.actorUser,
      "died before turn-started",
      turnNotStartedOrdinalCopy(1),
      turnStateCopy["recovery-required"],
      `${turnOrdinalCopy(1)} · ${transcriptCopy.outcomeUnknownRule}`,
    ]);
    assert.doesNotMatch(html, /Turn not started<\/span>/u);
  });
});

test("the You renderer is a direct Solid text node with pre-wrapped safe wrapping", async () => {
  const [source, styles] = await Promise.all([
    readFile(
      new URL("../../src/workbench-shell/renderer/transcript.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../src/workbench-shell/renderer/styles.css", import.meta.url),
      "utf8",
    ),
  ]);
  const userTurnSource = source.slice(
    source.indexOf("const UserMessageTurn: Component"),
    source.indexOf("interface TimelineDisclosureState"),
  );
  // The literal-text contract is unchanged: the persisted prompt is a direct
  // Solid text child of the pre-wrapped container — never markdown, never
  // innerHTML. Long prompts additionally get the clamp affordance (issue #6
  // case 5): the only structural additions are the `is-clamped` class hook
  // and the disclosure button, both outside the text node itself.
  assert.match(
    userTurnSource,
    /class=\{`turn-body user-message-text\$\{/u,
  );
  assert.match(userTurnSource, /\{props\.text\}/u);
  assert.match(userTurnSource, /class="user-message-toggle"/u);
  assert.doesNotMatch(
    userTurnSource,
    /AgentMessageText|agentMessageBlocks|innerHTML|textContent/u,
  );

  const userRule = styles.slice(
    styles.indexOf(".turn-user .turn-body"),
    styles.indexOf(".prose {"),
  );
  assert.match(userRule, /white-space: pre-wrap;/u);
  assert.match(userRule, /overflow-wrap: anywhere;/u);
  assert.equal(
    eventTitle({ kind: "user-message", text: "private" }),
    eventTitleCopy["user-message"],
  );
});

function commandWith(options: {
  readonly status: WorkbenchCommandView["status"];
  readonly timeline: readonly WorkbenchTimelineEvent[];
}): WorkbenchCommandView {
  const seed = visualFixture.commands[0];
  assert.ok(seed?.session);
  return Object.freeze({
    ...seed,
    key: "command-user-message",
    label: "Agent Session 01",
    status: options.status,
    session: Object.freeze({
      ...seed.session,
      timeline: options.timeline,
      resumable: false,
      selectionKey: null,
    }),
  });
}

function requestedProjection(modelLabel: string, workIntensityLabel: string) {
  return Object.freeze({
    kind: "recorded" as const,
    runtimeFamilyLabel: "Codex",
    endpointLabel: "Codex desktop",
    modelLabel,
    workIntensityControlLabel: Object.freeze({
      label: "Reasoning",
      provenance: "runtime-catalog" as const,
    }),
    workIntensityLabel,
    executionModeLabel: runtimeProfileCopy.fixedExecutionModeLabel,
    accessModeLabel: runtimeProfileCopy.fixedAccessModeLabel,
  });
}

function effectiveProjection(modelLabel: string, workIntensityLabel: string) {
  return Object.freeze({
    kind: "observed" as const,
    provenance: "post-turn-observation" as const,
    model: Object.freeze({
      label: modelLabel,
      comparison: "matches-requested" as const,
    }),
    workIntensity: Object.freeze({
      label: workIntensityLabel,
      comparison: "matches-requested" as const,
    }),
    accessMode: Object.freeze({
      label: runtimeProfileCopy.fixedAccessModeLabel,
      comparison: "matches-requested" as const,
    }),
  });
}

function turnTimeline(
  input: string,
  reply: string,
  sessionStarted: boolean,
): readonly WorkbenchTimelineEvent[] {
  return Object.freeze([
    { kind: "user-message" as const, text: input },
    ...(sessionStarted ? [{ kind: "session-started" as const }] : []),
    { kind: "turn-started" as const },
    { kind: "agent-message" as const, text: reply },
    { kind: "turn-completed" as const, status: "completed" as const },
  ]);
}

function durableCommand(options: {
  readonly commandId: string;
  readonly input: string;
  readonly model: string;
  readonly effortLevel: string;
  readonly reply: string;
  readonly requested: ReturnType<typeof requestedProjection>;
  readonly effective: ReturnType<typeof effectiveProjection>;
  readonly sessionStarted: boolean;
}): ProjectSnapshot["commands"][number] {
  return Object.freeze({
    commandId: options.commandId,
    runtime: "codex" as const,
    status: "completed" as const,
    input: options.input,
    session: Object.freeze({
      sessionId: "hidden-shared-session",
      displayName: "Agent Session 01",
      archived: false,
      profile: Object.freeze({
        model: options.model,
        effortLevel: options.effortLevel,
        executionMode: "single-agent",
        accessMode: "full-access",
      }),
      requestedProfileProjection: options.requested,
      effectiveProfileProjection: options.effective,
      resumable: true,
      events: Object.freeze([
        ...(options.sessionStarted ? [{ kind: "session-started" as const }] : []),
        { kind: "turn-started" as const },
        { kind: "agent-message" as const, text: options.reply },
        { kind: "turn-completed" as const, status: "completed" as const },
      ]),
    }),
  });
}

function staticProjectChannel(snapshot: ProjectSnapshot): ProjectChannel {
  let finish: ((result: IteratorResult<ProjectUpdate>) => void) | undefined;
  const iterator: AsyncIterableIterator<ProjectUpdate> = {
    next: () => new Promise((resolve) => {
      finish = resolve;
    }),
    return: async () => {
      finish?.({ done: true, value: undefined });
      finish = undefined;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return {
    async act() {
      throw new Error("ACT_MUST_NOT_RUN");
    },
    async validateContinuationProfile() {
      return { status: "compatible" };
    },
    async removeSession() {
      return { status: "not-found" };
    },
    async mutateSessionMetadata() {
      return { status: "not-found" };
    },
    readTurnActivity() {
      return "idle";
    },
    async snapshot() {
      return snapshot;
    },
    observe() {
      return iterator;
    },
    async close() {
      finish?.({ done: true, value: undefined });
      finish = undefined;
    },
  };
}

function assertOrdered(html: string, values: readonly string[]): void {
  let previous = -1;
  for (const value of values) {
    const index = html.indexOf(value, previous + 1);
    assert.ok(index > previous, `${JSON.stringify(value)} appears in order`);
    previous = index;
  }
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
}

function decodeText(html: string): string {
  return html
    .replace(/<[^>]+>/gu, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function withoutSolidMarkers(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/gu, "");
}

async function withUserMessageRendererModule(
  assertion: (module: UserMessageRendererModule) => Promise<void> | void,
): Promise<void> {
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: {
      middlewareMode: true,
    },
  });

  try {
    const transcriptModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/transcript.tsx",
    );
    const inspectorModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/inspector.tsx",
    );
    const transcriptSearchModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/transcript-search.ts",
    );
    const module = {
      ...transcriptModule,
      ...inspectorModule,
      ...transcriptSearchModule,
    } as unknown as UserMessageRendererModule;
    await assertion(module);
  } finally {
    await server.close();
  }
}
