import {
  For,
  Show,
  createUniqueId,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { WorkbenchProjectHistoryDiscoveryResult } from "../contract.ts";
import {
  projectHistoryCopy,
  projectHistoryRows,
  type WorkbenchProjectHistoryFeedback,
} from "./view-model.ts";
import { type WorkbenchRemovalConfirmation } from "./removal-presentation.ts";
import { dialogsCopy } from "./copy/dialogs-copy.ts";
import { presentationText } from "./presentation-text.ts";

export const RemovalConfirmationDialog: Component<{
  readonly confirmation: WorkbenchRemovalConfirmation;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}> = (props) => {
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  const confirmation = () => props.confirmation;
  let cancelButton!: HTMLButtonElement;
  let confirmButton!: HTMLButtonElement;
  let returnFocus: HTMLElement | null = null;

  onMount(() => {
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelButton.focus();
  });
  onCleanup(() => {
    const target = returnFocus;
    queueMicrotask(() => {
      if (target?.isConnected) {
        target.focus();
        return;
      }
      document
        .querySelector<HTMLElement>("[data-removal-focus-fallback]")
        ?.focus();
    });
  });

  return (
    <Portal>
      <div class="removal-dialog-backdrop">
        <section
          class="removal-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-busy={props.pending}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              if (event.shiftKey && document.activeElement === cancelButton) {
                event.preventDefault();
                confirmButton.focus();
              } else if (
                !event.shiftKey &&
                document.activeElement === confirmButton
              ) {
                event.preventDefault();
                cancelButton.focus();
              }
              return;
            }
            if (event.key !== "Escape" || props.pending) return;
            event.preventDefault();
            props.onCancel();
          }}
        >
          <p class="system-kicker">{dialogsCopy.confirmRemovalKicker}</p>
          <h2 id={titleId}>{presentationText(confirmation().title)}</h2>
          <p id={descriptionId}>{presentationText(confirmation().description)}</p>
          <div class="removal-dialog-actions">
            <button
              ref={cancelButton}
              type="button"
              class="btn"
              disabled={props.pending}
              onClick={props.onCancel}
            >
              {dialogsCopy.cancel}
            </button>
            <button
              ref={confirmButton}
              type="button"
              class="btn removal-confirm-button"
              disabled={props.pending}
              onClick={props.onConfirm}
            >
              {props.pending
                ? confirmation().kind === "session"
                  ? dialogsCopy.deleting
                  : dialogsCopy.removing
                : presentationText(confirmation().confirmLabel)}
            </button>
          </div>
        </section>
      </div>
    </Portal>
  );
};

/**
 * Lets the owner see every recorded conversation history that belongs to one
 * Project folder, and switch which one the Project shows.
 *
 * The panel deliberately shows counts, size and a date and nothing else: the
 * public snapshot carries no Session name, no message text and no path, so
 * reviewing another history here can never expose its contents. The safety
 * sentence is not decoration — it is the reason this action is offered at all.
 */
export const ProjectHistoriesDialog: Component<{
  readonly projectLabel: string;
  readonly result: WorkbenchProjectHistoryDiscoveryResult | null;
  readonly pending: boolean;
  readonly notice: WorkbenchProjectHistoryFeedback | null;
  readonly onClose: () => void;
  readonly onAdopt: (historyKey: string) => void;
  readonly onHide: ((historyKey: string) => void) | undefined;
}> = (props) => {
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  const rows = () => projectHistoryRows(props.result ?? { status: "unavailable" });
  let closeButton!: HTMLButtonElement;
  let returnFocus: HTMLElement | null = null;

  onMount(() => {
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButton.focus();
  });
  onCleanup(() => {
    const target = returnFocus;
    queueMicrotask(() => {
      if (target?.isConnected) target.focus();
    });
  });

  return (
    <Portal>
      <div class="removal-dialog-backdrop">
        <section
          class="removal-dialog project-histories-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-busy={props.pending}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || props.pending) return;
            event.preventDefault();
            props.onClose();
          }}
        >
          <p class="system-kicker">{props.projectLabel}</p>
          <h2 id={titleId}>{projectHistoryCopy.title}</h2>
          <p id={descriptionId}>{projectHistoryCopy.intent}</p>
          <p class="project-histories-safety">{projectHistoryCopy.safety}</p>
          <Show
            when={props.result !== null}
            fallback={<p aria-live="polite">{projectHistoryCopy.loadingNotice}</p>}
          >
            <Show
              when={rows().length > 1}
              fallback={<p>{projectHistoryCopy.emptyNotice}</p>}
            >
              <ul class="project-histories-list">
                <For each={rows()}>
                  {(row) => (
                    <li
                      class="project-histories-row"
                      classList={{ "is-current": row.current }}
                    >
                      <div class="project-histories-facts">
                        <b>{row.ordinalLabel}</b>
                        <Show when={row.current}>
                          <span class="project-histories-badge">
                            {projectHistoryCopy.currentBadge}
                          </span>
                        </Show>
                        <span>{row.contentLabel}</span>
                        <span>
                          {row.sizeLabel} · {row.lastModifiedLabel}
                        </span>
                      </div>
                      <Show when={row.adoptable}>
                        <div class="project-histories-actions">
                          <button
                            type="button"
                            class="btn project-histories-adopt"
                            disabled={props.pending}
                            onClick={() => props.onAdopt(row.historyKey)}
                          >
                            {props.pending
                              ? projectHistoryCopy.adoptingLabel
                              : projectHistoryCopy.adoptLabel}
                          </button>
                          <Show when={row.hideable && props.onHide !== undefined}>
                            <button
                              type="button"
                              class="btn project-histories-hide"
                              disabled={props.pending}
                              onClick={() => props.onHide?.(row.historyKey)}
                            >
                              {props.pending
                                ? projectHistoryCopy.hidingLabel
                                : projectHistoryCopy.hideLabel}
                            </button>
                          </Show>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
          <Show when={props.notice}>
            {(notice) => (
              <p
                class="project-histories-notice"
                role={notice().tone}
                aria-live="polite"
              >
                {presentationText(notice().message)}
              </p>
            )}
          </Show>
          <div class="removal-dialog-actions">
            <button
              ref={closeButton}
              type="button"
              class="btn"
              disabled={props.pending}
              onClick={props.onClose}
            >
              {dialogsCopy.close}
            </button>
          </div>
        </section>
      </div>
    </Portal>
  );
};
