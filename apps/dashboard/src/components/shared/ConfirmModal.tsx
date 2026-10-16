import { ModalShell } from "./ModalShell.js";

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Удалить",
  cancelLabel = "Отмена",
  closeLabel = "Закрыть",
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
      <p className="text-sm leading-relaxed text-text-secondary">{message}</p>
      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="btn"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={onConfirm}
          className={`btn ${tone === "primary" ? "btn-primary" : "btn-danger"}`}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
