import { ChevronDown } from "lucide-react";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
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

/** A tick with its words; `hint` is a quiet second line. */
export function Checkbox({ checked, onChange, label, hint, disabled = false, name, className }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  name?: string;
  className?: string;
}) {
  return (
    <label className={cx("ui-check", disabled && "ui-check--disabled", className)}>
      <input type="checkbox" name={name} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        {hint !== undefined && <span className="ui-check__hint">{hint}</span>}
      </span>
    </label>
  );
}
