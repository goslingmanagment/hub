import { useEffect } from "react";

const ATTRIBUTE = "data-ui-full-window";
let holders = 0;

/**
 * A working screen that fills the window (a shift's review): while it is
 * shown, `<html data-ui-full-window>` is set — the page itself does not
 * scroll, the app's frame is exactly the window's height and the screen's
 * panes scroll inside. The app's shell styles the frame by that attribute;
 * narrow windows (≤ 1100 px) scroll as usual.
 */
export function useFullWindow(active = true) {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    holders += 1;
    document.documentElement.setAttribute(ATTRIBUTE, "");
    return () => {
      holders = Math.max(0, holders - 1);
      if (holders === 0) document.documentElement.removeAttribute(ATTRIBUTE);
    };
  }, [active]);
}
