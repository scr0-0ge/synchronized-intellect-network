import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_OPEN_ANNUAL_REPORT_OUTPUT_CHANNEL,
  WORKBENCH_READ_ANNUAL_REPORT_JOB_CHANNEL,
  WORKBENCH_START_ANNUAL_REPORT_JOB_CHANNEL,
} from "../../src/workbench-shell/contract.ts";
import { createWorkbenchPreloadBridge, type FixedProjectViewIpc } from "../../src/workbench-shell/preload-bridge.ts";
import {
  reconstructWorkbenchAnnualReportJobRequest,
  sanitizeWorkbenchAnnualReportSnapshot,
} from "../../src/workbench-shell/result-sanitizer.ts";

const uuid = "11111111-1111-4111-8111-111111111111";
const request = Object.freeze({
  projectId: `project-selection:${uuid}`,
  snapshotKey: `snapshot:${uuid}`,
  endpointKey: `endpoint-option:1:${uuid}`,
  modelKey: `model-option:1:${uuid}`,
  workIntensityKey: `intensity-option:1:${uuid}`,
  executionModeKey: `execution-option:1:${uuid}`,
  accessModeKey: `access-option:1:${uuid}`,
});

const snapshot = Object.freeze({
  job: {
    schemaVersion: 1,
    status: "completed",
    projectDirectory: ".",
    outputDirectory: "annual-report/20260915-120000",
    startedAt: "2026-09-15T12:00:00.000Z",
    endedAt: "2026-09-15T12:01:00.000Z",
    observedModel: "fake-model",
    configurationVersion: "default-fields-draft-2026-09-14",
    documents: [{
      fileName: "sample.pdf",
      status: "needs-human",
      reason: "text-layer-absent",
      pdfPages: 2,
      textLayer: "absent",
      fields: [{ id: "revenue", status: "empty", reviewStatus: "needs-human", attemptMs: 12, error: null }],
    }],
    stats: {
      pdfFiles: 1,
      documents: 1,
      fields: 1,
      fieldsVerified: 0,
      fieldsNeedingHuman: 1,
      documentsNeedingHuman: 1,
    },
    report: {
      recordsPath: "annual-report/20260915-120000/records.json",
      markdownPath: "annual-report/20260915-120000/report.md",
      pdfPath: "annual-report/20260915-120000/report.pdf",
      pdfNote: "1234 bytes",
    },
    lastError: null,
  },
  records: [{
    document: { fileName: "sample.pdf", pdfPageCount: 2, company: "Sample", reportingPeriod: "FY 2025" },
    taskStatus: "needs-human",
    fields: [{
      id: "revenue",
      displayName: "Revenue",
      note: "Note 1",
      status: "empty",
      reviewStatus: "needs-human",
      value: null,
      endReason: "cannot-verify",
      attempts: [{
        n: 1,
        status: "empty",
        reviewStatus: "needs-human",
        checks: [],
        verdict: "cannot-verify",
        problems: [{ code: "no-evidence", message: "No cited page was supplied." }],
        failureReason: null,
      }],
    }],
  }],
});

test("annual-report requests reuse the exact current profile selection keys", () => {
  assert.deepEqual(reconstructWorkbenchAnnualReportJobRequest(request), { ok: true, request });
  assert.equal(reconstructWorkbenchAnnualReportJobRequest({ ...request, durableEndpointId: "private" }).ok, false);
  assert.equal(reconstructWorkbenchAnnualReportJobRequest({ ...request, projectId: "old-project" }).ok, false);
});

test("annual-report snapshot keeps only exact relative-path progress and review records", () => {
  const result = sanitizeWorkbenchAnnualReportSnapshot(snapshot);
  assert.deepEqual(result, snapshot);
  assert.equal(Object.isFrozen(result?.records?.[0]?.fields[0]?.attempts[0]), true);
  assert.equal(sanitizeWorkbenchAnnualReportSnapshot({
    ...snapshot,
    job: { ...snapshot.job, outputDirectory: "C:\\Users\\Ada\\private" },
  }), null);
  assert.equal(sanitizeWorkbenchAnnualReportSnapshot({
    ...snapshot,
    records: snapshot.records.map((record) => ({ ...record, secret: "not-on-wire" })),
  }), null);
});

test("the preload exposes exactly the three annual-report invocations and sanitizes each result", async () => {
  const calls: Array<{ channel: string; values: readonly unknown[] }> = [];
  const ipc: FixedProjectViewIpc = {
    on() {}, removeListener() {}, send() {},
    async invoke(channel, ...values) {
      calls.push({ channel, values });
      if (channel === WORKBENCH_START_ANNUAL_REPORT_JOB_CHANNEL) return { ok: true, status: "started" };
      if (channel === WORKBENCH_READ_ANNUAL_REPORT_JOB_CHANNEL) return snapshot;
      if (channel === WORKBENCH_OPEN_ANNUAL_REPORT_OUTPUT_CHANNEL) return { ok: true, status: "opened" };
      return undefined;
    },
  };
  const bridge = createWorkbenchPreloadBridge(ipc);
  assert.deepEqual(await bridge.startAnnualReportJob(request), { ok: true, status: "started" });
  assert.deepEqual(await bridge.readAnnualReportJob({ projectId: request.projectId }), snapshot);
  assert.deepEqual(await bridge.openAnnualReportOutput({ projectId: request.projectId }), { ok: true, status: "opened" });
  assert.deepEqual(calls.map((call) => call.channel), [
    WORKBENCH_START_ANNUAL_REPORT_JOB_CHANNEL,
    WORKBENCH_READ_ANNUAL_REPORT_JOB_CHANNEL,
    WORKBENCH_OPEN_ANNUAL_REPORT_OUTPUT_CHANNEL,
  ]);
  assert.deepEqual(calls[0]?.values, [request]);
});
