/**
 * What each new address renders today: the existing screen, adapted only in how
 * it gets its page and its period. Each section's rebuild replaces its lines
 * here; no write, check or confirmation changes in this file.
 */
import { Fragment, lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import { useQuery } from "@tanstack/react-query";
import { kernel } from "@/api/sdk";
import { usePageSpenderAutoLists } from "@/api/queries";
import { ScreenFallback } from "@/components/layout/ScreenFrame";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { useRoutePageLabel } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { decodeRouteSegment, buildFanProfileNavigation, syncSettingsTab } from "@/lib/navigation";
import { shiftAnchor, usageDateLabel } from "@/lib/format";
import { useScrollToAnchor } from "@/lib/useScrollToAnchor";

const named = <T extends string>(load: () => Promise<Record<T, ComponentType>>, name: T) =>
  lazy(() => load().then((module) => ({ default: module[name] })));

const OverviewPage = named(() => import("@/pages/OverviewPage"), "OverviewPage");
const TransactionsPage = named(() => import("@/pages/TransactionsPage"), "TransactionsPage");
const SpenderAutoListPage = named(() => import("@/pages/SpenderAutoListPage"), "SpenderAutoListPage");
const DeletedFansPage = named(() => import("@/pages/DeletedFansPage"), "DeletedFansPage");
const SubscribersPage = named(() => import("@/pages/SubscribersPage"), "SubscribersPage");
const FollowersPage = named(() => import("@/pages/FollowersPage"), "FollowersPage");
const FanProfilePage = named(() => import("@/pages/FanProfilePage"), "FanProfilePage");
const TopSupportersPage = named(() => import("@/pages/TopSupportersPage"), "TopSupportersPage");
const UsagePage = named(() => import("@/pages/UsagePage"), "UsagePage");
const AiSpendPage = named(() => import("@/pages/AiSpendPage"), "AiSpendPage");
const AiReconciliationSection = named(() => import("@/pages/AiReconciliationSection"), "AiReconciliationSection");
const OfapiCreditsPage = named(() => import("@/pages/OfapiCreditsPage"), "OfapiCreditsPage");
const OfapiMediaPage = named(() => import("@/pages/OfapiMediaPage"), "OfapiMediaPage");
const OfapiActions = named(() => import("@/pages/OfapiActions"), "OfapiActions");
const OfapiExportsPage = named(() => import("@/pages/OfapiExportsPage"), "OfapiExportsPage");
const ClientHeldSendsPage = named(() => import("@/pages/ClientHeldSendsPage"), "ClientHeldSendsPage");
const TeamShiftsPage = named(() => import("@/pages/team/TeamShiftsPage"), "TeamShiftsPage");
const TeamAuthorsPage = named(() => import("@/pages/team/TeamAuthorsPage"), "TeamAuthorsPage");
const TeamApproachesPage = named(() => import("@/pages/team/TeamApproachesPage"), "TeamApproachesPage");
const TeamNumbersPage = named(() => import("@/pages/team/TeamNumbersPage"), "TeamNumbersPage");
const TeamCustomsPage = named(() => import("@/pages/team/TeamCustomsPage"), "TeamCustomsPage");
const TeamShiftReportsPage = named(() => import("@/pages/team/TeamShiftReportsPage"), "TeamShiftReportsPage");
const TeamSalesPage = named(() => import("@/pages/team/TeamSalesPage"), "TeamSalesPage");
const TeamCoveragePage = named(() => import("@/pages/team/TeamCoveragePage"), "TeamCoveragePage");
const TeamChatterStatsPage = named(() => import("@/pages/team/TeamChatterStatsPage"), "TeamChatterStatsPage");
const TeamTab = named(() => import("@/pages/settings/team/TeamTab"), "TeamTab");
const PublicationsPage = named(() => import("@/pages/publications/PublicationsPage"), "PublicationsPage");
const PublicationSettingsPage = named(() => import("@/pages/publications/PublicationSettingsPage"), "PublicationSettingsPage");
const AnalyticsPage = named(() => import("@/pages/AnalyticsPage"), "AnalyticsPage");
const AgentHydrationPage = named(() => import("@/pages/AgentHydrationPage"), "AgentHydrationPage");
const FailuresPage = named(() => import("@/pages/notifications/NotificationsIncidentsTab"), "NotificationsIncidentsTab");
const LogPage = named(() => import("@/pages/dev/LogPage"), "LogPage");
const QueuePage = named(() => import("@/pages/dev/QueuePage"), "QueuePage");
const DbStatsPage = named(() => import("@/pages/dev/DbStatsPage"), "DbStatsPage");
const SyncAnomaliesPage = named(() => import("@/pages/dev/IncidentsPage"), "IncidentsPage");
const SyncStatusPage = named(() => import("@/pages/dev/SyncStatusPage"), "SyncStatusPage");
const ClientHealthPage = named(() => import("@/pages/dev/ClientHealthPage"), "ClientHealthPage");
const PageBrowserOnboardingPage = named(() => import("@/pages/page-browser/PageBrowserOnboardingPage"), "PageBrowserOnboardingPage");
const PageBrowserDraftPage = named(() => import("@/pages/page-browser/PageBrowserDraftPage"), "PageBrowserDraftPage");
const PagesTab = named(() => import("@/pages/settings/PagesTab"), "PagesTab");
const AiPersonasTab = named(() => import("@/pages/settings/AiPersonasTab"), "AiPersonasTab");
const FeaturesTab = named(() => import("@/pages/settings/FeaturesTab"), "FeaturesTab");
const ConfigurationTab = named(() => import("@/pages/settings/ConfigurationTab"), "ConfigurationTab");
const AiChatterLimitsSection = lazy(() => import("@/pages/AiChatterLimitsSection").then((module) => ({ default: module.AiChatterLimitsSection })));
const NotificationsSettingsSection = named(() => import("@/pages/settings/NotificationsSettingsSection"), "NotificationsSettingsSection");
const EngineTab = named(() => import("@/pages/settings/engine/EngineTab"), "EngineTab");
const EnginePageDetail = lazy(() => import("@/pages/settings/engine/EnginePageDetail").then((module) => ({ default: module.EnginePageDetail })));
const SyncTab = named(() => import("@/pages/settings/SyncTab"), "SyncTab");
const TechnicalTab = named(() => import("@/pages/settings/team/TechnicalTab"), "TechnicalTab");
const CollectionTab = named(() => import("@/pages/settings/CollectionTab"), "CollectionTab");
const OfapiApiTab = named(() => import("@/pages/settings/OfapiApiTab"), "OfapiApiTab");
const WebhookCard = lazy(() => import("@/pages/settings/collection/CollectionTab").then((module) => ({ default: module.WebhookCard })));
const PageSpenderAutoListsSection = lazy(() => import("@/pages/PageDetailPage").then((module) => ({ default: module.PageSpenderAutoListsSection })));

export { OverviewPage, TransactionsPage, ClientHeldSendsPage, TeamCoveragePage, TeamSalesPage, TeamApproachesPage, TeamCustomsPage, TeamShiftReportsPage, TeamNumbersPage, AgentHydrationPage, FailuresPage, QueuePage, DbStatsPage, ClientHealthPage, PageBrowserOnboardingPage, PagesTab, FeaturesTab, ConfigurationTab, NotificationsSettingsSection, TechnicalTab, CollectionTab, OfapiApiTab, OfapiMediaPage, OfapiExportsPage, OfapiActions, FanProfilePage, TeamChatterStatsPage, AnalyticsPage, PageBrowserDraftPage, SyncStatusPage, TeamTab, AiPersonasTab };

/** A one-page list starts anew when its page changes: no row, panel or draft of
 *  another page survives. */
function OnePage({ children }: { children: ReactNode }) {
  const pageLabel = useRoutePageLabel();
  if (!pageLabel) return null;
  return <Fragment key={pageLabel}>{children}</Fragment>;
}

export function PayingFansScreen() {
  return <OnePage><TopSupportersPage /></OnePage>;
}
export function SubscribersScreen() {
  return <OnePage><SubscribersPage /></OnePage>;
}
export function FollowersScreen() {
  return <OnePage><FollowersPage /></OnePage>;
}
export function GoneFansScreen() {
  return <OnePage><DeletedFansPage /></OnePage>;
}

/** The lists by the sum spent, of one page. Their period is their own. */
export function BySpendScreen() {
  const pageLabel = useRoutePageLabel() ?? "";
  const { key } = useScreenPeriod();
  const spender = key === "all" ? "lifetime" : (key as "today" | "7d" | "30d" | "90d" | "180d");
  const lists = usePageSpenderAutoLists(pageLabel, { period: spender }, { enabled: pageLabel.length > 0 });
  if (lists.isLoading) return <TableSkeleton rows={4} columns={3} />;
  if (lists.isError && !lists.data) return <NoAnswerPanel retry={lists.refetch} />;
  return <PageSpenderAutoListsSection pageLabel={pageLabel} autoLists={lists.data} period={key} />;
}

export function BySpendListScreen() {
  return <OnePage><SpenderAutoListPage /></OnePage>;
}

/** A fan with no page in the address: opens the page where they spent the most. */
export function FanAnyPageScreen() {
  const { platform = "", platformUserId = "" } = useParams<{ platform: string; platformUserId: string }>();
  const location = useLocation();
  const detail = useQuery({
    queryKey: ["crossPageFanDetail", platform, platformUserId],
    queryFn: () => kernel.crossPageFanDetail({ params: { platform, platformUserId } as Parameters<typeof kernel.crossPageFanDetail>[0]["params"] }),
    meta: { suppressGlobalError: true },
    retry: false,
  });
  if (detail.isLoading) return <ScreenFallback />;
  const top = [...(detail.data?.pages ?? [])].sort((a, b) => b.totalCreatorNetMills - a.totalCreatorNetMills)[0];
  if (!top) {
    return (
      <StatusPanel
        title={detail.isError ? "Hub не ответил" : "Такого фана нет на ваших страницах"}
        action={<Link to="/fans" className="btn btn-sm">К фанам</Link>}
      />
    );
  }
  const target = buildFanProfileNavigation(top.pageLabel, platform, platformUserId, "/fans");
  return <Navigate to={target.to} state={location.state ?? target.state} replace />;
}

/** «ИИ» of the costs, until its two old screens become one: both, a click apart. */
export function AiCostsScreen() {
  const [search, setSearch] = useSearchParams();
  const view = search.get("view") === "people" ? "people" : "spend";
  return (
    <div className="space-y-6">
      <Segmented
        label="Что показать"
        value={view}
        onChange={(next) => {
          const query = new URLSearchParams(search);
          if (next === "people") query.set("view", next);
          else query.delete("view");
          setSearch(query);
        }}
        options={[
          { value: "spend", label: "На что ушло" },
          { value: "people", label: "Счета и сотрудники" },
        ]}
      />
      {view === "spend" ? <AiSpendPage /> : <UsagePage />}
    </div>
  );
}

export function AnthropicReconciliationScreen() {
  return <AiReconciliationSection />;
}

function OfapiOffNotice({ children }: { children?: ReactNode }) {
  return (
    <Notice tone="off">
      <b>OnlyFans API выключен с 1 ноября.</b> {children}
    </Notice>
  );
}

export function OnlyFansApiCostsScreen() {
  return (
    <div className="space-y-6">
      <OfapiOffNotice>Суммы и кредиты здесь — по 1 ноября.</OfapiOffNotice>
      <OfapiCreditsPage />
    </div>
  );
}

/** «Состояние»: says it plainly and leads to where everything lies. */
export function OnlyFansApiStatusScreen() {
  return (
    <div className="space-y-6">
      <OfapiOffNotice>
        Hub больше не собирает через него данные и не тратит кредиты. Переписка, деньги и фаны OnlyFans идут из ленты
        ChatSpace, код остаётся на случай возврата.
      </OfapiOffNotice>
      <WebhookCard />
      <p className="text-sm text-text-secondary">
        Кредиты и журнал операций — в <Link className="link" to="/money/costs/onlyfans-api">Деньги → Расходы → OnlyFans API</Link>.
      </p>
    </div>
  );
}

/** Команда → Смены: who worked, and at #authors the messages nobody signed. */
export function ShiftsScreen() {
  const location = useLocation();
  const authors = location.hash === "#authors";
  useScrollToAnchor("authors", authors);
  return (
    <div className="space-y-6">
      <TeamShiftsPage />
      <details id="authors" className="help scroll-mt-16" open={authors}>
        <summary>Сообщения без автора</summary>
        <div className="mt-4"><Suspense fallback={<ScreenFallback />}><TeamAuthorsPage /></Suspense></div>
      </details>
    </div>
  );
}

export function PublicationsScreen() {
  const [search] = useSearchParams();
  if (search.get("panel") === "settings") {
    return (
      <>
        <PageHeader actions={<Link to="/publications" className="btn">К расписанию</Link>} />
        <PublicationSettingsPage />
      </>
    );
  }
  return (
    <>
      <PageHeader actions={<Link to="/publications?panel=settings" className="btn">Настройки публикации</Link>} />
      <PublicationsPage />
    </>
  );
}

/** A day's personal AI limits: the day is the screen's own, in the address. */
export function AiLimitsScreen() {
  const [search, setSearch] = useSearchParams();
  const today = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
  const asked = search.get("day");
  const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= today ? asked : today;
  const go = (next: string) => {
    const query = new URLSearchParams(search);
    if (next === today) query.delete("day");
    else query.set("day", next);
    setSearch(query);
  };
  return (
    <>
      <PageHeader
        actions={(
          <span className="period-stepper">
            <button type="button" className="btn btn-icon" aria-label="Предыдущий день" onClick={() => go(shiftAnchor(day, "day", -1))}><ChevronLeft size={16} aria-hidden="true" /></button>
            <span className="min-w-[96px] text-center text-sm tabular-nums" aria-live="polite">{usageDateLabel(day, "day")}</span>
            <button type="button" className="btn btn-icon" aria-label="Следующий день" disabled={day >= today} onClick={() => go(shiftAnchor(day, "day", 1))}><ChevronRight size={16} aria-hidden="true" /></button>
          </span>
        )}
      />
      <AiChatterLimitsSection day={day} />
    </>
  );
}

/** All the pages' collection, until the two old lists become one table. */
export function CollectionScreen() {
  return (
    <div className="space-y-8">
      <section className="space-y-4" aria-labelledby="collection-fansly">
        <h2 id="collection-fansly" className="section-title">Fansly</h2>
        <EngineTab />
      </section>
      <section className="space-y-4" aria-labelledby="collection-onlyfans">
        <h2 id="collection-onlyfans" className="section-title">OnlyFans</h2>
        <SyncTab />
      </section>
    </div>
  );
}

/** One page's collection. The page is in the path, so a lever here has no other target. */
export function CollectionPageScreen() {
  const { pageLabel: raw = "" } = useParams<{ pageLabel: string }>();
  const pageLabel = decodeRouteSegment(raw);
  const { findPageByLabel, pageCatalogState } = useDashboardShell();
  const navigate = useNavigate();
  const page = findPageByLabel(pageLabel);
  if (pageCatalogState === "loading") return <ScreenFallback />;
  const header = <PageHeader title={pageLabel} />;
  if (!page) {
    return (
      <>
        {header}
        <StatusPanel title="Такой страницы нет" action={<Link to="/system/collection" className="btn btn-sm">Ко всем страницам</Link>} />
      </>
    );
  }
  if (syncSettingsTab(page.platform) === "engine") {
    return <>{header}<EnginePageDetail pageLabel={pageLabel} onBack={() => navigate("/system/collection")} /></>;
  }
  return <>{header}<SyncTab /></>;
}

/** The old log and its anomalies: one screen, `?problems=1` is only the problems. */
export function DevLogScreen() {
  const [search, setSearch] = useSearchParams();
  const problems = search.get("problems") === "1";
  return (
    <div className="space-y-6">
      <Segmented
        label="Что показать"
        value={problems ? "problems" : "all"}
        onChange={(next) => {
          const query = new URLSearchParams(search);
          if (next === "problems") query.set("problems", "1");
          else query.delete("problems");
          setSearch(query);
        }}
        options={[
          { value: "all", label: "Все события" },
          { value: "problems", label: "Только проблемы" },
        ]}
      />
      {problems ? <SyncAnomaliesPage /> : <LogPage />}
    </div>
  );
}

export function PersonaScreen() {
  const { key = "" } = useParams<{ key: string }>();
  return (
    <>
      <PageHeader title={decodeRouteSegment(key)} />
      <AiPersonasTab />
    </>
  );
}

export function FeatureScreen() {
  return <ConfigurationTab />;
}

