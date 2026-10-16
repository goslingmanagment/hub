import type { ReactNode } from "react";

/** The heading of a System screen under /dev: the System layout already
 *  shows «Система» and its navigation, so the screen opens with a section
 *  heading and one line of what it is — the same as a Settings tab. */
export function DevHeader({ title, description, actions }: {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="section-title">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm text-text-secondary">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
