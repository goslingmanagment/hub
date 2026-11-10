/**
 * On and off, in effect at once. The caller waits for the answer: `checked` is
 * what the hub said, so the knob moves only after it and comes back on an error.
 * What affects money, publications or AI answers asks first (ConfirmModal).
 */
export function Switch({ checked, onChange, label, disabled = false, title }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean | undefined;
  title?: string | undefined;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
    />
  );
}

