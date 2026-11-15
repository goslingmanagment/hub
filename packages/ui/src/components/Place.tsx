import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import {
  Banknote,
  CalendarClock,
  ChartColumn,
  ChevronsUpDown,
  ClipboardList,
  Flag,
  Heart,
  House,
  Inbox,
  LogOut,
  Megaphone,
  Menu as Burger,
  Monitor,
  Moon,
  Newspaper,
  Package,
  Search,
  Settings,
  Smartphone,
  Sun,
  TrendingUp,
  Users,
  Wallet,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { CountBadge } from "./Badge.js";
import { Kbd } from "./Kbd.js";
import { Menu, type MenuEntry } from "./Menu.js";
import { useFocusScope } from "./focus.js";
import { PALETTE_ARIA_SHORTCUT, PALETTE_SHORTCUT, isPaletteShortcut } from "../paletteShortcut.js";
import { roleWord, type MenuCountView, type ProductLink } from "../place.js";
import { NAME_MENU_ACCOUNT, type MenuCount, type MenuIcon, type MenuItem, type ScreenApp } from "../screens.js";
import { THEME_OPTIONS, useThemeStore, type ThemePreference } from "../theme.js";

/**
 * A product's frame (products plan §2.1): one sidebar for Hub and for Workboard,
 * the same component with the product's own name, accent (tokens.css,
 * `[data-product]`) and menu — the brand line that opens the products' switcher
 * when the person has more than one, the search field, the product's menu of
 * screens.ts, the account at the foot. An item of the app drawing it is a router
 * link; an item of the other product is a page load to its own name.
 * Below 768 px the sidebar is a drawer behind ☰ in a strip over the screen.
 */

const ICONS: Readonly<Record<MenuIcon, LucideIcon>> = {
  House,
  Inbox,
  Wallet,
  Heart,
  ChartColumn,
  Newspaper,
  Megaphone,
  ClipboardList,
  CalendarClock,
  Users,
  TrendingUp,
  Banknote,
  Package,
  Flag,
  Settings,
  Wrench,
};

const THEME_ICON: Readonly<Record<ThemePreference, LucideIcon>> = { system: Monitor, light: Sun, dark: Moon };

/** What the app drawing the frame says about itself. */
export interface PlaceHere {
  /** The app: its own items are router links. */
  app: ScreenApp;
  /** Its router's basename on the host: "" for the console, "/workboard" for Workboard. */
  basename: string;
}

export interface PlaceAccount {
  name: string;
  role: string | null;
  signOut: () => void;
  signingOut?: boolean;
  /** The server did not confirm the sign-out: said under the account, never a silent stay. */
  signOutFailed?: boolean;
  /** «Аккаунт и устройства» (Workboard's `/workboard/account`): devices, password, the person's AI spend. */
  onAccount?: () => void;
}

export interface PlaceSidebarProps {
  here: PlaceHere;
  /** The brand line: the product's name (place.ts `productName`). */
  brand: string;
  /** The product's home, an address of this app (place.ts `productHome`). */
  home: string;
  /** The products' switcher under the brand line (place.ts `productLinks`); empty: the brand is a link home. */
  products: readonly ProductLink[];
  /** The search field and ⌘K (absent: true). A chatter's two items need none. */
  search?: boolean;
  menu: { upper: readonly MenuItem[]; lower: readonly MenuItem[] };
  /** The item the address lights (screens.ts `menuItemAt`). */
  current: string | null;
  /** An item's address with what it carries (place.ts `carriedHref` for the other app's items). */
  hrefOf: (item: MenuItem) => string;
  counts: Partial<Record<MenuCount, MenuCountView | null>>;
  account: PlaceAccount;
}

/** A link of the frame: to an address of the app drawing it a router link, to the other app a page load. */
function PlaceLink({ here, app, href, className, current, label, children }: {
  here: PlaceHere;
  /** The app at `href`. */
  app: ScreenApp;
  href: string;
  className: string;
  current?: boolean;
  label?: string;
  children: ReactNode;
}) {
  const aria = { "aria-current": current ? ("page" as const) : undefined, "aria-label": label };
  if (app === here.app) {
    const to = here.basename && (href === here.basename || href.startsWith(`${here.basename}/`)) ? href.slice(here.basename.length) || "/" : href;
    return <Link to={to} className={className} {...aria}>{children}</Link>;
  }
  return <a href={href} className={className} {...aria}>{children}</a>;
}

function Mark() {
  return (
    <svg className="ui-side__mark" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" />
      <rect x="7.5" y="8" width="4.5" height="16" rx="1.5" className="ui-side__bar" />
      <rect x="13.75" y="8" width="4.5" height="11" rx="1.5" className="ui-side__bar" opacity=".82" />
      <rect x="20" y="8" width="4.5" height="7" rx="1.5" className="ui-side__bar" opacity=".64" />
    </svg>
  );
}

/** The product's name, a link to its home. */
function Brand({ here, brand, home }: { here: PlaceHere; brand: string; home: string }) {
  return (
    <PlaceLink here={here} app={here.app} href={home} className="ui-side__brand" label={`${brand}: на главную`}>
      <Mark />
      <span>{brand}</span>
    </PlaceLink>
  );
}

/**
 * The product's name that opens the list of the person's products (one step, no second sign-in): the products, then
 * quieter the outside tools. The current one is ticked.
 */
function Switcher({ brand, products }: { brand: string; products: readonly ProductLink[] }) {
  const main = products.filter((product) => !product.quiet);
  const quiet = products.filter((product) => product.quiet);
  const go = (href: string) => () => window.location.assign(href);
  const items: MenuEntry[] = [
    { group: "Продукты" },
    ...main.map((product) => ({ label: product.label, checked: product.current, onSelect: go(product.href) })),
    ...(quiet.length > 0 ? [{ separator: true as const }, { group: "Инструменты" }] : []),
    ...quiet.map((product) => ({ label: product.label, onSelect: go(product.href) })),
  ];
  return (
    <Menu
      label="Продукты"
      align="start"
      items={items}
      renderTrigger={({ ref, ...trigger }) => (
        <button ref={ref} type="button" className="ui-side__brand ui-side__brand--switch" aria-label={`${brand}: другие продукты`} {...trigger}>
          <Mark />
          <span>{brand}</span>
          <ChevronsUpDown size={16} strokeWidth={1.75} aria-hidden className="ui-side__chevron" />
        </button>
      )}
    />
  );
}

/** A menu item's number: nothing while it is read or at zero; a quiet «?» when it could not be checked. */
function ItemCount({ view, label }: { view: MenuCountView | null | undefined; label: string }) {
  if (!view || (view.value === 0 && !view.unknown)) return null;
  const said = [
    view.value > 0 ? `${label}: ${view.value}` : null,
    view.unknown ? (view.value > 0 ? "не всё удалось проверить, может быть больше" : "не удалось проверить, это не ноль") : null,
  ].filter((part): part is string => part !== null).join(". ");
  return (
    <span className="ui-side__count" aria-label={said} title={said}>
      {view.value > 0 && <CountBadge value={view.value} />}
      {view.unknown && <span className="ui-side__unknown" aria-hidden>?</span>}
    </span>
  );
}

function Items({ items, props }: { items: readonly MenuItem[]; props: PlaceSidebarProps }) {
  const rows: ReactNode[] = [];
  for (const item of items) {
    const Icon = ICONS[item.icon];
    rows.push(
      <PlaceLink key={item.id} here={props.here} app={item.app} href={props.hrefOf(item)} className="ui-side__item" current={props.current === item.id}>
        <Icon size={18} strokeWidth={1.75} aria-hidden className="ui-side__icon" />
        <span className="ui-side__label">{item.label}</span>
        {item.count && <ItemCount view={props.counts[item.count]} label={item.label} />}
      </PlaceLink>,
    );
  }
  return <>{rows}</>;
}

function Account({ account }: { account: PlaceAccount }) {
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const items: MenuEntry[] = [
    ...(account.onAccount ? [{ label: NAME_MENU_ACCOUNT.label, icon: Smartphone, onSelect: account.onAccount }, { separator: true as const }] : []),
    { group: "Тема" },
    ...THEME_OPTIONS.map((option) => ({
      label: option.label,
      icon: THEME_ICON[option.value],
      checked: theme === option.value,
      onSelect: () => setTheme(option.value),
    })),
    { separator: true },
    { label: account.signingOut ? "Выходим…" : "Выйти", icon: LogOut, disabled: account.signingOut === true, onSelect: account.signOut },
  ];
  return (
    <div className="ui-side__foot">
      <Menu
        label={account.onAccount ? "Аккаунт, тема и выход" : "Тема и выход"}
        align="start"
        items={items}
        renderTrigger={({ ref, ...trigger }) => (
          <button ref={ref} type="button" className="ui-side__account" aria-label={`${account.name}: ${account.onAccount ? "аккаунт, тема и выход" : "тема и выход"}`} {...trigger}>
            <span className="ui-side__avatar" aria-hidden>{account.name.slice(0, 1).toUpperCase()}</span>
            <span className="ui-side__who">
              <span className="ui-side__name">{account.name}</span>
              <span className="ui-side__role">{roleWord(account.role)}</span>
            </span>
            <ChevronsUpDown size={16} strokeWidth={1.75} aria-hidden className="ui-side__chevron" />
          </button>
        )}
      />
      {account.signOutFailed && <p role="alert" className="ui-side__alert">Выход не подтверждён. Повторите попытку.</p>}
    </div>
  );
}

/** The sidebar itself: brand, search, the menu above and under the rule, the account. */
export function PlaceSidebar(props: PlaceSidebarProps & { onSearch: () => void }) {
  const { menu } = props;
  return (
    <aside className="ui-side">
      {props.products.length > 1 ? <Switcher brand={props.brand} products={props.products} /> : <Brand here={props.here} brand={props.brand} home={props.home} />}
      {props.search !== false && (
        <button type="button" className="ui-side__search" onClick={props.onSearch} aria-keyshortcuts={PALETTE_ARIA_SHORTCUT} title={`Найти (${PALETTE_SHORTCUT})`}>
          <Search size={16} strokeWidth={1.75} aria-hidden />
          <span>Найти</span>
          <Kbd>{PALETTE_SHORTCUT}</Kbd>
        </button>
      )}
      <nav aria-label="Разделы" className="ui-side__nav">
        <Items items={menu.upper} props={props} />
        {menu.lower.length > 0 && (
          <>
            <div className="ui-side__rule" role="separator" />
            <Items items={menu.lower} props={props} />
          </>
        )}
      </nav>
      <Account account={props.account} />
    </aside>
  );
}

/** The sidebar on a phone: over the screen from the left, closed by ✕, Escape, a tap beside it or a new address. */
function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusScope(panel, true, { initial: "box" });
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const wide = window.matchMedia("(min-width: 768px)");
    const onWide = () => {
      if (wide.matches) onClose();
    };
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    wide.addEventListener("change", onWide);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      wide.removeEventListener("change", onWide);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div className="ui-place__drawer">
      <div className="ui-place__veil" aria-hidden onClick={onClose} />
      <div ref={panel} role="dialog" aria-modal="true" aria-label="Меню" tabIndex={-1} className="ui-place__panel">
        {children}
        <button type="button" className="ui-place__close" aria-label="Закрыть меню" onClick={onClose}>
          <X size={18} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </div>
  );
}

