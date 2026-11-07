import type { ReactNode } from "react";
import { cx } from "./cx.js";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** A quiet number after the words: how many rows this filter shows. */
  count?: number | undefined;
  disabled?: boolean;
  /** Said on hover: why it is off, what it means. */
  title?: string;
}

/**
 * Two to five values of one filter of this list, all visible. Not for sections
 * (that is Tabs) and not for on/off. The picked one is raised on the track.
 */
export function Segmented<V extends string>({ options, value, onChange, label, size = "md", reselect, className }: {
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Values that answer a press even when already picked (they open something). */
  reselect?: readonly V[];
  /** What the group chooses, for a screen reader: «Какие чаты». */
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cx("ui-seg", size === "sm" && "ui-seg--sm", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="ui-seg__item"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => {
            if (option.value !== value || reselect?.includes(option.value)) onChange(option.value);
          }}
        >
          {option.label}
          {option.count !== undefined && <span className="ui-seg__count">{option.count.toLocaleString("ru-RU")}</span>}
        </button>
      ))}
    </div>
  );
}
