import assert from "node:assert/strict";
import test from "node:test";
import { publicCreateProjectResult, publicProjectOpenUnavailable } from "../../src/workbench-shell/contract.ts";
import { sanitizeWorkbenchCreateProjectResult, sanitizeWorkbenchOpenProjectResult } from "../../src/workbench-shell/result-sanitizer.ts";

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