export interface PlaceFrameProps extends PlaceSidebarProps {
  /** The search (the app's palette) is open: ⌘K closes it again. */
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  /** The screen's column: the app's own <main>. */
  children: ReactNode;
}

/**
 * The whole frame: the sidebar on the left (sticky, full height), the screen
 * on the right; ⌘K opens the app's search from anywhere.
 */
export function PlaceFrame({ searchOpen, setSearchOpen, children, ...sidebar }: PlaceFrameProps) {
  const location = useLocation();
  const [drawer, setDrawer] = useState(false);
  const searchOpenNow = useRef(searchOpen);
  searchOpenNow.current = searchOpen;
  useEffect(() => setDrawer(false), [location.key]);
  const searchable = sidebar.search !== false;
  useEffect(() => {
    if (!searchable) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      setDrawer(false);
      setSearchOpen(!searchOpenNow.current);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSearchOpen, searchable]);
  const openSearch = () => {
    setDrawer(false);
    setSearchOpen(true);
  };
  const closeDrawer = () => setDrawer(false);
  return (
    <div className="ui-place">
      <PlaceSidebar {...sidebar} onSearch={openSearch} />
      <div className="ui-place__column">
        <div className="ui-strip">
          <button type="button" className="ui-strip__button" aria-label="Открыть меню" onClick={() => setDrawer(true)}>
            <Burger size={20} strokeWidth={1.75} aria-hidden />
          </button>
          <Brand here={sidebar.here} brand={sidebar.brand} home={sidebar.home} />
          {searchable && (
            <button type="button" className="ui-strip__button ui-strip__search" aria-label="Найти" onClick={openSearch}>
              <Search size={18} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>
        {children}
      </div>
      {drawer && (
        <Drawer onClose={closeDrawer}>
          <PlaceSidebar {...sidebar} onSearch={openSearch} />
        </Drawer>
      )}
    </div>
  );
}
