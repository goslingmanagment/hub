import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean | undefined;
  danger?: boolean | undefined;
  title?: string | undefined;
}

const MENU_WIDTH = 220;
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
    const up = rect.bottom + GAP + height > window.innerHeight && rect.top - GAP - height > 0;
    setPlace({
      top: up ? rect.top - GAP - height : rect.bottom + GAP,
      left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
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
          className="fixed z-40 rounded-xl border border-border bg-card p-1.5 shadow-lg"
          style={{
            width: MENU_WIDTH,
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
              className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45 ${item.danger ? "text-danger" : "text-text-primary"}`}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
