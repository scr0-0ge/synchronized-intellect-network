export const PROFILE_POPOVER_ANCHOR_GAP = 8;
export const PROFILE_POPOVER_HORIZONTAL_GUTTER = 40;
export const PROFILE_POPOVER_MAX_WIDTH = 400;
export const PROFILE_POPOVER_VERTICAL_GUTTER = 8;
export const PROFILE_POPOVER_ID = "direct-profile-popover";
export const PROFILE_POPOVER_HEADING_ID =
  "direct-profile-popover-heading";

export interface ProfilePopoverRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface ProfilePopoverSize {
  readonly width: number;
  readonly height: number;
}

export interface ProfilePopoverViewport {
  readonly width: number;
  readonly height: number;
}

export interface ProfilePopoverPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
}

export interface ProfilePopoverOpenState<
  Kind extends string = string,
  Trigger = unknown,
> {
  readonly kind: Kind;
  readonly trigger: Trigger;
}

export type ProfilePopoverDismissReason =
  | "escape"
  | "outside-pointer"
  | "focus-out";

export interface ProfilePopoverLifecycleEvent {
  readonly target: unknown;
  readonly key?: string;
  preventDefault(): void;
}

export interface ProfilePopoverLifecycleEventSource {
  addEventListener(
    type: string,
    listener: (event: ProfilePopoverLifecycleEvent) => void,
    options?: boolean | Readonly<{ capture?: boolean; passive?: boolean }>,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: ProfilePopoverLifecycleEvent) => void,
    options?: boolean | Readonly<{ capture?: boolean; passive?: boolean }>,
  ): void;
}

export interface ProfilePopoverLifecycleElement {
  readonly name: string;
  readonly nativeElement?: Element;
  getBoundingClientRect(): ProfilePopoverRect;
  contains(target: unknown): boolean;
  focus(): void;
}

export interface ProfilePopoverResizeObserver {
  observe(element: ProfilePopoverLifecycleElement): void;
  disconnect(): void;
}

export interface ProfilePopoverLifecycleEnvironment {
  readonly documentEvents: ProfilePopoverLifecycleEventSource;
  readonly viewportEvents: ProfilePopoverLifecycleEventSource;
  getViewport(): ProfilePopoverViewport;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(frame: number): void;
  createResizeObserver?(
    callback: () => void,
  ): ProfilePopoverResizeObserver | undefined;
}

export interface ProfilePopoverLifecycleOptions {
  readonly anchor: ProfilePopoverLifecycleElement;
  readonly popover: ProfilePopoverLifecycleElement;
  readonly environment: ProfilePopoverLifecycleEnvironment;
  readonly onBeforeMeasure: () => void;
  readonly focusContent: (revision: string) => void;
  readonly isProfilePopoverTrigger: (target: unknown) => boolean;
  readonly onPlacement: (placement: ProfilePopoverPlacement) => void;
  readonly onDismiss: (reason: ProfilePopoverDismissReason) => void;
}

export interface ProfilePopoverLifecycle {
  updateContentRevision(revision: string): void;
  dispose(): void;
}

export function placeProfilePopover(
  anchor: ProfilePopoverRect,
  popover: ProfilePopoverSize,
  viewport: ProfilePopoverViewport,
): ProfilePopoverPlacement {
  const availableWidth = Math.max(
    0,
    viewport.width - PROFILE_POPOVER_HORIZONTAL_GUTTER * 2,
  );
  const width = Math.min(
    Math.max(0, popover.width),
    PROFILE_POPOVER_MAX_WIDTH,
    availableWidth,
  );
  const maximumLeft = Math.max(
    PROFILE_POPOVER_HORIZONTAL_GUTTER,
    viewport.width - PROFILE_POPOVER_HORIZONTAL_GUTTER - width,
  );
  const left = clamp(
    anchor.left,
    PROFILE_POPOVER_HORIZONTAL_GUTTER,
    maximumLeft,
  );
  const maxHeight = Math.max(
    0,
    viewport.height - PROFILE_POPOVER_VERTICAL_GUTTER * 2,
  );
  const effectiveHeight = Math.min(Math.max(0, popover.height), maxHeight);
  const maximumTop = Math.max(
    PROFILE_POPOVER_VERTICAL_GUTTER,
    viewport.height - PROFILE_POPOVER_VERTICAL_GUTTER - effectiveHeight,
  );
  const top = clamp(
    anchor.bottom + PROFILE_POPOVER_ANCHOR_GAP,
    PROFILE_POPOVER_VERTICAL_GUTTER,
    maximumTop,
  );

  return { left, top, width, maxHeight };
}

export function toggleProfilePopover<Kind extends string, Trigger>(
  current: ProfilePopoverOpenState<Kind, Trigger> | null,
  kind: Kind,
  trigger: Trigger,
): ProfilePopoverOpenState<Kind, Trigger> | null {
  return current?.kind === kind && current.trigger === trigger
    ? null
    : { kind, trigger };
}

export function nextProfileOptionIndex(
  currentIndex: number,
  optionCount: number,
  key: string,
): number | null {
  if (optionCount <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return (currentIndex + 1 + optionCount) % optionCount;
    case "ArrowUp":
      return (currentIndex - 1 + optionCount) % optionCount;
    case "Home":
      return 0;
    case "End":
      return optionCount - 1;
    default:
      return null;
  }
}

