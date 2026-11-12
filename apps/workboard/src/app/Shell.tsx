import { ArrowLeft, Banknote, CalendarClock, ChevronsUpDown, Flag, Inbox, LogOut, Monitor, Moon, Package, Smartphone, Sun, TrendingUp, Users } from "lucide-react";
import { Suspense, type ReactNode } from "react";
import { NavLink, Navigate, Outlet, useLocation, useMatches, type UIMatch } from "react-router";
import { CountBadge, ErrorState, Menu, Skeleton, Tooltip, type IconComponent, type MenuEntry } from "@agency_hub_core/ui";
import { THEME_OPTIONS, useThemeStore, type ThemePreference } from "@agency_hub_core/ui/theme";
import { NO_SILENT_SIGNIN, peerOriginOf, siteOf } from "@agency_hub_core/ui/sites";
import { kernel, queryClient, signInHref } from "@/shared/hub";
import { carryParams } from "@/shared/links";
import { decisionParts, decisionsElsewhereText, decisionsFailedText, useDecisionCounts } from "@/shared/decisions";
import { useMattersActive, useWaitingTotal } from "@/shared/matters";
import { START_PATH, startOpen, useAccountStart } from "@/shared/start";
import { CHATTER, OWNER, TEAM, useMe, type Role } from "@/shared/useMe";
import { usePageFilter } from "@/shared/usePageFilter";
import { useRestoredPeriod } from "@/shared/usePeriod";
import { useScrollMemory } from "@/shared/scroll";
import { ErrorBoundary } from "./ErrorBoundary.js";
import type { ScreenHandle } from "./routes.js";

interface NavItem {
  to: string;
  label: string;
  icon: IconComponent;
  /** Who sees it (shared/useMe.ts); its screen is behind the same roles (routes.tsx). */
  roles: readonly Role[];
}

/**
 * The sidebar, by work (spec §3). Labels are final unless the owner renames
 * them. Every item carries the period and the page filter (spec §3 r2, D3): a
 * screen that does not need them keeps them in its address and does not show
 * them, so the next screen opens on the same dates. The team (the owner and
 * team leads) and a chatter see their own items only: a chatter's part of
 * Workboard is theirs alone (owner, 2026-11-10) — «Мои смены», their shifts
 * with their reports; their account is in the menu at the bottom.
 */
const WORK: readonly NavItem[] = [
  // A newcomer's way to the first shift: in the menu only while a step is open (Shell).
  { to: START_PATH, label: "Начало", icon: Flag, roles: CHATTER },
  { to: "/my/shifts", label: "Мои смены", icon: CalendarClock, roles: CHATTER },
  { to: "/shifts", label: "Смены", icon: CalendarClock, roles: TEAM },
  { to: "/people", label: "Люди", icon: Users, roles: TEAM },
  { to: "/sales", label: "Что продаёт", icon: TrendingUp, roles: TEAM },
  { to: "/decisions", label: "Решения", icon: Inbox, roles: TEAM },
  // Заказы кастомов: everyone's; Hub shows each person the orders they may see.
  { to: "/customs", label: "Кастомы", icon: Package, roles: [...TEAM, ...CHATTER] },
  // People's pay is the owner's alone (the ledger's answer reaches no other session).
  { to: "/payouts", label: "Выплаты", icon: Banknote, roles: OWNER },
];

/** Under the line, before the way out. «Доступ» lives in «Люди» now (a person's card, «Доступ и входы»). */
const ADMIN: readonly NavItem[] = [];

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

/** A chatter's account — devices, password, their AI spend — is the console's page on this host (a page load). */
const ACCOUNT_HREF = "/account";

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

function NavRow({ item, end }: { item: NavItem; end?: ReactNode }) {
  const location = useLocation();
  const search = carryParams(location.search).toString();
  const Icon = item.icon;
  return (
    <NavLink to={{ pathname: item.to, search: search ? `?${search}` : "" }} className="wb-nav__item">
      <Icon size={18} strokeWidth={1.75} aria-hidden className="wb-nav__icon" />
      <span className="wb-nav__label">{item.label}</span>
      {end}
    </NavLink>
  );
}

/**
 * The badge of Решения: what waits on the chosen page — the number Решения
 * shows after the click — the other pages in its hint (D17). A queue that did
 * not answer is a quiet «?» beside it, never a silent zero; while a queue is
 * still read, nothing at all (never a partial sum that grows a moment later).
 */
