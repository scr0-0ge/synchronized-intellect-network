import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchCommandView } from "../../src/workbench-shell/contract.ts";
import {
  beginSessionRenameFromRowDoubleClick,
  beginSessionRenameFromRowKeyboard,
  focusSessionRenameInput,
  returnSessionRenameFocus,
  sessionArchiveControlPresentation,
  sessionMetadataFeedback,
  sessionMetadataRequest,
} from "../../src/workbench-shell/renderer/session-metadata-presentation.ts";
import { presentationText } from "../../src/workbench-shell/renderer/presentation-text.ts";

const command: WorkbenchCommandView = Object.freeze({
  key: "command-1",
  label: "Agent Session 01",
  runtime: "Codex",
  status: "completed",
  session: Object.freeze({
    archived: false,
    metadataKey:
      "session-metadata:00000000-0000-4000-8000-000000000091",
    profile: Object.freeze({
      requested: Object.freeze({ kind: "not-recorded" as const }),
      effective: Object.freeze({ kind: "not-recorded" as const }),
    }),
    timeline: Object.freeze([]),
    removalKey:
      "session-removal:00000000-0000-4000-8000-000000000092",
    resumable: false,
    selectionKey: null,
  }),
});

test("Session metadata presentation forwards only the current opaque capability", () => {
  assert.deepEqual(
    sessionMetadataRequest(command, {
      kind: "rename",
      displayName: "Café 工程",
    }),
    {
      metadataKey: command.session?.metadataKey,
      operation: { kind: "rename", displayName: "Café 工程" },
    },
  );
  assert.deepEqual(sessionMetadataRequest(command, { kind: "archive" }), {
    metadataKey: command.session?.metadataKey,
    operation: { kind: "archive" },
  });
  assert.equal(
    sessionMetadataRequest(
      { key: "command-2", label: "Starting", runtime: "Codex", status: "accepted" },
      { kind: "archive" },
    ),
    null,
  );
});

test("metadata feedback never presents failed persistence or blocked archive as success", () => {
  for (const [operation, result, expectedKey, expectedMessage] of [
    [
      { kind: "rename", displayName: "Name" },
      { status: "renamed" },
      "session-metadata.renamed",
      "Agent Session renamed.",
    ],
    [
      { kind: "archive" },
      { status: "archived" },
      "session-metadata.archived",
      "Agent Session archived.",
    ],
    [
      { kind: "restore" },
      { status: "restored" },
      "session-metadata.restored",
      "Agent Session restored.",
    ],
  ] as const) {
    const feedback = sessionMetadataFeedback(operation, result);
    assert.equal(feedback.tone, "status");
    assert.equal(
      typeof feedback.message === "string" ? null : feedback.message.key,
      expectedKey,
    );
    assert.equal(presentationText(feedback.message), expectedMessage);
  }

  for (const [operation, result] of [
    [{ kind: "rename", displayName: "Name" }, { status: "unavailable" }],
    [{ kind: "archive" }, { status: "blocked", activity: "accepted" }],
    [{ kind: "archive" }, { status: "blocked", activity: "in-flight" }],
    [{ kind: "archive" }, { status: "blocked", activity: "unknown" }],
    [{ kind: "rename", displayName: "Name" }, { status: "invalid-name" }],
    [{ kind: "restore" }, { status: "not-found" }],
  ] as const) {
    const feedback = sessionMetadataFeedback(operation, result);
    assert.equal(feedback.tone, "alert");
    const message = presentationText(feedback.message) ?? "";
    assert.match(message, /not|could not|no longer/iu);
    assert.doesNotMatch(message, /renamed\.$|archived\.$|restored\.$/iu);
  }
});

test("Archive presentation mirrors the acknowledgement-aware durable matrix and fails closed", () => {
  const expected = [
    [
      "accepted",
      true,
      "A turn is starting; archive is unavailable.",
    ],
    [
      "in-flight",
      true,
      "A turn is running; archive is unavailable.",
    ],
    ["completed", false, "Archive Agent Session"],
    ["failed", false, "Archive Agent Session"],
    [
      "recovery-required",
      false,
      "Confirm that this Session's final turn outcome is unknown to archive it. Archiving keeps it in Recovery required.",
    ],
  ] as const;
  for (const [status, disabled, title] of expected) {
    const presentation = sessionArchiveControlPresentation(
      Object.freeze({ ...command, status }),
      false,
    );
    assert.deepEqual(presentation, {
      accessibleName: "Archive Agent Session 01",
      disabled,
      label: "Archive",
      operation: { kind: "archive" },
      title,
    });
  }

  const globallyPending = sessionArchiveControlPresentation(command, true);
  assert.equal(globallyPending.disabled, true);
  assert.equal(globallyPending.title, "Archive Agent Session");

  const malformedStatus = sessionArchiveControlPresentation(
    Object.freeze({
      ...command,
      status: "unknown-status" as WorkbenchCommandView["status"],
    }),
    false,
  );
  assert.equal(malformedStatus.disabled, true);
  assert.equal(
    malformedStatus.title,
    "Turn activity could not be verified; archive is unavailable.",
  );

  const malformedArchiveState = sessionArchiveControlPresentation(
    Object.freeze({
      ...command,
      session: Object.freeze({
        ...command.session!,
        archived: "unknown" as unknown as boolean,
      }),
    }),
    false,
  );
  assert.equal(malformedArchiveState.disabled, true);
  assert.equal(
    malformedArchiveState.title,
    "Turn activity could not be verified; archive is unavailable.",
  );
});

