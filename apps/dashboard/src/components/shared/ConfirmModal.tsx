import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/Skeleton";
import { ModalShell } from "./ModalShell.js";

export interface ConfirmFact {
  /** «Куда», «Что именно», «Когда», «Кто увидит», «Сколько стоит», «Отменить», «Было → стало». */
  label: string;
  value: ReactNode;
}

/**
 * The question before something paid, public, irreversible, affecting a payout
 * or reaching a person: a verb and its object in the title, what will happen in
 * a sentence, the facts in a list, the same verb on the button. One press, one
 * request: the button waits for the answer and nothing repeats by itself.
 */
export function ConfirmModal({
  title,
  message,
  facts,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Отмена",
  closeLabel = "Закрыть",
  tone = "danger",
  isPending,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  facts?: readonly ConfirmFact[];
  confirmLabel: string;
  /** The verb in progress: «Утверждаем…». */
  pendingLabel?: string;
  cancelLabel?: string;
  closeLabel?: string;
  tone?: "danger" | "primary";
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ModalShell title={title} onClose={onClose} closeLabel={closeLabel} size="confirm">
      <p className="dialog-text">{message}</p>
      {facts && facts.length > 0 && (
        <dl className="confirm-facts">
          {facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="dialog-actions">
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
          {isPending && <Spinner />}
          {isPending && pendingLabel ? pendingLabel : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
