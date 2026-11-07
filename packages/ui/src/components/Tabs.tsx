import type { ReactNode } from "react";
import { NavLink, type To } from "react-router";
import { cx } from "./cx.js";

export interface TabItem {
  to: To;
  label: ReactNode;
  /** Only a queue's size, equal to the rows inside. */
  count?: number | undefined;
  /** Current only on this exact address, not below it. */
  end?: boolean;
}

/**
 * Sections of one screen, each with its own address (links, not buttons). The
 * current one is the text's colour with a 2 px ink line under it.
 */
export function Tabs({ items, label, className }: { items: readonly TabItem[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={cx("ui-tabs", className)}>
      {items.map((item, index) => (
        <NavLink key={index} to={item.to} end={item.end} className="ui-tab">
          {item.label}
          {item.count !== undefined && item.count > 0 && <span className="ui-tab__count">{item.count.toLocaleString("ru-RU")}</span>}
        </NavLink>
      ))}
    </nav>
  );
}
