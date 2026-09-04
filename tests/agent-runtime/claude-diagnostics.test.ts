import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLAUDE_DIAGNOSTIC_DETAIL_MAXIMUM_BYTES,
  CLAUDE_DIAGNOSTIC_LOG_MAXIMUM_BYTES,
  ClaudeDiagnosticError,
  createClaudeDiagnosticRecorder,
  formatClaudeDiagnosticSummary,
} from "../../src/agent-runtime/claude/diagnostics.ts";
import { parseClaudeControlResponseLine } from "../../src/agent-runtime/claude/protocol.ts";

test("Claude private diagnostics retain raw failure evidence under a hard byte bound while summaries omit it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-diagnostic-test-"));
  const filePath = join(directory, "diagnostics.jsonl");
  const summaries: string[] = [];
  try {
    const record = createClaudeDiagnosticRecorder({
      filePath,
      maximumBytes: 2_048,
      writeSummary: (summary) => summaries.push(summary),
    });
    for (let sequence = 0; sequence < 12; sequence += 1) {
      record({
        kind: "child-stderr",
        category: "runtime-unavailable",
        capturedBytes: 4_096,
        omittedBytes: 512,
        detail: `PRIVATE_CREDENTIAL_CANARY_${sequence}_${"x".repeat(4_096)}`,
      });
    }

    const information = await stat(filePath);
    const retained = await readFile(filePath, "utf8");
    assert.equal(information.size <= 2_048, true, "hard file bound");
    assert.match(retained, /PRIVATE_CREDENTIAL_CANARY_11/u, "newest row retained");
    assert.equal(retained.includes("PRIVATE_CREDENTIAL_CANARY_0_"), false, "old rows reset");
    assert.equal(summaries.length, 12);
    assert.equal(summaries.some((summary) => summary.includes("PRIVATE_")), false);
    assert.match(summaries.at(-1) ?? "", /kind=child-stderr/u);
    assert.match(summaries.at(-1) ?? "", /omittedBytes=/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude diagnostic constants make both the durable log and each private detail explicitly bounded", () => {
  assert.equal(CLAUDE_DIAGNOSTIC_LOG_MAXIMUM_BYTES, 524_288);
  assert.equal(CLAUDE_DIAGNOSTIC_DETAIL_MAXIMUM_BYTES, 65_536);
  assert.equal(
    CLAUDE_DIAGNOSTIC_DETAIL_MAXIMUM_BYTES < CLAUDE_DIAGNOSTIC_LOG_MAXIMUM_BYTES,
    true,
  );
});

test("Claude diagnostic errors keep a fixed public Runtime error while retaining a private cause", () => {
  const failure = new ClaudeDiagnosticError("catalog-invalid", {
    kind: "catalog-shape-rejected",
    category: "catalog-invalid",
    gate: "models",
    row: 0,
    addedKeys: ["futurePrivateField"],
    missingKeys: [],
    invalidKeys: [],
    detail: "PRIVATE_NATIVE_CATALOG_ROW",
  });

  assert.equal(failure.message, "Agent Runtime operation failed.");
  assert.equal(failure.category, "catalog-invalid");
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(failure, "diagnostic"),
    false,
  );
  assert.equal(JSON.stringify(failure).includes("PRIVATE"), false);
  assert.equal(JSON.stringify({ message: failure.message, category: failure.category }).includes("PRIVATE"), false);
  assert.equal(formatClaudeDiagnosticSummary(failure.diagnostic).includes("PRIVATE"), false);
  assert.match(formatClaudeDiagnosticSummary(failure.diagnostic), /gate=models/u);
  assert.match(formatClaudeDiagnosticSummary(failure.diagnostic), /row=0/u);
});

test("Claude diagnostic summaries reject arbitrary native launch error codes", () => {
  const summary = formatClaudeDiagnosticSummary({
    kind: "process-launch-rejected",
    category: "runtime-unavailable",
    errorCode: "PRIVATE_PATH_CANARY\nforged=summary",
    detail: "PRIVATE_LAUNCH_DETAIL",
  });

  assert.equal(summary.includes("PRIVATE"), false);
  assert.equal(summary.includes("forged"), false);
  assert.match(summary, /errorCode=invalid-token/u);
});

test("Claude non-success control responses retain the raw body and name the rejected operation", () => {
  const line = JSON.stringify({
    type: "control_response",
    response: {
      subtype: "error",
      request_id: "request-fixed",
      error: "PRIVATE_EXPIRED_CREDENTIAL_DETAIL",
    },
  });

  assert.throws(
    () => parseClaudeControlResponseLine(line, "request-fixed", "initialize"),
    (error) => {
      assert.equal(error instanceof ClaudeDiagnosticError, true);
      const failure = error as ClaudeDiagnosticError;
      assert.equal(failure.category, "runtime-unavailable");
      assert.deepEqual(failure.diagnostic, {
        kind: "control-response-rejected",
        category: "runtime-unavailable",
        gate: "initialize",
        row: null,
        addedKeys: [],
        missingKeys: [],
        invalidKeys: ["subtype"],
        detail: JSON.stringify({
          subtype: "error",
          request_id: "request-fixed",
          error: "PRIVATE_EXPIRED_CREDENTIAL_DETAIL",
        }),
      });
      return true;
    },
  );
});