function DecisionsCount() {
  const { page } = usePageFilter();
  const counts = useDecisionCounts({ page });
  if (!counts.settled) return null;
  const failed = decisionsFailedText(counts);
  const elsewhere = decisionsElsewhereText(counts.elsewhere);
  if (counts.total === 0 && failed === null && elsewhere === null) return null;
  const lines = [
    counts.total > 0 ? `Ждут решения${page ? ` на ${page}` : ""}: ${decisionParts(counts, "").map((part) => part.text).join(", ")}` : page ? `На ${page} решений нет` : null,
    elsewhere ? `${elsewhere.charAt(0).toUpperCase()}${elsewhere.slice(1)}` : null,
    // With some numbers shown, the failed queue may add to them; with none, nothing is known.
    failed ? (counts.total > 0 || counts.elsewhere > 0 ? `${failed}: решений может быть больше` : `${failed}. Hub не ответил — это не ноль`) : null,
  ].filter((line): line is string => line !== null);
  // Nothing here but something on the other pages: the number of those, quiet.
  const shown = counts.total > 0 ? counts.total : counts.elsewhere;
  return (
    <Tooltip content={lines.map((line) => <span key={line} className="wb-nav__tip-line">{line}</span>)} align="start">
      <span className="wb-nav__count" aria-label={lines.join(". ")}>
        {shown > 0 && <CountBadge value={shown} quiet={counts.total === 0} />}
        {failed && <span className="wb-nav__unknown" aria-hidden>?</span>}
      </span>
    </Tooltip>
  );
}

/**
 * The badge of «Ждут вас» while the owner's switch reads matters: everything
 * that waits for the person (never what only informs), on every page; a kind
 * not checked is a quiet «?», never a silent zero.
 */
function WaitingCount() {
  const { total, failed, settled } = useWaitingTotal();
  if (!settled || (total === 0 && !failed)) return null;
  const line = [total > 0 ? `Ждут вас: ${total}` : null, failed ? "Не всё удалось проверить: это не ноль" : null].filter(Boolean).join(". ");
  return (
    <Tooltip content={<span className="wb-nav__tip-line">{line}</span>} align="start">
      <span className="wb-nav__count" aria-label={line}>
        {total > 0 && <CountBadge value={total} />}
        {failed && <span className="wb-nav__unknown" aria-hidden>?</span>}
      </span>
    </Tooltip>
  );
}

/** «Решения», or «Ждут вас» with its own count once the switch reads matters. */
function DecisionsRow({ item }: { item: NavItem }) {
  const { active } = useMattersActive();
  return active ? <NavRow item={{ ...item, label: "Ждут вас" }} end={<WaitingCount />} /> : <NavRow item={item} end={<DecisionsCount />} />;
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
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  if (!user) return null;
  const name = user.username;
  const chatter = role === "chatter";
  // A narrow session (from the extension) does not change the account's devices or password.
  const items: MenuEntry[] = [
    ...(chatter && !narrow ? [{ label: "Аккаунт и устройства", icon: Smartphone, onSelect: () => window.location.assign(ACCOUNT_HREF) }, { separator: true as const }] : []),
    { group: "Тема" },
    ...THEME_OPTIONS.map((option) => ({
      label: option.label,
      icon: THEME_ICON[option.value],
      checked: theme === option.value,
      onSelect: () => setTheme(option.value),
    })),
    { separator: true },
    {
      label: "Выйти",
      icon: LogOut,
      onSelect: () => {
        void kernel.logout().catch(() => undefined).finally(() => {
          queryClient.clear();
          // Signed out: the sign-in page does not ask the other name (no silent sign-back-in).
          window.location.assign(`${signInHref(import.meta.env.BASE_URL)}&${NO_SILENT_SIGNIN.param}=${NO_SILENT_SIGNIN.value}`);
        });
      },
    },
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

/**
 * Workboard's frame: the sidebar by work on the left (sticky, full height), the
 * screen on the right using all the width there is. A broken screen keeps the
 * sidebar.
 */
export function Shell() {
  const { role } = useMe();
  const location = useLocation();
  // A bare address opens the period last used in this tab (D3); the address then says it — a chatter's too.
  const restored = useRestoredPeriod();
  // «←» comes back to the same place of the page; a new screen opens at its top (D16).
  useScrollMemory();
  const screenKey = useScreenKey();
  const start = useAccountStart();
  // «Начало» leaves the menu once every step is done (the address still opens it).
  const work = seenBy(WORK, role).filter((item) => item.to !== START_PATH || startOpen(start.data));
  return (
    <div className="wb-app" data-part={role === "chatter" ? "chatter" : undefined}>
      <aside className="wb-side">
        <Brand />
        <nav aria-label="Разделы Workboard" className="wb-nav">
          {work.map((item) => (
            item.to === "/decisions" ? <DecisionsRow key={item.to} item={item} /> : <NavRow key={item.to} item={item} />
          ))}
          {/* The line parts work from the rest; with nothing after it (a chatter), there is no line. */}
          {seenBy(ADMIN, role).length + seenBy(EXITS, role).length > 0 && <div className="wb-nav__sep" role="separator" />}
          {seenBy(ADMIN, role).map((item) => <NavRow key={item.to} item={item} />)}
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
    </div>
  );
}
