import { X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton } from "./Button.js";
import { cx } from "./cx.js";
import { Disclosure } from "./Disclosure.js";
import { useFocusScope } from "./focus.js";
import { Notice } from "./Notice.js";

export interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  /** `confirm` 480 (a question), `form` 560 (up to three fields), `wide` 800. */
  size?: "confirm" | "form" | "wide";
  /** A window holding something that cannot be got back (a one-time link): only its button closes it. */
  explicitCloseOnly?: boolean;
  /** The buttons, right-aligned: «Отмена» and the action. */
  actions?: ReactNode;
  children?: ReactNode;
  closeLabel?: string;
  className?: string;
}

/**
 * A window over a dimmed page: a question or a short form. Focus starts inside
 * (`data-autofocus` names where), Tab stays inside, Escape and a click on the
 * dimmed page close it, unless `explicitCloseOnly`. The title and the buttons
 * stay in place; only the middle scrolls when the window is taller than the
 * screen, so the buttons are always in sight. Long editing is never a window:
 * that is a page.
 */
export function Modal({ title, onClose, size = "form", explicitCloseOnly = false, actions, children, closeLabel = "Закрыть", className }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusScope(ref, true);
  // The middle scrolls: a hairline then parts it from the buttons.
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const check = () => setScrolls(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!explicitCloseOnly) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [explicitCloseOnly, onClose]);

  return createPortal(
    <div className="ui-modal-backdrop" onMouseDown={(event) => {
      if (!explicitCloseOnly && event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx("ui-modal", size === "confirm" && "ui-modal--confirm", size === "wide" && "ui-modal--wide", scrolls && "ui-modal--scrolls", className)}
      >
        <header className="ui-modal__head">
          <h2 id={titleId} className="ui-modal__title">{title}</h2>
          {!explicitCloseOnly && <IconButton icon={X} label={closeLabel} size="sm" onClick={onClose} />}
        </header>
        <div ref={body} className="ui-modal__body">{children}</div>
        {actions !== undefined && <div className="ui-modal__actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmFact {
  /** «Куда», «Что именно», «Когда», «Кто увидит», «Сколько стоит», «Отменить», «Было → стало». */
  label: string;
  value: ReactNode;
}

export interface ConfirmProps {
  /** A question with a verb and its object: «Снять доступ к mia-1?» */
  title: string;
  /** What will happen, in one sentence. */
  message: ReactNode;
  /** Only the facts needed; «Куда» always comes from the record itself, never from a filter. */
  facts?: readonly ConfirmFact[];
  /** Folded under the facts: «Подробнее». */
  details?: ReactNode;
  /** The same verb as the question: «Снять доступ». */
  confirmLabel: string;
  /** The verb in progress: «Снимаем…». */
  pendingLabel?: string;
  cancelLabel?: string;
  /** `danger` (default) for removing and the irreversible; `primary` for the paid and the public. */
  tone?: "danger" | "primary";
  /** Hub's refusal in the screen's words: shown inside, with one button left. */
  error?: ReactNode;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * The question before a write that removes, cannot be undone, costs money,
 * affects a payout or reaches a person. The focus starts on «Отмена». One press
 * is one request: the button waits, the window cannot be closed under it, and
 * nothing is repeated by itself. After an error it shows the error and closes.
 */
export function Confirm({
  title,
  message,
  facts,
  details,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Отмена",
  tone = "danger",
  error,
  isPending,
  onConfirm,
  onClose,
}: ConfirmProps) {
  const close = () => {
    if (!isPending) onClose();
  };
  return (
    <Modal
      title={title}
      onClose={close}
      size="confirm"
      actions={error ? (
        <Button data-autofocus onClick={close}>Закрыть</Button>
      ) : (
        <>
          <Button data-autofocus disabled={isPending} onClick={close}>{cancelLabel}</Button>
          <Button variant={tone === "primary" ? "primary" : "danger"} loading={isPending} onClick={onConfirm}>
            {isPending && pendingLabel ? pendingLabel : confirmLabel}
          </Button>
        </>
      )}
    >
      <p className="ui-modal__text">{message}</p>
      {facts && facts.length > 0 && (
        <dl className="ui-confirm-facts">
          {facts.map((fact) => (
            <div key={fact.label} style={{ display: "contents" }}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {details !== undefined && <Disclosure summary="Подробнее">{details}</Disclosure>}
      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    </Modal>
  );
}
