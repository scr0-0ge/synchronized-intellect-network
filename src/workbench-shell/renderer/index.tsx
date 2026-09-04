import "./styles.css";
import "./themes/theme-acrylic.css";
import "./themes/theme-crt.css";
import "./themes/theme-schemes.css";
import "./themes/theme-legibility.css";

import { mountWorkbench } from "./mount.tsx";

/* `material=on` says main.ts chose to PRESENT Windows acrylic. It does not say
   Windows applied it: `shouldPresentWindowsAcrylic` is `state !== "unavailable"`,
   so an `undetermined` DWM probe presents acrylic too. Signalling "on" there
   suppressed the skin's own fallback backdrop, and the panes then sat translucent
   over the desktop wallpaper with no designed ground under the text — measured at
   3.0:1 in light tone, and indistinguishable from a design choice.
   "unverified" matches the fallback gate `:not([data-material="on"])`, so the
   fallback ground paints; the full-glass rules are gated on skin and glass level
   only, so the panes stay translucent — over a known ground instead of a
   wallpaper. `applied` is unaffected and still reads "on". */
const startupParameters = new URLSearchParams(window.location.search);
if (startupParameters.get("material") === "on") {
  document.documentElement.dataset.material =
    startupParameters.get("material-state") === "undetermined"
      ? "unverified"
      : "on";
}
if (window.location.search.length > 0) {
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.hash}`,
  );
}

const root = document.querySelector<HTMLElement>("#root");
if (root !== null) {
  mountWorkbench(root, window.workbench, window.workbenchWindow);
}
