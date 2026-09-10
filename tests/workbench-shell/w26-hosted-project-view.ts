import assert from "node:assert/strict";

import type {
  WorkbenchHostedProjectResult,
  WorkbenchHostedProjectView,
} from "../../src/workbench-shell/contract.ts";

export function hostedProjectView(
  result: WorkbenchHostedProjectResult,
): WorkbenchHostedProjectView {
  if (!result.ok || !("view" in result)) {
    assert.fail("Expected a hosted Project view.");
  }
  return result.view;
}
