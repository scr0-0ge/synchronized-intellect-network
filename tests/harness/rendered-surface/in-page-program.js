/*
 * The in-page half of the rendered-surface measurement (F118).
 *
 * This file is never bundled and never imported. It is read as text and
 * evaluated inside a real Chromium renderer by `measure-electron.mjs`, so it
 * must stay plain ES2022 with no imports and no TypeScript syntax.
 *
 * Everything here is an OBSERVATION. It records what the engine laid out and
 * what the engine resolved; it decides nothing. Every threshold, allowance and
 * verdict lives in the test that consumes this output, so a measurement can
 * never be quietly relaxed by editing the thing that produces it.
 */
globalThis.__uawMeasure = {
  /**
   * Measuring a surface mid-transition reads a colour the product never rests
   * at. Appearance changes animate, and a settle delay that happens to land
   * inside one produces a number that is neither the old value nor the new one
   * and that changes between runs. Motion is stopped before anything is read.
   *
   * The default WCAG path removes text shadow from every capture so CRT glow
   * cannot be read as either foreground or background. A dedicated visual
   * evidence path may preserve it; hideAllInk still removes it from the paired
   * background capture, so the halo is then measured as ink rather than ground.
   */
  freezeMotion(preserveTextShadow = false) {
    const style = document.createElement("style");
    style.id = "uaw-measure-freeze";
    style.textContent =
      "*,*::before,*::after{transition:none !important;animation:none !important;" +
      (preserveTextShadow ? "" : "text-shadow:none !important;") +
      "caret-color:transparent !important}";
    document.head.append(style);
    return true;
  },

  /**
   * Pass 1 — geometry and resolved style, before any pixel capture.
   *
   * `grids` is the F118 observation. A grid container states its track set in
   * `grid-template-columns`; the number of rows its children actually occupy is
   * a rendered fact that no source-text comparison can reach. We record both
   * and let the test adjudicate.
   */
  collect() {
    const gridSignatures = new Map();
    const textSignatures = new Map();
    const grids = [];
    const texts = [];

    for (const element of document.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      if (style.display === "grid" || style.display === "inline-grid") {
        const grid = describeGrid(element, style, gridSignatures);
        if (grid !== null) grids.push(grid);
      }
      const text = describeText(element, style, textSignatures);
      if (text !== null) texts.push(text);
    }

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      root: {
        skin: document.documentElement.getAttribute("data-skin"),
        glass: document.documentElement.getAttribute("data-glass"),
        tone: document.documentElement.getAttribute("data-tone"),
        crt: document.documentElement.getAttribute("data-crt"),
        phosphor: document.documentElement.getAttribute("data-phosphor"),
        phosphorTier: document.documentElement.getAttribute("data-phosphor-tier"),
        material: document.documentElement.getAttribute("data-material"),
      },
      /* Separate from `root` on purpose: `root` is the product's own `data-*`
         attributes, and a test is entitled to compare that set whole. What the
         OS asked for is not one of them. It is read back rather than assumed
         because the transparency preference is emulated from outside the page,
         so a measurement of that configuration has to carry proof it engaged. */
      mediaEnvironment: {
        reducedTransparency: window.matchMedia(
          "(prefers-reduced-transparency: reduce)",
        ).matches
          ? "reduce"
          : "no-preference",
      },
      /* The `F51`/`F54`/`F78` question, read directly rather than inferred from
         a selector: with native material signalled on, does the acrylic skin's
         own fallback backdrop still paint? `content: "none"` means the
         pseudo-element does not exist, which is the suppression. */
      fallbackGround: {
        rootBackground: getComputedStyle(document.documentElement).backgroundColor,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        beforeContent: getComputedStyle(document.body, "::before").content,
        beforeBackgroundImage: getComputedStyle(document.body, "::before").backgroundImage,
      },
      grids,
      texts,
      grounds: describeGrounds(),
      extents: describeExtents(),
      clippedControls: describeClippedControls(),
      paintedEdges: describePaintedEdges(),
      seams: describeSeams(),
      verticalSeams: describeVerticalSeams(),
    };
  },

  /**
   * Between the two captures ALL ink is removed while every box, background and
   * position stays exactly where it was. The second capture therefore shows the
   * real surface each string is painted onto — gradients, stacked alpha,
   * backdrop-filter and all.
   *
   * Removal is global, not per-measured-element. A neighbouring glyph, a
   * `::before` bullet or an icon stroke that happens to fall inside a measured
   * string's box is ink too, and leaving it lit would let the harness read
   * somebody else's foreground as this string's background — a false failure
   * that a maintainer could only resolve by weakening the assertion.
   *
   * This is safe here and would not be safe everywhere: no background, border
   * or shadow in this corpus derives from `currentcolor`. The only
   * `currentcolor` consumers are SVG `stroke` and the neutral `--crt-phosphor`,
   * both of which are themselves ink.
   */
  hideAllInk() {
    const style = document.createElement("style");
    style.id = "uaw-measure-hide-text";
    style.textContent =
      "*,*::before,*::after{color:transparent !important;" +
      "-webkit-text-fill-color:transparent !important;" +
      "-webkit-text-stroke-color:transparent !important;" +
      "text-decoration-color:transparent !important;" +
      "text-shadow:none !important}";
    document.head.append(style);
    return document.querySelectorAll('[data-uaw-measured="text"]').length;
  },

  restoreMeasuredText() {
    document.querySelector("#uaw-measure-hide-text")?.remove();
    for (const element of document.querySelectorAll('[data-uaw-measured="text"]')) {
      element.removeAttribute("data-uaw-measured");
    }
  },
};