export function createProfilePopoverLifecycle(
  options: ProfilePopoverLifecycleOptions,
): ProfilePopoverLifecycle {
  let disposed = false;
  let dismissed = false;
  let frame: number | null = null;
  let lastContentRevision: string | null = null;
  let pendingFocusRevision: string | null = null;
  const removers: Array<() => void> = [];

  const schedulePlacement = (): void => {
    if (disposed || dismissed || frame !== null) return;
    frame = options.environment.requestAnimationFrame(() => {
      frame = null;
      if (disposed || dismissed) return;
      const anchor = options.anchor.getBoundingClientRect();
      options.onBeforeMeasure();
      const popover = options.popover.getBoundingClientRect();
      options.onPlacement(
        placeProfilePopover(anchor, popover, options.environment.getViewport()),
      );
      if (disposed || dismissed) return;
      const focusRevision = pendingFocusRevision;
      pendingFocusRevision = null;
      if (focusRevision !== null) {
        options.focusContent(focusRevision);
      }
    });
  };
  const cancelScheduledPlacement = (): void => {
    if (frame === null) return;
    options.environment.cancelAnimationFrame(frame);
    frame = null;
  };
  const dismiss = (
    reason: ProfilePopoverDismissReason,
    restoreFocus: boolean,
    event?: ProfilePopoverLifecycleEvent,
  ): void => {
    if (disposed || dismissed) return;
    dismissed = true;
    pendingFocusRevision = null;
    cancelScheduledPlacement();
    event?.preventDefault();
    options.onDismiss(reason);
    if (restoreFocus) options.anchor.focus();
  };
  const onPointerDown = (event: ProfilePopoverLifecycleEvent): void => {
    if (
      options.anchor.contains(event.target) ||
      options.popover.contains(event.target) ||
      options.isProfilePopoverTrigger(event.target)
    ) {
      return;
    }
    dismiss("outside-pointer", true, event);
  };
  const onKeyDown = (event: ProfilePopoverLifecycleEvent): void => {
    if (event.key === "Escape") dismiss("escape", true, event);
  };
  const onFocusIn = (event: ProfilePopoverLifecycleEvent): void => {
    if (
      options.anchor.contains(event.target) ||
      options.popover.contains(event.target)
    ) {
      return;
    }
    dismiss("focus-out", false);
  };
  const listen = (
    source: ProfilePopoverLifecycleEventSource,
    type: string,
    listener: (event: ProfilePopoverLifecycleEvent) => void,
    eventOptions?: boolean | Readonly<{ capture?: boolean; passive?: boolean }>,
  ): void => {
    source.addEventListener(type, listener, eventOptions);
    removers.push(() =>
      source.removeEventListener(type, listener, eventOptions),
    );
  };

  listen(options.environment.documentEvents, "pointerdown", onPointerDown, true);
  listen(options.environment.documentEvents, "keydown", onKeyDown, true);
  listen(options.environment.documentEvents, "focusin", onFocusIn, true);
  listen(options.environment.documentEvents, "scroll", schedulePlacement, {
    capture: true,
    passive: true,
  });
  listen(options.environment.viewportEvents, "resize", schedulePlacement, {
    passive: true,
  });
  const resizeObserver =
    options.environment.createResizeObserver?.(schedulePlacement);
  resizeObserver?.observe(options.anchor);
  resizeObserver?.observe(options.popover);
  schedulePlacement();

  return {
    updateContentRevision: (revision) => {
      if (disposed || dismissed || revision === lastContentRevision) return;
      lastContentRevision = revision;
      pendingFocusRevision = revision;
      schedulePlacement();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pendingFocusRevision = null;
      cancelScheduledPlacement();
      resizeObserver?.disconnect();
      for (const remove of removers.reverse()) remove();
    },
  };
}

export function createBrowserProfilePopoverElement(
  element: HTMLElement,
  name: string,
): ProfilePopoverLifecycleElement {
  return {
    name,
    nativeElement: element,
    contains: (target) => {
      const NodeConstructor = element.ownerDocument.defaultView?.Node;
      return NodeConstructor !== undefined && target instanceof NodeConstructor
        ? element.contains(target)
        : false;
    },
    focus: () => element.focus({ preventScroll: true }),
    getBoundingClientRect: () => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    },
  };
}

export function createBrowserProfilePopoverEnvironment(
  ownerDocument: Document,
): ProfilePopoverLifecycleEnvironment {
  const view = ownerDocument.defaultView;
  if (view === null) {
    throw new Error("Profile popovers require a document with a viewport.");
  }
  const resizeObserverConstructor = (
    view as Window & {
      readonly ResizeObserver?: typeof ResizeObserver;
    }
  ).ResizeObserver;

  return {
    documentEvents: browserEventSource(ownerDocument),
    viewportEvents: browserEventSource(view),
    getViewport: () => ({ width: view.innerWidth, height: view.innerHeight }),
    requestAnimationFrame: (callback) => view.requestAnimationFrame(callback),
    cancelAnimationFrame: (frame) => view.cancelAnimationFrame(frame),
    createResizeObserver:
      resizeObserverConstructor === undefined
        ? undefined
        : (callback) => {
            const observer = new resizeObserverConstructor(callback);
            return {
              observe: (element) => {
                if (element.nativeElement !== undefined) {
                  observer.observe(element.nativeElement);
                }
              },
              disconnect: () => observer.disconnect(),
            };
          },
  };
}

function browserEventSource(
  target: EventTarget,
): ProfilePopoverLifecycleEventSource {
  return {
    addEventListener: (type, listener, options) =>
      target.addEventListener(
        type,
        listener as EventListener,
        options as AddEventListenerOptions | boolean | undefined,
      ),
    removeEventListener: (type, listener, options) =>
      target.removeEventListener(
        type,
        listener as EventListener,
        options as EventListenerOptions | boolean | undefined,
      ),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
