import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean | undefined;
  danger?: boolean | undefined;
  title?: string | undefined;
}

/** The secondary actions of a list row behind one "⋯" button, so a row shows
 *  its one main action and not a wall of equal-weight buttons. */
export function RowMenu({ label, items }: { label: string; items: readonly RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative inline-flex">
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
      {open && (
        <div id={menuId} role="menu" className="absolute right-0 top-full z-20 mt-1 min-w-[200px] rounded-xl border border-border bg-card p-1.5 shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45 ${item.danger ? "text-danger" : "text-text-primary"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
