import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import {
  Link,
  useLocation,
  useNavigationType,
  useSearchParams,
} from "react-router";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import type { OverviewRevenueResponse } from "@agency_hub_core/contracts";
import { useAuthMe, useOverview, useOverviewRevenue } from "@/api/queries";
import { usePeriodStore, type PeriodOption } from "@/stores/periodStore";
import { PageHeader } from "@/components/ui/PageHeader";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import {
  isAlertState,
  syncStateLabel,
  syncTone,
} from "@/components/shared/syncUxDisplay";
import { buildPageRoute } from "@/lib/navigation";
import {
  buildRevenueTransactionsRoute,
  overviewSearch,
  parseOverviewState,
  PERIOD_LABELS,
  type OverviewState,
  type PageSort,
} from "@/lib/overviewNavigation";
import {
  biggestMovers,
  describeMixedRevenueWindows,
  describeWindows,
  formatPct,
  groupRevenue,
  money,
  plural,
  signedMoney,
  type PageRow,
} from "./overview/presentation.js";
import { AudienceLink, PageSources } from "./overview/PageSources.js";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { RevenueDelta } from "./overview/RevenueValue.js";
import { RevenueCharts } from "./overview/RevenueCharts.js";
import "./overview.css";

export { describeMixedRevenueWindows } from "./overview/presentation.js";

// Contains only UI position, never API data or account information. Kept per
// exact URL so Back, reload, and another tab's period cannot overwrite it.
function positionKey(search: string) {
  return `hub-overview-position:${search}`;
}
function readPosition(search: string): { y: number; focus: string } | null {
  try {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem(positionKey(search)) ?? "null",
    );
    if (
      saved &&
      typeof saved === "object" &&
      "y" in saved &&
      typeof saved.y === "number" &&
      Number.isFinite(saved.y) &&
      "focus" in saved &&
      typeof saved.focus === "string"
    )
      return { y: saved.y, focus: saved.focus };
  } catch {
    /* Storage can be disabled; navigation still works. */
  }
  return null;
}

/** Three states of one header: the server's order, then decline first, then
 *  growth first. Pages are sorted inside their model. */
const NEXT_SORT: Record<PageSort, PageSort> = {
  source: "decline",
  decline: "growth",
  growth: "source",
};
const SORT_TEXT: Record<PageSort, string> = {
  source: "без сортировки",
  decline: "сначала падение",
  growth: "сначала рост",
};

function Delta({ mills, pct }: { mills: number; pct: number | null | undefined }) {
  return (
    <>
      <span className={mills < 0 ? "text-danger" : mills > 0 ? "text-green" : ""}>
        {signedMoney(mills)}
      </span>
      {pct != null && ` (${formatPct(pct)})`}
    </>
  );
}

/** KPI tiles built only from the report: no figure here is computed in the
 *  browser beyond picking the pages with the largest server-side change. */
