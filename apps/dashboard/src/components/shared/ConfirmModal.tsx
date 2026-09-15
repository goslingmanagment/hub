import { ModalShell } from "./ModalShell.js";

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  closeLabel = "Close",
  tone = "danger",
  isPending,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  closeLabel?: string;
  tone?: "danger" | "primary";
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ModalShell title={title} onClose={onClose} closeLabel={closeLabel}>
      <p className="text-sm text-text-secondary">{message}</p>
      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-secondary hover:bg-hover"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={onConfirm}
          className={`rounded-lg ${tone === "primary" ? "bg-accent" : "bg-danger"} px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50`}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
