import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, Power, TriangleAlert, type LucideIcon } from "lucide-react";

export type NoticeTone = "info" | "warning" | "danger" | "off" | "success";

const ICONS: Readonly<Record<NoticeTone, LucideIcon>> = {
  info: Info,
  warning: TriangleAlert,
  danger: CircleAlert,
  off: Power,
  success: CircleCheck,
};

const CLASSES: Readonly<Record<NoticeTone, string>> = {
  info: "notice notice-info",
  warning: "notice notice-warning",
  danger: "notice notice-danger",
  off: "notice notice-off",
  success: "notice notice-success",
};

/**
 * One sentence that matters, under the header. `off` is what the owner switched
 * off on purpose: grey, never an alarm. Text in the main colour, a second line
 * under it, one button on the right.
 */
export function Notice({ tone = "info", children, detail, action, className = "", role }: {
  tone?: NoticeTone;
  children: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
  role?: "status" | "alert";
}) {
  const Icon = ICONS[tone];
  return (
    <div className={`${CLASSES[tone]} ${className}`.trim()} role={role}>
      <Icon size={18} aria-hidden="true" />
      <div className="notice-body">
        {children}
        {detail && <small>{detail}</small>}
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}
