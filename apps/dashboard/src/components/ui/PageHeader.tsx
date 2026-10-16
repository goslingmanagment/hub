import type { ReactNode } from "react";

/** The one header every screen opens with: a title, at most one sentence of
 *  what the screen is for, and the screen's own actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  titleId,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleId?: string;
}) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1 id={titleId} className="page-title">{title}</h1>
        {description && <p className="page-subtitle">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
