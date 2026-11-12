import { ArrowLeft, Banknote, CalendarClock, ChevronsUpDown, Flag, Inbox, LogOut, Monitor, Moon, Package, Smartphone, Sun, TrendingUp, Users } from "lucide-react";
import { Suspense, useState, type ReactNode } from "react";
import { NavLink, Navigate, Outlet, useLocation, useMatches, useNavigate, type UIMatch } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CountBadge, ErrorState, Menu, Skeleton, type IconComponent, type MenuEntry } from "@agency_hub_core/ui";
import { PlaceFrame } from "@agency_hub_core/ui/components/Place";
import { carriedHref, placeName, waitingCount, waitingQuery, workboardDays, type MenuCountView } from "@agency_hub_core/ui/place";
import { menuItemAt, placeMenu, teamMenu, type MenuIcon, type MenuItem } from "@agency_hub_core/ui/screens";
import { THEME_OPTIONS, useThemeStore, type ThemePreference } from "@agency_hub_core/ui/theme";
import { NO_SILENT_SIGNIN, peerOriginOf, siteOf } from "@agency_hub_core/ui/sites";
import { useFace } from "@/shared/face";
import { kernel, queryClient, signInHref } from "@/shared/hub";
import { carryParams } from "@/shared/links";
import { startOpen, useAccountStart } from "@/shared/start";
import { TEAM, useMe, type Role } from "@/shared/useMe";
import { usePageFilter } from "@/shared/usePageFilter";
import { useRestoredPeriod } from "@/shared/usePeriod";
import { useScrollMemory } from "@/shared/scroll";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { WorkboardPalette } from "./Palette.js";
import { BASENAME, type ScreenHandle } from "./routes.js";

/** Workboard's own menu draws the table's icons (packages/ui/src/screens.ts) with its own components. */
const ICON: Readonly<Partial<Record<MenuIcon, IconComponent>>> = { CalendarClock, Users, TrendingUp, Inbox, Banknote, Package, Flag };

/**
 * The way out to the console, for the team (a page load): on this host, or —
 * on the team's name, where the console is not served — on the console's own
 * name (the owner's place; the sign-in was planted there too).
 */
function consoleHref(): string {
  const origin = window.location.origin;
  return siteOf(origin) === "team" ? `${peerOriginOf(origin) ?? ""}/` : "/";
}

const EXITS: readonly { href: () => string; label: string; roles: readonly Role[] }[] = [
  { href: consoleHref, label: "Hub", roles: TEAM },
];


const ROLE_WORD: Record<string, string> = { owner: "Владелец", team_lead: "Тимлид", chatter: "Чаттер" };
const THEME_ICON: Record<ThemePreference, IconComponent> = { system: Monitor, light: Sun, dark: Moon };

/** The items of a list that `role` sees. */
function seenBy<T extends { roles: readonly Role[] }>(items: readonly T[], role: Role | null): T[] {
  return role === null ? [] : items.filter((item) => item.roles.includes(role));
}

function Brand() {
  return (
    <a href={import.meta.env.BASE_URL} className="wb-brand" aria-label="Workboard — на главную">
      <svg className="wb-brand__mark" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" />
        <rect x="7.5" y="8" width="4.5" height="16" rx="1.5" className="wb-brand__bar" />
        <rect x="13.75" y="8" width="4.5" height="11" rx="1.5" className="wb-brand__bar" opacity=".82" />
        <rect x="20" y="8" width="4.5" height="7" rx="1.5" className="wb-brand__bar" opacity=".64" />
      </svg>
      <span>Workboard</span>
    </a>
  );
}

/** The router's basename as a prefix of the host's addresses: "" when Workboard is served at the root. */
function base(): string {
  return BASENAME === "/" ? "" : BASENAME;
}

/** A Workboard address of the table (`/workboard/shifts`) as this router's path (`/shifts`). */
function routerPath(to: string): string {
  return base() && to.startsWith(`${base()}/`) ? to.slice(base().length) : to;
}

function NavRow({ item, end }: { item: MenuItem; end?: ReactNode }) {
  const location = useLocation();
  const search = carryParams(location.search).toString();
  const Icon = ICON[item.icon] ?? Inbox;
  return (
    <NavLink to={{ pathname: routerPath(item.to), search: search ? `?${search}` : "" }} className="wb-nav__item">
      <Icon size={18} strokeWidth={1.75} aria-hidden className="wb-nav__icon" />
      <span className="wb-nav__label">{item.label}</span>
      {end}
    </NavLink>
  );
}

