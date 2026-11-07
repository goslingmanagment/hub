import { X } from "lucide-react";
import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button.js";
import { isModalOpen, useFocusScope } from "./focus.js";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** A quiet line under the title: the context («alex.k · 7 нояб., 09:12–16:40»). */
  subtitle?: ReactNode;
  /** Bottom bar: one primary action and «Закрыть». */
  footer?: ReactNode;
  /** 560 by default; 720 for long evidence. */
  width?: number;
  /** Right of the title, before the cross: a menu. */
  actions?: ReactNode;
  children: ReactNode;
  closeLabel?: string;
}

/**
 * A side panel on the right, full height, over the page without dimming it: to
 * look at one record without losing the list (evidence of a message, a person's
 * links and devices). Escape and the cross close it; a window opened from it
 * gets Escape first. Put its state in the address where it can be shared.
 */
export function Drawer({ open, onClose, title, subtitle, footer, width = 560, actions, children, closeLabel = "Закрыть" }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusScope(ref, open, { trap: false });

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented && !isModalOpen()) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="ui-drawer"
      style={{ "--ui-drawer-width": `${width}px` } as CSSProperties}
    >
      <header className="ui-drawer__head">
        <div className="ui-drawer__titles">
          <h2 id={titleId} className="ui-drawer__title">{title}</h2>
          {subtitle !== undefined && <p className="ui-drawer__subtitle">{subtitle}</p>}
        </div>
        {actions}
        <IconButton icon={X} label={closeLabel} onClick={onClose} />
      </header>
      <div className="ui-drawer__body">{children}</div>
      {footer !== undefined && <footer className="ui-drawer__foot">{footer}</footer>}
    </div>,
    document.body,
  );
}
