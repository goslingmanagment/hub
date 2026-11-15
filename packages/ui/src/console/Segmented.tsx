export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** A number, or the number already written for the eye («1 420»). */
  count?: number | string | undefined;
  disabled?: boolean | undefined;
  title?: string | undefined;
}

/** A filter of one list, or the period: 2–5 values that exclude each other and
 *  are all worth seeing. Sections are tabs; on and off is a switch. */
export function Segmented<T extends string>({ options, value, onChange, label, className = "" }: {
  options: readonly SegmentOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={`segmented ${className}`.trim()} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segment"
          aria-pressed={value === option.value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count != null && <span className="segment-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}
