import { useEffect, useRef, useState } from "react";
import { useLocation, Link } from "react-router";
import { LogOut, ChevronDown, ChevronRight, Menu, Search } from "lucide-react";
import { useLogout } from "@/api/queries";
import { PeriodSelector } from "@/components/shared/PeriodSelector";
import { clearDashboardSession } from "@/lib/queryClient";
import { buildPageRoute, decodeRouteSegment, isSafeInAppPath, resolveFanLabelFromState, resolveFanProfileBackTarget, resolveSettingsTab } from "@/lib/navigation";
import { SETTINGS_GROUPS, SYSTEM_GROUPS, SYSTEM_HOME, TABBED_SECTIONS, currentSideLink, isSystemPath, sectionOfPath } from "@/lib/sections";
import { useDashboardShell } from "./DashboardShellContext.js";

const ROLE_LABELS: Record<string, string> = {
  owner: "Владелец",
  team_lead: "Тимлид",
  chatter: "Чаттер",
};

interface TopbarProps {
  onOpenNavigation?: () => void;
  onOpenPalette?: (() => void) | undefined;
  user: { username: string; role: string };
}

export function Topbar({ user, onOpenNavigation, onOpenPalette }: TopbarProps) {
  const location = useLocation();
  const logout = useLogout();
  const { pages } = useDashboardShell();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  const backTo = new URLSearchParams(location.search).get("backTo") ?? resolveFanProfileBackTarget(location.state, undefined);
  const overviewBack = backTo && isSafeInAppPath(backTo) && (backTo === "/" || backTo.startsWith("/?")) ? backTo : "/";
  const breadcrumbs = buildBreadcrumbs(location.pathname, location.search, pages, location.state).map((crumb) => crumb.href === "/" ? { ...crumb, href: overviewBack } : crumb);
  const periodSelectorMode = getPeriodSelectorMode(location.pathname);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { setMenuOpen(false); menuButtonRef.current?.focus(); }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  async function handleLogout() {
    if (logout.isPending) return;
    try {
      await logout.mutateAsync();
      clearDashboardSession();
      window.location.assign("/login");
    } catch { /* The mutation retains the failure; do not report an unconfirmed logout. */ }
  }

  return (
    <div className="fixed top-0 right-0 left-0 z-10 flex h-[56px] items-center justify-between gap-3 border-b border-border bg-card/95 px-3 backdrop-blur md:left-[248px] md:px-8">
      <nav aria-label="Где вы находитесь" className="flex min-w-0 items-center gap-1.5 overflow-hidden text-sm">
        <button type="button" className="btn btn-ghost btn-icon mr-1 shrink-0 md:hidden" aria-label="Открыть навигацию" onClick={onOpenNavigation}><Menu size={20} /></button>
        {breadcrumbs.map((crumb, i) => (
          <span key={i} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <ChevronRight size={14} className="shrink-0 text-text-muted" aria-hidden="true" />}
            {crumb.href && i < breadcrumbs.length - 1 ? (
              <Link to={crumb.href} className="truncate text-text-secondary hover:text-text-primary">
                {crumb.label}
              </Link>
            ) : (
              <span className="truncate font-semibold text-text-primary" aria-current="page">
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      <div className="flex shrink-0 items-center gap-2">
        {onOpenPalette && <button type="button" className="btn btn-ghost btn-icon md:hidden" aria-label="Поиск" onClick={onOpenPalette}><Search size={19} /></button>}
        {periodSelectorMode && <PeriodSelector mode={periodSelectorMode} />}

        <div className="relative ml-1 sm:ml-2.5" ref={menuRef}>
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Меню аккаунта"
            aria-expanded={menuOpen}
            className="flex items-center gap-1.5 rounded-full p-1 hover:bg-hover"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent">
              {user.username.charAt(0).toUpperCase()}
            </div>
            <ChevronDown size={14} className="hidden sm:block text-text-muted" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 mt-2 w-56 rounded-xl border border-border bg-card p-2 shadow-lg">
              <div className="px-3 py-2 border-b border-border-light">
                <div className="text-sm font-semibold text-text-primary">{user.username}</div>
                <div className="text-xs text-text-muted">{ROLE_LABELS[user.role] ?? user.role}</div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                disabled={logout.isPending}
                className="mt-2 flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-secondary hover:bg-hover hover:text-text-primary disabled:opacity-50"
              >
                <LogOut size={14} />
                {logout.isPending ? "Выходим…" : "Выйти"}
              </button>
              {logout.isError && <p role="alert" className="px-3 py-2 text-sm text-danger">Выход не подтверждён. Повторите попытку.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getPeriodSelectorMode(pathname: string): "dashboard" | "spender" | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "dashboard";
  if (parts[0] === "pages" && parts[1]) {
    if (!parts[2]) return "dashboard"; // PageDetail
    if (parts[2] === "top-supporters") return "spender";
    if (parts[2] === "spender-autolists") return "spender";
    if (parts[2] === "fans" && parts[3] && parts[4]) return "spender";
    return null;
  }
  if (parts[0] === "usage") return null;
  return null;
}

const PAGE_SECTION_LABELS: Record<string, string> = {
  subscribers: "Подписчики",
  followers: "Фолловеры",
  "top-supporters": "Топ фанов",
  "deleted-fans": "Удалённые фаны",
  "spender-autolists": "Список спендеров",
  "browser-login": "Вход в браузер",
};

function buildBreadcrumbs(
  pathname: string,
  search: string,
  pages: Array<{ label: string }>,
  locationState?: unknown,
): { label: string; href?: string }[] {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 0) return [{ label: "Обзор" }];
  if (parts[0] === "transactions") return [{ label: "Обзор", href: "/" }, { label: "Операции" }];
  if (parts[0] === "analytics") return [{ label: "Аналитика" }];

  const sectionId = sectionOfPath(pathname);
  if (sectionId) {
    const section = TABBED_SECTIONS[sectionId];
    const tab = section.tabs.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
    const home = section.tabs[0]?.to;
    return [home ? { label: section.title, href: home } : { label: section.title }, ...(tab ? [{ label: tab.label }] : [])];
  }

  if (parts[0] === "settings" || parts[0] === "dev") {
    const system = isSystemPath(pathname, search);
    const groups = system ? SYSTEM_GROUPS : SETTINGS_GROUPS;
    const root = system ? { label: "Система", href: SYSTEM_HOME } : { label: "Настройки", href: "/settings" };
    if (pathname === "/dev/sync-status") {
      return [root, { label: "Журнал", href: "/dev/log" }, { label: "Запуск синка" }];
    }
    const tab = parts[0] === "settings" ? resolveSettingsTab(new URLSearchParams(search).get("tab")) : null;
    const link = currentSideLink(groups, pathname, tab === "models" || tab === "credentials" ? "?tab=pages" : search);
    return link ? [root, { label: link.label }] : [root];
  }

  if (parts[0] === "browser-profiles") {
    return [
      { label: "Настройки", href: "/settings" },
      { label: "Модели и страницы", href: "/settings?tab=pages" },
      { label: parts[1] === "new" ? "Новый браузер страницы" : "Подключение страницы" },
    ];
  }

  if (parts[0] === "pages" && parts[1]) {
    const pageLabel = decodeRouteSegment(parts[1]);
    const page = pages.find((item) => item.label === pageLabel);
    const pageTitle = page?.label ?? pageLabel;
    if (parts.length === 2) return [{ label: pageTitle }];
    const crumbs: { label: string; href?: string }[] = [{ label: pageTitle, href: buildPageRoute(pageLabel) }];
    if (parts[2] === "fans" && parts[3] && parts[4]) {
      crumbs.push({ label: resolveFanLabelFromState(locationState) ?? "Профиль фана" });
    } else {
      const section = parts[2] ? PAGE_SECTION_LABELS[parts[2]] : undefined;
      if (section) crumbs.push({ label: section });
    }
    return crumbs;
  }

  return [{ label: "Обзор" }];
}
