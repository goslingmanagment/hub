import type { ReactNode } from "react";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
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
 * request: the button waits for the answer, the window cannot be closed under it
 * and nothing repeats by itself. After an error it only shows the error and closes.
 */
export function ConfirmModal({
  title,
  message,
  facts,
  details,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Отмена",
  closeLabel = "Закрыть",
  tone = "danger",
  initialFocus = "first",
  error,
  isPending,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  facts?: readonly ConfirmFact[];
  /** Under the facts, folded: «Подробнее». */
  details?: ReactNode;
  confirmLabel: string;
  /** The verb in progress: «Утверждаем…». */
  pendingLabel?: string;
  cancelLabel?: string;
  closeLabel?: string;
  tone?: "danger" | "primary";
  /** `cancel`: the focus starts on the way out, when what follows cannot be undone. */
  initialFocus?: "first" | "cancel";
  /** The hub's refusal, in the screen's words: inside the window, with one button left. */
  error?: ReactNode;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const close = () => {
    if (!isPending) onClose();
  };
  return (
    <ModalShell title={title} onClose={close} closeLabel={closeLabel} size="confirm">
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
      {details && <Disclosure label="Подробнее">{details}</Disclosure>}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
      <div className="dialog-actions">
        {error ? (
          <button type="button" onClick={close} className="btn" data-autofocus>
            {closeLabel}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={close}
              disabled={isPending}
              className="btn"
              data-autofocus={initialFocus === "cancel" ? true : undefined}
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
          </>
        )}
      </div>
    </ModalShell>
  );
}
