import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean | undefined;
  danger?: boolean | undefined;
  title?: string | undefined;
  /** A second line in the item itself: why it is off. Not hidden in a tooltip. */
  hint?: string | undefined;
}

/** As wide as its longest item, between these: an item stays on one line. */
const MENU_MIN_WIDTH = 220;
const MENU_MAX_WIDTH = 360;
const GAP = 4;

/** The secondary actions of a list row behind one "⋯" button, so a row shows
 *  its one main action and not a wall of equal-weight buttons. The menu is
 *  drawn over the page (a portal), so a table's scroll box cannot clip it;
 *  near the bottom of the window it opens upwards. */
export function RowMenu({ label, items }: { label: string; items: readonly RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? items.length * 40 + 12;
    const width = menu.current?.offsetWidth ?? MENU_MIN_WIDTH;
    const up = rect.bottom + GAP + height > window.innerHeight && rect.top - GAP - height > 0;
    setPlace({
      top: up ? rect.top - GAP - height : rect.bottom + GAP,
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    }
    // The menu is pinned to where the button was; any scroll or resize closes it.
    const close = () => setOpen(false);
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (open && place) menu.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [open, place]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && createPortal(
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          className="menu fixed z-20"
          style={{
            minWidth: MENU_MIN_WIDTH,
            maxWidth: `min(${MENU_MAX_WIDTH}px, calc(100vw - 16px))`,
            width: "max-content",
            top: place?.top ?? -9999,
            left: place?.left ?? -9999,
            visibility: place ? "visible" : "hidden",
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                setOpen(false);
                button.current?.focus();
                item.onSelect();
              }}
              className={`menu-item ${item.danger ? "menu-item-danger" : ""}`}
            >
              {item.hint ? (
                <span className="min-w-0">
                  {item.label}
                  <span className="menu-item-hint">{item.hint}</span>
                </span>
              ) : item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
