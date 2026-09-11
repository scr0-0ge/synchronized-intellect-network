import assert from "node:assert/strict";
import test from "node:test";
import {
  publicCreateProjectResult,
  publicOpenProjectDriveRootRefused,
  publicProjectDriveRootRefused,
  publicProjectOpenUnavailable,
  WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL,
} from "../../src/workbench-shell/contract.ts";
import {
  sanitizeWorkbenchCreateProjectResult,
  sanitizeWorkbenchOpenProjectResult,
  sanitizeWorkbenchProjectSelectionResult,
} from "../../src/workbench-shell/result-sanitizer.ts";

const reasons = ["selected-file", "directory-missing", "destination-exists", "parent-directory-missing", "parent-is-file",
  "parent-is-alias", "parent-is-reparse", "parent-unavailable", "create-denied", "unknown"] as const;
const failure = { reason: "selected-file" as const, targetPath: "C:\\owned-test-root\\not-a-directory.txt" };
function openFailure(value: unknown) {
  const result = publicProjectOpenUnavailable();
  assert.equal(result.ok, false);
  return { ...result, error: { ...result.error, failure: value } };
}

test("Open/Create retain only the agreed in-memory reason and absolute path", () => {
  for (const reason of reasons) {
    const detail = { ...failure, reason };
    const create = { outcome: "unavailable", failure: detail };
    const open = openFailure(detail);
    assert.deepEqual(sanitizeWorkbenchCreateProjectResult(create), create);
    assert.deepEqual(sanitizeWorkbenchOpenProjectResult(open), open);
    assert.ok(Object.isFrozen(sanitizeWorkbenchCreateProjectResult(create)));
  }
});

test("public factories freeze fresh diagnostic copies and preserve Windows drive/UNC spellings", () => {
  for (const targetPath of ["C:/owned-test-root/Project", "\\\\test-server\\share\\Project", "\\\\?\\C:\\owned-test-root\\Project"]) {
    const detail = { ...failure, targetPath };
    const create = publicCreateProjectResult("unavailable", detail);
    const open = publicProjectOpenUnavailable(detail);
    assert.equal(create.outcome, "unavailable");
    assert.equal(open.ok, false);
    if (create.outcome !== "unavailable" || open.ok) throw new Error("wrong public discriminator");
    // Narrow past the drive-root refusal, which carries no path detail.
    if (open.error.category !== "project-open-unavailable") throw new Error("wrong open failure category");
    assert.notEqual(create.failure, detail);
    assert.notEqual(open.error.failure, detail);
    assert.ok(Object.isFrozen(create.failure));
    assert.ok(Object.isFrozen(open.error.failure));
    assert.deepEqual(sanitizeWorkbenchCreateProjectResult(create), create);
    assert.deepEqual(sanitizeWorkbenchOpenProjectResult(open), open);
  }
});

test("malformed details, extra fields and diagnostics on successful/cancelled outcomes fail closed", () => {
  for (const detail of [null, {}, { ...failure, reason: "raw-provider-error" }, { ...failure, extra: "private" },
    ...["", "relative/path", "C:drive-relative", "https://example.com/path", "file:///C:/path", "C:\\bad\u0000path"].map(targetPath => ({ ...failure, targetPath }))]) {
    assert.deepEqual(sanitizeWorkbenchCreateProjectResult({ outcome: "unavailable", failure: detail }), publicCreateProjectResult("unavailable"));
    assert.deepEqual(sanitizeWorkbenchOpenProjectResult(openFailure(detail)), publicProjectOpenUnavailable());
  }
  for (const outcome of ["created", "cancelled", "created-recovery-required"]) {
    assert.deepEqual(sanitizeWorkbenchCreateProjectResult({ outcome, failure }), publicCreateProjectResult("unavailable"));
  }
  assert.deepEqual(sanitizeWorkbenchOpenProjectResult({ ok: true, status: "opened", message: "Project was opened.", failure }), publicProjectOpenUnavailable());
  assert.deepEqual(sanitizeWorkbenchCreateProjectResult({ outcome: "unavailable", failure, rawError: "private" }), publicCreateProjectResult("unavailable"));
});

// F-w187 / public issue #5: the one refusal with a cause crosses both seams
// intact, and anything that only looks like it still fails closed.
test("the drive-root refusal round-trips through both project seams and nothing that merely resembles it does", () => {
  const selection = publicProjectDriveRootRefused();
  const open = publicOpenProjectDriveRootRefused();
  assert.deepEqual(sanitizeWorkbenchProjectSelectionResult(selection), selection);
  assert.deepEqual(sanitizeWorkbenchOpenProjectResult(open), open);
  assert.equal(
    WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL,
    "A drive root cannot be a Project. Choose a folder inside the drive instead.",
  );

  for (const imposter of [
    // Right category, invented wording.
    { ok: false, error: { category: "project-directory-is-drive-root", message: "Drive roots are fine, actually." } },
    // Right wording, wrong category.
    { ok: false, error: { category: "project-switch-unavailable", message: WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL } },
    // Extra field smuggled alongside.
    { ok: false, error: { category: "project-directory-is-drive-root", message: WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL, targetPath: "C:\\" } },
  ]) {
    assert.equal(sanitizeWorkbenchProjectSelectionResult(imposter).ok, false);
    assert.notEqual(
      (sanitizeWorkbenchProjectSelectionResult(imposter) as { error: { category: string } }).error.category,
      "project-directory-is-drive-root",
      "selection imposter must fall to the generic failure",
    );
    const opened = sanitizeWorkbenchOpenProjectResult(imposter);
    assert.equal(opened.ok, false);
    assert.equal((opened as { error: { category: string } }).error.category, "project-open-unavailable");
  }
});