/**
 * The panes whose GROUND is measured, in left-to-right window order.
 *
 * `F102` is a complaint about ground, not about text: the owner reported the
 * conversation reading as a smaller sheet pasted onto the window. Proving that
 * fixed means proving the panes composite to one colour at one alpha — which is
 * a different question from "do they cite the same token". Same token under a
 * different stacking context, a different inherited alpha, or with a private
 * overlay on top still paints two sheets, and a source comparison cannot see it.
 */
const GROUND_TARGETS = Object.freeze([
  ".app",
  ".titlebar",
  ".rail",
  ".stage",
  ".transcript",
  ".column",
  ".composer",
  ".inspector",
  ".body-grid",
  ".statusbar",
  /* Settings occupies the same grid cell as the stage and is the one surface
     inside the body grid that is SUPPOSED to paint its own ground — the owner
     ruling keeps it opaque so native material and the wallpaper cannot lower
     reading contrast. It is measured for that reason, not despite it: an
     opaque reading ground that quietly stopped being opaque would be the same
     class of defect as a pane that started painting one, and until now no gate
     reached this surface at all. It is absent from every Project surface, so
     adding it here leaves the existing pane assertions untouched. */
  ".settings",
]);

/**
 * The elements whose HORIZONTAL EXTENT is read, with no colour claim attached.
 *
 * `GROUND_TARGETS` cannot answer this. A ground target is obliged to paint
 * nothing of its own — that is the `F102` ground contract — and the composer's
 * own children paint themselves by design. Their width is nonetheless the open
 * half of `F102`: the reading column is capped and the input row is not, so on
 * a wide window a narrow band of prose sits on a much wider input.
 *
 * Reading a box costs nothing and asserts nothing. The verdict lives in the
 * test, as everywhere else here.
 */
const EXTENT_TARGETS = Object.freeze([
  ".body-grid",
  ".rail",
  ".stage",
  ".transcript",
  ".column",
  ".composer",
  ".target-bar",
  ".input-shell",
  ".composer-foot",
  ".controlbar",
  ".inspector",
  ".settings",
  ".settings-inner",
  ".titlebar",
  ".statusbar",
]);

/** The adjacent pane pairs whose meeting line the owner can actually see. */
const SEAM_PAIRS = Object.freeze([
  [".rail", ".stage"],
  [".stage", ".inspector"],
]);

/** The two horizontal meetings that decide whether chrome is the same sheet. */
const VERTICAL_SEAM_PAIRS = Object.freeze([
  [".titlebar", ".body-grid"],
  [".body-grid", ".statusbar"],
]);

/**
 * Points inside an element whose painted colour IS that element's own ground.
 *
 * The element does not have to be the topmost one. A pane is normally covered
 * edge to edge by layout wrappers that paint nothing at all, and requiring the
 * pane itself to be on top measured zero points on the rail — the pane the
 * owner named first. What actually matters is that nothing between the pane and
 * the eye contributes colour, so a point qualifies when every element stacked
 * above it is a descendant that paints no fill, no image, no shadow and no
 * border.
 *
 * Pseudo-elements never appear in a hit list, which is deliberate here: the CRT
 * tube overlay is an `::after`, it is part of what the eye sees, and excluding
 * its contribution would make the measurement agree with the stylesheet instead
 * of with the screen.
 */
