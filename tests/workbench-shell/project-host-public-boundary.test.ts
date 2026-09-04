import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  reconstructWorkbenchProjectSelectionRequest,
  sanitizeWorkbenchCreateProjectResult,
  sanitizeWorkbenchHostedProjectResult,
  sanitizeWorkbenchOpenProjectResult,
  sanitizeWorkbenchProjectSelectionResult,
} from "../../src/workbench-shell/result-sanitizer.ts";

const projectKey =
  "project-selection:00000000-0000-4000-8000-000000000131";
const sessionRemovalKey =
  "session-removal:00000000-0000-4000-8000-000000000133";
const sessionMetadataKey =
  "session-metadata:00000000-0000-4000-8000-000000000134";

test("the hosted Project public boundary reconstructs path-free snapshots and requests", () => {
  const sanitizedView = sanitizeWorkbenchHostedProjectResult({
    ok: true,
    view: {
      project: {
        label: "Shared Name",
      },
      observation: { cursor: 1, live: true },
      commands: [],
      initialSelectionKey: null,
      projectSelection: {
        projects: [
          {
            label: "Shared Name",
            availability: "available",
            selected: true,
            selectionKey: projectKey,
          },
          {
            label: "Shared Name",
            availability: "unreadable",
            selected: false,
            selectionKey:
              "project-selection:00000000-0000-4000-8000-000000000132",
          },
        ],
      },
    },
  });
  assert.equal(sanitizedView.ok, true);
  if (!sanitizedView.ok) assert.fail("Expected a sanitized hosted view.");
  assert.deepEqual(
    sanitizedView.view.projectSelection.projects.map((project) =>
      Object.keys(project).sort(),
    ),
    [
      ["availability", "label", "selected", "selectionKey"],
      ["availability", "label", "selected", "selectionKey"],
    ],
  );
  const reconstructed = reconstructWorkbenchProjectSelectionRequest({
    selectionKey: projectKey,
  });
  assert.deepEqual(reconstructed, {
    ok: true,
    request: { selectionKey: projectKey },
  });
  const selected = sanitizeWorkbenchProjectSelectionResult({
    ok: true,
    status: "selected",
    message: "Project was opened.",
    recordKey: "PRIVATE_DURABLE_RECORD",
    databasePath: "C:\\private\\ledger.sqlite",
  });
  const selectedExisting = sanitizeWorkbenchProjectSelectionResult({
    ok: true,
    status: "selected",
    message: "Project was opened with its existing conversation history.",
    ledgerSlot: "PRIVATE_LEDGER_SLOT",
  });
  const historySnapshot = {
    projectLabel: "Shared Name",
    histories: [
      {
        historyKey:
          "project-history:00000000-0000-4000-8000-000000000135",
        current: false,
        sessionCount: 1,
        commandCount: 1,
        updateCount: 4,
        byteSize: 49_152,
        lastModified: "2026-08-21T10:00:00Z",
        schemaVersion: 5,
      },
      {
        historyKey:
          "project-history:00000000-0000-4000-8000-000000000136",
        current: false,
        sessionCount: 2,
        commandCount: 3,
        updateCount: 8,
        byteSize: 61_440,
        lastModified: "2026-08-20T10:00:00Z",
        schemaVersion: 5,
      },
    ],
  };
  const selectionRequired = sanitizeWorkbenchProjectSelectionResult({
    ok: true,
    status: "history-selection-required",
    message:
      "Choose which existing conversation history this Project should show. Nothing changed yet.",
    snapshot: historySnapshot,
    canonicalDirectory: "C:\\private\\choice",
  });
  const opened = sanitizeWorkbenchOpenProjectResult({
    ok: true,
    status: "opened",
    message: "Project was opened.",
    filePaths: ["C:\\private\\opened"],
    nativeValue: "PRIVATE_NATIVE_VALUE",
  });
  const openedExisting = sanitizeWorkbenchOpenProjectResult({
    ok: true,
    status: "opened",
    message: "Project was opened with its existing conversation history.",
    nativeValue: "PRIVATE_NATIVE_VALUE",
  });
  const openSelectionRequired = sanitizeWorkbenchOpenProjectResult({
    ok: true,
    status: "history-selection-required",
    message:
      "Choose which existing conversation history this Project should show. Nothing changed yet.",
    snapshot: historySnapshot,
    filePaths: ["C:\\private\\choice"],
  });
  const cancelled = sanitizeWorkbenchOpenProjectResult({
    ok: true,
    status: "cancelled",
    message: "Open Project was cancelled. Nothing changed.",
    filePaths: ["C:\\private\\cancelled"],
  });
  const created = sanitizeWorkbenchCreateProjectResult({
    outcome: "created",
    target: "C:\\private\\created",
    targetToken: "PRIVATE_CREATE_TOKEN",
  });
  const serialized = JSON.stringify({
    sanitizedView,
    reconstructed,
    selected,
    selectedExisting,
    selectionRequired,
    opened,
    openedExisting,
    openSelectionRequired,
    cancelled,
    created,
  });
  for (const forbidden of [
    "C:\\private",
    "privateRegistryPath",
    "canonicalDirectory",
    "recordKey",
    "ledgerSlot",
    "databasePath",
    "nativeIdentifier",
    "filePaths",
    "nativeValue",
    "commandId",
    "sessionId",
    "opaqueSessionReference",
    "rawPayload",
    "privateReasoning",
    "authentication",
    "credential",
    "PRIVATE_",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const widenedHistory = {
    ...historySnapshot,
    histories: [
      {
        ...historySnapshot.histories[0],
        ledgerSlot: "PRIVATE_NESTED_LEDGER_SLOT",
      },
      historySnapshot.histories[1],
    ],
  };
  assert.equal(
    sanitizeWorkbenchProjectSelectionResult({
      ok: true,
      status: "history-selection-required",
      message:
        "Choose which existing conversation history this Project should show. Nothing changed yet.",
      snapshot: widenedHistory,
    }).ok,
    false,
  );
  assert.equal(
    sanitizeWorkbenchOpenProjectResult({
      ok: true,
      status: "history-selection-required",
      message:
        "Choose which existing conversation history this Project should show. Nothing changed yet.",
      snapshot: widenedHistory,
    }).ok,
    false,
  );
});

test("the hosted Project boundary preserves exact user text and fails closed on an extra event key", () => {
  const text = [
    "C:\\Users\\Ada\\repo\\file.ts",
    "Bearer PUBLIC-CATEGORY-TEXT",
    "<script>literal</script>",
    "# Markdown stays text",
  ].join("\n");
  const hostedResult = (event: unknown): unknown => ({
    ok: true,
    view: {
      project: { label: "Shared Name" },
      observation: { cursor: 2, live: true },
      commands: [
        {
          key: "command-1",
          label: "Agent Session 01",
          runtime: "Codex",
          status: "accepted",
          session: {
            profile: {
              requested: { kind: "not-recorded" },
              effective: { kind: "not-recorded" },
            },
            timeline: [event],
            removalKey: sessionRemovalKey,
            metadataKey: sessionMetadataKey,
            archived: false,
            selectionKey: null,
            resumable: false,
          },
        },
      ],
      initialSelectionKey: "command-1",
      projectSelection: {
        projects: [
          {
            label: "Shared Name",
            availability: "available",
            selected: true,
            selectionKey: projectKey,
          },
        ],
      },
    },
  });

  const exact = sanitizeWorkbenchHostedProjectResult(
    hostedResult({ kind: "user-message", text }),
  );
  assert.equal(exact.ok, true);
  if (!exact.ok) assert.fail("Expected the exact public user event.");
  assert.deepEqual(exact.view.commands[0]?.session?.timeline, [
    { kind: "user-message", text },
  ]);
  assert.equal(
    exact.view.commands[0]?.session?.removalKey,
    sessionRemovalKey,
  );
  assert.equal(
    exact.view.commands[0]?.session?.timeline[0]?.kind === "user-message"
      ? exact.view.commands[0].session.timeline[0].text
      : undefined,
    text,
  );
  assert.equal(Object.isFrozen(exact.view.commands[0]?.session?.timeline), true);
  assert.equal(Object.isFrozen(exact.view.commands[0]?.session?.timeline[0]), true);

  const extraKey = sanitizeWorkbenchHostedProjectResult(
    hostedResult({
      kind: "user-message",
      text,
      extra: "PRIVATE_EXTRA_EVENT_FIELD",
    }),
  );
  assert.deepEqual(extraKey, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.equal(JSON.stringify(extraKey).includes("PRIVATE_EXTRA_EVENT_FIELD"), false);
});

test("argument-free renderer transport contains no directory input or private Project identifiers", async () => {
  const [contractSource, preloadSource, projectViewIpcSource] =
    await Promise.all(
      [
      "../../src/workbench-shell/contract.ts",
      "../../src/workbench-shell/preload-bridge.ts",
      "../../src/workbench-shell/electron/project-view-ipc.ts",
      ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    );
  const rendererRoot = new URL(
    "../../src/workbench-shell/renderer/",
    import.meta.url,
  );
  const rendererFiles = [
    "mount.tsx",
    "view-model.ts",
    "chrome.tsx",
    "composer.tsx",
    "dialogs.tsx",
    "inspector.tsx",
    "project-rail.tsx",
    "settings.tsx",
    "stage.tsx",
    "states.tsx",
    "transcript.tsx",
    "transcript-search.ts",
    "view-types.ts",
    "copy/chrome-copy.ts",
    "copy/common-copy.ts",
    "copy/composer-copy.ts",
    "copy/dialogs-copy.ts",
    "copy/history-recovery-copy.ts",
    "copy/inspector-copy.ts",
    "copy/project-history-copy.ts",
    "copy/rail-copy.ts",
    "copy/removal-copy.ts",
    "copy/runtime-profile-copy.ts",
    "copy/session-metadata-copy.ts",
    "copy/session-status-copy.ts",
    "copy/settings-copy.ts",
    "copy/shell-copy.ts",
    "copy/stage-copy.ts",
    "copy/transcript-copy.ts",
    "copy/turn-notification-copy.ts",
  ] as const;
  const rendererSources = await Promise.all(
    rendererFiles.map((file) => readFile(new URL(file, rendererRoot), "utf8")),
  );
  const publicBoundarySource = [
    contractSource,
    preloadSource,
    ...rendererSources,
  ].join("\n");
  for (const forbiddenField of [
    "canonicalDirectory",
    "recordKey",
    "ledgerSlot",
    "databasePath",
    "commandId",
    "sessionId",
    "opaqueSessionReference",
    "nativeIdentifier",
  ]) {
    assert.equal(
      new RegExp(`\\b${forbiddenField}\\b`, "u").test(publicBoundarySource),
      false,
      forbiddenField,
    );
  }
  assert.equal(/type=["']file["']/iu.test(publicBoundarySource), false);
  assert.equal(/showOpenDialog|webkitdirectory|filePaths/iu.test(publicBoundarySource), false);
  assert.match(
    contractSource!,
    /interface WorkbenchProjectOption \{[\s\S]*?label: string;[\s\S]*?availability: WorkbenchProjectAvailability;[\s\S]*?selected: boolean;[\s\S]*?selectionKey: string;[\s\S]*?\}/u,
  );
  assert.match(
    contractSource!,
    /interface WorkbenchProjectSelectionRequest \{\s+readonly selectionKey: string;\s+\}/u,
  );
  assert.match(
    contractSource!,
    /openProject\(\): Promise<WorkbenchOpenProjectResult>;/u,
  );
  assert.match(
    contractSource!,
    /createProject\(\): Promise<WorkbenchCreateProjectResult>;/u,
  );
  assert.match(
    preloadSource!,
    /async openProject\(\): Promise<WorkbenchOpenProjectResult> \{[\s\S]*?ipc\.invoke\(WORKBENCH_OPEN_PROJECT_CHANNEL\)/u,
  );
  assert.match(
    preloadSource!,
    /async createProject\(\): Promise<WorkbenchCreateProjectResult> \{[\s\S]*?ipc\.invoke\(WORKBENCH_CREATE_PROJECT_CHANNEL\)/u,
  );
  assert.equal(/openProject\([^)]*[a-z][^)]*\)/iu.test(contractSource!), false);
  assert.equal(/createProject\([^)]*[a-z][^)]*\)/iu.test(contractSource!), false);
  assert.match(
    projectViewIpcSource!,
    /options\.source\.registerTrustedProject\(\s*chosen\.directory,?\s*\)/u,
  );
});

test("production has one owning-window native directory-dialog call site", async () => {
  const sourceRoot = new URL("../../src/workbench-shell/", import.meta.url);
  const files = await collectSourceFiles(sourceRoot);
  const matches: string[] = [];
  for (const file of files) {
    const source = await readFile(new URL(file, sourceRoot), "utf8");
    if (/dialog\.showOpenDialog/u.test(source)) matches.push(file);
  }
  assert.deepEqual(matches, ["electron/project-directory-chooser.ts"]);
});

async function collectSourceFiles(
  directory: URL,
  prefix = "",
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      return collectSourceFiles(
        new URL(`${encodeURIComponent(entry.name)}/`, directory),
        `${relative}/`,
      );
    }
    return /\.tsx?$/u.test(entry.name) ? [relative] : [];
  }));
  return nested.flat().sort();
}
