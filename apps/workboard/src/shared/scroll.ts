import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router";

/**
 * Where the page stood (spec r3, D16): «←» of a deep screen returns to the same
 * place of the screen it came from, not to its top. The shell remembers the
 * window's scroll of every address of this tab as the owner scrolls
 * (`pathname + search`, the very `to` of a back target); «←» (`BackLink`) asks
 * for it back with `state.restoreScroll`. A new screen opens at its top; the
 * browser's own Back and Forward keep doing what the browser does.
 */

/** The window's scroll of each address of this tab, the last time it was there. */
const positions = new Map<string, number>();
/** The address the scroll events belong to: set in the commit that shows it. */
let current = "";

/** The scroll remembered for an address (`/shifts?week=2026-11-02`), 0 when none. */
export function rememberedScroll(address: string): number {
  return positions.get(address) ?? 0;
}

/**
 * Scrolls to `y` as soon as the page is tall enough: the screen may still be
 * growing (a list from the cache, a frame leaving the full-window mode). Gives
 * up after 3 s or the moment the owner scrolls, presses a key or clicks.
 */
function scrollBackTo(y: number): () => void {
  let frame = 0;
  let stopped = false;
  const deadline = performance.now() + 3000;
  const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    for (const name of events) window.removeEventListener(name, stop);
  };
  for (const name of events) window.addEventListener(name, stop, { passive: true });
  const tick = () => {
    if (stopped) return;
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) <= 2 || performance.now() > deadline) stop();
    else frame = requestAnimationFrame(tick);
  };
  tick();
  return stop;
}

/** The shell's half (once, in Shell): remembers, restores on «←», opens a new screen at its top. */
export function useScrollMemory(): void {
  const location = useLocation();
  const navigation = useNavigationType();
  const address = `${location.pathname}${location.search}`;
  const shownPath = useRef<string | null>(null);

  useLayoutEffect(() => {
    current = address;
  }, [address]);

  useEffect(() => {
    const onScroll = () => {
      positions.set(current, window.scrollY);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const before = shownPath.current;
    shownPath.current = location.pathname;
    if (before === null || navigation === "POP") return undefined;
    const wanted = (location.state as { restoreScroll?: unknown } | null)?.restoreScroll === true;
    if (wanted) {
      const y = positions.get(address) ?? 0;
      return y > 0 ? scrollBackTo(y) : undefined;
    }
    // Another screen (not the same one with other filters, not a jump to a section): its top.
    if (location.pathname !== before && location.hash === "") window.scrollTo(0, 0);
    return undefined;
    // Once per navigation: the key changes with every one, the address alone would miss a «←» to the same place.
  }, [location.key]);
}
