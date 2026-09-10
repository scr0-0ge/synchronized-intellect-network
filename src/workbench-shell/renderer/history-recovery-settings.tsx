import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  untrack,
  type Component,
} from "solid-js";

import type {
  HistoryRecoveryActionResult,
  HistoryRecoveryBrowseItem,
  HistoryRecoveryBrowseRequest,
  HistoryRecoveryBrowseResult,
  HistoryRecoveryProblemCode,
  HistoryRecoveryRendererBridge,
  HistoryRecoverySnapshotResult,
  HistoryRecoverySourceSummary,
} from "../history-recovery-contract.ts";
import { commonCopy } from "./copy/common-copy.ts";
import {
  historyRecoveryCopy,
  preservingOperationCopy,
  acknowledgingOperationCopy,
  exportingOperationCopy,
  preservedCountCopy,
  recoveryCountsCopy,
  sessionRowDetailCopy,
  turnRowDetailCopy,
  historyActionResultCopy,
  preservedResultCopy,
  alreadyPreservedResultCopy,
  exportedResultCopy,
} from "./copy/history-recovery-copy.ts";
import { dynamicCopy } from "./copy/dynamic-copy.ts";
import {
  presentationText,
  workbenchLocalizedText,
  type WorkbenchPresentationText,
} from "./presentation-text.ts";

type RecoveryRoute =
  | { readonly kind: "home" }
  | { readonly kind: "overview" }
  | {
      readonly kind: "projects";
      readonly generationKey: string;
      readonly label: WorkbenchPresentationText;
    }
  | {
      readonly kind: "sessions";
      readonly generationKey: string;
      readonly projectKey: string;
      readonly label: WorkbenchPresentationText;
    }
  | {
      readonly kind: "turns";
      readonly generationKey: string;
      readonly projectKey: string;
      readonly sessionKey: string;
      readonly label: WorkbenchPresentationText;
    };

let keySequence = 0;

export function historyRecoveryNeedsAttention(
  result: HistoryRecoverySnapshotResult | null,
): boolean {
  return result?.status === "ready" || result?.status === "partial"
    ? result.snapshot.attention
    : result?.status === "unavailable";
}

export function historyRecoveryCardVisible(
  result: HistoryRecoverySnapshotResult | null,
): boolean {
  if (result === null) return false;
  return result.status === "unavailable" ||
    result.snapshot.attention ||
    result.snapshot.library.generationCount > 0 ||
    result.snapshot.sources.some((source) => source.role === "historical");
}

