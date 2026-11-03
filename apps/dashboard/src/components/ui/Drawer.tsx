import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * A panel on the right: look at a record without losing the list. No dimming;
 * its address is in the URL, so a link opens it and Back closes it. A
 * confirmation never lives here, it is always a dialog.
 */
export function Drawer({ title, onClose, children }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);

  return (
    <aside ref={panel} className="drawer" tabIndex={-1} aria-label={typeof title === "string" ? title : undefined}>
      <div className="drawer-head">
        <h2 className="drawer-title">{title}</h2>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Закрыть" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}
