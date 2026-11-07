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
export function Notice({ tone = "info", title, children, action, actionPlacement = "end", role, className }: {
  tone?: NoticeTone;
  /** The sentence in 500 weight; `children` below it in 14 px. Or only `children`. */
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /** `end` (default): the button on the right. `below`: under the words — in a narrow panel, so the words keep the width. */
  actionPlacement?: "end" | "below";
  role?: "alert" | "status";
  className?: string;
}) {
  const Icon = ICONS[tone];
  const below = actionPlacement === "below";
  return (
    <div role={role} className={cx("ui-notice", tone !== "info" && `ui-notice--${tone}`, below && "ui-notice--action-below", className)}>
      <Icon size={18} strokeWidth={1.75} aria-hidden className="ui-notice__icon" />
      <div className="ui-notice__body">
        {title !== undefined && <div className="ui-notice__title">{title}</div>}
        {children !== undefined && (title !== undefined ? <div className="ui-notice__text">{children}</div> : <div>{children}</div>)}
        {below && action !== undefined && <div className="ui-notice__action ui-notice__action--below">{action}</div>}
      </div>
      {!below && action !== undefined && <div className="ui-notice__action">{action}</div>}
    </div>
  );
}
