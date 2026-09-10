import type {
  WorkbenchUserInputQuestion, WorkbenchUserInputReadRequest, WorkbenchUserInputResponse,
  WorkbenchUserInputResponseResult, WorkbenchUserInputResult, WorkbenchUserInputView,
} from "./contract.ts";

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new Error("invalid-shape");
  return value as Record<string, unknown>;
}
function text(value: unknown, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value.trim())) throw new Error("invalid-text");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("invalid-array");
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid-boolean");
  return value;
}

export function reconstructUserInputRead(value: unknown): WorkbenchUserInputReadRequest | undefined {
  try { const data = record(value, ["sessionKey"]); return { sessionKey: text(data.sessionKey, true) }; }
  catch { return undefined; }
}

export function reconstructUserInputResponse(value: unknown): WorkbenchUserInputResponse | undefined {
  try {
    const kind = (value as WorkbenchUserInputResponse)?.kind;
    const data = record(value, kind === "answer" ? ["kind", "requestKey", "answers"] : ["kind", "requestKey"]);
    const requestKey = text(data.requestKey, true);
    if (kind === "cancel") return { kind, requestKey };
    if (kind !== "answer") return undefined;
    const answers = array(data.answers).map(value => {
      const entry = record(value, ["questionId", "values"]);
      const values = array(entry.values).map(value => text(value, true));
      if (!values.length) throw new Error("empty-answer");
      return { questionId: text(entry.questionId, true), values };
    });
    if (!answers.length || new Set(answers.map(a => a.questionId)).size !== answers.length) return undefined;
    return { kind, requestKey, answers };
  } catch { return undefined; }
}

export function sanitizeUserInputResponseResult(value: unknown): WorkbenchUserInputResponseResult {
  try {
    const data = record(value, ["status"]);
    if (["answered", "cancelled", "invalid-answer", "unavailable"].includes(text(data.status))) {
      return Object.freeze({ status: data.status as WorkbenchUserInputResponseResult["status"] });
    }
  } catch { /* Return the fixed public failure, never provider/error text. */ }
  return Object.freeze({ status: "unavailable" });
}

function question(value: unknown): WorkbenchUserInputQuestion {
  const q = record(value, ["id", "header", "text", "kind", "options", "allowFreeText", "isSecret"]);
  if (q.kind !== "choice" && q.kind !== "free-text") throw new Error("invalid-kind");
  const options = array(q.options).map(value => {
    const option = record(value, ["label", "description"]);
    return Object.freeze({ label: text(option.label, true), description: text(option.description) });
  });
  if ((q.kind === "choice") !== (options.length > 0)) throw new Error("invalid-options");
  return Object.freeze({ id: text(q.id, true), header: text(q.header), text: text(q.text, true), kind: q.kind,
    options: Object.freeze(options), allowFreeText: bool(q.allowFreeText), isSecret: bool(q.isSecret) });
}

export function sanitizeUserInputResult(value: unknown): WorkbenchUserInputResult {
  try {
    const data = record(value, ["ok", "requests"]);
    if (data.ok !== true) return Object.freeze({ ok: false });
    const requests = array(data.requests).map((value): WorkbenchUserInputView => {
      const pending = (value as WorkbenchUserInputView)?.state === "pending";
      const entry = record(value, pending ? ["requestKey", "state", "questions", "isBlocking", "expiresAt"] : ["requestKey", "state"]);
      const requestKey = text(entry.requestKey, true);
      if (!pending) {
        if (!["answered", "cancelled", "timed-out", "runtime-resolved", "session-ended"].includes(text(entry.state))) throw new Error("invalid-state");
        return Object.freeze({ requestKey, state: entry.state as Exclude<WorkbenchUserInputView["state"], "pending"> });
      }
      const questions = array(entry.questions).map(question);
      if (!questions.length || new Set(questions.map(q => q.id)).size !== questions.length ||
          typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt) || entry.expiresAt < 0) throw new Error("invalid-request");
      return Object.freeze({ requestKey, state: "pending", questions: Object.freeze(questions),
        isBlocking: bool(entry.isBlocking), expiresAt: entry.expiresAt });
    });
    if (new Set(requests.map(r => r.requestKey)).size !== requests.length) return Object.freeze({ ok: false });
    return Object.freeze({ ok: true, requests: Object.freeze(requests) });
  } catch { return Object.freeze({ ok: false }); }
}
