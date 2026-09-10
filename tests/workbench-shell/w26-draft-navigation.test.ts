import assert from "node:assert/strict";
import test from "node:test";

import {
  beginCreateProject,
  beginProjectSelection,
  canCreateProject,
  canOpenProject,
  canSelectProject,
  completeCreateProject,
  completeProjectSelection,
  initialRendererState,
  replaceProjectResult,
  updateDirectInputDraft,
} from "../../src/workbench-shell/renderer/view-model.ts";
import {
  openedProjectVisualFixture,
  secondSessionVisualFixture,
  visualFixture,
} from "./visual-harness/fixture.ts";

const draft = "Keep this unfinished request while I check another Project.";

test("a local draft can navigate to another Project and remains in the composer", () => {
  const ready = replaceProjectResult(initialRendererState, {
    ok: true,
    view: visualFixture,
  });
  const drafted = updateDirectInputDraft(ready, draft);

  assert.equal(canSelectProject(drafted, 1), true);
  const attempt = beginProjectSelection(drafted, 1);
  assert.notEqual(attempt.request, null);
  const accepted = completeProjectSelection(attempt.state, {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  const switched = replaceProjectResult(accepted, {
    ok: true,
    view: secondSessionVisualFixture,
  });

  assert.equal(switched.composer.draft, draft);
  assert.equal(switched.composer.phase, "idle");
});

test("Open and Create Project stay available and carry the local draft", () => {
  const ready = replaceProjectResult(initialRendererState, {
    ok: true,
    view: visualFixture,
  });
  const drafted = updateDirectInputDraft(ready, draft);

  assert.equal(canOpenProject(drafted), true);
  assert.equal(canCreateProject(drafted), true);

  const pending = beginCreateProject(drafted);
  assert.equal(pending.projectOpen.phase, "pending");
  const viewArrived = replaceProjectResult(pending, {
    ok: true,
    view: openedProjectVisualFixture,
  });
  const created = completeCreateProject(viewArrived, { outcome: "created" });

  assert.equal(created.projectOpen.phase, "created");
  assert.equal(created.composer.draft, draft);
  assert.equal(created.composer.phase, "idle");
});
