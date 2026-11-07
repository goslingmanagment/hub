import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx.js";

/**
 * Something folded until asked for: «Как это считается» (where a number comes
 * from), «Подробнее» (technical details), a slow block. A real <details>: the
 * browser keeps it accessible and it opens with the keyboard.
 */
export function Disclosure({ summary, hint, children, defaultOpen, open, onOpenChange, size = "sm", className }: {
  summary: ReactNode;
  /** Quiet words after the summary: «3 смены». */
  hint?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controlled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** `sm`: 14 px grey (help, details); `md`: 15 px, a folded block of a screen. */
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <details
      className={cx("ui-disclosure", size === "md" && "ui-disclosure--md", className)}
      open={open ?? defaultOpen}
      onToggle={onOpenChange ? (event) => onOpenChange((event.currentTarget as HTMLDetailsElement).open) : undefined}
    >
      <summary>
        <ChevronRight size={16} strokeWidth={2} aria-hidden className="ui-disclosure__chevron" />
        {summary}
        {hint !== undefined && <span className="ui-disclosure__hint">{hint}</span>}
      </summary>
      <div className="ui-disclosure__body">{children}</div>
    </details>
  );
}