function OverviewKpis({
  report,
  period,
}: {
  report: OverviewRevenueResponse;
  period: PeriodOption;
}) {
  const comparison = report.comparison;
  const movers = biggestMovers(report.pages);
  const noComparison =
    period === "all" ? "Для «Всё время» сравнения нет" : "Сравнение недоступно";
  return (
    <div className="stat-grid max-sm:grid-cols-2">
      <div className="stat">
        <p className="stat-label">
          Доход · {PERIOD_LABELS[period].toLowerCase()}
        </p>
        <p className="stat-value">{money(report.netEarningsMills)}</p>
        <p className="stat-meta">
          {comparison ? (
            <>
              <Delta mills={comparison.deltaNetMills} pct={comparison.deltaPct} />{" "}
              к прошлому периоду
            </>
          ) : (
            noComparison
          )}
        </p>
      </div>
      <div className="stat">
        <p className="stat-label">Прошлый период</p>
        <p className="stat-value">{money(comparison?.netEarningsMills)}</p>
        {comparison && (
          <p className="stat-meta">
            {describeWindows(report.platformWindows, true)}
          </p>
        )}
      </div>
      <div className="stat">
        <p className="stat-label">Больше всего выросла</p>
        <p className="stat-value text-lg leading-8 max-sm:text-base">
          {movers.growth?.pageLabel ?? "—"}
        </p>
        {(movers.growth || comparison) && (
          <p className="stat-meta">
            {movers.growth ? (
              <Delta
                mills={movers.growth.deltaNetMills!}
                pct={movers.growth.deltaPct}
              />
            ) : (
              "Роста нет"
            )}
          </p>
        )}
      </div>
      <div className="stat">
        <p className="stat-label">Больше всего снизилась</p>
        <p className="stat-value text-lg leading-8 max-sm:text-base">
          {movers.decline?.pageLabel ?? "—"}
        </p>
        {(movers.decline || comparison) && (
          <p className="stat-meta">
            {movers.decline ? (
              <Delta
                mills={movers.decline.deltaNetMills!}
                pct={movers.decline.deltaPct}
              />
            ) : (
              "Снижения нет"
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function LoadingReport() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Загружаем доход…</span>
      <div className="stat-grid max-sm:grid-cols-2" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="stat">
            <div className="h-3 w-24 animate-pulse rounded bg-hover" />
            <div className="mt-3 h-7 w-28 animate-pulse rounded bg-hover" />
          </div>
        ))}
      </div>
      <div aria-hidden="true">
        <TableSkeleton rows={4} columns={5} />
      </div>
    </div>
  );
}

export function OverviewPage() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const navigationType = useNavigationType();
  const storedPeriod = usePeriodStore((store) => store.period);
  const state = parseOverviewState(search, storedPeriod);
  const catalog = useOverview();
  const revenue = useOverviewRevenue(state.period);
  const user = useAuthMe();
  const report = revenue.isPlaceholderData ? undefined : revenue.data;
  const groups = report
    ? groupRevenue(report, catalog.data?.pages ?? [], state.sort)
    : [];
  const backTo = `/?${overviewSearch(state)}`;
  const root = useRef<HTMLDivElement>(null);
  const lastFocus = useRef("");
  const restored = useRef<string | null>(null);
  const entryKey = useRef(location.key);
  const ready = Boolean(report);
  const expandedPageId = report?.pages.find(
    (page) => page.pageLabel === state.row,
  )?.pageId;
  const refreshing = Boolean(revenue.isFetching || catalog.isFetching);

  useEffect(() => {
    if (!report?.windowAt || state.period === "all") return;
    const windowDay = report.windowAt.slice(0, 10);
    function refreshIfNewDay() {
      if (
        document.visibilityState === "visible" &&
        new Date().toISOString().slice(0, 10) !== windowDay
      )
        void revenue.refetch();
    }
    const nextDay = new Date();
    nextDay.setUTCHours(24, 0, 1, 0);
    const timer = window.setTimeout(
      refreshIfNewDay,
      windowDay === new Date().toISOString().slice(0, 10)
        ? nextDay.getTime() - Date.now()
        : 0,
    );
    document.addEventListener("visibilitychange", refreshIfNewDay);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshIfNewDay);
    };
  }, [report?.windowAt, state.period, revenue.refetch]);

  useEffect(() => {
    if (!search.has("period"))
      setSearch(overviewSearch(state), { replace: true });
  }, [search, state.period, setSearch]);

  useLayoutEffect(() => {
    function save() {
      try {
        sessionStorage.setItem(
          positionKey(location.search),
          JSON.stringify({ y: window.scrollY, focus: lastFocus.current }),
        );
      } catch {
        /* Position persistence is optional. */
      }
    }
    window.addEventListener("pagehide", save);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
    };
  }, [location.search]);

  useEffect(() => {
    if (!ready || restored.current === location.key) return;
    restored.current = location.key;
    if (navigationType !== "POP" && location.key !== entryKey.current) return;
    const saved = readPosition(location.search);
    if (saved) {
      const restore = () => {
        window.scrollTo({ top: saved.y, behavior: "instant" });
        const focus = document.getElementById(saved.focus);
        if (focus && document.activeElement !== focus)
          focus.focus({ preventScroll: true });
      };
      // The report mounts before lazy charts and source queries settle. Retry
      // after layout growth so the browser's early height clamp is not final.
      // A user's first interaction takes control and cancels restoration.
      restore();
      const observer = new ResizeObserver(restore);
      if (root.current) observer.observe(root.current);
      const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
      const stop = () => {
        observer.disconnect();
        for (const event of events) window.removeEventListener(event, stop);
      };
      for (const event of events)
        window.addEventListener(event, stop, { once: true, passive: true });
      return stop;
    } else if (expandedPageId != null) {
      const button = document.getElementById(`expand-${expandedPageId}`);
      button?.scrollIntoView({ block: "center", behavior: "instant" });
      button?.focus({ preventScroll: true });
    }
  }, [ready, location.key, location.search, navigationType, expandedPageId]);

  function update(patch: Partial<OverviewState>) {
    setSearch(overviewSearch({ ...state, ...patch }));
  }
  function amount(page: PageRow, previous = false) {
    const value = previous
      ? page.previousNetEarningsMills
      : page.netEarningsMills;
    const platform = page.platform ?? page.catalog?.platform;
    const window = report?.platformWindows.find(
      (item) => item.platform === platform,
    );
    if (!window || value == null) return money(value);
    const to = buildRevenueTransactionsRoute({
      pageLabel: page.pageLabel,
      from: previous ? window.comparisonFrom : window.from,
      to: previous ? window.comparisonTo : window.to,
      backTo,
    });
    return (
      <Link
        id={`${previous ? "previous" : "current"}-money-${page.pageId}`}
        className="ov-money-link"
        to={to}
        title="Открыть операции за этот период"
      >
        {money(value)}
      </Link>
    );
  }

  const mixedWindows = report
    ? describeMixedRevenueWindows(
        report.platformWindows,
        PERIOD_LABELS[state.period],
      )
    : null;

  return (
    <div
      ref={root}
      className="space-y-6"
      onFocusCapture={(event) => {
        if (event.target.id) lastFocus.current = event.target.id;
      }}
    >
      <PageHeader
        title="Обзор"
        description="Доход агентства после комиссии платформ"
        actions={
          <button
            id="overview-refresh"
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={refreshing}
            onClick={() =>
              void Promise.all([revenue.refetch(), catalog.refetch()])
            }
          >
            <RefreshCw
              size={14}
              aria-hidden="true"
              className={refreshing ? "animate-spin" : ""}
            />
            {refreshing && report ? "Обновляем…" : "Обновить"}
          </button>
        }
      />
      {catalog.isError && (
        <div>
          <p className="mb-1 text-[13px] font-medium text-text-secondary">
            Подписчики и состояние сбора данных
          </p>
          <QueryNotice
            error
            stale={Boolean(catalog.data)}
            retry={catalog.refetch}
          />
        </div>
      )}
      <QueryNotice
        error={Boolean(revenue.isError)}
        stale={Boolean(report)}
        retry={revenue.refetch}
      />
      {!report && revenue.isFetching && <LoadingReport />}
      {report && report.pages.length === 0 && (
        <StatusPanel
          title="Нет страниц в доступной области"
          description="Добавьте страницу в настройках или проверьте доступ."
        />
      )}
      {report && report.pages.length > 0 && (
        <>
          <OverviewKpis report={report} period={state.period} />
          {state.row &&
            !report.pages.some((page) => page.pageLabel === state.row) && (
              <div className="notice" role="status">
                <span className="min-w-0 flex-1">
                  Страница из ссылки недоступна в текущей области.
                </span>
                <button
                  type="button"
                  className="link shrink-0"
                  onClick={() => update({ row: null })}
                >
                  Закрыть
                </button>
              </div>
            )}
          <div className="space-y-3">
            <div className="table-wrap">
              <table
                className="data-table ov-table"
                aria-label={`Страницы агентства, доход за период ${PERIOD_LABELS[state.period]}`}
              >
                <thead>
                  <tr>
                    <th scope="col">Страница</th>
                    <th scope="col" className="num">
                      Доход
                    </th>
                    <th scope="col" className="num ov-wide">
                      Прошлый период
                    </th>
                    <th
                      scope="col"
                      className="num"
                      aria-sort={
                        state.sort === "source"
                          ? "none"
                          : state.sort === "decline"
                            ? "ascending"
                            : "descending"
                      }
                    >
                      <button
                        id="overview-sort"
                        type="button"
                        className="ov-sort"
                        data-active={state.sort !== "source"}
                        title={`Порядок страниц внутри модели: ${SORT_TEXT[state.sort]}. Нажмите — ${SORT_TEXT[NEXT_SORT[state.sort]]}.`}
                        onClick={() => update({ sort: NEXT_SORT[state.sort] })}
                      >
                        Изменение
                        {state.sort === "source" ? (
                          <ArrowUpDown size={13} aria-hidden="true" />
                        ) : state.sort === "decline" ? (
                          <ArrowUp size={13} aria-hidden="true" />
                        ) : (
                          <ArrowDown size={13} aria-hidden="true" />
                        )}
                        <span className="sr-only">, {SORT_TEXT[state.sort]}</span>
                      </button>
                    </th>
                    <th scope="col" className="num ov-wide">
                      Подписчики
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map(({ model, pages }) => (
                    <Fragment key={model.modelSlug}>
                      <tr className="ov-model-row">
                        <td>
                          <span className="ov-model-name">{model.modelName}</span>
                          <span className="ov-model-meta">
                            {model.pageCount}{" "}
                            {plural(model.pageCount, "страница", "страницы", "страниц")}
                            {model.status === "retired" ? " · в архиве" : ""}
                          </span>
                        </td>
                        <td className="num">{money(model.netEarningsMills)}</td>
                        <td className="num ov-wide">
                          {money(model.previousNetEarningsMills)}
                        </td>
                        <td className="num">
                          <RevenueDelta {...model} />
                        </td>
                        <td className="ov-wide" />
                      </tr>
                      {pages.map((page) => {
                        const expanded = state.row === page.pageLabel;
                        const platform = page.platform ?? page.catalog?.platform;
                        const sync = page.catalog?.syncUx;
                        return (
                          <Fragment key={page.pageId}>
                            <tr
                              className={`ov-page-row${expanded ? " ov-expanded" : ""}`}
                            >
                              <td>
                                <div className="ov-page-cell">
                                  <button
                                    id={`expand-${page.pageId}`}
                                    type="button"
                                    className="ov-expander"
                                    aria-label={`${expanded ? "Свернуть" : "Раскрыть"} источники дохода ${page.pageLabel}`}
                                    aria-expanded={expanded}
                                    aria-controls={
                                      expanded
                                        ? `sources-${page.pageId}`
                                        : undefined
                                    }
                                    onClick={() =>
                                      update({
                                        row: expanded ? null : page.pageLabel,
                                      })
                                    }
                                  >
                                    <ChevronRight size={16} aria-hidden="true" />
                                  </button>
                                  <div className="ov-page-name">
                                    {page.status === "deleted" ? (
                                      <>
                                        <span className="text-text-secondary">
                                          {page.pageLabel}
                                        </span>
                                        <span className="badge">Архив</span>
                                      </>
                                    ) : (
                                      <Link
                                        className="ov-page-link"
                                        to={`${buildPageRoute(page.pageLabel)}?${new URLSearchParams({ period: state.period })}`}
                                        state={{ backTo }}
                                      >
                                        {page.pageLabel}
                                      </Link>
                                    )}
                                    {platform && <PlatformBadge platform={platform} />}
                                    {sync && isAlertState(sync) && (
                                      <span
                                        className={`badge ${syncTone(sync) === "error" ? "badge-danger" : "badge-warning"}`}
                                        title={sync.detail ?? undefined}
                                      >
                                        {syncStateLabel(sync, platform)}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="num">{amount(page)}</td>
                              <td className="num muted ov-wide">
                                {amount(page, true)}
                              </td>
                              <td className="num">
                                <RevenueDelta {...page} />
                              </td>
                              <td className="num ov-wide">
                                <AudienceLink page={page} backTo={backTo} />
                              </td>
                            </tr>
                            {expanded && (
                              <PageSources
                                page={page}
                                period={state.period}
                                windowAt={report.windowAt}
                                windows={report.platformWindows}
                                backTo={backTo}
                                isOwner={user.data?.user.role === "owner"}
                              />
                            )}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ))}
                  <tr className="ov-total-row">
                    <td>Всего по агентству</td>
                    <td className="num">{money(report.netEarningsMills)}</td>
                    <td className="num ov-wide">
                      {money(report.comparison?.netEarningsMills)}
                    </td>
                    <td className="num">
                      <RevenueDelta
                        deltaNetMills={report.comparison?.deltaNetMills}
                        deltaPct={report.comparison?.deltaPct}
                      />
                    </td>
                    <td className="ov-wide" />
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="ov-footnote">
              {state.period === "all"
                ? "Вся сохранённая история"
                : `${describeWindows(report.platformWindows)} (UTC)`}
              . Суммы включают ожидающие подтверждения операции и корректировки.
            </p>
            <details className="help">
              <summary>О данных</summary>
              <div className="help-body">
                <p>
                  Это доход после комиссии платформ — не прибыль агентства и не
                  сумма к выплате. В него входят ожидающие подтверждения
                  операции, возвраты, чарджбэки и суммы без классификации.
                </p>
                <p>
                  Суммы считаются по операциям, которые сохранил Hub; полноту
                  сбора с платформы это не подтверждает. Даты — по UTC, текущий
                  день ещё идёт.
                </p>
                <p>
                  Прошлый период — столько же дней непосредственно перед
                  выбранными.{mixedWindows ? ` ${mixedWindows}` : ""}
                </p>
                <p>
                  Подписчики — текущий доступ к странице, включая бесплатный и
                  пробный; от выбранного периода не зависят. Аудитория разных
                  страниц не складывается.
                </p>
                <p>Прочерк означает, что значение недоступно.</p>
              </div>
            </details>
          </div>
          <RevenueCharts
            report={report}
            period={state.period}
            scope={state.chart}
            selectScope={(scope) => update({ chart: scope })}
          />
        </>
      )}
    </div>
  );
}
