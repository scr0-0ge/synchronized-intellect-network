import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkbenchCommandView,
  WorkbenchProjectOption,
} from "../../src/workbench-shell/contract.ts";
import {
  projectRemovalConfirmation,
  removalFeedback,
  sessionRemovalConfirmation,
} from "../../src/workbench-shell/renderer/removal-presentation.ts";
import { presentationText } from "../../src/workbench-shell/renderer/presentation-text.ts";

const command: WorkbenchCommandView = {
  key: "command-1",
  label: "Agent Session 01",
  runtime: "Codex",
  status: "completed",
  session: {
    archived: false,
    metadataKey:
      "session-metadata:00000000-0000-4000-8000-000000000071",
    profile: {
      requested: { kind: "not-recorded" },
      effective: { kind: "not-recorded" },
    },
    timeline: [],
    removalKey:
      "session-removal:00000000-0000-4000-8000-000000000071",
    selectionKey: null,
    resumable: false,
  },
};

const project: WorkbenchProjectOption = {
  label: "Atlas Fieldnotes",
  availability: "available",
  selected: true,
  selectionKey:
    "project-selection:00000000-0000-4000-8000-000000000072",
};

test("removal confirmations carry only opaque capabilities and make Project filesystem safety explicit", () => {
  assert.deepEqual(resolvedConfirmation(sessionRemovalConfirmation(command)), {
    kind: "session",
    title: "Delete Agent Session?",
    description:
      "Delete Agent Session 01 and its recorded conversation? This cannot be undone.",
    confirmLabel: "Delete Session",
    request: { removalKey: command.session!.removalKey },
  });
  assert.deepEqual(resolvedConfirmation(projectRemovalConfirmation(project)), {
    kind: "project",
    title: "Remove Project from Workbench?",
    description:
      "Remove Atlas Fieldnotes from this Workbench? Its folder and files will stay on disk.",
    confirmLabel: "Remove Project",
    request: { selectionKey: project.selectionKey },
  });
  assert.equal(
    JSON.stringify({
      session: sessionRemovalConfirmation(command),
      project: projectRemovalConfirmation(project),
    }).includes("sessionId"),
    false,
  );
  assert.equal(
    sessionRemovalConfirmation({ ...command, session: undefined }),
    null,
  );
});

test("an outcome-unknown Session gets an exit that states what deletion cannot undo", () => {
  const stuck = sessionRemovalConfirmation({
    ...command,
    status: "recovery-required",
  });
  assert.deepEqual(resolvedConfirmation(stuck), {
    kind: "session",
    title: "Delete Agent Session?",
    description:
      "Delete Agent Session 01 and its recorded conversation? The outcome of its last turn was never established, and that cannot change. Deleting removes this record; it does not stop or undo work the runtime may already have done. This cannot be undone.",
    confirmLabel: "Delete Session",
    request: {
      removalKey: command.session!.removalKey,
      acknowledgedUnknownOutcome: true,
    },
  });

  // The copy must not promise that waiting resolves an outcome that is already
  // terminal — that promise is the defect this exit repairs.
  assert.doesNotMatch(
    presentationText(stuck!.description) ?? "",
    /try again|when activity is known/iu,
  );

  // Every other status keeps the plain confirmation and sends no acknowledgement.
  for (const status of ["completed", "failed", "accepted", "in-flight"] as const) {
    const confirmation = sessionRemovalConfirmation({ ...command, status });
    assert.deepEqual(confirmation?.request, {
      removalKey: command.session!.removalKey,
    });
  }
});

test("removal feedback distinguishes in-flight and unknown blocks without claiming deletion", () => {
  assert.deepEqual(resolvedFeedback(removalFeedback("session", { status: "removed" })), {
    tone: "status",
    message: "Agent Session deleted.",
  });
  assert.deepEqual(
    resolvedFeedback(
      removalFeedback("session", { status: "blocked", activity: "in-flight" }),
    ),
    {
      tone: "alert",
      message:
        "Agent Session was not deleted because a turn is running. Let it finish, then try again.",
    },
  );
  assert.deepEqual(
    resolvedFeedback(
      removalFeedback("session", { status: "blocked", activity: "unknown" }),
    ),
    {
      tone: "alert",
      message:
        "Agent Session was not deleted because turn activity could not be verified. Try again — if its last turn outcome was never established, you will be asked to confirm removal.",
    },
  );
  assert.deepEqual(resolvedFeedback(removalFeedback("project", { status: "removed" })), {
    tone: "status",
    message:
      "Project removed from the Workbench. Its folder and files remain on disk.",
  });
  assert.deepEqual(
    resolvedFeedback(
      removalFeedback("project", { status: "blocked", activity: "accepted" }),
    ),
    {
      tone: "alert",
      message:
        "Project was not removed because a turn is starting. Let it finish, then try again.",
    },
  );
  assert.deepEqual(
    resolvedFeedback(
      removalFeedback("project", { status: "blocked", activity: "unknown" }),
    ),
    {
      tone: "alert",
      message:
        "Project was not removed because turn activity could not be verified. Keep the Workbench open and try again when activity is known.",
    },
  );
});

function resolvedConfirmation(
  confirmation: ReturnType<typeof projectRemovalConfirmation> | ReturnType<typeof sessionRemovalConfirmation>,
) {
  return confirmation === null
    ? null
    : {
        ...confirmation,
        title: presentationText(confirmation.title),
        description: presentationText(confirmation.description),
        confirmLabel: presentationText(confirmation.confirmLabel),
      };
}

function resolvedFeedback(feedback: ReturnType<typeof removalFeedback>) {
  return {
    ...feedback,
    message: presentationText(feedback.message),
  };
}