function paintsNothing(node) {
  const style = getComputedStyle(node);
  return (
    style.backgroundImage === "none" &&
    style.boxShadow === "none" &&
    parseAlpha(style.backgroundColor) === 0 &&
    style.borderTopWidth === "0px" &&
    style.borderRightWidth === "0px" &&
    style.borderBottomWidth === "0px" &&
    style.borderLeftWidth === "0px"
  );
}

/** `rgba(r, g, b, a)` / `rgb(r g b / a)` — only the alpha is needed. */
function parseAlpha(color) {
  if (color === "transparent") return 0;
  const match = /^rgba?\(([^)]*)\)$/u.exec(color.trim());
  if (match === null) return 1;
  const parts = match[1].split(/[,/]/u).map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length < 4) return 1;
  const alpha = Number.parseFloat(parts[3]);
  return Number.isFinite(alpha) ? alpha : 1;
}

function freePointsWithin(element, rect, step) {
  const points = [];
  const inset = 6;
  const right = rect.left + rect.width - inset;
  const bottom = rect.top + rect.height - inset;
  for (let y = rect.top + inset; y <= bottom; y += step) {
    for (let x = rect.left + inset; x <= right; x += step) {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
      const hits = document.elementsFromPoint(x, y);
      const index = hits.indexOf(element);
      if (index === -1) continue;
      if (!hits.slice(0, index).every((node) => element.contains(node) && paintsNothing(node))) {
        continue;
      }
      points.push({ x: round(x), y: round(y) });
    }
  }
  return points;
}

function describeGrounds() {
  const grounds = [];
  for (const selector of GROUND_TARGETS) {
    const element = document.querySelector(selector);
    if (element === null) {
      grounds.push({ selector, present: false, signature: null, rect: null, points: [] });
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 16 || rect.height < 16) {
      grounds.push({ selector, present: true, signature: signatureOf(element), rect: boxOf(rect), points: [] });
      continue;
    }
    const style = getComputedStyle(element);
    grounds.push({
      selector,
      present: true,
      signature: signatureOf(element),
      /* Diagnostic only. The verdict is taken from painted pixels; this says
         which declaration a maintainer would have to edit. */
      declaredBackgroundColor: style.backgroundColor,
      declaredBackgroundImage: style.backgroundImage,
      declaredBackdropFilter: style.backdropFilter,
      declaredWebkitBackdropFilter: style.webkitBackdropFilter,
      rect: boxOf(rect),
      points: freePointsWithin(element, rect, 24),
    });
  }
  return grounds;
}

/**
 * The border box and the CONTENT box of each extent target.
 *
 * Both are needed and neither substitutes for the other. The border box is what
 * the eye sees as the edge of a control; the content box is where its text
 * actually starts and stops, which is what makes two stacked elements read as
 * aligned or not. `.column` has 28px of inline padding and `.composer` has
 * 16px, so a comparison of border boxes alone would report a 24px mismatch that
 * does not exist and miss the one that does.
 */
