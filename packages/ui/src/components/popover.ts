import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

const GAP = 6;
const EDGE = 8;

/**
 * Where a floating box (a menu, a tooltip, the period's own-range form) stands
 * next to its anchor: below it, or above when there is no room below; its start
 * or end edge lined up with the anchor's; kept inside the window. Fixed
 * position, so a table's or a card's clipping never cuts it.
 */
export function useAnchoredPosition(
  anchor: RefObject<HTMLElement | null>,
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
    setStyle({ top, left, visibility: "visible", maxHeight: below ? window.innerHeight - top - EDGE : a.top - GAP - EDGE });
  }, [align, anchor, floating, side]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

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
