import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

const GAP = 6;
const EDGE = 8;

/**
 * What a floating box stands next to: an element, or only a place on the
 * screen (a mark on a chart, a cell of a grid drawn without its own element).
 */
export interface AnchorLike {
  getBoundingClientRect(): DOMRect | { top: number; right: number; bottom: number; left: number; width: number; height: number };
}

/** A place on the screen (window coordinates), as a tooltip's anchor: a point or a box. */
export interface ScreenRect {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** A place on the screen as an anchor for `useAnchoredPosition`. */
export function rectAnchor(rect: ScreenRect | DOMRect): AnchorLike {
  const width = rect.width ?? 0;
  const height = rect.height ?? 0;
  return {
    getBoundingClientRect: () => ({ top: rect.y, left: rect.x, right: rect.x + width, bottom: rect.y + height, width, height }),
  };
}

/**
 * Where a floating box (a menu, a tooltip, the period's own-range form) stands
 * next to its anchor: below it, or above when there is no room below; its start
 * or end edge lined up with the anchor's; kept inside the window. Fixed
 * position, so a table's or a card's clipping never cuts it. The place is
 * found again when the box changes its size (a menu that grows from
 * «Загружаем…» to its list), when the window resizes and on any scroll.
 */
export function useAnchoredPosition(
  anchor: RefObject<AnchorLike | null>,
  floating: RefObject<HTMLElement | null>,
  open: boolean,
  options: { align?: "start" | "end" | "center"; side?: "bottom" | "top" } = {},
): CSSProperties {
  const { align = "start", side = "bottom" } = options;
  const [style, setStyle] = useState<CSSProperties>({ top: -9999, left: -9999, visibility: "hidden" });

  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    const box = floating.current;
    if (!a || !box) return;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const roomBelow = window.innerHeight - a.bottom - GAP - EDGE;
    const roomAbove = a.top - GAP - EDGE;
    const below = side === "bottom" ? roomBelow >= height || roomBelow >= roomAbove : !(roomAbove >= height || roomAbove >= roomBelow);
    const top = below ? a.bottom + GAP : Math.max(EDGE, a.top - GAP - height);
    let left = align === "end" ? a.right - width : align === "center" ? a.left + a.width / 2 - width / 2 : a.left;
    left = Math.min(Math.max(EDGE, left), window.innerWidth - width - EDGE);
    const maxHeight = below ? window.innerHeight - top - EDGE : a.top - GAP - EDGE;
    setStyle((current) => (
      current.top === top && current.left === left && current.maxHeight === maxHeight && current.visibility === "visible"
        ? current
        : { top, left, visibility: "visible", maxHeight }
    ));
  }, [align, anchor, floating, side]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    // The box itself grows or shrinks (its content loaded, a line wrapped): stand again.
    const box = floating.current;
    const observer = box && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => place()) : null;
    if (box) observer?.observe(box);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [floating, open, place]);

  return style;
}

/** Closes a floating box on a press outside it and its anchor, and on Escape (focus back to the anchor). */
export function useDismiss(
  open: boolean,
  close: () => void,
  refs: readonly RefObject<HTMLElement | null>[],
  anchor?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      const target = event.target as Node;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      close();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
      anchor?.current?.focus();
    }
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, close, open, refs]);
}
