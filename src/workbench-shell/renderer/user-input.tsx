import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, useContext, type Component } from "solid-js";
import type { WorkbenchUserInputResponse, WorkbenchUserInputResponseResult, WorkbenchUserInputView } from "../contract.ts";
import { WorkbenchRendererBridgeContext } from "./view-types.ts";
import { userInputCopy as copy } from "./copy/user-input-copy.ts";
import "./user-input.css";

/** Ephemeral questions refresh on selection and Runtime invalidation, never on a polling timer. */
export const RuntimeQuestions: Component<{
  scopeKey: string;
  sessionKey: string | undefined;
}> = (props) => {
  const bridge = useContext(WorkbenchRendererBridgeContext);
  const [requests, setRequests] = createSignal<readonly WorkbenchUserInputView[]>([]);
  const [unavailable, setUnavailable] = createSignal(false);
  const [dismissed, setDismissed] = createSignal<readonly string[]>([]);
  const scopeKey = createMemo(() => props.scopeKey);
  const sessionKey = createMemo(() => props.sessionKey);
  createEffect(() => {
    scopeKey();
    setRequests([]); setDismissed([]); setUnavailable(false);
    if (!bridge?.readUserInput || !bridge.respondToUserInput) return;
    let disposed = false;
    let reading = false;
    let refreshQueued = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (reading) { refreshQueued = true; return; }
      reading = true;
      const selectedSessionKey = untrack(sessionKey);
      if (selectedSessionKey) {
        try {
          const result = await Promise.race([
            bridge.readUserInput!({ sessionKey: selectedSessionKey }),
            new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("timeout")), 5000); }),
          ]);
          if (disposed) return;
          setUnavailable(!result.ok);
          setRequests(result.ok ? result.requests : []);
        } catch {
          if (disposed) return;
          setRequests([]); setUnavailable(true);
        } finally { clearTimeout(deadline); }
      }
      reading = false;
      if (refreshQueued && !disposed) { refreshQueued = false; void refresh(); }
    };
    const unsubscribe = bridge.observeUserInput?.(() => { void refresh(); });
    createEffect(() => { sessionKey(); void refresh(); });
    onCleanup(() => { disposed = true; unsubscribe?.(); clearTimeout(deadline); });
  });
  const visible = () => requests().filter(r => !dismissed().includes(r.requestKey));
  return <Show when={visible().length > 0 || unavailable()}>
    <section class="runtime-questions" aria-label={copy.title}>
      <Show when={unavailable()}><p role="status">{copy.unavailable}</p></Show>
      <For each={visible().map(r => r.requestKey)}>{key =>
        <QuestionCard view={requests().find(r => r.requestKey === key)!}
          respond={request => bridge!.respondToUserInput!(request)}
          dismiss={() => setDismissed(keys => [...keys, key])}/>
      }</For>
    </section>
  </Show>;
};

const QuestionCard: Component<{
  view: WorkbenchUserInputView;
  respond: (request: WorkbenchUserInputResponse) => Promise<WorkbenchUserInputResponseResult>;
  dismiss: () => void;
}> = (props) => {
  const [answers, setAnswers] = createSignal<Record<string, string>>({});
  const [ownAnswer, setOwnAnswer] = createSignal<Record<string, boolean>>({});
  const [sending, setSending] = createSignal(false);
  const [confirmed, setConfirmed] = createSignal<"answered" | "cancelled">();
  const [error, setError] = createSignal<"uncertain" | "invalid">();
  const [expired, setExpired] = createSignal(false);
  let disposed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => { disposed = true; clearTimeout(deadline); });
  const pending = () => props.view.state === "pending" && !confirmed();
  const question = () => props.view.state === "pending" ? props.view : undefined;
  createEffect(() => {
    const expiresAt = question()?.expiresAt;
    setExpired(expiresAt !== undefined && expiresAt <= Date.now());
    if (expiresAt === undefined || expiresAt <= Date.now()) return;
    const timer = setTimeout(() => setExpired(true), expiresAt - Date.now());
    onCleanup(() => clearTimeout(timer));
  });
  const state = () => confirmed() ?? props.view.state;
  const answer = (id: string, value: string) => setAnswers(values => ({ ...values, [id]: value }));
  const send = async (kind: "answer" | "cancel") => {
    if (!pending() || sending() || expired()) return;
    setSending(true); setError(undefined);
    try {
      const request: WorkbenchUserInputResponse = kind === "cancel"
        ? { kind, requestKey: props.view.requestKey }
        : { kind, requestKey: props.view.requestKey, answers: question()!.questions.map(q => ({ questionId: q.id, values: [answers()[q.id] ?? ""] })) };
      const result = await Promise.race([props.respond(request), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("timeout")), 10000);
      })]);
      if (disposed) return;
      if (result.status === "answered" || result.status === "cancelled") {
        setConfirmed(result.status); setAnswers({});
      } else setError(result.status === "invalid-answer" ? "invalid" : "uncertain");
    } catch { if (!disposed) setError("uncertain"); }
    finally { clearTimeout(deadline); if (!disposed) setSending(false); }
  };
  return <div class="runtime-question">
    <Show when={pending()} fallback={<>
      <p role="status">{copy[state() as Exclude<WorkbenchUserInputView["state"], "pending">]}</p>
      <button type="button" onClick={props.dismiss}>{copy.dismiss}</button>
    </>}>
      <div class="runtime-question-intro">
        <h2>{copy.title}</h2><p>{copy.hint}</p><p>{copy.expires}</p>
      </div>
      <Show when={expired()} fallback={
        <form class="runtime-question-form" onSubmit={event => { event.preventDefault(); void send("answer"); }}>
          <div class="runtime-question-fields">
          <For each={question()!.questions.map(q => q.id)}>{id => {
            const q = () => question()!.questions.find(q => q.id === id)!;
            return <fieldset disabled={sending()}>
              <legend>{q().header}</legend><p>{q().text}</p>
              <For each={q().options}>{option => <label class="runtime-question-option">
                <input type="radio" name={`${props.view.requestKey}-${id}`} checked={!ownAnswer()[id] && answers()[id] === option.label}
                  onChange={() => { setOwnAnswer(values => ({ ...values, [id]: false })); answer(id, option.label); }}/>
                <span>{option.label}<small>{option.description}</small></span>
              </label>}</For>
              <Show when={q().allowFreeText}>
                <Show when={q().kind === "choice"}>
                  <label><input type="radio" name={`${props.view.requestKey}-${id}`} checked={ownAnswer()[id] === true}
                    onChange={() => { setOwnAnswer(values => ({ ...values, [id]: true })); answer(id, ""); }}/>{copy.other}</label>
                </Show>
                <Show when={q().kind === "free-text" || ownAnswer()[id]}>
                  <input type={q().isSecret ? "password" : "text"} aria-label={q().text}
                    autocomplete="off" value={answers()[id] ?? ""} onInput={event => answer(id, event.currentTarget.value)}/>
                </Show>
              </Show>
            </fieldset>;
          }}</For>
          <Show when={error()}><p role="alert">{copy[error()!]}</p></Show>
          </div>
          <div class="runtime-question-actions">
            <button type="submit" disabled={sending() || !question()!.questions.every(q => answers()[q.id]?.trim())}>{sending() ? copy.sending : copy.send}</button>
            <button type="button" disabled={sending()} onClick={() => void send("cancel")}>{copy.cancel}</button>
          </div>
        </form>
      }><p role="status">{copy.expired}</p><button type="button" onClick={props.dismiss}>{copy.dismiss}</button></Show>
    </Show>
  </div>;
};
