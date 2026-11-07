import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.js";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  /** One sentence under the title, 14 px. */
  description?: ReactNode;
  /** Right of the title: a legend, one button or a menu. */
  actions?: ReactNode;
  /** A quiet line under the content: a count, a pager. */
  footer?: ReactNode;
  /** `none`: the content touches the edges (a table inside). */
  padding?: "none" | "md";
  /** The heading level of the title. */
  as?: "h2" | "h3";
}

/**
 * A sheet: what is read together (a table, a chart, a form). White on the warm
 * ground, a hairline, 12 px corners, no shadow. Never a card inside a card.
 */
export function Card({ title, description, actions, footer, padding = "md", as: Heading = "h2", className, children, ...rest }: CardProps) {
  const head = title !== undefined || actions !== undefined;
  return (
    <section className={cx("ui-card", className)} {...rest}>
      {head && (
        <header className="ui-card__head">
          <div style={{ minWidth: 0 }}>
            {title !== undefined && <Heading className="ui-card__title">{title}</Heading>}
            {description !== undefined && <p className="ui-card__desc">{description}</p>}
          </div>
          {actions !== undefined && <div className="ui-card__actions">{actions}</div>}
        </header>
      )}
      <div className={cx("ui-card__body", padding === "none" && "ui-card__body--flush")}>{children}</div>
      {footer !== undefined && <footer className="ui-card__foot">{footer}</footer>}
    </section>
  );
}

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  as?: "h2" | "h3";
}

/** A titled block of a screen without a frame: «Неделя», «Журнал смен». 20 px title. */
export function Section({ title, description, actions, as: Heading = "h2", className, children, ...rest }: SectionProps) {
  return (
    <section className={cx("ui-section", className)} {...rest}>
      <header className="ui-section__head">
        <div style={{ minWidth: 0 }}>
          <Heading className="ui-section__title">{title}</Heading>
          {description !== undefined && <p className="ui-section__desc">{description}</p>}
        </div>
        {actions !== undefined && <div className="ui-section__actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