function describeExtents() {
  const extents = [];
  for (const selector of EXTENT_TARGETS) {
    const element = document.querySelector(selector);
    if (element === null) {
      extents.push({ selector, present: false, signature: null, rect: null, content: null, declaredMaxWidth: null });
      continue;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const leftInset =
      Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
    const rightInset =
      Number.parseFloat(style.borderRightWidth) + Number.parseFloat(style.paddingRight);
    extents.push({
      selector,
      present: true,
      signature: signatureOf(element),
      rect: boxOf(rect),
      content: {
        left: round(rect.left + leftInset),
        width: round(Math.max(0, rect.width - leftInset - rightInset)),
      },
      declaredMaxWidth: style.maxWidth,
    });
  }
  return extents;
}

/**
 * Interactive controls that an ancestor has clipped out of reach.
 *
 * Why this exists as its own observation rather than as more `extents`: an
 * extent is a named box compared against another named box, and a grid child
 * measured against its own grid can never be reported as overflowing, because
 * a stretched track child is bounded by the track by construction (w61 asserted
 * exactly that shape and was therefore green at every width). The thing a
 * person actually loses is a CONTROL, several levels below any named box, so
 * this walks controls upward to whatever clips them instead of walking
 * containers downward one level.
 *
 * "Out of reach" and "overflowing" are not the same, and the difference is the
 * whole point. Content that overflows a scroll container is still reachable —
 * the person scrolls. Content that overflows an `overflow: hidden` / `clip`
 * ancestor is gone, with no gesture that recovers it. So the search stops at
 * the FIRST ancestor that establishes either behaviour: scrollable means
 * reachable and nothing is reported; clipping means the hidden width is.
 *
 * Comparison is against the clipper's PADDING box, because that is the edge
 * `overflow` actually cuts at — a border-box comparison would under-report by
 * the border width and let a one-pixel loss through.
 *
 * This reports numbers only. Whether any loss at all is acceptable is the
 * consuming test's decision, per this file's contract.
 */
function describeClippedControls() {
  const clipped = [];
  const signatures = new Map();
  const controls = document.querySelectorAll(
    'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  for (const control of controls) {
    const style = getComputedStyle(control);
    if (style.display === "none" || style.visibility === "hidden") continue;
    /* A subtree the product has declared not-presented cannot be "lost": the
       Stage sets aria-hidden="true" on itself whenever Settings is the live
       surface (stage.tsx), and its controls are then covered on purpose.
       Honouring that declaration here — rather than letting each test carve
       the same case out by selector — keeps the exclusion in one place, tied
       to the product's own statement about what it is showing. Measured: with
       Settings open at 360px the covered composer reports a clipped button;
       on the Project surface at every width from 360 to 1280 it reports none. */
    if (control.closest('[aria-hidden="true"], [inert]') !== null) continue;
    const rect = control.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    let node = control.parentElement;
    while (node !== null) {
      const nodeStyle = getComputedStyle(node);
      const overflowX = nodeStyle.overflowX;
      const overflowY = nodeStyle.overflowY;
      if (overflowX === "auto" || overflowX === "scroll") break;
      if (overflowX === "hidden" || overflowX === "clip") {
        const box = node.getBoundingClientRect();
        const left =
          box.left + Number.parseFloat(nodeStyle.borderLeftWidth || "0");
        const right =
          box.right - Number.parseFloat(nodeStyle.borderRightWidth || "0");
        const hiddenLeft = Math.max(0, left - rect.left);
        const hiddenRight = Math.max(0, rect.right - right);
        const hidden = hiddenLeft + hiddenRight;
        if (hidden > 0.5) {
          clipped.push({
            signature: identify(control, signatures),
            label: (control.getAttribute("aria-label") ?? control.textContent ?? "")
              .trim()
              .slice(0, 60),
            clipper: signatureOf(node),
            clipperOverflowX: overflowX,
            clipperOverflowY: overflowY,
            /* Overflowing content EXISTS here — but this ancestor clips, so
               there is no gesture that brings it back. Named for what it is,
               not "scrollable", which would read as though it were reachable. */
            clipperHasOverflowContent: node.scrollWidth - node.clientWidth > 1,
            rect: boxOf(rect),
            clipperRect: boxOf(box),
            hiddenLeft: round(hiddenLeft),
            hiddenRight: round(hiddenRight),
            hiddenTotal: round(hidden),
            /* Nothing of the control remains inside the clipper. */
            fullyHidden: rect.left >= right || rect.right <= left,
          });
        }
        break;
      }
      node = node.parentElement;
    }
  }
  return clipped;
}

/**
 * Every element inside the conversation that DRAWS a vertical edge, and where.
 *
 * A width mismatch between two invisible boxes is arithmetic. A width mismatch
 * between two boxes that each paint a hairline, a fill or a rule is something
 * the eye is given directly — two rectangles of different widths sharing a
 * centreline, which is the literal description of a smaller sheet laid on a
 * larger one. This separates the two cases by measurement instead of leaving
 * the difference to be argued.
 *
 * `::before` / `::after` are included because the turn boundaries in this
 * product are drawn by pseudo-elements, and excluding them would report the
 * transcript as painting no edge at all when it visibly paints one per turn.
 */
function describePaintedEdges() {
  const edges = [];
  for (const scope of [".transcript", ".composer"]) {
    const root = document.querySelector(scope);
    if (root === null) continue;
    const seen = new Set();
    for (const element of [root, ...root.querySelectorAll("*")]) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 1) continue;
      for (const pseudo of [null, "::before", "::after"]) {
        const style = getComputedStyle(element, pseudo);
        if (pseudo !== null && style.content === "none") continue;
        const paints =
          parseAlpha(style.backgroundColor) > 0 ||
          style.backgroundImage !== "none" ||
          (style.borderLeftWidth !== "0px" && parseAlpha(style.borderLeftColor) > 0) ||
          (style.borderRightWidth !== "0px" && parseAlpha(style.borderRightColor) > 0) ||
          (style.borderTopWidth !== "0px" && parseAlpha(style.borderTopColor) > 0) ||
          (style.borderBottomWidth !== "0px" && parseAlpha(style.borderBottomColor) > 0);
        if (!paints) continue;
        /* A pseudo-element has no box of its own in the layout API. Its own
           extent is bounded by its originating element, which is the number
           this observation is about, so the originating box is reported and
           the pseudo is named so the reader knows which rule drew it. */
        const key = `${scope}|${signatureOf(element)}${pseudo ?? ""}|${round(rect.left)}|${round(rect.width)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          scope,
          signature: signatureOf(element) + (pseudo ?? ""),
          left: round(rect.left),
          right: round(rect.left + rect.width),
          width: round(rect.width),
        });
      }
    }
  }
  return edges;
}

/**
 * Pairs of points straddling each pane boundary at a matched y.
 *
 * This is the direct measurement of "no visible edge where the grounds meet".
 * Two panes can each be internally uniform and still meet at a step; sampling
 * across the boundary at the same height reads that step as a number. The 1px
 * structural hairline is skipped by starting at an offset, because a declared
 * border is a line the design asks for and not the seam being complained about.
 */
function describeSeams() {
  const seams = [];
  for (const [leftSelector, rightSelector] of SEAM_PAIRS) {
    const left = document.querySelector(leftSelector);
    const right = document.querySelector(rightSelector);
    if (left === null || right === null) continue;
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    const top = Math.max(leftRect.top, rightRect.top);
    const bottom = Math.min(leftRect.top + leftRect.height, rightRect.top + rightRect.height);
    if (bottom - top < 32) continue;

    const samples = [];
    for (const fraction of [0.3, 0.5, 0.7]) {
      const y = round(top + (bottom - top) * fraction);
      for (const offset of [4, 16]) {
        samples.push({
          y,
          offset,
          left: { x: round(leftRect.left + leftRect.width - offset), y },
          right: { x: round(rightRect.left + offset), y },
        });
      }
    }
    seams.push({
      leftSelector,
      rightSelector,
      boundaryX: round((leftRect.left + leftRect.width + rightRect.left) / 2),
      samples,
    });
  }
  return seams;
}

/**
 * Points immediately above and below the title/body and body/status meetings.
 * The declared 1px hairline is skipped by starting two pixels away from the
 * boundary. Sampling several x positions prevents one text run from deciding
 * the whole seam; glyph hits remain labelled and the test excludes them.
 */
function describeVerticalSeams() {
  const seams = [];
  for (const [topSelector, bottomSelector] of VERTICAL_SEAM_PAIRS) {
    const top = document.querySelector(topSelector);
    const bottom = document.querySelector(bottomSelector);
    if (top === null || bottom === null) continue;
    const topRect = top.getBoundingClientRect();
    const bottomRect = bottom.getBoundingClientRect();
    const left = Math.max(topRect.left, bottomRect.left);
    const right = Math.min(topRect.right, bottomRect.right);
    if (right - left < 24) continue;
    const samples = [];
    for (const fraction of [0.18, 0.5, 0.82]) {
      const x = round(left + (right - left) * fraction);
      for (const offset of [2, 4, 8]) {
        samples.push({
          x,
          offset,
          top: { x, y: round(topRect.bottom - offset) },
          bottom: { x, y: round(bottomRect.top + offset) },
        });
      }
    }
    seams.push({
      topSelector,
      bottomSelector,
      boundaryY: round((topRect.bottom + bottomRect.top) / 2),
      samples,
    });
  }
  return seams;
}

function boxOf(rect) {
  return {
    top: round(rect.top),
    left: round(rect.left),
    width: round(rect.width),
    height: round(rect.height),
  };
}

/**
 * A grid child that is out of flow, or that places itself explicitly, is not
 * evidence about auto-placement, so it is excluded from the row observation
 * rather than silently counted.
 */
function describeGrid(element, style, signatures) {
  const children = [];
  for (const child of element.children) {
    const childStyle = getComputedStyle(child);
    if (childStyle.display === "none") continue;
    if (childStyle.position === "absolute" || childStyle.position === "fixed") continue;
    const rect = child.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    children.push({
      signature: signatureOf(child),
      top: round(rect.top),
      left: round(rect.left),
      width: round(rect.width),
      height: round(rect.height),
      explicitlyPlaced:
        childStyle.gridRowStart !== "auto" || childStyle.gridColumnStart !== "auto",
    });
  }
  if (children.length === 0) return null;

  const rect = element.getBoundingClientRect();
  const rows = clusterRows(children);
  return {
    signature: identify(element, signatures),
    autoFlow: style.gridAutoFlow,
    templateColumns: style.gridTemplateColumns,
    templateRows: style.gridTemplateRows,
    declaredColumnTracks: trackCount(style.gridTemplateColumns),
    inFlowChildCount: children.length,
    autoPlacedChildCount: children.filter((child) => !child.explicitlyPlaced).length,
    renderedRowCount: rows.length,
    rows,
    rect: { top: round(rect.top), left: round(rect.left), width: round(rect.width), height: round(rect.height) },
    children,
  };
}

/**
 * Rows are recovered from painted geometry, not from a track name.
 *
 * Children of a single row rarely share a `top` — `align-items` centres a short
 * child against a tall one — so equal-top grouping reports phantom rows. Two
 * boxes are on the same row when they vertically overlap by at least half the
 * incoming box's height, which is true of any centred or stretched row and
 * false the moment one wraps past the last declared track.
 */
function clusterRows(children) {
  const rows = [];
  for (const child of [...children].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const bottom = child.top + child.height;
    const row = rows.find(
      (candidate) =>
        Math.min(candidate.bottom, bottom) - Math.max(candidate.top, child.top) >=
        0.5 * child.height,
    );
    if (row === undefined) {
      rows.push({ top: child.top, bottom: round(bottom), members: [child.signature] });
      continue;
    }
    row.top = Math.min(row.top, child.top);
    row.bottom = round(Math.max(row.bottom, bottom));
    row.members.push(child.signature);
  }
  return rows;
}

/**
 * Only elements that own their text are measured. A wrapper inherits its
 * child's strings and would otherwise be reported as a second, phantom site
 * with the wrapper's own (often irrelevant) colour.
 */
function describeText(element, style, signatures) {
  const ownText = [...element.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== "");
  if (ownText.length === 0) return null;
  if (style.visibility === "hidden" || style.display === "none") return null;

  const opacityChain = [];
  for (let node = element; node !== null; node = node.parentElement) {
    const value = Number.parseFloat(getComputedStyle(node).opacity);
    if (Number.isFinite(value) && value < 1) {
      opacityChain.push({ signature: signatureOf(node), opacity: value });
    }
  }
  const inheritedOpacity = opacityChain.reduce((total, entry) => total * entry.opacity, 1);
  if (inheritedOpacity === 0) return null;

  /* Layout position is not painted position. A string inside a scrolled pane
     still reports a client rect, and reading pixels there would sample whatever
     the clipping ancestor drew instead — a background belonging to some other
     element, attributed to this one. Only the region that survives every
     clipping ancestor and the viewport is a place this string exists. */
  const clip = visibleClip(element);
  if (clip === null) return null;

  const boxes = [];
  for (const node of ownText) {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      const visible = intersect(rect, clip);
      if (visible === null || visible.width < 1 || visible.height < 1) continue;
      boxes.push(visible);
    }
  }
  if (boxes.length === 0) return null;

  element.setAttribute("data-uaw-measured", "text");
  return {
    signature: identify(element, signatures),
    region: element.closest(".titlebar") !== null
      ? "titlebar"
      : element.closest(".statusbar") !== null
        ? "statusbar"
        : null,
    surfaceAncestor: surfaceAncestorOf(element),
    ariaHiddenAncestors: ariaHiddenAncestorsOf(element),
    occludedBy: occluderOf(element, boxes),
    text: ownText.map((node) => node.textContent.trim()).join(" ").slice(0, 80),
    color: style.color,
    fontSizePx: Number.parseFloat(style.fontSize),
    fontWeight: style.fontWeight,
    textShadow: style.textShadow === "none" ? null : style.textShadow,
    textStrokeColor: style.webkitTextStrokeColor,
    textStrokeWidthPx: Number.parseFloat(style.webkitTextStrokeWidth),
    inheritedOpacity: round(inheritedOpacity),
    opacityChain,
    /* The token a maintainer has to edit. Resolved values alone say a colour is
       wrong without saying where it came from. */
    colorSource: authoredColorSource(element),
    boxes,
  };
}

function surfaceAncestorOf(element) {
  const ancestor = element.closest("main.stage, aside.inspector");
  return ancestor === null ? null : signatureOf(ancestor);
}

/**
 * Explicit semantic hiding, nearest ancestor first. This records all matching
 * ancestors because a visible decorative glyph may hide itself from assistive
 * technology while also living inside a dormant surface root. The test, not
 * this observational pass, decides which ancestor owns the paint obligation.
 */
function ariaHiddenAncestorsOf(element) {
  const ancestors = [];
  for (let node = element; node !== null; node = node.parentElement) {
    if (node.getAttribute("aria-hidden") === "true") {
      ancestors.push(signatureOf(node));
    }
  }
  return ancestors;
}

/**
 * What, if anything, is stacked above this string at the middle of its first
 * box. Hit testing ignores `pointer-events: none`, so this deliberately walks
 * the whole hit list rather than trusting `elementFromPoint` alone — the CRT
 * overlays are all `pointer-events: none` and they are exactly the layers that
 * can bury a string.
 */
function occluderOf(element, boxes) {
  const box = boxes[0];
  if (box === undefined) return null;
  const hits = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const index = hits.indexOf(element);
  const above = index === -1 ? hits : hits.slice(0, index);
  for (const candidate of above) {
    if (candidate.contains(element)) continue;
    return signatureOf(candidate);
  }
  return null;
}

/**
 * The region an element can actually be painted in: the viewport, narrowed by
 * every ancestor that clips. Returns null when nothing of it is on screen.
 */
function visibleClip(element) {
  let clip = { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    const clips =
      style.overflowX !== "visible" ||
      style.overflowY !== "visible" ||
      style.contain.includes("paint");
    if (!clips) continue;
    clip = intersect(node.getBoundingClientRect(), clip);
    if (clip === null) return null;
  }
  return clip;
}

function intersect(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return {
    top: round(top),
    left: round(left),
    width: round(right - left),
    height: round(bottom - top),
  };
}

/**
 * Walks the author's own rules to recover which custom property produced this
 * element's colour. Purely diagnostic: nothing is asserted on it.
 */
function authoredColorSource(element) {
  let best = null;
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of flattenRules(rules)) {
      const declared = rule.style?.getPropertyValue("color");
      if (declared === undefined || declared === "") continue;
      let matches = false;
      try {
        matches = element.matches(rule.selectorText);
      } catch {
        continue;
      }
      if (matches) best = declared.trim();
    }
  }
  return best;
}

function flattenRules(rules) {
  const flat = [];
  for (const rule of rules) {
    if (rule.selectorText !== undefined) flat.push(rule);
    if (rule.cssRules !== undefined) flat.push(...flattenRules(rule.cssRules));
  }
  return flat;
}

/**
 * `grid-template-columns` computes to the used track list, so counting tokens
 * counts real tracks. `[name]` line names are not tracks and are dropped.
 */
function trackCount(computed) {
  if (computed === "none" || computed === "") return 0;
  return computed
    .split(/\s+/u)
    .filter((token) => token !== "" && !token.startsWith("["))
    .length;
}

function signatureOf(element) {
  const classes = [...element.classList]
    .filter((name) => !name.startsWith("uaw-"))
    .sort()
    .join(".");
  return element.tagName.toLowerCase() + (classes === "" ? "" : "." + classes);
}

/** Same-signature elements are numbered so two sites never collapse into one. */
function identify(element, signatures) {
  const signature = signatureOf(element);
  const ordinal = (signatures.get(signature) ?? 0) + 1;
  signatures.set(signature, ordinal);
  return ordinal === 1 ? signature : signature + "#" + ordinal;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
