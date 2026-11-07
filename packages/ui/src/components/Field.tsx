import { Check, ChevronDown, Minus } from "lucide-react";
import { forwardRef, useEffect, useId, useRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cx } from "./cx.js";

/** A label above a control, a hint and an error below it. The control gets the label's id. */
export function Field({ label, hint, error, children, className }: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Render prop: gets the id to put on the control and the ids that describe it. */
  children: (control: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint !== undefined ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("ui-field", className)}>
      <label htmlFor={id} className="ui-field__label">{label}</label>
      {children({ id, ...(describedBy ? { "aria-describedby": describedBy } : {}), ...(error ? { "aria-invalid": true as const } : {}) })}
      {hint !== undefined && <p id={hintId} className="ui-field__hint">{hint}</p>}
      {error ? <p id={errorId} className="ui-field__error" role="alert">{error}</p> : null}
    </div>
  );
}

/** A one-line text field, 36 px. */
export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, type = "text", ...rest }, ref) {
  return <input ref={ref} type={type} className={cx("ui-input", className)} {...rest} />;
});

/** A native list, styled: for 3–20 values. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <span className="ui-select-wrap">
      <select ref={ref} className={cx("ui-select", className)} {...rest}>{children}</select>
      <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
    </span>
  );
});

/**
 * A text of several lines (a reason, a note), 16 px for reading what one
 * writes. `rows` lines high (3), grows by hand downward. Give it the Field's
 * `{...control}` like a TextInput.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 3, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} className={cx("ui-input ui-textarea", className)} {...rest} />;
});

/**
 * A tick with its words; `hint` is a quiet second line. One look everywhere
 * (a list of pages, a matrix cell, a form): an 18 px box, ink when ticked, a
 * dash when `indeterminate` (some of a model's pages, not all). Without
 * `label` it is a bare box: give `aria-label` then.
 */
export function Checkbox({ checked, onChange, label, hint, disabled = false, indeterminate = false, name, className, "aria-label": ariaLabel, id }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  /** Some, not all: a dash in the box. A press then ticks all (`onChange(true)`). */
  indeterminate?: boolean;
  name?: string;
  className?: string;
  "aria-label"?: string;
  id?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [checked, indeterminate]);
  const box = (
    <span className="ui-check__control">
      <input
        ref={ref}
        type="checkbox"
        className="ui-check__box"
        name={name}
        id={id}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-checked={indeterminate && !checked ? "mixed" : undefined}
        onChange={(event) => onChange(indeterminate && !checked ? true : event.target.checked)}
      />
      <Check size={14} strokeWidth={2.5} aria-hidden className="ui-check__tick" />
      <Minus size={14} strokeWidth={2.5} aria-hidden className="ui-check__dash" />
    </span>
  );
  if (label === undefined && hint === undefined) {
    return <span className={cx("ui-check ui-check--bare", disabled && "ui-check--disabled", className)}>{box}</span>;
  }
  return (
    <label className={cx("ui-check", disabled && "ui-check--disabled", className)}>
      {box}
      <span>
        {label}
        {hint !== undefined && <span className="ui-check__hint">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * On or off, written at once (an approach in the extension): a 36 × 20 track.
 * The words say what is on («В расширении»); `pending` while the request
 * runs — the switch waits and cannot be pressed twice. The request and any
 * question before it are the caller's.
 */
export function Switch({ checked, onChange, label, hint, disabled = false, pending = false, labelHidden = false, className, title }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** What is on when it is on. Always needed — shown, or only for a screen reader with `labelHidden`. */
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  pending?: boolean;
  /** Only the track is seen (in a table row whose words already say what it is). */
  labelHidden?: boolean;
  className?: string;
  title?: string;
}) {
  const id = useId();
  const off = disabled || pending;
  return (
    <span className={cx("ui-switch", off && "ui-switch--disabled", pending && "ui-switch--pending", className)} title={title}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-busy={pending || undefined}
        disabled={off}
        className="ui-switch__track"
        onClick={() => onChange(!checked)}
        {...(labelHidden && typeof label === "string" ? { "aria-label": label } : {})}
      >
        <span className="ui-switch__thumb" aria-hidden />
      </button>
      {labelHidden ? (typeof label === "string" ? null : <span className="ui-sr-only">{label}</span>) : (
        <label htmlFor={id} className="ui-switch__label">
          {label}
          {hint !== undefined && <span className="ui-check__hint">{hint}</span>}
        </label>
      )}
    </span>
  );
}
