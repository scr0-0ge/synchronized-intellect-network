import {
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import {
  canCreateProject,
  canOpenProject,
  type WorkbenchProjectOpenState,
} from "./view-model.ts";
import type { WorkbenchWindowRendererBridge } from "../window-control-bridge.ts";
import { type WorkbenchRemovalFeedback } from "./removal-presentation.ts";
import { commonCopy } from "./copy/common-copy.ts";
import { chromeCopy } from "./copy/chrome-copy.ts";
import { shellCopy } from "./copy/shell-copy.ts";
import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "./locale.ts";
import { presentationText } from "./presentation-text.ts";

const englishCopy = {
  title: "No Projects in the Workbench",
  body: "Open an existing Project or create a new one to get started.",
} as const;

const simplifiedChineseCopy = {
  title: "Workbench 中没有项目",
  body: "打开现有项目或创建新项目即可开始。",
} as const satisfies LocalizedShape<typeof englishCopy>;

const noProjectsCopy = createLocaleCopy(
  defineCopyLocaleDictionaries(englishCopy, simplifiedChineseCopy),
);

export const EmptyState: Component<{
  readonly title: string;
  readonly body: string;
  readonly tone?: string;
}> = (props) => (
  <div class="empty-state" data-tone={props.tone}>
    <span class="state-glyph small" aria-hidden="true">
      ◇
    </span>
    <h3>{props.title}</h3>
    <p>{props.body}</p>
  </div>
);

export const LoadingState: Component = () => (
  <main class="system-state" aria-labelledby="loading-title">
    <span class="mark system-mark" aria-hidden="true">
      U
    </span>
    <p class="system-kicker">{shellCopy.loadingKicker}</p>
    <h1 id="loading-title">{shellCopy.loadingTitle}</h1>
    <p>{shellCopy.loadingBody}</p>
  </main>
);

export const NoProjectsTitlebar: Component<{
  readonly windowBridge: WorkbenchWindowRendererBridge;
}> = (props) => {
  const [maximized, setMaximized] = createSignal(false);
  onMount(() => {
    const dispose = props.windowBridge.observeState((state) => {
      setMaximized(state.maximized);
    });
    onCleanup(dispose);
  });
  return (
    <header class="titlebar">
      <div class="tb-group">
        <span class="mark" aria-hidden="true">
          U
        </span>
        <span class="project-menu">
          <span class="pm-name">{shellCopy.appTitle}</span>
        </span>
      </div>
      <div class="caption-buttons">
        <button
          type="button"
          class="caption-btn"
          aria-label={chromeCopy.minimize}
          title={chromeCopy.minimize}
          onClick={() => props.windowBridge.minimize()}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5.5h10" />
          </svg>
        </button>
        <button
          type="button"
          class="caption-btn"
          data-maximized={maximized()}
          aria-label={maximized() ? chromeCopy.restore : chromeCopy.maximize}
          title={maximized() ? chromeCopy.restore : chromeCopy.maximize}
          onClick={() => props.windowBridge.toggleMaximize()}
        >
          <svg class="glyph-maximize" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
          <svg class="glyph-restore" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5v-2h7v7h-2" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          </svg>
        </button>
        <button
          type="button"
          class="caption-btn close"
          aria-label={chromeCopy.close}
          title={chromeCopy.close}
          onClick={() => props.windowBridge.close()}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
          </svg>
        </button>
      </div>
    </header>
  );
};

export const NoProjectsState: Component<{
  readonly projectOpen: WorkbenchProjectOpenState;
  readonly canCreateProject: () => boolean;
  readonly onCreateProject: () => void;
  readonly canOpenProject: () => boolean;
  readonly onOpenProject: () => void;
}> = (props) => (
  <main class="stage-state" aria-labelledby="no-projects-title">
    <div class="empty-state" data-tone="neutral">
      <span class="state-glyph small" aria-hidden="true">
        ◇
      </span>
      <h3 id="no-projects-title">{noProjectsCopy.title}</h3>
      <p>{noProjectsCopy.body}</p>
      <div class="failure-project-actions">
        <button
          type="button"
          class="btn"
          disabled={!props.canOpenProject()}
          onClick={props.onOpenProject}
        >
          {props.projectOpen.phase === "pending" &&
          props.projectOpen.operation === "open"
            ? commonCopy.openingProject
            : commonCopy.openProject}
        </button>
        <button
          type="button"
          class="btn primary"
          disabled={!props.canCreateProject()}
          onClick={props.onCreateProject}
        >
          {props.projectOpen.phase === "pending" &&
          props.projectOpen.operation === "create"
            ? commonCopy.creatingProject
            : commonCopy.createProject}
        </button>
      </div>
      <Show when={props.projectOpen.feedback}>
        {(feedback) => (
          <p class="failure-project-feedback" role="status" aria-live="polite">
            {presentationText(feedback())}
          </p>
        )}
      </Show>
    </div>
  </main>
);

export const FailureState: Component<{
  readonly message: string;
  readonly removalNotice?: WorkbenchRemovalFeedback | null;
  readonly projectOpen: WorkbenchProjectOpenState;
  readonly canCreateProject: () => boolean;
  readonly onCreateProject: () => void;
  readonly canOpenProject: () => boolean;
  readonly onOpenProject: () => void;
}> = (props) => (
  <main class="system-state failure" aria-labelledby="failure-title">
    <span class="state-glyph is-warn" aria-hidden="true">
      !
    </span>
    <p class="system-kicker">{shellCopy.failureKicker}</p>
    <h1 id="failure-title">{shellCopy.failureTitle}</h1>
    <p>{props.message}</p>
    <div class="failure-project-actions">
      <button
        type="button"
        class="btn"
        disabled={!props.canOpenProject()}
        onClick={props.onOpenProject}
      >
        {props.projectOpen.phase === "pending" &&
        props.projectOpen.operation === "open"
          ? commonCopy.openingProject
          : commonCopy.openProject}
      </button>
      <button
        type="button"
        class="btn primary"
        disabled={!props.canCreateProject()}
        onClick={props.onCreateProject}
      >
        {props.projectOpen.phase === "pending" &&
        props.projectOpen.operation === "create"
          ? commonCopy.creatingProject
          : commonCopy.createProject}
      </button>
    </div>
    <Show when={props.projectOpen.feedback}>
      {(feedback) => (
        <p class="failure-project-feedback" role="status" aria-live="polite">
          {presentationText(feedback())}
        </p>
      )}
    </Show>
    <Show when={props.removalNotice}>
      {(notice) => (
        <p
          class="failure-removal-feedback"
          role={notice().tone}
          aria-live="polite"
          tabIndex={-1}
          data-removal-focus-fallback
        >
          {presentationText(notice().message)}
        </p>
      )}
    </Show>
  </main>
);
