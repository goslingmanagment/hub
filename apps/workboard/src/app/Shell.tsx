import { ArrowLeft, Banknote, CalendarClock, Inbox, KeyRound, LogOut, Monitor, Moon, Sun, TrendingUp, Users } from "lucide-react";
import { Suspense, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { CountBadge, ErrorState, Menu, Skeleton, type IconComponent } from "@agency_hub_core/ui";
import { THEME_OPTIONS, useThemeStore, type ThemePreference } from "@agency_hub_core/ui/theme";
import { kernel, queryClient, signInHref } from "@/shared/hub";
import { carryParams } from "@/shared/links";
import { useDecisionCounts } from "@/shared/decisions";
import { useMe } from "@/shared/useMe";
import { ErrorBoundary } from "./ErrorBoundary.js";

interface NavItem {
  to: string;
  label: string;
  icon: IconComponent;
  /** Carries the period and the page filter (screens about the same dates). */
  carry?: boolean;
  ownerOnly?: boolean;
}

/** The sidebar, by work (spec §3). Labels are final unless the owner renames them. */
const WORK: readonly NavItem[] = [
  { to: "/shifts", label: "Смены", icon: CalendarClock, carry: true },
  { to: "/people", label: "Люди", icon: Users, carry: true },
  { to: "/sales", label: "Что продаёт", icon: TrendingUp, carry: true },
  { to: "/decisions", label: "Решения", icon: Inbox },
  { to: "/payouts", label: "Выплаты", icon: Banknote, carry: true },
];

const ADMIN: readonly NavItem[] = [
  { to: "/access", label: "Доступ", icon: KeyRound, ownerOnly: true },
];

const ROLE_WORD: Record<string, string> = { owner: "Владелец", team_lead: "Тимлид", chatter: "Чаттер" };
const THEME_ICON: Record<ThemePreference, IconComponent> = { system: Monitor, light: Sun, dark: Moon };

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
  const search = item.carry ? carryParams(location.search).toString() : "";
  const Icon = item.icon;
  return (
    <NavLink to={{ pathname: item.to, search: search ? `?${search}` : "" }} className="wb-nav__item">
      <Icon size={18} strokeWidth={1.75} aria-hidden className="wb-nav__icon" />
      <span className="wb-nav__label">{item.label}</span>
      {end}
    </NavLink>
  );
}

function DecisionsCount() {
  const counts = useDecisionCounts();
  if (counts.total === 0) return null;
  const parts = [
    counts.disputes ? `споры: ${counts.disputes}` : null,
    counts.customs ? `кастомы: ${counts.customs}` : null,
    counts.held ? `отправки: ${counts.held}` : null,
  ].filter(Boolean).join(", ");
  return <span className="wb-nav__count"><CountBadge value={counts.total} label={`Ждут решения — ${parts}`} /></span>;
}

function Account() {
  const { user, role } = useMe();
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  if (!user) return null;
  const name = user.username;
  return (
    <div className="wb-account">
      <span className="wb-account__avatar" aria-hidden>{name.slice(0, 1).toUpperCase()}</span>
      <span className="wb-account__text">
        <span className="wb-account__name">{name}</span>
        <span className="wb-account__role">{ROLE_WORD[role ?? ""] ?? role}</span>
      </span>
      <Menu
        label="Тема и выход"
        size="sm"
        align="start"
        triggerIcon={THEME_ICON[theme]}
        items={[
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
                window.location.assign(signInHref(import.meta.env.BASE_URL));
              });
            },
          },
        ]}
      />
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
  const { isOwner } = useMe();
  const location = useLocation();
  return (
    <div className="wb-app">
      <aside className="wb-side">
        <Brand />
        <nav aria-label="Разделы Workboard" className="wb-nav">
          {WORK.map((item) => (
            <NavRow key={item.to} item={item} end={item.to === "/decisions" ? <DecisionsCount /> : undefined} />
          ))}
          <div className="wb-nav__sep" role="separator" />
          {ADMIN.filter((item) => isOwner || !item.ownerOnly).map((item) => <NavRow key={item.to} item={item} />)}
          <a href="/" className="wb-nav__item wb-nav__item--quiet">
            <ArrowLeft size={18} strokeWidth={1.75} aria-hidden className="wb-nav__icon" />
            <span className="wb-nav__label">Hub</span>
          </a>
        </nav>
        <div className="wb-side__foot">
          <Account />
        </div>
      </aside>
      <main className="wb-main">
        <ErrorBoundary key={location.pathname} fallback={<div className="wb-content"><ErrorState title="Не удалось открыть экран" onRetry={() => window.location.reload()}>Что-то сломалось в самом экране. Перезагрузка обычно помогает; данные в Hub не тронуты.</ErrorState></div>}>
          <Suspense fallback={<ScreenFallback />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
