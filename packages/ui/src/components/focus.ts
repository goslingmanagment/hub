import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
}

/**
 * Where the focus starts in a box that opens:
 * - `auto` (default): `[data-autofocus]`, else the first field, else the box;
 * - `box`: the box itself (a panel of ticks, where a stray Space must not tick anything);
 * - an element of one's own (a ref).
 */
export type InitialFocus = "auto" | "box" | RefObject<HTMLElement | null>;

/**
 * While open: the focus starts inside (see `InitialFocus`), Tab goes round
 * inside when `trap`, and on close the focus returns to whatever had it before
 * (the button that opened the box).
 */
export function useFocusScope(ref: RefObject<HTMLElement | null>, open: boolean, options: { trap?: boolean; initial?: InitialFocus } = {}) {
  const { trap = true, initial = "auto" } = options;
  const initialRef = useRef(initial);
  initialRef.current = initial;

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const choice = initialRef.current;
    const start = choice === "box"
      ? root
      : typeof choice === "object"
        ? choice.current ?? root
        : root?.querySelector<HTMLElement>("[data-autofocus]")
          ?? root?.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])')
          ?? root;
    start?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected && before.getClientRects().length > 0) before.focus({ preventScroll: true });
    };
  }, [open, ref]);

  useEffect(() => {
    if (!open || !trap) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const root = ref.current;
      if (!root) return;
      const items = focusables(root);
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        root.focus();
        return;
      }
      const active = document.activeElement;
      if (!root.contains(active) || (!event.shiftKey && active === last)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, ref, trap]);
}

/** Whether a window (Modal, Confirm) is open over the page: a panel's Escape waits for it. */
export function isModalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}
