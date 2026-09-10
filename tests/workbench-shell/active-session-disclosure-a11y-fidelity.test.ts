import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import { createServer, type Plugin } from "vite";
import solid from "vite-plugin-solid";

import type {
  WorkbenchCommandView,
  WorkbenchTimelineEvent,
} from "../../src/workbench-shell/contract.ts";

interface ActiveDisclosureModule {
  readonly SessionRow: (
    props: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly TimelineTurn: (
    props: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly TimelineTurns: (
    props: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly initialTimelineDisclosureState: (
    turnKey: string,
    active: boolean,
  ) => TimelineDisclosureState;
  readonly reconcileTimelineDisclosure: (
    state: TimelineDisclosureState,
    turnKey: string,
    active: boolean,
  ) => TimelineDisclosureState;
  readonly toggleTimelineDisclosure: (
    state: TimelineDisclosureState,
  ) => TimelineDisclosureState;
  readonly createTimelineDisclosureStore: () => TimelineDisclosureStore;
  readonly rawTimelineEventDetail: (
    event: WorkbenchTimelineEvent,
    streaming: boolean,
  ) => string;
  readonly groupTimelineEvents: (
    events: readonly WorkbenchTimelineEvent[],
  ) => readonly unknown[];
}

interface TimelineDisclosureState {
  readonly turnKey: string;
  readonly active: boolean;
  readonly open: boolean;
  readonly userToggled: boolean;
}

interface TimelineDisclosureStore {
  readonly state: (
    turnKey: string,
    active: boolean,
  ) => TimelineDisclosureState;
  readonly reconcile: (turnKey: string, active: boolean) => void;
  readonly toggle: (turnKey: string, active: boolean) => void;
  readonly clear: () => void;
}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("active runtime disclosure defaults open with a controlled mounted raw log and polite lifecycle", async () => {
  await withActiveDisclosureModule(async ({
    TimelineTurn,
    createTimelineDisclosureStore,
  }) => {
    const events = Object.freeze([
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({
        kind: "item-started" as const,
        itemType: "agent-message" as const,
      }),
      Object.freeze({
        kind: "agent-message" as const,
        text: "streaming text",
      }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const html = renderToString(() =>
      TimelineTurn({
        command: commandWith({ status: "in-flight", timeline: events }),
        turnKey: "command-7:0",
        events,
        status: "in-flight",
        active: true,
        streaming: true,
        disclosureStore: createTimelineDisclosureStore(),
      }),
    );

    const disclosure = html.match(
      /<button[^>]*class="disclosure"[^>]*>[\s\S]*?<\/button>/u,
    )?.[0];
    assert.ok(disclosure, "the event count is exposed by a native disclosure");
    assert.match(disclosure, /aria-expanded="true"/u);
    assert.equal(plainText(disclosure), "3 events ▴");
    assert.match(disclosure, /<span[^>]*aria-hidden="true">▴<\/span>/u);

    const controlledId = disclosure.match(/aria-controls="([^"]+)"/u)?.[1];
    assert.ok(controlledId, "the disclosure controls an identified raw log");
    const eventLog = html.match(
      new RegExp(
        `<ol[^>]*id="${escapeRegExp(controlledId)}"[^>]*class="event-log"[^>]*>[\\s\\S]*?<\\/ol>`,
        "u",
      ),
    )?.[0];
    assert.ok(eventLog, "the controlled raw log stays mounted while open");
    assert.doesNotMatch(eventLog, /\shidden(?:="")?/u);
    assert.doesNotMatch(eventLog, /aria-live/u);
    assert.match(eventLog, /<span class="ev-kind">turn-started<\/span><span><\/span>/u);
    assert.match(eventLog, /<span class="ev-kind">item-started<\/span><span>agent-message<\/span>/u);
    assert.match(eventLog, /<span class="ev-kind">agent-message<\/span><span>streaming text<\/span>/u);

    const lifecycle = html.match(
      /<span[^>]*class="turn-state is-running"[^>]*>working<\/span>/u,
    )?.[0];
    assert.ok(lifecycle, "the active lifecycle is visible as working");
    assert.match(lifecycle, /aria-live="polite"/u);
    assert.match(lifecycle, /aria-atomic="true"/u);
  });
});

test("SessionRow accessible name is the exact visible label, family, model, status tuple", async () => {
  await withActiveDisclosureModule(async ({ SessionRow }) => {
    const command = Object.freeze({
      ...commandWith({ status: "in-flight", timeline: Object.freeze([]) }),
      key: "C:\\private\\session-selection:super-secret",
    });
    const html = renderToString(() =>
      SessionRow({
        command,
        selected: true,
        disabled: false,
        onSelect: (): void => undefined,
      }),
    );

    assert.match(
      html,
      /aria-label="Agent Session 07, Codex, GPT-5\.6-Sol, Running"/u,
    );
    assert.match(html, />GPT-5\.6-Sol<\/span>/u);
    assert.doesNotMatch(html, /session-selection|super-secret|C:\\private/u);
  });
});

test("disclosure state defaults by lifecycle and preserves explicit choice across appends and completion", async () => {
  await withActiveDisclosureModule(async (module) => {
    const active = module.initialTimelineDisclosureState("command-7:0", true);
    assert.deepEqual(active, {
      turnKey: "command-7:0",
      active: true,
      open: true,
      userToggled: false,
    });
    assert.equal(Object.isFrozen(active), true);
    assert.equal(
      module.reconcileTimelineDisclosure(active, "command-7:0", true),
      active,
      "an untouched active group stays open across event appends",
    );

    const untouchedTerminal = module.reconcileTimelineDisclosure(
      active,
      "command-7:0",
      false,
    );
    assert.deepEqual(untouchedTerminal, {
      ...active,
      active: false,
      open: false,
    });

    const explicitlyClosed = module.toggleTimelineDisclosure(active);
    assert.deepEqual(explicitlyClosed, {
      ...active,
      open: false,
      userToggled: true,
    });
    assert.equal(
      module.reconcileTimelineDisclosure(
        explicitlyClosed,
        "command-7:0",
        true,
      ),
      explicitlyClosed,
    );
    assert.equal(
      module.reconcileTimelineDisclosure(
        explicitlyClosed,
        "command-7:0",
        false,
      ).open,
      false,
      "an explicit choice survives completion",
    );

    const terminal = module.initialTimelineDisclosureState("command-7:1", false);
    assert.equal(terminal.open, false);
    const explicitlyOpened = module.toggleTimelineDisclosure(terminal);
    assert.equal(explicitlyOpened.open, true);
    assert.equal(
      module.reconcileTimelineDisclosure(
        explicitlyOpened,
        "command-7:1",
        false,
      ),
      explicitlyOpened,
    );
    assert.deepEqual(
      module.reconcileTimelineDisclosure(
        explicitlyOpened,
        "command-7:2",
        true,
      ),
      {
        turnKey: "command-7:2",
        active: true,
        open: true,
        userToggled: false,
      },
      "a different ordinal receives its own lifecycle default",
    );
  });
});

test("turn-keyed disclosure survives a recycled timeline position", async () => {
  await withActiveDisclosureModule(async ({ createTimelineDisclosureStore }) => {
    const store = createTimelineDisclosureStore();
    store.reconcile("command-7:41", false);
    store.toggle("command-7:41", false);
    assert.equal(store.state("command-7:41", false).open, true);

    store.reconcile("command-7:12", false);
    assert.equal(
      store.state("command-7:12", false).open,
      false,
      "the recycled position receives the other turn's default",
    );
    assert.equal(
      store.state("command-7:41", false).open,
      true,
      "returning to the original identity restores its explicit state",
    );
  });
});

test("raw third detail is exact for every runtime event and only streams agent text while active", async () => {
  await withActiveDisclosureModule(async ({ rawTimelineEventDetail }) => {
    assert.equal(rawTimelineEventDetail({ kind: "session-started" }, false), "");
    assert.equal(rawTimelineEventDetail({ kind: "turn-started" }, false), "");
    assert.equal(
      rawTimelineEventDetail(
        { kind: "item-started", itemType: "agent-message" },
        false,
      ),
      "agent-message",
    );
    assert.equal(
      rawTimelineEventDetail({ kind: "agent-message", text: "partial" }, true),
      "partial",
    );
    assert.equal(
      rawTimelineEventDetail({ kind: "agent-message", text: "complete" }, false),
      "",
    );
    assert.equal(
      rawTimelineEventDetail(
        { kind: "item-completed", itemType: "agent-message" },
        false,
      ),
      "agent-message",
    );
    assert.equal(
      rawTimelineEventDetail(
        { kind: "turn-completed", status: "completed" },
        false,
      ),
      "completed",
    );
    assert.equal(rawTimelineEventDetail({ kind: "failed" }, false), "");
  });
});

test("collapsed event logs stay empty until disclosure or data-backed search reveals them", async () => {
  await withActiveDisclosureModule(async ({
    TimelineTurn,
    createTimelineDisclosureStore,
  }) => {
    const events = Object.freeze([
      Object.freeze({
        kind: "turn-completed" as const,
        status: "completed" as const,
      }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const collapsedHtml = renderToString(() =>
      TimelineTurn({
        command: commandWith({ status: "completed", timeline: events }),
        turnKey: "command-7:turn:1:group:1",
        events,
        status: "completed",
        active: false,
        disclosureStore: createTimelineDisclosureStore(),
      }),
    );
    const collapsedLog = collapsedHtml.match(
      /<ol[^>]*class="event-log"[^>]*>[\s\S]*?<\/ol>/u,
    )?.[0];
    assert.ok(collapsedLog, "the disclosure keeps its controlled list in the DOM");
    assert.match(collapsedLog, /\shidden(?:="")?/u);
    assert.doesNotMatch(
      collapsedLog,
      /<li(?:\s|>)/u,
      "a collapsed list must not eagerly mount event rows",
    );

    const searchedHtml = renderToString(() =>
      TimelineTurn({
        command: commandWith({ status: "completed", timeline: events }),
        turnKey: "command-7:turn:1:group:1",
        events,
        status: "completed",
        active: false,
        searchQuery: "turn-completed",
        disclosureStore: createTimelineDisclosureStore(),
      }),
    );
    assert.match(
      searchedHtml,
      /<button[^>]*class="disclosure"[^>]*aria-expanded="true"/u,
    );
    assert.match(
      searchedHtml,
      /<mark[^>]*data-transcript-search-match[^>]*>turn-completed<\/mark>/u,
      "search reads event data and mounts the matching row without depending on hidden DOM",
    );

    const failedEvents = Object.freeze([
      Object.freeze({ kind: "failed" as const }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const searchedFailureHtml = renderToString(() =>
      TimelineTurn({
        command: commandWith({ status: "failed", timeline: failedEvents }),
        turnKey: "command-7:turn:2:group:1",
        events: failedEvents,
        status: "failed",
        active: false,
        searchQuery: "failed",
        disclosureStore: createTimelineDisclosureStore(),
      }),
    );
    assert.match(
      searchedFailureHtml,
      /<span class="ev-kind"><mark[^>]*data-transcript-search-match[^>]*>failed<\/mark><\/span><span><\/span>/u,
      "revealing a failed event preserves its exact blank raw detail",
    );
  });
});

test("windowed timeline groups reconcile by stable business identity instead of window position", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/renderer/transcript.tsx", import.meta.url),
    "utf8",
  );
  const timelineSource = source.slice(
    source.indexOf("const TimelineTurns: Component"),
    source.indexOf("const TimelineTurn: Component"),
  );

  assert.doesNotMatch(timelineSource, /<Index each=\{props\.groups\}>/u);
  assert.match(timelineSource, /<For each=\{groupKeys\(\)\}>/u);
  assert.match(
    timelineSource,
    /const groupIndex = \(\) => startIndex\(\) \+ index\(\);/u,
  );
  assert.match(
    timelineSource,
    /guidanceTurnOrdinalCopy\(group\(\)\.turnOrdinal\)/u,
  );
  assert.match(
    timelineSource,
    /turnOrdinalCopy\(group\(\)\.turnOrdinal\)/u,
  );
  assert.doesNotMatch(
    timelineSource,
    /turnOrdinalCopy\(groupIndex\(\) \+ 1\)/u,
  );
  assert.match(
    timelineSource,
    /turnKey=\{`\$\{props\.command\.key\}:\$\{groupKey\}`\}/u,
  );
});

test("terminal, recovery, and implicit earlier groups default closed while the latest active group opens", async () => {
  await withActiveDisclosureModule(async ({
    TimelineTurn,
    TimelineTurns,
    groupTimelineEvents,
    createTimelineDisclosureStore,
  }) => {
    const timeline = Object.freeze([
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({ kind: "agent-message" as const, text: "settled" }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({
        kind: "item-started" as const,
        itemType: "agent-message" as const,
      }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const groupedHtml = renderToString(() =>
      TimelineTurns({
        command: commandWith({ status: "in-flight", timeline }),
        groups: groupTimelineEvents(timeline),
        disclosureStore: createTimelineDisclosureStore(),
      }),
    );
    assert.deepEqual(
      [...groupedHtml.matchAll(/data-transcript-group-key="([^"]+)"/gu)].map(
        (match) => match[1],
      ),
      ["turn:1:group:1", "turn:2:group:1"],
      "rendered groups expose the same source identity regardless of window position",
    );
    const disclosures = [...groupedHtml.matchAll(
      /<button[^>]*class="disclosure"[^>]*>[\s\S]*?<\/button>/gu,
    )].map((match) => match[0] ?? "");
    assert.equal(disclosures.length, 2);
    assert.match(disclosures[0] ?? "", /aria-expanded="false"/u);
    assert.match(disclosures[1] ?? "", /aria-expanded="true"/u);
    const controlIds = disclosures.map(
      (disclosure) => disclosure.match(/aria-controls="([^"]+)"/u)?.[1],
    );
    assert.equal(controlIds.every(Boolean), true);
    assert.equal(new Set(controlIds).size, 2);
    assert.match(
      groupedHtml,
      new RegExp(
        `<ol[^>]*id="${escapeRegExp(controlIds[0] ?? "")}"[^>]*hidden`,
        "u",
      ),
    );

    const completedEvents = Object.freeze([
      Object.freeze({
        kind: "turn-completed" as const,
        status: "completed" as const,
      }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const completedHtml = renderToString(() =>
      TimelineTurn({
        command: commandWith({ status: "completed", timeline: completedEvents }),
        turnKey: "command-7:0",
        events: completedEvents,
        status: "completed",
        active: false,
        disclosureStore: createTimelineDisclosureStore(),
      }),
    );
    assert.equal(
      plainText(completedHtml.match(/<button[^>]*class="disclosure"[^>]*>[\s\S]*?<\/button>/u)?.[0] ?? ""),
      "1 event ▾",
    );
    assert.match(completedHtml, /<ol[^>]*class="event-log"[^>]*hidden/u);
    assert.doesNotMatch(
      completedHtml,
      /<span class="ev-kind">turn-completed<\/span><span>completed<\/span>/u,
    );

    const recoveryHtml = renderToString(() =>
      TimelineTurn({
        command: commandWith({
          status: "recovery-required",
          timeline: Object.freeze([]),
        }),
        turnKey: "command-7:0",
        events: Object.freeze([]),
        status: "recovery-required",
        active: false,
        disclosureStore: createTimelineDisclosureStore(),
      }),
    );
    assert.equal(
      plainText(recoveryHtml.match(/<button[^>]*class="disclosure"[^>]*>[\s\S]*?<\/button>/u)?.[0] ?? ""),
      "0 events ▾",
    );
    assert.match(recoveryHtml, /<ol[^>]*class="event-log"[^>]*hidden/u);
  });
});

function commandWith(options: {
  readonly status: WorkbenchCommandView["status"];
  readonly timeline: readonly WorkbenchTimelineEvent[];
}): WorkbenchCommandView {
  return Object.freeze({
    key: "command-7",
    label: "Agent Session 07",
    runtime: "Codex",
    status: options.status,
    session: Object.freeze({
      archived: false,
      metadataKey:
        "session-metadata:00000000-0000-4000-8000-000000000707",
      profile: Object.freeze({
        requested: Object.freeze({
          kind: "recorded" as const,
          runtimeFamilyLabel: "Codex",
          endpointLabel: "Codex desktop",
          modelLabel: "GPT-5.6-Sol",
          workIntensityControlLabel: Object.freeze({
            label: "Reasoning",
            provenance: "runtime-catalog" as const,
          }),
          workIntensityLabel: "Maximum",
          executionModeLabel: "Single agent",
          accessModeLabel: "Workspace access",
        }),
        effective: Object.freeze({ kind: "unknown" as const }),
      }),
      timeline: options.timeline,
      removalKey:
        "session-removal:00000000-0000-4000-8000-000000000701",
      selectionKey: null,
      resumable: false,
    }),
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
}

async function withActiveDisclosureModule(
  assertion: (module: ActiveDisclosureModule) => Promise<void> | void,
): Promise<void> {
  const exposeTimelineTurn: Plugin = {
    name: "expose-active-timeline-disclosure",
    enforce: "pre",
    transform(source, id) {
      const normalizedId = id.replaceAll("\\", "/");
      if (normalizedId.endsWith("/src/workbench-shell/renderer/transcript.tsx")) {
        const exposed = source.replace(
          "const TimelineTurn: Component",
          "export const TimelineTurn: Component",
        ).replace(
          "const TimelineTurns: Component",
          "export const TimelineTurns: Component",
        );
        return `${exposed}\nexport { createTimelineDisclosureStore, initialTimelineDisclosureState, reconcileTimelineDisclosure, toggleTimelineDisclosure, rawTimelineEventDetail };`;
      }
      if (normalizedId.endsWith("/src/workbench-shell/renderer/project-rail.tsx")) {
        return source.replace(
          "const SessionRow: Component",
          "export const SessionRow: Component",
        );
      }
    },
  };
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeTimelineTurn, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const transcriptModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/transcript.tsx",
    );
    const projectRailModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/project-rail.tsx",
    );
    const transcriptSearchModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/transcript-search.ts",
    );
    const module = {
      ...transcriptModule,
      ...projectRailModule,
      ...transcriptSearchModule,
    } as unknown as ActiveDisclosureModule;
    await assertion(module);
  } finally {
    await server.close();
  }
}
