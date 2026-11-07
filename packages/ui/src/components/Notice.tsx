import { CircleAlert, CircleCheck, Info, Power, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx.js";

export type NoticeTone = "info" | "warning" | "danger" | "off" | "success";

const ICONS = { info: Info, warning: TriangleAlert, danger: CircleAlert, off: Power, success: CircleCheck } as const;

/**
 * One sentence that matters over a screen or a list: what is known, what is
 * stale, what is switched off, what broke and the one button to fix it. At most
 * two per screen; text in the main colour, never small and faded.
 */
export function Notice({ tone = "info", title, children, action, role, className }: {
  tone?: NoticeTone;
  /** The sentence in 500 weight; `children` below it in 14 px. Or only `children`. */
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: "alert" | "status";
  className?: string;
}) {
  const Icon = ICONS[tone];
  return (
    <div role={role} className={cx("ui-notice", tone !== "info" && `ui-notice--${tone}`, className)}>
      <Icon size={18} strokeWidth={1.75} aria-hidden className="ui-notice__icon" />
      <div className="ui-notice__body">
        {title !== undefined && <div className="ui-notice__title">{title}</div>}
        {children !== undefined && (title !== undefined ? <div className="ui-notice__text">{children}</div> : <div>{children}</div>)}
      </div>
      {action !== undefined && <div className="ui-notice__action">{action}</div>}
    </div>
  );
}
