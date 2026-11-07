import type { ReactNode } from "react";
import { cx } from "./cx.js";
import { Tooltip } from "./Tooltip.js";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** A quiet number after the words: how many rows this filter shows. */
  count?: number | undefined;
  disabled?: boolean;
  /** Said on hover and focus (the app's Tooltip, not the browser's): what this filter shows, why it is off. */
  hint?: ReactNode;
  /** The same as `hint` (kept for old calls). */
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
      {options.map((option) => {
        const button = (
          <button
            key={option.value}
            type="button"
            className="ui-seg__item"
            aria-pressed={option.value === value}
            disabled={option.disabled}
            onClick={() => {
              if (option.value !== value || reselect?.includes(option.value)) onChange(option.value);
            }}
          >
            {option.label}
            {option.count !== undefined && <span className="ui-seg__count">{option.count.toLocaleString("ru-RU")}</span>}
          </button>
        );
        const tip = option.hint ?? option.title;
        return tip === undefined || tip === null || tip === "" ? button : <Tooltip key={option.value} content={tip} side="bottom">{button}</Tooltip>;
      })}
    </div>
  );
}
