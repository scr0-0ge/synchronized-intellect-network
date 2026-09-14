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

// The SIN mark's ribbon path (assets/brand/sin-mark-mono-ink.svg, viewBox
// 0 0 1024 1024), rendered inline with currentColor so it follows the
// existing `.mark` token instead of duplicating a themed asset per tone.
const sinMarkPath =
  "M431.20,338.00L710.00,338.00L714.39,337.83L718.76,337.31L720.93,336.92L725.20,335.90L729.38,334.54L731.43,333.74L733.44,332.86L737.36,330.86L741.11,328.56L744.67,325.98L746.37,324.58L749.60,321.60L751.12,320.01L753.98,316.67L756.56,313.11L758.86,309.36L759.90,307.42L761.74,303.43L762.54,301.38L763.90,297.20L764.92,292.93L765.31,290.76L765.83,286.39L766.00,282.00L765.83,277.61L765.31,273.24L764.92,271.07L763.90,266.80L762.54,262.62L760.86,258.56L758.86,254.64L756.56,250.89L753.98,247.33L751.12,243.99L748.01,240.88L744.67,238.02L741.11,235.44L737.36,233.14L733.44,231.14L729.38,229.46L725.20,228.10L720.93,227.08L716.58,226.39L712.20,226.04L710.00,226.00L428.00,226.00L423.66,226.09L418.67,226.39L413.66,226.94L408.64,227.73L402.26,229.10L396.17,230.82L389.92,233.02L384.08,235.51L378.16,238.51L372.71,241.72L367.30,245.38L364.32,247.62L361.31,250.07L357.54,253.39L354.40,256.40L254.40,356.40L251.29,359.64L248.86,362.39L245.50,366.52L243.25,369.57L241.09,372.78L239.01,376.16L237.05,379.73L235.21,383.48L233.52,387.42L232.45,390.30L231.07,394.59L229.92,399.03L229.31,401.94L228.83,404.85L228.28,409.52L228.07,413.00L228.00,416.00L228.15,420.74L228.59,425.44L229.31,430.06L229.92,432.97L231.07,437.41L232.02,440.45L233.52,444.58L235.21,448.52L237.05,452.27L239.01,455.84L241.09,459.22L243.25,462.43L245.50,465.48L247.80,468.36L251.29,472.36L253.78,474.96L256.92,477.97L258.58,479.37L262.05,481.99L265.71,484.33L269.55,486.38L271.52,487.29L275.57,488.88L477.51,559.28L514.38,453.53L367.04,402.16ZM656.96,621.84L592.80,686.00L314.00,686.00L309.61,686.17L305.24,686.69L303.07,687.08L298.80,688.10L294.62,689.46L292.57,690.26L288.58,692.10L284.74,694.25L282.89,695.44L279.33,698.02L275.99,700.88L274.40,702.40L271.42,705.63L268.70,709.08L267.44,710.89L265.14,714.64L263.14,718.56L261.46,722.62L260.10,726.80L259.55,728.93L258.69,733.24L258.17,737.61L258.04,739.80L258.00,742.00L258.17,746.39L258.69,750.76L259.08,752.93L260.10,757.20L261.46,761.38L263.14,765.44L265.14,769.36L267.44,773.11L268.70,774.92L270.02,776.67L272.88,780.01L275.99,783.12L279.33,785.98L282.89,788.56L286.64,790.86L290.56,792.86L294.62,794.54L298.80,795.90L303.07,796.92L305.24,797.31L309.61,797.83L314.00,798.00L596.62,798.00L601.61,797.86L606.63,797.49L611.67,796.88L616.72,796.02L622.87,794.61L629.20,792.74L635.15,790.55L641.23,787.87L646.85,784.93L652.48,781.52L657.65,777.92L662.69,773.93L666.46,770.61L669.60,767.60L769.60,667.60L772.71,664.36L775.14,661.61L778.50,657.48L780.75,654.43L782.91,651.22L784.99,647.84L786.95,644.27L788.79,640.52L790.48,636.58L791.55,633.70L792.93,629.41L794.08,624.97L794.69,622.06L795.17,619.15L795.72,614.48L795.93,611.00L796.00,608.00L795.85,603.26L795.41,598.56L794.69,593.94L794.08,591.03L792.93,586.59L791.98,583.55L790.48,579.42L788.79,575.48L786.95,571.73L784.99,568.16L782.91,564.78L780.75,561.57L778.50,558.52L776.20,555.64L772.71,551.64L770.22,549.04L767.08,546.03L765.42,544.63L761.95,542.01L758.29,539.67L756.39,538.61L752.48,536.71L748.43,535.12L546.49,464.72L509.62,570.47Z";

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
      <svg viewBox="0 0 1024 1024" width="12" height="12" aria-hidden="true">
        <path d={sinMarkPath} fill="currentColor" />
      </svg>
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
          <svg viewBox="0 0 1024 1024" width="12" height="12" aria-hidden="true">
            <path d={sinMarkPath} fill="currentColor" />
          </svg>
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
