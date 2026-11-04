import { useEffect } from "react";

/**
 * Brings an anchor into view and keeps it there while the content above it loads:
 * an old link to `#authors` must land on it, not above it. A person's first touch
 * of the page takes over.
 */
export function useScrollToAnchor(id: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const scroll = () => document.getElementById(id)?.scrollIntoView({ block: "start" });
    scroll();
    const observer = new ResizeObserver(scroll);
    observer.observe(document.body);
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, stop);
    };
    const timer = window.setTimeout(stop, 4_000);
    for (const name of events) window.addEventListener(name, stop, { passive: true });
    return stop;
  }, [active, id]);
}
