import { Suspense, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
import { useAuthMe } from "@/api/queries";
import { useOfapiStatus } from "@/api/waiting";
import { Notice } from "@/components/ui/Notice";
import { SectionTabs, type SectionTabItem } from "@/components/ui/SectionTabs";
import { ScreenFrameContext, type ScreenFrame as ScreenFrameValue } from "@/components/ui/screenFrame";
import {
  headerPeriodOf,
  matchScreen,
  pageFilterOf,
  sectionById,
  tabOfScreen,
  tabRow,
  visibleSectionTabs,
  type Crumb,
  type Role,
  type Screen,
  type Section,
  type SectionTab,
} from "@agency_hub_core/ui/screens";
import { contentopsHref, contentopsModelsOf } from "@agency_hub_core/ui/sites";
import { useAgentKeys } from "@/api/agentKeys";
import { useDashboardShell } from "./DashboardShellContext.js";
import { PageScopeGate } from "./PageScopeGate.js";
import { PageFilterChip } from "./PageFilterChip.js";
import { PeriodControl, PeriodMissingNote } from "./PeriodControl.js";
import { usePageFilter, usePageFilterSync } from "./usePageFilter.js";

export function ScreenFallback() {
  return <div role="status" className="py-16 text-center text-sm text-text-muted">Загружаем экран…</div>;
}

/** Tabs inside a section carry the page and the period of the current address. */
function linkTo(target: Screen, current: URLSearchParams): string {
  const query = new URLSearchParams();
  const { mode } = pageFilterOf(target);
  const page = current.get("page");
  if (page && (mode === "any" || mode === "one")) query.set("page", page);
  const period = current.get("period");
  if (period && target.period?.class === "shared") query.set("period", period);
  const text = query.toString();
  return text ? `${target.path}?${text}` : target.path;
}

function Crumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <nav aria-label="Где вы находитесь" className="page-crumbs">
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.label}-${index}`} className="inline-flex items-center gap-1">
          {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
          {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** A small words-only row of the screens inside a tab. */
function SubRow({ sectionTab, role, screen, search }: { sectionTab: SectionTab; role: Role; screen: Screen; search: URLSearchParams }) {
  const row = tabRow(sectionTab, role);
  const items: SectionTabItem[] = row.map((item) => ({ to: linkTo(item, search), label: item.label }));
  const current = row.findIndex((item) => item.id === screen.id);
  return <SectionTabs sub label={sectionTab.label} items={items} current={current >= 0 ? items[current]?.to : undefined} />;
}

/**
 * The section's places in another product (Контент: ContentOps' План, Приехало,
 * Библиотека) on the chosen page's model, named beside them, when ContentOps
 * holds that model (`contentopsModelsOf`: the pages of ContentOps' sign-in key);
 * a page whose model ContentOps does not hold has none. With every page chosen
 * there is no model to name: one link to ContentOps' own start.
 */
function OutsideLinks({ outside, role }: { outside: NonNullable<Section["outside"]>; role: Role }) {
  const filter = usePageFilter();
  const { pages, findPageByLabel } = useDashboardShell();
  const keys = useAgentKeys(outside.site === "contentops" && role === "owner");
  if (outside.site === "workboard") {
    // A Workboard screen on this host: a page load, the same tab.
    const links = outside.links.filter((link) => !link.ownerOnly || role === "owner");
    if (links.length === 0) return null;
    return (
      <span className="section-outside">
        {links.map((link) => <a key={link.to} className="section-tab" href={link.to} title={link.title}>{link.label}</a>)}
      </span>
    );
  }
  const page = findPageByLabel(filter.page ?? undefined);
  const held = keys.data ? contentopsModelsOf(keys.data, pages) : null;
  if (page && held && !held.has(page.modelSlug.toLowerCase())) return null;
  if (!page || !held) {
    return (
      <span className="section-outside">
        <a className="section-tab section-tab-outside" href={contentopsHref(null, "")} target="_blank" rel="noreferrer">
          {outside.label}
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </span>
    );
  }
  return (
    <span className="section-outside">
      <span className="section-outside-label">{outside.label} · {page.modelName}</span>
      {outside.links.map((link) => (
        <a key={link.path} className="section-tab section-tab-outside" href={contentopsHref(page.modelSlug, link.path)} target="_blank" rel="noreferrer">
          {link.label}
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      ))}
    </span>
  );
}

function SectionRow({ section, role, screen, search }: { section: Section; role: Role; screen: Screen; search: URLSearchParams }) {
  const tabs = visibleSectionTabs(section, role);
  const currentTab = tabOfScreen(section, screen.id);
  const itemOf = (item: SectionTab): SectionTabItem => ({ to: linkTo(tabRow(item, role)[0]!, search), label: item.label });
  const currentTo = currentTab && tabs.includes(currentTab) ? itemOf(currentTab).to : undefined;
  return (
    <>
      <SectionTabs
        label={section.title}
        items={tabs.filter((item) => !item.more).map(itemOf)}
        more={tabs.filter((item) => item.more).map(itemOf)}
        current={currentTo}
        end={section.outside ? <OutsideLinks outside={section.outside} role={role} /> : undefined}
      />
      {currentTab && <SubRow sectionTab={currentTab} role={role} screen={screen} search={search} />}
    </>
  );
}

/** Settings and System: a list on the left, a select on a narrow screen. */
function SideMenu({ section, role, screen, search, children }: {
  section: Section;
  role: Role;
  screen: Screen;
  search: URLSearchParams;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const ofapi = useOfapiStatus(role);
  const tabs = visibleSectionTabs(section, role);
  const currentTab = tabOfScreen(section, screen.id);
  const entries = tabs.flatMap((item) => (item.listedInSideMenu
    ? tabRow(item, role).map((target) => ({ to: linkTo(target, search), label: `${item.label}: ${target.label}`, tab: item, screen: target }))
    : [{ to: linkTo(tabRow(item, role)[0]!, search), label: item.label, tab: item, screen: tabRow(item, role)[0]! }]));
  const currentEntry = entries.find((entry) => entry.screen.id === screen.id) ?? entries.find((entry) => entry.tab.id === currentTab?.id);

  // A section closed to this role: its refusal stands alone, beside no empty column.
  if (entries.length === 0) return <>{children}</>;

  return (
    <div className="side-nav-layout">
      <nav aria-label={`Разделы: ${section.label}`} className="side-nav">
        <ul className="side-nav-list">
          {tabs.map((item) => {
            const isCurrent = item.id === currentTab?.id;
            const first = tabRow(item, role)[0]!;
            return (
              <li key={item.id}>
                <Link to={linkTo(first, search)} className="side-nav-link" aria-current={isCurrent && !item.listedInSideMenu ? "page" : undefined}>
                  {item.label}
                  {item.note && ofapi === "off" && <span className="side-nav-note">{item.note}</span>}
                </Link>
                {item.listedInSideMenu && isCurrent && (
                  <ul className="side-nav-sub">
                    {tabRow(item, role).map((target) => (
                      <li key={target.id}>
                        <Link to={linkTo(target, search)} className="side-nav-link" aria-current={target.id === screen.id ? "page" : undefined}>
                          {target.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0">
        <label className="side-nav-select mb-6">
          <span className="field-label">Раздел</span>
          <select className="select" value={currentEntry?.to ?? ""} onChange={(event) => navigate(event.target.value)}>
            {entries.map((entry) => <option key={entry.to} value={entry.to}>{entry.label}</option>)}
          </select>
        </label>
        {currentTab && !currentTab.listedInSideMenu && <SubRow sectionTab={currentTab} role={role} screen={screen} search={search} />}
        {children}
      </div>
    </div>
  );
}

function FilterNotices() {
  const filter = usePageFilter();
  const notices: ReactNode[] = [];
  if (filter.rejected) {
    // What is on the screen instead: one page, or every page. A screen that waits
    // for a choice shows neither yet, and its table says so.
    const shown = filter.page !== null
      ? ` Показана ${filter.page}.`
      : filter.mode === "one" ? "" : " Показаны все страницы.";
    notices.push(
      <Notice key="rejected" tone="warning" role="status">
        Страница «{filter.rejected}» не найдена или недоступна.{shown}
      </Notice>,
    );
  } else if (filter.substituted !== null) {
    notices.push(
      <Notice key="substituted" role="status">Статистика только по одной странице. Показана {filter.substituted}.</Notice>,
    );
  }
  return notices.length > 0 ? <div className="screen-notices">{notices}</div> : null;
}

/**
 * The frame of every screen of the console: crumbs on a deep screen, the header
 * that stays over the scroll (the title, the screen's button, the period, the
 * page chip), one sentence of why, the dates, the section's tabs and the screen.
 * Reads one table, packages/ui/src/screens.ts.
 */
export function ScreenFrame() {
  usePageFilterSync();
  const location = useLocation();
  const [search] = useSearchParams();
  const { data: auth } = useAuthMe();
  const role = auth?.user.role ?? "team_lead";
  const match = matchScreen(location.pathname);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const [subtitleSlot, setSubtitleSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [windowSlot, setWindowSlot] = useState<HTMLElement | null>(null);
  const filter = usePageFilter();

  const deep = match?.screen.deep === true;
  const frame = useMemo<ScreenFrameValue>(() => ({
    mode: deep ? "deep" : "section",
    slots: { title: titleSlot, subtitle: subtitleSlot, actions: actionsSlot, window: windowSlot },
  }), [actionsSlot, deep, subtitleSlot, titleSlot, windowSlot]);

  const browserTitle = match ? `${match.screen.title}${filter.page ? ` · ${filter.page}` : ""} — Hub` : "Hub";
  // A layout effect: a deep screen's own name (a passive effect in PageHeader) comes after it.
  useLayoutEffect(() => {
    document.title = browserTitle;
  }, [browserTitle]);

  if (!match) return <Outlet />;
  const { screen, params } = match;
  const section = sectionById(screen.section);
  const crumbs = screen.crumbs?.(params);
  const body = (
    <>
      <FilterNotices />
      <PageScopeGate>
        <Suspense fallback={<ScreenFallback />}>
          <Outlet />
        </Suspense>
      </PageScopeGate>
    </>
  );

  return (
    <ScreenFrameContext.Provider value={frame}>
      <div className="min-w-0">
        {crumbs && <Crumbs crumbs={crumbs} />}
        <div className="page-bar">
          {/* The deep screen's own name lands here; until it is known, the screen's kind. */}
          <h1 key={deep ? "deep" : "section"} ref={setTitleSlot} className="page-title empty:before:content-[attr(data-fallback)]" data-fallback={screen.title}>
            {deep ? null : section?.title ?? screen.title}
          </h1>
          <div className="page-controls">
            <div ref={setActionsSlot} className="page-actions" />
            {headerPeriodOf(screen) && <PeriodControl />}
            <PageFilterChip />
          </div>
        </div>
        <div className="page-meta">
          <p key={deep ? "deep" : "section"} ref={setSubtitleSlot} className="page-subtitle">{deep ? null : screen.why}</p>
          <div className="page-window">
            <PeriodMissingNote />
            <span ref={setWindowSlot} />
          </div>
        </div>
        {section?.nav === "tabs" && !deep && (
          <SectionRow section={section} role={role} screen={screen} search={search} />
        )}
        {section?.nav === "side" && !deep
          ? <SideMenu section={section} role={role} screen={screen} search={search}>{body}</SideMenu>
          : body}
      </div>
    </ScreenFrameContext.Provider>
  );
}

