import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

export function ModalShell({
  children,
  title,
  onClose,
  closeLabel = "Закрыть",
  restoreFocusRef,
  // A dialog holding something the person cannot get back — a
  // one-time link shown once — refuses the casual dismissals. Escape and a
  // stray backdrop click stop closing it; only the explicit close button does.
  explicitCloseOnly = false,
  wide = false,
  size,
}: {
  children: ReactNode;
  title: string;
  onClose: () => void;
  closeLabel?: string;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  explicitCloseOnly?: boolean;
  /** Room for charts side by side. */
  wide?: boolean;
  /** `confirm`: the narrow window of a question (480). `short`: a form of a few
   *  fields or a window of settings (560). */
  size?: "confirm" | "short";
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (!explicitCloseOnly) onClose(); return; }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      const elements = [...(dialog?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter(element => element.getClientRects().length > 0);
      const first = elements[0]; const last = elements.at(-1);
      if (!first || !last) { e.preventDefault(); dialog?.focus(); return; }
      if (!dialog?.contains(document.activeElement) || (!e.shiftKey && document.activeElement === last)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, explicitCloseOnly]);

  // Focus the first interactive element on open and restore focus to whatever was focused
  // (the trigger) on close, so keyboard users are moved into the dialog and back out again.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // A dialog may name where the focus starts: «Отмена» when nothing can be undone.
    // Else the first field; else the first control under the title, not its cross.
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelector<HTMLElement>("[data-autofocus]")
      ?? dialog?.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])')
      ?? dialog?.querySelector<HTMLElement>(':scope > :not(.dialog-head) :is(a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]))')
      ?? dialog?.querySelector<HTMLElement>("button:not([disabled])");
    focusable?.focus();
    return () => {
      const target = previouslyFocused?.isConnected && previouslyFocused.getClientRects().length > 0
        ? previouslyFocused
        : restoreFocusRef?.current;
      target?.focus();
    };
  }, [restoreFocusRef]);

  return (
    <div
      className="dialog-backdrop"
      // Parent space-y utilities must not leave an uncovered strip behind the dialog.
      style={{ margin: 0 }}
      onClick={explicitCloseOnly ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        className={`dialog ${size === "confirm" ? "dialog-confirm" : size === "short" ? "dialog-short" : wide ? "dialog-wide" : "dialog-form"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          {/* The same cross as a panel's; the words of the choice stand at the bottom. */}
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
            className="btn btn-ghost btn-icon btn-sm shrink-0"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