/** «Ждут вас»: the one read both apps show (packages/ui/src/place.ts), in Workboard's own menu. */
function useWaitingCount(enabled: boolean): MenuCountView | null {
  const read = useQuery({ ...waitingQuery(kernel), enabled });
  return enabled ? waitingCount(read) : null;
}

function TeamCount({ view, label }: { view: MenuCountView | null; label: string }) {
  if (!view || (view.value === 0 && !view.unknown)) return null;
  const said = [view.value > 0 ? `${label}: ${view.value}` : null, view.unknown ? "не всё удалось проверить, это не ноль" : null]
    .filter((part): part is string => part !== null).join(". ");
  return (
    <span className="wb-nav__count" aria-label={said} title={said}>
      {view.value > 0 && <CountBadge value={view.value} />}
      {view.unknown && <span className="wb-nav__unknown" aria-hidden>?</span>}
    </span>
  );
}

/**
 * What makes a new instance of the screen: its route, and for a deep page the
 * object it shows (`handle.screenKey`, routes.tsx). Tabs of one card or one
 * screen keep the screen — and its state — mounted.
 */
function useScreenKey(): string {
  const matches = useMatches() as UIMatch<unknown, ScreenHandle | undefined>[];
  const leaf = matches.at(-1);
  if (!leaf) return "";
  return `${leaf.id}:${leaf.handle?.screenKey?.(leaf.params) ?? ""}`;
}

/**
 * Who is signed in, at the sidebar's foot, and their menu: the theme and the
 * way out; a chatter's also leads to their account (devices, password). A
 * chatter's whole row is the menu's button — on a phone it is the strip's
 * last item, and their only way to the account.
 */
function Account() {
  const { user, role, accountRole, narrow } = useMe();
  const navigate = useNavigate();
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  if (!user) return null;
  const name = user.username;
  const chatter = role === "chatter";
  // A narrow session (from the extension) does not change the account's devices or password.
  const items: MenuEntry[] = [
    ...(chatter && !narrow ? [{ label: "Аккаунт и устройства", icon: Smartphone, onSelect: () => navigate("/account") }, { separator: true as const }] : []),
    { group: "Тема" },
    ...THEME_OPTIONS.map((option) => ({
      label: option.label,
      icon: THEME_ICON[option.value],
      checked: theme === option.value,
      onSelect: () => setTheme(option.value),
    })),
    { separator: true },
    { label: "Выйти", icon: LogOut, onSelect: signOut },
  ];
  const avatar = <span className="wb-account__avatar" aria-hidden>{name.slice(0, 1).toUpperCase()}</span>;
  const text = (
    <span className="wb-account__text">
      <span className="wb-account__name">{name}</span>
      <span className="wb-account__role">{ROLE_WORD[accountRole ?? ""] ?? accountRole}</span>
    </span>
  );
  if (chatter) {
    return (
      <Menu
        label="Аккаунт, тема и выход"
        align="start"
        items={items}
        renderTrigger={({ ref, ...trigger }) => (
          <button ref={ref} type="button" className="wb-account wb-account--button" aria-label={`${name}: аккаунт, тема и выход`} {...trigger}>
            {avatar}
            {text}
            <ChevronsUpDown size={16} strokeWidth={1.75} aria-hidden className="wb-account__chevron" />
          </button>
        )}
      />
    );
  }
  return (
    <div className="wb-account">
      {avatar}
      {text}
      <Menu label="Тема и выход" size="sm" align="start" triggerIcon={THEME_ICON[theme]} items={items} />
    </div>
  );
}

/** A screen's place while its code loads: the header's height and a sheet. */
export function ScreenFallback() {
  return (
    <div className="wb-fallback" aria-busy>
      <Skeleton width={180} height={28} radius={6} />
      <Skeleton height={320} radius={12} />
    </div>
  );
}