export const HistoryRecoverySettingsCard: Component<{
  readonly bridge: Partial<HistoryRecoveryRendererBridge>;
  readonly result: HistoryRecoverySnapshotResult | null;
  readonly onSnapshot: (result: HistoryRecoverySnapshotResult) => void;
  readonly onRefresh: () => void;
}> = (props) => {
  const [route, setRoute] = createSignal<RecoveryRoute>({ kind: "home" });
  const [browseResult, setBrowseResult] =
    createSignal<HistoryRecoveryBrowseResult | null>(null);
  const [actionResult, setActionResult] =
    createSignal<HistoryRecoveryActionResult | null>(null);
  const [actionUnavailable, setActionUnavailable] = createSignal(false);
  const [browseUnavailable, setBrowseUnavailable] = createSignal(false);
  const [pendingOperation, setPendingOperation] = createSignal<{
    readonly operationKey: string;
    readonly label: WorkbenchPresentationText;
  } | null>(null);
  const [loadGeneration, setLoadGeneration] = createSignal(0);
  const focusHistory: HTMLElement[] = [];
  let heading: HTMLHeadingElement | undefined;
  let active = true;
  let observedSnapshotKey: string | null = null;

  onCleanup(() => {
    active = false;
    setLoadGeneration((value) => value + 1);
  });

  createEffect(() => {
    const result = props.result;
    const snapshotKey =
      result?.status === "ready" || result?.status === "partial"
        ? result.snapshot.snapshotKey
        : null;
    if (
      observedSnapshotKey !== null &&
      snapshotKey !== observedSnapshotKey &&
      route().kind !== "home"
    ) {
      focusHistory.length = 0;
      setRoute({ kind: "overview" });
      setBrowseResult(null);
      untrack(() => { void loadOverview(); });
      queueMicrotask(() => heading?.focus({ preventScroll: true }));
    }
    observedSnapshotKey = snapshotKey;
  });

  const snapshot = () =>
    props.result?.status === "ready" || props.result?.status === "partial"
      ? props.result.snapshot
      : null;

  const enter = (next: RecoveryRoute, trigger?: HTMLElement): void => {
    if (pendingOperation() !== null) return;
    if (trigger !== undefined) focusHistory.push(trigger);
    setRoute(next);
    setBrowseResult(null);
    setBrowseUnavailable(false);
    setActionResult(null);
    setActionUnavailable(false);
    if (next.kind === "overview") {
      void loadOverview();
    } else if (next.kind !== "home") {
      void loadRoute(next);
    }
    queueMicrotask(() => heading?.focus({ preventScroll: true }));
  };

  const goBack = (): void => {
    if (pendingOperation() !== null) return;
    const current = route();
    if (current.kind === "home") return;
    setLoadGeneration((value) => value + 1);
    setBrowseResult(null);
    setBrowseUnavailable(false);
    if (current.kind === "overview") {
      setRoute({ kind: "home" });
    } else if (current.kind === "projects") {
      setRoute({ kind: "overview" });
      void loadOverview();
    } else if (current.kind === "sessions") {
      const parent: RecoveryRoute = {
        kind: "projects",
        generationKey: current.generationKey,
        label: workbenchLocalizedText(
          "history.projects-breadcrumb",
          () => historyRecoveryCopy.projectsBreadcrumb,
        ),
      };
      setRoute(parent);
      void loadRoute(parent);
    } else {
      const parent: RecoveryRoute = {
        kind: "sessions",
        generationKey: current.generationKey,
        projectKey: current.projectKey,
        label: workbenchLocalizedText(
          "history.sessions-breadcrumb",
          () => historyRecoveryCopy.sessionsBreadcrumb,
        ),
      };
      setRoute(parent);
      void loadRoute(parent);
    }
    const target = focusHistory.pop();
    queueMicrotask(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
      else heading?.focus({ preventScroll: true });
    });
  };

  const loadOverview = async (): Promise<void> => {
    const current = snapshot();
    if (current === null) return;
    await loadBrowse({
      version: 1,
      kind: "generations",
      requestKey: recoveryKey("request"),
      snapshotKey: current.snapshotKey,
      libraryKey: current.library.libraryKey,
      page: Object.freeze({ after: null, size: 50 }),
    });
  };

  const loadRoute = async (target: Exclude<RecoveryRoute, { kind: "home" | "overview" }>): Promise<void> => {
    const current = snapshot();
    if (current === null) return;
    const common = {
      version: 1 as const,
      requestKey: recoveryKey("request"),
      snapshotKey: current.snapshotKey,
      page: Object.freeze({ after: null, size: 50 }),
    };
    if (target.kind === "projects") {
      await loadBrowse({
        ...common,
        kind: "projects",
        generationKey: target.generationKey,
      });
    } else if (target.kind === "sessions") {
      await loadBrowse({
        ...common,
        kind: "sessions",
        projectKey: target.projectKey,
      });
    } else {
      await loadBrowse({
        ...common,
        kind: "turns",
        sessionKey: target.sessionKey,
      });
    }
  };

  const loadBrowse = async (
    request: HistoryRecoveryBrowseRequest,
    append = false,
  ): Promise<void> => {
    const browse = props.bridge.browse;
    const generation = loadGeneration() + 1;
    setLoadGeneration(generation);
    setBrowseUnavailable(false);
    if (browse === undefined) {
      setBrowseUnavailable(true);
      return;
    }
    let result: HistoryRecoveryBrowseResult;
    try {
      result = await browse(request);
    } catch {
      if (active && generation === loadGeneration()) {
        setBrowseUnavailable(true);
      }
      return;
    }
    if (!active || generation !== loadGeneration()) return;
    if (result.status === "stale") {
      focusHistory.length = 0;
      setRoute({ kind: "overview" });
      setBrowseResult(result);
      props.onRefresh();
      queueMicrotask(() => heading?.focus({ preventScroll: true }));
      return;
    }
    if (append && result.status === "ready") {
      const prior = browseResult();
      if (
        prior?.status === "ready" &&
        prior.branch === result.branch &&
        prior.parentKey === result.parentKey &&
        prior.snapshotKey === result.snapshotKey
      ) {
        setBrowseResult(
          Object.freeze({
            ...result,
            page: Object.freeze({
              ...result.page,
              items: Object.freeze([
                ...prior.page.items,
                ...result.page.items,
              ]),
            }),
          }),
        );
        return;
      }
    }
    setBrowseResult(result);
  };

  const loadMore = (): void => {
    const result = browseResult();
    const current = route();
    const currentSnapshot = snapshot();
    if (
      result?.status !== "ready" ||
      result.page.nextAfter === null ||
      currentSnapshot === null ||
      current.kind === "home" ||
      current.kind === "overview" && result.branch !== "generations"
    ) {
      return;
    }
    const common = {
      version: 1 as const,
      requestKey: recoveryKey("request"),
      snapshotKey: currentSnapshot.snapshotKey,
      page: Object.freeze({ after: result.page.nextAfter, size: 50 }),
    };
    const request: HistoryRecoveryBrowseRequest = result.branch === "generations"
      ? {
          ...common,
          kind: "generations",
          libraryKey: result.parentKey,
        }
      : result.branch === "projects"
        ? { ...common, kind: "projects", generationKey: result.parentKey }
        : result.branch === "sessions"
          ? { ...common, kind: "sessions", projectKey: result.parentKey }
          : { ...common, kind: "turns", sessionKey: result.parentKey };
    void loadBrowse(request, true);
  };

  const perform = async (
    action: "preserve" | "acknowledge" | "export-copy",
    capabilityKey: string,
    label: WorkbenchPresentationText,
  ): Promise<void> => {
    const current = snapshot();
    const invoke = props.bridge.perform;
    if (current === null || invoke === undefined || pendingOperation() !== null) {
      return;
    }
    const operationKey = recoveryKey("operation");
    setPendingOperation({ operationKey, label });
    setActionResult(null);
    setActionUnavailable(false);
    const common = {
      version: 1 as const,
      action,
      requestKey: recoveryKey("request"),
      operationKey,
      snapshotKey: current.snapshotKey,
    };
    try {
      const result = await invoke(
        action === "export-copy"
          ? Object.freeze({
              ...common,
              action: "export-copy" as const,
              generationKey: capabilityKey,
            })
          : Object.freeze({
              ...common,
              action,
              sourceKey: capabilityKey,
            }),
      );
      if (!active || pendingOperation()?.operationKey !== operationKey) return;
      setActionResult(result);
      if (
        (result.action === "preserve" &&
          (result.status === "preserved" ||
            result.status === "already-preserved")) ||
        (result.action === "acknowledge" &&
          (result.status === "acknowledged" ||
            result.status === "already-acknowledged"))
      ) {
        props.onSnapshot({
          version: 1,
          kind: "snapshot",
          requestKey: recoveryKey("request"),
          status:
            props.result?.status === "partial" || result.cleanup === "pending"
              ? "partial"
              : "ready",
          snapshot: result.snapshot,
        });
        focusHistory.length = 0;
        setRoute({ kind: "overview" });
        queueMicrotask(() => heading?.focus({ preventScroll: true }));
      }
    } catch {
      if (active && pendingOperation()?.operationKey === operationKey) {
        setActionUnavailable(true);
      }
      props.onRefresh();
    } finally {
      if (active && pendingOperation()?.operationKey === operationKey) {
        setPendingOperation(null);
      }
    }
  };

  const cancelPending = (): void => {
    const pending = pendingOperation();
    const cancel = props.bridge.cancel;
    if (pending === null || cancel === undefined) return;
    void cancel({
      version: 1,
      requestKey: recoveryKey("request"),
      operationKey: pending.operationKey,
    });
  };

  const readyBrowse = () => {
    const result = browseResult();
    return result?.status === "ready" ? result : null;
  };
  const items = () => readyBrowse()?.page.items ?? [];
  const activeGenerationKey = (): string | null => {
    const current = route();
    return current.kind === "projects" ||
        current.kind === "sessions" ||
        current.kind === "turns"
      ? current.generationKey
      : null;
  };

  return (
    <Show when={historyRecoveryCardVisible(props.result)}>
      <section
        class="history-recovery-card"
        aria-labelledby="history-recovery-title"
        aria-busy={pendingOperation() !== null}
      >
        <div class="history-recovery-heading-row">
          <div>
            <p class="system-kicker">{historyRecoveryCopy.kicker}</p>
            <h2
              ref={heading}
              id="history-recovery-title"
              tabIndex={-1}
            >
              {historyRecoveryCopy.heading}
            </h2>
          </div>
          <Show when={route().kind !== "home"}>
            <button
              type="button"
              class="btn ghost sm"
              disabled={pendingOperation() !== null}
              onClick={goBack}
            >
              {historyRecoveryCopy.back}
            </button>
          </Show>
        </div>

        <Show
          when={
            props.result?.status !== "unavailable" &&
            historyRecoveryNeedsAttention(props.result)
          }
        >
          <p class="history-recovery-attention" role="status">
            {historyRecoveryCopy.attention}
          </p>
        </Show>

        <Show
          when={props.result?.status !== "unavailable"}
          fallback={
            <p class="history-recovery-problem" role="alert">
              {props.result?.status === "unavailable"
                ? historyProblemLabel(props.result.problem.code)
                : historyRecoveryCopy.unavailableFallback}
            </p>
          }
        >
          <Show when={route().kind === "home"}>
            <p>
              {historyRecoveryCopy.homeIntro}
            </p>
            <button
              type="button"
              class="btn sm"
              onClick={(event) =>
                enter({ kind: "overview" }, event.currentTarget)
              }
            >
              {historyRecoveryCopy.reviewButton}
            </button>
          </Show>

          <Show when={route().kind === "overview"}>
            <div class="history-recovery-overview">
              <For each={snapshot()?.sources ?? []}>
                {(source, index) => (
                  <article class="history-recovery-row">
                    <div>
                      <strong>
                        {sourceLabel(
                          source,
                          sourceOrdinal(snapshot()?.sources ?? [], index()),
                        )}
                      </strong>
                      <span>
                        {sourceMetadataLabel(source)}
                      </span>
                      <Show when={source.state === "unavailable"}>
                        <span role="alert">
                          {historyRecoveryCopy.unavailableSourceGuidance}
                        </span>
                      </Show>
                      <Show when={sourceInventoryUnreadable(source)}>
                        <span>{historyRecoveryCopy.unreadableSourceGuidance}</span>
                      </Show>
                    </div>
                    <span class={`badge ${source.state === "available" || source.state === "empty" ? "warn" : "off"}`}>
                      {sourceDisplayStateLabel(source)}
                    </span>
                    <Show when={source.action !== "none"}>
                      <button
                        type="button"
                        class="btn sm"
                        disabled={pendingOperation() !== null}
                        onClick={() =>
                          perform(
                            source.action as "preserve" | "acknowledge",
                            source.sourceKey,
                            workbenchLocalizedText(
                              `history.${source.action}-source`,
                              () => source.action === "preserve"
                                ? preservingOperationCopy(
                                    sourceLabel(
                                      source,
                                      sourceOrdinal(
                                        snapshot()?.sources ?? [],
                                        index(),
                                      ),
                                    ),
                                  )
                                : acknowledgingOperationCopy(
                                    sourceLabel(
                                      source,
                                      sourceOrdinal(
                                        snapshot()?.sources ?? [],
                                        index(),
                                      ),
                                    ),
                                  ),
                            ),
                          )
                        }
                      >
                        {source.action === "preserve" ? historyRecoveryCopy.preserveAction : historyRecoveryCopy.acknowledgeAction}
                      </button>
                    </Show>
                  </article>
                )}
              </For>
              <div class="history-recovery-library-head">
                <strong>{historyRecoveryCopy.libraryHeading}</strong>
                <span>{preservedCountCopy(snapshot()?.library.generationCount ?? 0)}</span>
              </div>
              <RecoveryBrowseState result={browseResult()} />
              <For each={items().filter(isGeneration)}>
                {(generation) => (
                  <article class="history-recovery-row">
                    <button
                      type="button"
                      class="history-recovery-link"
                      disabled={pendingOperation() !== null}
                      onClick={(event) =>
                        enter(
                          {
                            kind: "projects",
                            generationKey: generation.generationKey,
                            label: workbenchLocalizedText(
                              "history.recovery-label",
                              () => dynamicCopy.recoveryCopy(generation.ordinal),
                            ),
                          },
                          event.currentTarget,
                        )
                      }
                    >
                      <strong>{dynamicCopy.recoveryCopy(generation.ordinal)}</strong>
                      <span>{countsLabel(generation.counts)}</span>
                    </button>
                    <button
                      type="button"
                      class="btn ghost sm"
                      disabled={pendingOperation() !== null}
                      onClick={() =>
                        perform(
                          "export-copy",
                          generation.generationKey,
                          workbenchLocalizedText(
                            "history.exporting-recovery",
                            () => exportingOperationCopy(
                              dynamicCopy.recoveryCopy(generation.ordinal),
                            ),
                          ),
                        )
                      }
                    >
                      {historyRecoveryCopy.exportExactCopy}
                    </button>
                  </article>
                )}
              </For>
            </div>
          </Show>

          <Show when={route().kind === "projects"}>
            <RecoveryList
              heading={(route() as Extract<RecoveryRoute, { kind: "projects" }>).label}
              result={browseResult()}
              items={items().filter(isProject)}
              onSelect={(item, trigger) => {
                const current = route() as Extract<RecoveryRoute, { kind: "projects" }>;
                enter(
                  {
                    kind: "sessions",
                    generationKey: current.generationKey,
                    projectKey: item.projectKey,
                    label: workbenchLocalizedText(
                      "history.project-label",
                      () => dynamicCopy.projectCopy(item.ordinal),
                    ),
                  },
                  trigger,
                );
              }}
            />
          </Show>

          <Show when={route().kind === "sessions"}>
            <RecoveryList
              heading={(route() as Extract<RecoveryRoute, { kind: "sessions" }>).label}
              result={browseResult()}
              items={items().filter(isSession)}
              onSelect={(item, trigger) => {
                const current = route() as Extract<RecoveryRoute, { kind: "sessions" }>;
                enter(
                  {
                    kind: "turns",
                    generationKey: current.generationKey,
                    projectKey: current.projectKey,
                    sessionKey: item.sessionKey,
                    label: workbenchLocalizedText(
                      "history.session-label",
                      () => dynamicCopy.sessionCopy(item.ordinal),
                    ),
                  },
                  trigger,
                );
              }}
            />
          </Show>

          <Show when={route().kind === "turns"}>
            <RecoveryList
              heading={(route() as Extract<RecoveryRoute, { kind: "turns" }>).label}
              result={browseResult()}
              items={items().filter(isTurn)}
            />
          </Show>

          <Show when={activeGenerationKey()}>
            {(generationKey) => (
              <div class="history-recovery-pending">
                <span>{historyRecoveryCopy.contentExportGuidance}</span>
                <button
                  type="button"
                  class="btn ghost sm"
                  disabled={pendingOperation() !== null}
                  onClick={() =>
                    perform(
                      "export-copy",
                      generationKey(),
                      workbenchLocalizedText(
                        "history.exporting-recovery-copy",
                        () => historyRecoveryCopy.exportingExactCopy,
                      ),
                    )
                  }
                >
                  {historyRecoveryCopy.exportExactCopy}
                </button>
              </div>
            )}
          </Show>

          <Show
            when={
              readyBrowse()?.page.nextAfter !== null &&
              readyBrowse() !== null
            }
          >
            <button type="button" class="btn ghost sm" onClick={loadMore}>
              {historyRecoveryCopy.loadMore}
            </button>
          </Show>
        </Show>

        <Show when={pendingOperation()}>
          {(pending) => (
            <div class="history-recovery-pending" role="status">
              <span>{presentationText(pending().label)}…</span>
              <button type="button" class="btn ghost sm" onClick={cancelPending}>
                {commonCopy.cancel}
              </button>
            </div>
          )}
        </Show>
        <Show when={actionResult()}>
          {(result) => (
            <p
              class="history-recovery-feedback"
              role={result().status === "failed" ? "alert" : "status"}
            >
              {actionResultLabel(result())}
            </p>
          )}
        </Show>
        <Show when={actionUnavailable()}>
          <p class="history-recovery-feedback" role="alert">
            {historyRecoveryCopy.unavailableFallback}
          </p>
        </Show>
        <Show when={browseUnavailable()}>
          <p class="history-recovery-feedback" role="alert">
            {historyRecoveryCopy.unavailableFallback}
          </p>
        </Show>
      </section>
    </Show>
  );
};

