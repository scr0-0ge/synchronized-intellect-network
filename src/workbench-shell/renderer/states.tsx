import { Show, type Component } from "solid-js";
import {
  canCreateProject,
  canOpenProject,
  type WorkbenchProjectOpenState,
} from "./view-model.ts";
import { type WorkbenchRemovalFeedback } from "./removal-presentation.ts";
import { commonCopy } from "./copy/common-copy.ts";
import { shellCopy } from "./copy/shell-copy.ts";
import { presentationText } from "./presentation-text.ts";

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