test("an already archived valid row keeps Restore available with its exact name", () => {
  const archivedCommand = Object.freeze({
    ...command,
    status: "failed" as const,
    session: Object.freeze({ ...command.session!, archived: true }),
  });
  assert.deepEqual(sessionArchiveControlPresentation(archivedCommand, false), {
    accessibleName: "Restore Agent Session 01",
    disabled: false,
    label: "Restore",
    operation: { kind: "restore" },
    title: "Restore Agent Session",
  });

  const archivedRecovery = Object.freeze({
    ...archivedCommand,
    status: "recovery-required" as const,
  });
  assert.deepEqual(sessionArchiveControlPresentation(archivedRecovery, false), {
    accessibleName: "Restore Agent Session 01",
    disabled: false,
    label: "Restore",
    operation: { kind: "restore" },
    title: "Restore Agent Session",
  });

  const malformedArchived = Object.freeze({
    ...archivedCommand,
    status: "unknown-status" as WorkbenchCommandView["status"],
  });
  assert.deepEqual(
    sessionArchiveControlPresentation(malformedArchived, false),
    {
      accessibleName: "Restore Agent Session 01",
      disabled: true,
      label: "Restore",
      operation: { kind: "restore" },
      title: "Turn activity could not be verified; restore is unavailable.",
    },
  );
});

test("rename focus enters the input and returns for Save, Cancel, and Escape", () => {
  const input = new FocusTarget();
  assert.equal(focusSessionRenameInput(input), true);
  assert.deepEqual(input.focusCalls, [{ preventScroll: true }]);

  for (const reason of ["save", "cancel", "escape"] as const) {
    const trigger = new FocusTarget();
    assert.equal(
      returnSessionRenameFocus(trigger, () => undefined, reason),
      true,
      reason,
    );
    assert.deepEqual(trigger.focusCalls, [{ preventScroll: true }], reason);
  }

  const replacedTrigger = new FocusTarget();
  assert.equal(
    returnSessionRenameFocus(
      new FocusTarget(false),
      () => replacedTrigger,
      "save",
    ),
    true,
  );
  assert.deepEqual(replacedTrigger.focusCalls, [{ preventScroll: true }]);
  assert.equal(
    returnSessionRenameFocus(
      new FocusTarget(false),
      () => new FocusTarget(false),
      "cancel",
    ),
    false,
  );
});

test("row double-click begins rename while action and editable descendants are ignored", () => {
  const row = new ClosestTarget();
  const title = new ClosestTarget(row);
  const action = new ClosestTarget();
  const actionGlyph = new ClosestTarget(action);
  const editable = new ClosestTarget();
  const editableText = new ClosestTarget(editable);
  let begins = 0;
  let prevented = 0;

  assert.equal(
    beginSessionRenameFromRowDoubleClick(
      {
        currentTarget: row,
        target: title,
        preventDefault: () => {
          prevented += 1;
        },
      },
      () => {
        begins += 1;
      },
    ),
    true,
  );
  for (const target of [actionGlyph, editableText]) {
    assert.equal(
      beginSessionRenameFromRowDoubleClick(
        {
          currentTarget: row,
          target,
          preventDefault: () => {
            prevented += 1;
          },
        },
        () => {
          begins += 1;
        },
      ),
      false,
    );
  }

  assert.equal(begins, 1);
  assert.equal(prevented, 1);
});

test("F2 on the focused Session row is the modifier-free keyboard rename route", () => {
  const row = new ClosestTarget();
  const action = new ClosestTarget();
  let begins = 0;
  let prevented = 0;
  const begin = () => {
    begins += 1;
  };

  assert.equal(
    beginSessionRenameFromRowKeyboard(
      keyboardRenameEvent(row, row, "F2", () => {
        prevented += 1;
      }),
      begin,
    ),
    true,
  );
  for (const event of [
    keyboardRenameEvent(row, row, "Enter"),
    keyboardRenameEvent(row, row, "F2", undefined, { ctrlKey: true }),
    keyboardRenameEvent(action, row, "F2"),
  ]) {
    assert.equal(beginSessionRenameFromRowKeyboard(event, begin), false);
  }

  assert.equal(begins, 1);
  assert.equal(prevented, 1);
});

class FocusTarget {
  readonly focusCalls: FocusOptions[] = [];
  readonly isConnected: boolean;

  constructor(isConnected = true) {
    this.isConnected = isConnected;
  }

  focus(options: FocusOptions = {}): void {
    this.focusCalls.push({ ...options });
  }
}

class ClosestTarget extends EventTarget {
  readonly closestInteractive: EventTarget | null;

  constructor(closestInteractive: EventTarget | null = null) {
    super();
    this.closestInteractive = closestInteractive;
  }

  closest(_selectors: string): EventTarget | null {
    return this.closestInteractive;
  }
}

function keyboardRenameEvent(
  target: EventTarget,
  currentTarget: EventTarget,
  key: string,
  preventDefault: (() => void) | undefined = undefined,
  modifiers: Readonly<{
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  }> = {},
) {
  return {
    altKey: modifiers.altKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    currentTarget,
    key,
    metaKey: modifiers.metaKey ?? false,
    preventDefault: preventDefault ?? (() => undefined),
    shiftKey: modifiers.shiftKey ?? false,
    target,
  };
}