const RecoveryBrowseState: Component<{
  readonly result: HistoryRecoveryBrowseResult | null;
}> = (props) => (
  <Show when={props.result !== null && props.result.status !== "ready"}>
    <p
      class="history-recovery-problem"
      role={props.result?.status === "unavailable" ? "alert" : "status"}
    >
      {props.result?.status === "ready"
        ? ""
        : props.result === null
          ? ""
          : historyProblemLabel(props.result.problem.code)}
    </p>
  </Show>
);

const RecoveryList: Component<{
  readonly heading: WorkbenchPresentationText;
  readonly result: HistoryRecoveryBrowseResult | null;
  readonly items: readonly HistoryRecoveryBrowseItem[];
  readonly onSelect?: (item: any, trigger: HTMLElement) => void;
}> = (props) => (
  <div class="history-recovery-browser">
    <h3>{presentationText(props.heading)}</h3>
    <RecoveryBrowseState result={props.result} />
    <Show
      when={props.result?.status !== "ready" || props.items.length > 0}
      fallback={<p class="history-recovery-empty">{historyRecoveryCopy.emptyBranch}</p>}
    >
      <For each={props.items}>
        {(item) => (
          <Show
            when={props.onSelect !== undefined}
            fallback={
              <div class="history-recovery-metadata-row">
                <strong>{historyItemLabel(item)}</strong>
                <span>{itemDetail(item)}</span>
              </div>
            }
          >
            <button
              type="button"
              class="history-recovery-link"
              onClick={(event) => props.onSelect?.(item, event.currentTarget)}
            >
              <strong>{historyItemLabel(item)}</strong>
              <span>{itemDetail(item)}</span>
            </button>
          </Show>
        )}
      </For>
    </Show>
  </div>
);