/** The team's place: Workboard's own short menu (packages/ui/src/screens.ts `teamMenu`), as it was. */
function TeamSide() {
  const { role } = useMe();
  // «Начало» is listed while a newcomer has a step open (the address still opens it).
  const start = useAccountStart();
  const items = role === null ? [] : teamMenu(role, { newcomer: startOpen(start.data) });
  const waiting = useWaitingCount(items.some((item) => item.count === "waiting"));
  return (
    <aside className="wb-side">
      <Brand />
      <nav aria-label="Разделы Workboard" className="wb-nav">
        {items.map((item) => (
          <NavRow key={item.id} item={item} end={item.count === "waiting" ? <TeamCount view={waiting} label={item.label} /> : undefined} />
        ))}
        {/* The line parts work from the way out; with nothing after it (a chatter), there is no line. */}
        {seenBy(EXITS, role).length > 0 && <div className="wb-nav__sep" role="separator" />}
        {seenBy(EXITS, role).map((exit) => (
          <a key={exit.label} href={exit.href()} className="wb-nav__item wb-nav__item--quiet">
            <ArrowLeft size={18} strokeWidth={1.75} aria-hidden className="wb-nav__icon" />
            <span className="wb-nav__label">{exit.label}</span>
          </a>
        ))}
      </nav>
      <div className="wb-side__foot">
        <Account />
      </div>
    </aside>
  );
}

/**
 * The owner's place: the frame and the menu of the console (packages/ui
 * Place.tsx), drawn here. Workboard's items keep the period and the page of
 * this screen; the console's carry the page and the period they share.
 */
function PlaceShell({ children }: { children: ReactNode }) {
  const { user, role, accountRole } = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const { page } = usePageFilter();
  const [searchOpen, setSearchOpen] = useState(false);
  const waiting = useWaitingCount(true);
  const own = carryParams(location.search).toString();
  const days = workboardDays(new URLSearchParams(location.search));
  const hrefOf = (item: MenuItem) => (item.app === "workboard" ? `${item.to}${own ? `?${own}` : ""}` : carriedHref(item, { page, days }));
  if (!user || role === null) return null;
  return (
    <>
      {searchOpen && <WorkboardPalette role={role} onClose={() => setSearchOpen(false)} />}
      <PlaceFrame
        here={{ app: "workboard", basename: base() }}
        brand={placeName("place")}
        menu={placeMenu(role)}
        current={menuItemAt(`${base()}${location.pathname}`)}
        hrefOf={hrefOf}
        counts={{ waiting }}
        account={{ name: user.username, role: accountRole, signOut, onAccount: () => navigate("/account") }}
        searchOpen={searchOpen}
        setSearchOpen={setSearchOpen}
      >
        {children}
      </PlaceFrame>
    </>
  );
}

/** Signed out: the sign-in page does not ask the other name (no silent sign-back-in). */
function signOut() {
  void kernel.logout().catch(() => undefined).finally(() => {
    queryClient.clear();
    window.location.assign(`${signInHref(import.meta.env.BASE_URL)}&${NO_SILENT_SIGNIN.param}=${NO_SILENT_SIGNIN.value}`);
  });
}

/**
 * Workboard's frame: the sidebar on the left (sticky, full height), the screen
 * on the right using all the width there is. The owner and team leads on the
 * console's name are in the owner's place — the console's frame and menu, one
 * place; everyone else in the team's, with Workboard's own short menu. A broken
 * screen keeps the frame.
 */
export function Shell() {
  const { role } = useMe();
  const face = useFace();
  const location = useLocation();
  // A bare address opens the period last used in this tab (D3); the address then says it — a chatter's too.
  const restored = useRestoredPeriod();
  // «←» comes back to the same place of the page; a new screen opens at its top (D16).
  useScrollMemory();
  const screenKey = useScreenKey();
  const main = (
    <main className="wb-main">
      {restored !== null ? (
        <Navigate replace to={{ pathname: location.pathname, search: restored, hash: location.hash }} state={location.state as unknown} />
      ) : (
        <ErrorBoundary key={screenKey} resetKey={location.pathname} fallback={<div className="wb-content"><ErrorState title="Не удалось открыть экран" onRetry={() => window.location.reload()}>Что-то сломалось в самом экране. Перезагрузка обычно помогает; данные в Hub не тронуты.</ErrorState></div>}>
          <Suspense fallback={<ScreenFallback />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      )}
    </main>
  );
  if (face === "place") return <PlaceShell>{main}</PlaceShell>;
  return (
    <div className="wb-app" data-part={role === "chatter" ? "chatter" : undefined}>
      <TeamSide />
      {main}
    </div>
  );
}
