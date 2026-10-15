import { Link, useLocation } from "react-router";

export interface SectionTabItem {
  to: string;
  label: string;
  /** Extra path prefixes that also mark this tab current. */
  match?: readonly string[];
  count?: number | undefined;
}

/** A row of sibling screens that read as one section (OnlyFans, Costs,
 *  System, a page's own views). Links, not buttons: each tab keeps its URL. */
export function SectionTabs({ items, label }: { items: readonly SectionTabItem[]; label: string }) {
  const location = useLocation();
  if (items.length < 2) return null;
  const current = items.find((item) => isCurrent(item, location.pathname, location.search));
  return (
    <nav aria-label={label} className="section-tabs">
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          aria-current={item === current ? "page" : undefined}
          className="section-tab"
        >
          {item.label}
          {item.count != null && <span className="section-tab-count">{item.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

function isCurrent(item: SectionTabItem, pathname: string, search: string): boolean {
  const [path, query] = item.to.split("?");
  if (item.match?.some((prefix) => pathname.startsWith(prefix))) return true;
  if (path !== pathname) return false;
  if (!query) return true;
  const want = new URLSearchParams(query);
  const have = new URLSearchParams(search);
  return [...want.entries()].every(([key, value]) => have.get(key) === value);
}
