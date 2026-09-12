import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

export function ModalShell({
  children,
  title,
  onClose,
  closeLabel = "Close",
  restoreFocusRef,
}: {
  children: ReactNode;
  title: string;
  onClose: () => void;
  closeLabel?: string;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
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
  }, [onClose]);

  // Focus the first interactive element on open and restore focus to whatever was focused
  // (the trigger) on close, so keyboard users are moved into the dialog and back out again.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusable = dialogRef.current?.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
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
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-6"
      // Parent space-y utilities must not leave an uncovered strip behind the dialog.
      style={{ margin: 0 }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[calc(100dvh-3rem)] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-bold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-8 shrink-0 text-sm text-text-muted hover:text-text-primary"
          >
            {closeLabel}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
