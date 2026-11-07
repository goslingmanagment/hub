import type { MouseEvent, ReactNode } from "react";
import { useHref, useLocation, useNavigate } from "react-router";

/**
 * A table whose rows open another screen (the shared `Table` with `rowHref`)
 * and whose «←» there must come back here with the filters: the shared row link
 * carries no router state, so a plain press on a row is taken here and followed
 * with `{ back }` (the same state `ShiftLink` leaves). ⌘-click, the middle
 * button and «open in a new tab» stay the table's own: a new tab has no history
 * to go back to anyway.
 *
 * Remove once `Table` takes `rowState` (asked for in the report).
 */
export function RowBackState({ label, children }: { label: string; children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const base = useHref("/").replace(/\/$/, "");

  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target as Element;
    const row = target.closest("tbody tr");
    const link = row?.querySelector<HTMLAnchorElement>("a.ui-table__rowlink");
    if (!row || !link) return;
    // Another control inside the row keeps its own job; so does a selection of text.
    const control = target.closest("a, button, input, select, textarea, label, [role='button']");
    if (control && control !== link) return;
    if (window.getSelection()?.toString()) return;
    const href = link.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    event.stopPropagation();
    const to = base && href.startsWith(base) ? href.slice(base.length) || "/" : href;
    navigate(to, { state: { back: { to: `${location.pathname}${location.search}`, label } } });
  };

  return <div onClickCapture={onClickCapture}>{children}</div>;
}
