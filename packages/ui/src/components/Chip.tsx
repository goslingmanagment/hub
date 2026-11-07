import { X } from "lucide-react";
import type { MouseEventHandler, ReactNode } from "react";
import { cx } from "./cx.js";
import type { IconComponent } from "./Button.js";

export interface ChipProps {
  children: ReactNode;
  /** A filter that is on: ink ground, so a forgotten filter cannot pass unseen. */
  selected?: boolean;
  /** `sm` 28 px (a page in a row), `md` 36 px (a filter in a header). */
  size?: "sm" | "md";
  icon?: IconComponent;
  /** The chip is a button. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** A cross at the end: «Показать все страницы». */
  onRemove?: () => void;
  removeLabel?: string;
  /** Extra end content (a chevron). */
  end?: ReactNode;
  title?: string;
  className?: string;
  "aria-haspopup"?: "menu" | "dialog" | "listbox";
  "aria-expanded"?: boolean;
}

/** A page, a filter, a tag. Static text by default; a button with `onClick`. */
export function Chip({ children, selected = false, size = "sm", icon: Icon, onClick, onRemove, removeLabel = "Убрать", end, title, className, ...aria }: ChipProps) {
  const classes = cx("ui-chip", size === "md" && "ui-chip--md", selected && "ui-chip--selected", className);
  const content = (
    <>
      {Icon && <Icon size={size === "md" ? 16 : 14} strokeWidth={1.75} aria-hidden />}
      <span className="ui-chip__text">{children}</span>
      {end}
    </>
  );
  if (onRemove) {
    // Two controls side by side: the chip itself (when it opens something) and its cross.
    return (
      <span className={classes} title={title}>
        {onClick ? (
          <button type="button" onClick={onClick} className="ui-chip__main" {...aria}>
            {content}
          </button>
        ) : content}
        <button type="button" className="ui-chip__remove" aria-label={removeLabel} title={removeLabel} onClick={onRemove}>
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </span>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick} title={title} {...aria}>
        {content}
      </button>
    );
  }
  return <span className={classes} title={title}>{content}</span>;
}
