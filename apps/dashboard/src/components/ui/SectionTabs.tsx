import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import { Menu } from "@agency_hub_core/ui/components/Menu";

export interface SectionTabItem {
  to: string;
  label: string;
  /** Extra path prefixes that also mark this tab current. */
  match?: readonly string[];
}

/** A row of sibling screens that read as one section. Links, not buttons: each
 *  tab keeps its URL. `sub` is the quieter second row inside a tab. */
export function SectionTabs({ items, label, sub = false, current: currentTo, end, more = [] }: {
  items: readonly SectionTabItem[];
  label: string;
  sub?: boolean;
  /** The current item's `to`, when the row knows better than the address. */
  current?: string | undefined;
  /** At the row's far end: the section's places in another product. */
  end?: ReactNode;
  /** Under «Ещё» at the row's end; while one of them is open the button bears its name. */
  more?: readonly SectionTabItem[];
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentRef = useRef<HTMLAnchorElement>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const all = [...items, ...more];
  const current = currentTo !== undefined
    ? all.find((item) => item.to === currentTo)
    : all.find((item) => isCurrent(item, location.pathname, location.search));
  const currentMore = current !== undefined && more.includes(current) ? current : undefined;

  // On a narrow window the current tab must not sit out of sight.
  useEffect(() => {
    (currentRef.current ?? moreRef.current)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current?.to]);

  if (all.length < 2) return null;
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
      {more.length > 0 && (
        <Menu
          label="Ещё"
          align="start"
          items={more.map((item) => ({ label: item.label, checked: item === currentMore, onSelect: () => navigate(item.to) }))}
          renderTrigger={({ ref, ...trigger }) => (
            <button
              ref={(element) => {
                ref(element);
                moreRef.current = currentMore ? element : null;
              }}
              type="button"
              className={sub ? "section-subtab" : "section-tab"}
              aria-current={currentMore ? "page" : undefined}
              {...trigger}
            >
              {currentMore?.label ?? "Ещё"}
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          )}
        />
      )}
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
