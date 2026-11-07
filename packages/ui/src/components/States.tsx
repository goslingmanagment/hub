import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button, type IconComponent } from "./Button.js";
import { cx } from "./cx.js";

/**
 * Nothing to show, said honestly: what is empty, why, what next — «За эту
 * неделю смен нет», «Последняя смена была 24 окт.», one button at most.
 */
export function EmptyState({ title, children, action, icon: Icon, compact = false, align = "center", className }: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: IconComponent;
  /** Inside a card or a table: less air. */
  compact?: boolean;
  align?: "center" | "left";
  className?: string;
}) {
  return (
    <div className={cx("ui-state", compact && "ui-state--compact", align === "left" && "ui-state--left", className)}>
      {Icon && <Icon size={24} strokeWidth={1.5} aria-hidden className="ui-state__icon" />}
      <p className="ui-state__title">{title}</p>
      {children !== undefined && <p className="ui-state__text">{children}</p>}
      {action !== undefined && <div className="ui-state__action">{action}</div>}
    </div>
  );
}

/**
 * Hub did not answer. Not a zero: the numbers may exist, the screen did not get
 * them. Always with «Повторить» when a retry is possible.
 */
export function ErrorState({
  title = "Hub не ответил",
  children = "Числа не пришли. Это не ноль: данные могут быть, просто экран их не получил.",
  onRetry,
  retrying = false,
  compact = false,
  className,
}: {
  title?: ReactNode;
  children?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div role="alert" className={cx("ui-state", compact && "ui-state--compact", className)}>
      <p className="ui-state__title">{title}</p>
      <p className="ui-state__text">{children}</p>
      {onRetry && (
        <div className="ui-state__action">
          <Button size="sm" icon={RotateCw} loading={retrying} onClick={onRetry}>{retrying ? "Повторяем…" : "Повторить"}</Button>
        </div>
      )}
    </div>
  );
}
