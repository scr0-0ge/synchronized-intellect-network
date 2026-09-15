import { For, Show, type Component } from "solid-js";

import type {
  WorkbenchAnnualReportSnapshot,
  WorkbenchAnnualReportStoredField,
} from "../contract.ts";
import { annualReportCopy } from "./copy/annual-report-copy.ts";

export const AnnualReportPanel: Component<{
  readonly snapshot: WorkbenchAnnualReportSnapshot | null;
  readonly starting: boolean;
  readonly error: string | null;
  readonly opening: boolean;
  readonly onOpenFolder: () => void;
}> = (props) => {
  const progress = () => {
    const fields = props.snapshot?.job.documents.flatMap((document) =>
      document.fields.map((field) => ({ document, field })),
    ) ?? [];
    const done = fields.filter(({ document, field }) =>
      field.status !== "pending" ||
      (document.status !== "pending" && document.status !== "in-progress"),
    ).length;
    const current = fields.find(({ document, field }) =>
      document.status === "in-progress" && field.status === "pending",
    ) ?? fields.find(({ document }) => document.status === "pending") ?? fields.at(-1);
    return {
      done,
      total: fields.length,
      file: current?.document.fileName ?? "—",
      field: current?.field.id ?? "—",
    };
  };
  const recordFor = (fileName: string) =>
    props.snapshot?.records?.find((record) => record.document.fileName === fileName);
  const fieldReason = (fileName: string, field: WorkbenchAnnualReportStoredField): string => {
    const jobField = props.snapshot?.job.documents
      .find((document) => document.fileName === fileName)?.fields
      .find((candidate) => candidate.id === field.id);
    if (jobField?.error) return jobField.error;
    const latest = field.attempts.at(-1);
    const problems = latest?.problems.map((problem) => problem.message).filter(Boolean) ?? [];
    if (problems.length > 0) return problems.join("; ");
    if (field.endReason) return field.endReason;
    return annualReportCopy.defaultReason;
  };
  const exceptions = () => {
    const snapshot = props.snapshot;
    if (snapshot === null) return [];
    const rows: string[] = [];
    if (snapshot.job.lastError) rows.push(annualReportCopy.jobFailure(snapshot.job.lastError));
    for (const document of snapshot.job.documents) {
      if (document.reason) rows.push(annualReportCopy.documentReason(document.reason));
      const record = snapshot.records?.find((candidate) => candidate.document.fileName === document.fileName);
      for (const field of record?.fields ?? []) {
        if (
          field.reviewStatus === "needs-human" ||
          field.status === "empty" ||
          field.status === "not-found-in-scope"
        ) {
          rows.push(annualReportCopy.exception(
            document.fileName,
            field.displayName,
            fieldReason(document.fileName, field),
          ));
        }
      }
    }
    return rows;
  };
  const valueFor = (field: WorkbenchAnnualReportStoredField): string =>
    field.value ?? annualReportCopy.unresolvedValue;
  const statusLabel = (status: WorkbenchAnnualReportStoredField["status"]): string =>
    status === "stated-not-applicable" ? "n/a" : status;

  return (
    <section class="annual-report-panel" aria-labelledby="annual-report-title">
      <header class="annual-report-panel-head">
        <div>
          <h2 id="annual-report-title">{annualReportCopy.title}</h2>
          <Show when={props.snapshot} fallback={<p>{annualReportCopy.starting}</p>}>
            {(snapshot) => (
              <p class="annual-report-stats">
                {annualReportCopy.stats(
                  snapshot().job.stats.fieldsVerified,
                  snapshot().job.stats.fieldsNeedingHuman,
                  snapshot().job.stats.documents,
                )}
              </p>
            )}
          </Show>
        </div>
        <Show when={props.snapshot !== null}>
          <button
            type="button"
            class="btn ghost sm annual-report-open"
            disabled={props.opening}
            onClick={props.onOpenFolder}
          >
            {props.opening ? annualReportCopy.openingFolder : annualReportCopy.openFolder}
          </button>
        </Show>
      </header>

      <Show when={props.error}>
        {(error) => <p class="annual-report-error" role="alert">{error()}</p>}
      </Show>
      <Show when={props.starting || props.snapshot?.job.status === "running"}>
        <p class="annual-report-progress" role="status" aria-live="polite">
          {annualReportCopy.progress(
            progress().done,
            progress().total,
            progress().file,
            progress().field,
          )}
        </p>
      </Show>

      <Show when={props.snapshot?.job.status !== "running" && props.snapshot !== null}>
        <div class="annual-report-documents">
          <For each={props.snapshot?.job.documents ?? []}>
            {(document) => {
              const record = () => recordFor(document.fileName);
              return (
                <section class="annual-report-document" aria-label={document.fileName}>
                  <div class="annual-report-document-head">
                    <h3>{document.fileName}</h3>
                    <span class={`annual-report-chip task-${document.status}`}>{document.status}</span>
                  </div>
                  <Show when={document.reason}>
                    {(reason) => <p class="annual-report-document-reason">{annualReportCopy.documentReason(reason())}</p>}
                  </Show>
                  <Show when={(record()?.fields.length ?? 0) > 0}>
                    <div class="annual-report-field-table" role="table">
                      <div class="annual-report-field-row annual-report-field-header" role="row">
                        <span role="columnheader">{annualReportCopy.field}</span>
                        <span role="columnheader">{annualReportCopy.value}</span>
                        <span role="columnheader">{annualReportCopy.status}</span>
                        <span role="columnheader">{annualReportCopy.review}</span>
                      </div>
                      <For each={record()?.fields ?? []}>
                        {(field) => (
                          <div class="annual-report-field-row" role="row">
                            <span role="cell" data-label={annualReportCopy.field}>{field.displayName}</span>
                            <span role="cell" data-label={annualReportCopy.value}>{valueFor(field)}</span>
                            <span role="cell" data-label={annualReportCopy.status}>
                              <span class={`annual-report-chip status-${field.status}`}>{statusLabel(field.status)}</span>
                            </span>
                            <span role="cell" data-label={annualReportCopy.review}>
                              <span class={`annual-report-chip review-${field.reviewStatus}`}>{field.reviewStatus}</span>
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </section>
              );
            }}
          </For>
        </div>
        <section class="annual-report-exceptions" aria-labelledby="annual-report-exceptions-title">
          <h3 id="annual-report-exceptions-title">{annualReportCopy.exceptions}</h3>
          <Show when={exceptions().length > 0} fallback={<p>{annualReportCopy.noExceptions}</p>}>
            <ul><For each={exceptions()}>{(exception) => <li>{exception}</li>}</For></ul>
          </Show>
        </section>
      </Show>
    </section>
  );
};