function recoveryKey(kind: "request" | "operation"): string {
  keySequence += 1;
  const random = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(16)}-${keySequence.toString(16)}`;
  return `history-${kind}-v1-${random}`;
}

function isGeneration(
  item: HistoryRecoveryBrowseItem,
): item is Extract<HistoryRecoveryBrowseItem, { kind: "generation" }> {
  return item.kind === "generation";
}

function isProject(
  item: HistoryRecoveryBrowseItem,
): item is Extract<HistoryRecoveryBrowseItem, { kind: "project" }> {
  return item.kind === "project";
}

function isSession(
  item: HistoryRecoveryBrowseItem,
): item is Extract<HistoryRecoveryBrowseItem, { kind: "session" }> {
  return item.kind === "session";
}

function isTurn(
  item: HistoryRecoveryBrowseItem,
): item is Extract<HistoryRecoveryBrowseItem, { kind: "turn" }> {
  return item.kind === "turn";
}

function countsLabel(counts: {
  readonly projects: number;
  readonly sessions: number;
  readonly commands: number;
  readonly updates: number;
}): string {
  return recoveryCountsCopy(counts);
}

function sourceStateLabel(
  state: HistoryRecoverySourceSummary["state"],
): string {
  return dynamicCopy.historyState[state];
}

function sourceMetadataLabel(source: HistoryRecoverySourceSummary): string {
  if (source.counts === null) return historyRecoveryCopy.metadataUnavailable;
  return sourceInventoryUnreadable(source)
    ? historyRecoveryCopy.unreadableSourceMetadata
    : countsLabel(source.counts);
}

function sourceDisplayStateLabel(source: HistoryRecoverySourceSummary): string {
  return sourceInventoryUnreadable(source)
    ? historyRecoveryCopy.unreadableSourceState
    : sourceStateLabel(source.state);
}

function sourceInventoryUnreadable(source: HistoryRecoverySourceSummary): boolean {
  return source.state === "available" &&
    source.counts.projects === 0 &&
    source.counts.sessions === 0 &&
    source.counts.commands === 0 &&
    source.counts.updates === 0;
}

function itemDetail(item: HistoryRecoveryBrowseItem): string {
  if (item.kind === "generation" || item.kind === "project") {
    return countsLabel(item.counts);
  }
  if (item.kind === "session") {
    return sessionRowDetailCopy(
      dynamicCopy.historyStatus[item.status],
      item.turnCount,
    );
  }
  return turnRowDetailCopy(
    dynamicCopy.historyStatus[item.status],
    item.eventCount,
  );
}

function actionResultLabel(result: HistoryRecoveryActionResult): string {
  if (result.status === "failed" || result.status === "cancelled") {
    return historyProblemLabel(result.problem.code);
  }
  switch (result.status) {
    case "preserved":
      return preservedResultCopy(dynamicCopy.recoveryCopy(result.generation.ordinal));
    case "already-preserved":
      return alreadyPreservedResultCopy(
        dynamicCopy.recoveryCopy(result.generation.ordinal),
      );
    case "acknowledged":
      return historyActionResultCopy.acknowledged;
    case "already-acknowledged":
      return historyActionResultCopy.alreadyAcknowledged;
    case "exported":
      return exportedResultCopy(
        localizedExportLabel(result.export.label),
      );
    case "already-exported":
      return historyActionResultCopy.alreadyExported;
    case "chooser-cancelled":
      return historyActionResultCopy.chooserCancelled;
    case "outcome-unknown":
      return historyActionResultCopy.outcomeUnknown;
  }
}

function historyProblemLabel(code: HistoryRecoveryProblemCode): string {
  return dynamicCopy.historyProblem[code];
}

function historyItemLabel(item: HistoryRecoveryBrowseItem): string {
  switch (item.kind) {
    case "generation":
      return dynamicCopy.recoveryCopy(item.ordinal);
    case "project":
      return dynamicCopy.projectCopy(item.ordinal);
    case "session":
      return dynamicCopy.sessionCopy(item.ordinal);
    case "turn":
      return dynamicCopy.turnCopy(item.ordinal);
  }
}

function sourceOrdinal(
  sources: readonly HistoryRecoverySourceSummary[],
  index: number,
): number {
  const role = sources[index]?.role;
  return sources
    .slice(0, index + 1)
    .filter((source) => source.role === role).length;
}

function sourceLabel(
  source: HistoryRecoverySourceSummary,
  ordinal: number,
): string {
  return source.role === "current"
    ? dynamicCopy.currentStoreCopy(ordinal)
    : dynamicCopy.historicalStoreCopy(ordinal);
}

function localizedExportLabel(label: string): string {
  const match = /^Recovery export ([1-9]\d*)$/u.exec(label);
  return match === null
    ? label
    : dynamicCopy.recoveryExportCopy(Number(match[1]));
}
