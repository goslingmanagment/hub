import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** A floating box's margin from the window's edges, and its gap from its anchor. */
const MARGIN = 8;
const GAP = 6;

type Side = "below" | "above";

/** Whether the anchor is seen in the area that scrolls it (the list, the rail): out of it, or under the head, it is not. */
function anchorInView(anchor: Element): boolean {
  const area = anchor.closest(".main, .rail-b") ?? document.documentElement;
  const at = anchor.getBoundingClientRect();
  const view = area.getBoundingClientRect();
  return at.bottom > view.top && at.top < view.bottom && at.width > 0;
}

/** The side a box opens to: the preferred one when it fits there, else the one with more room. Chosen once, at open. */
function sideFor(box: HTMLElement, anchor: Element, prefer: Side): Side {
  const at = anchor.getBoundingClientRect();
  const below = document.documentElement.clientHeight - at.bottom - GAP - MARGIN;
  const above = at.top - GAP - MARGIN;
  const tall = box.offsetHeight;
  if (prefer === "below") return below >= tall || below >= above ? "below" : "above";
  return above >= tall || above >= below ? "above" : "below";
}

/** Put a box (`position: fixed`) on its side of the anchor, its right edge at the anchor's, inside the window. */
function placeBy(box: HTMLElement, anchor: Element, side: Side): void {
  const at = anchor.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  const room = side === "below" ? height - at.bottom - GAP - MARGIN : at.top - GAP - MARGIN;
  box.style.maxHeight = `${Math.max(120, room)}px`;
  const tall = box.offsetHeight;
  const top = side === "below" ? at.bottom + GAP : at.top - GAP - tall;
  box.style.top = `${Math.round(Math.max(MARGIN, Math.min(top, height - MARGIN - tall)))}px`;
  box.style.left = `${Math.round(Math.max(MARGIN, Math.min(at.right - box.offsetWidth, width - MARGIN - box.offsetWidth)))}px`;
}

/**
 * A floating box by its anchor: its side chosen once when it opens (a footer that grows on hover never flips it), then
 * it follows the anchor on scroll, on resize and when it changes its own size; an anchor scrolled out of its area (or
 * under the head) closes it (`lost`). `packages/ui`'s `useAnchoredPosition` decides the side again on every move, so
 * the «чья» menu with its growing footer would flip under the pointer; outside presses and Esc are `useDismiss`'s.
 */
export function useFloating(box: RefObject<HTMLElement | null>, anchorOf: () => Element | null, prefer: Side, lost: () => void): void {
  const side = useRef<Side | null>(null);
  const place = useCallback(() => {
    const element = box.current;
    const anchor = anchorOf();
    if (!element) return;
    if (anchor === null || !anchorInView(anchor)) {
      lost();
      return;
    }
    side.current ??= sideFor(element, anchor, prefer);
    placeBy(element, anchor, side.current);
  }, [box, anchorOf, prefer, lost]);
  useLayoutEffect(() => {
    place();
  }, [place]);
  useEffect(() => {
    document.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place);
    const element = box.current;
    const observer = element && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => place()) : null;
    if (element) observer?.observe(element);
    return () => {
      document.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [box, place]);
}
