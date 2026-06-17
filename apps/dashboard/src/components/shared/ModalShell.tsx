import { useEffect, useId, useRef, type ReactNode } from "react";

export function ModalShell({
  children,
  title,
  onClose,
}: {
  children: ReactNode;
  title: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
    return () => previouslyFocused?.focus?.();
  }, []);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-6"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-2xl rounded-2xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-bold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-text-muted hover:text-text-primary"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
