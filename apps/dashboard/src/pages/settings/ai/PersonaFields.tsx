import { useEffect, type ReactNode } from "react";
import { useBlocker } from "react-router";
import { Field } from "@/components/shared/Field";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { formatCount } from "@/lib/format";

export const SYSTEM_BLOCK_MAX = 50_000;
export const DISPLAY_NAME_MAX = 120;
/** The same rule the hub checks a new persona's key against. */
export const PERSONA_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/**
 * The name and the instruction of a persona: the whole page is the editor
 * (a long text never lives in a window). `between` stands between them: the new
 * persona's key, which used to be easy to miss under the big text.
 */
export function PersonaFields({
  displayName,
  systemBlock,
  onDisplayNameChange,
  onSystemBlockChange,
  readOnly = false,
  touched = false,
  between,
}: {
  displayName: string;
  systemBlock: string;
  onDisplayNameChange: (value: string) => void;
  onSystemBlockChange: (value: string) => void;
  readOnly?: boolean;
  /** Errors are shown only after the person has typed or tried to save. */
  touched?: boolean;
  between?: ReactNode;
}) {
  const nameError = touched && !displayName.trim() ? "Нужно название." : undefined;
  const textError = touched && !/\S/.test(systemBlock) ? "Инструкция не может быть пустой." : undefined;
  return (
    <div className="persona-form">
      <Field label="Название" hint="Его видят чаттеры, когда выбирают персону." error={nameError}>
        <input
          value={displayName}
          maxLength={DISPLAY_NAME_MAX}
          readOnly={readOnly}
          aria-invalid={nameError !== undefined}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          placeholder="например, Мия: нежная и игривая"
          className="input"
        />
      </Field>
      {between}
      <div>
        <label htmlFor="persona-system-block" className="field-label">Инструкция для ИИ</label>
        <textarea
          id="persona-system-block"
          value={systemBlock}
          maxLength={SYSTEM_BLOCK_MAX}
          readOnly={readOnly}
          aria-invalid={textError !== undefined}
          onChange={(event) => onSystemBlockChange(event.target.value)}
          placeholder="Кто она, как пишет, о чём говорит и чего избегает…"
          className="textarea persona-textarea"
        />
        <div className="persona-counter">
          <span>Характер, манера речи и ограничения персоны.</span>
          <span className="tabular-nums">{formatCount(systemBlock.length)} из {formatCount(SYSTEM_BLOCK_MAX)} знаков</span>
        </div>
        {textError && <p className="field-error" role="alert">{textError}</p>}
      </div>
    </div>
  );
}

/**
 * Leaving with unsaved edits asks first: another address through the router (⌘K
 * goes through it too), and closing or reloading the tab through the browser.
 * A change of `?tab=` on the same page is not leaving: the draft lives above it.
 */
export function useLeaveGuard(dirty: boolean, name: string): ReactNode {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (blocker.state !== "blocked") return null;
  return (
    <ConfirmModal
      title="Уйти без сохранения?"
      message={`Правки персоны «${name}» не сохранены. Если уйти, они пропадут.`}
      cancelLabel="Остаться"
      confirmLabel="Уйти без сохранения"
      tone="danger"
      initialFocus="cancel"
      isPending={false}
      onConfirm={() => blocker.proceed()}
      onClose={() => blocker.reset()}
    />
  );
}
