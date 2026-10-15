import { Link, useLocation } from "react-router";
import { ChevronRight, Coins, Inbox, Layers, LayoutDashboard, LineChart, Settings, Wrench, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAdminConnections } from "@/api/queries";
import { isAlertState } from "@/components/shared/syncUxDisplay";
import { PlatformTag } from "@/components/shared/PlatformBadge";
import { buildAnalyticsRoute, buildPageRoute, decodeRouteSegment } from "@/lib/navigation";
import { SYSTEM_HOME, TABBED_SECTIONS, isSystemPath, sectionHome, sectionOfPath } from "@/lib/sections";
import { useDashboardShell } from "./DashboardShellContext.js";

interface SidebarProps {
  user: { username: string; role: string };
}

function prefetchAnalyticsCatalog() {
  void import("@/api/pages").then((module) => module.prefetchPages());
}

const COLLAPSED_KEY = "hub-sidebar-collapsed-models";

function readCollapsed(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function NavItem({ to, icon: Icon, active, children, trailing, onPointerEnter }: {
  to: string;
  icon: LucideIcon;
  active: boolean;
  children: ReactNode;
  trailing?: ReactNode;
  onPointerEnter?: () => void;
}) {
  return (
    <Link
      to={to}
      className="nav-item"
      aria-current={active ? "page" : undefined}
      onMouseEnter={onPointerEnter}
      onFocus={onPointerEnter}
    >
      <Icon size={17} strokeWidth={1.8} />
      <span className="min-w-0 truncate">{children}</span>
      {trailing}
    </Link>
  );
}

export function Sidebar({ user }: SidebarProps) {
  const { pages, pageCatalogState } = useDashboardShell();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const owner = user.role === "owner";
  const { data: connections } = useAdminConnections({ enabled: owner });
  const hasSyncWarning = owner && (connections?.some((c) => isAlertState(c.syncUx)) ?? false);

  type PageItem = (typeof pages)[number];
  const modelPages = new Map<string, { modelName: string; pages: PageItem[] }>();
  for (const page of pages) {
    const existing = modelPages.get(page.modelSlug);
    if (existing) existing.pages.push(page);
    else modelPages.set(page.modelSlug, { modelName: page.modelName, pages: [page] });
  }

  const { pathname, search } = location;
  const activePageLabel = (() => {
    const parts = pathname.split("/").filter(Boolean);
    return parts[0] === "pages" && parts[1] ? decodeRouteSegment(parts[1]) : null;
  })();
  const activeFanslyPageLabel = pages.some((page) => page.platform === "fansly" && page.label === activePageLabel)
    ? activePageLabel
    : null;
  // The Analytics link carries the Fansly page already in view: landing on
  // someone else's page is a worse default than landing on the first one.
  const analyticsRoute = buildAnalyticsRoute(activeFanslyPageLabel);
  const section = sectionOfPath(pathname);
  const system = isSystemPath(pathname, search);
  const onlyFansHome = sectionHome(TABBED_SECTIONS.onlyfans, user.role);
  const attentionHome = sectionHome(TABBED_SECTIONS.attention, user.role);

  function toggleModel(slug: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* Remembering a collapsed model is a convenience only. */
      }
      return next;
    });
  }

  return (
    <nav aria-label="Разделы" className="fixed top-0 bottom-0 z-20 flex w-[248px] flex-col border-r border-border bg-card">
      <Link to="/" className="flex h-[56px] shrink-0 items-center px-5 text-[17px] font-bold tracking-[-0.03em] text-text-primary">
        <span className="text-accent">Agency</span>Hub
      </Link>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <div className="space-y-0.5">
          <NavItem to="/" icon={LayoutDashboard} active={pathname === "/" || pathname === "/transactions"}>Обзор</NavItem>
          {owner && (
            <NavItem to={analyticsRoute} icon={LineChart} active={pathname === "/analytics"} onPointerEnter={prefetchAnalyticsCatalog}>
              Аналитика
            </NavItem>
          )}
          {onlyFansHome && (
            <NavItem to={onlyFansHome} icon={Layers} active={section === "onlyfans"}>OnlyFans</NavItem>
          )}
          {attentionHome && (
            <NavItem to={attentionHome} icon={Inbox} active={section === "attention"}>Требует внимания</NavItem>
          )}
        </div>

        <div className="nav-group-label">Модели</div>
        {pageCatalogState === "loading" && <p role="status" className="px-2.5 py-2 text-sm text-text-muted">Загружаем страницы…</p>}
        {pageCatalogState === "error" && <p className="px-2.5 py-2 text-sm text-text-muted">Список страниц недоступен.</p>}
        {pageCatalogState === "ready" && pages.length === 0 && (
          <p className="px-2.5 py-2 text-sm text-text-muted">
            Нет доступных страниц.
            {owner && <> <Link className="link" to="/settings?tab=pages">Подключить страницу</Link></>}
          </p>
        )}
        {[...modelPages.entries()].map(([slug, model]) => {
          const isCollapsed = collapsed.has(slug) && !model.pages.some((page) => page.label === activePageLabel);
          return (
            <div key={slug} className="mb-1">
              <button
                type="button"
                className="nav-model"
                aria-expanded={!isCollapsed}
                onClick={() => toggleModel(slug)}
              >
                <ChevronRight size={14} className={`text-text-muted transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
                <span className="min-w-0 truncate">{model.modelName}</span>
                <span className="nav-model-count">{model.pages.length}</span>
              </button>
              {!isCollapsed && model.pages.map((page) => (
                <Link
                  key={page.id}
                  to={buildPageRoute(page.label)}
                  className="nav-page"
                  aria-current={activePageLabel === page.label ? "page" : undefined}
                >
                  <span className="nav-page-label">{page.label}</span>
                  <PlatformTag platform={page.platform} />
                </Link>
              ))}
            </div>
          );
        })}
      </div>

      {owner && (
        <div className="shrink-0 space-y-0.5 border-t border-border p-3">
          <NavItem to="/ofapi-credits" icon={Coins} active={section === "costs"}>Расходы</NavItem>
          <NavItem
            to="/settings"
            icon={Settings}
            active={pathname === "/settings" && !system}
            trailing={hasSyncWarning ? <span className="nav-dot" role="img" aria-label="Нужна проверка подключения" /> : undefined}
          >
            Настройки
          </NavItem>
          <NavItem to={SYSTEM_HOME} icon={Wrench} active={system}>Система</NavItem>
        </div>
      )}
    </nav>
  );
}
