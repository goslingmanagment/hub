import { useEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "react-router";

export interface SectionTabItem {
  to: string;
  label: string;
  /** Extra path prefixes that also mark this tab current. */
  match?: readonly string[];
}

/** A row of sibling screens that read as one section. Links, not buttons: each
 *  tab keeps its URL. `sub` is the quieter second row inside a tab. */
export function SectionTabs({ items, label, sub = false, current: currentTo, end }: {
  items: readonly SectionTabItem[];
  label: string;
  sub?: boolean;
  /** The current item's `to`, when the row knows better than the address. */
  current?: string | undefined;
  /** At the row's far end: the section's places in another product. */
  end?: ReactNode;
}) {
  const location = useLocation();
  const currentRef = useRef<HTMLAnchorElement>(null);
  const current = currentTo !== undefined
    ? items.find((item) => item.to === currentTo)
    : items.find((item) => isCurrent(item, location.pathname, location.search));

  // On a narrow window the current tab must not sit out of sight.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current?.to]);

  if (items.length < 2) return null;
  return (
    <nav aria-label={label} className={sub ? "section-subnav" : "section-tabs"}>
      {items.map((item) => (
        <Link
          key={item.to}
          ref={item === current ? currentRef : undefined}
          to={item.to}
          aria-current={item === current ? "page" : undefined}
          className={sub ? "section-subtab" : "section-tab"}
        >
          {item.label}
        </Link>
      ))}
      {end}
    </nav>
  );
}

function isCurrent(item: SectionTabItem, pathname: string, search: string): boolean {
  const [path = "", query] = item.to.split("?");
  if (item.match?.some((prefix) => pathname.startsWith(prefix))) return true;
  if (path !== pathname) return false;
  if (!query) return true;
  const want = new URLSearchParams(query);
  const have = new URLSearchParams(search);
  return [...want.entries()].every(([key, value]) => have.get(key) === value);
}
