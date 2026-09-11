import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import {
  Link,
  useLocation,
  useNavigationType,
  useSearchParams,
} from "react-router";
import { useAuthMe, useOverview, useOverviewRevenue } from "@/api/queries";
import { usePeriodStore } from "@/stores/periodStore";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { isAlertState } from "@/components/shared/syncUxDisplay";
import { buildPageRoute } from "@/lib/navigation";
import { PLATFORM_DISPLAY_NAME } from "@/lib/platformUrls";
import {
  buildRevenueTransactionsRoute,
  overviewSearch,
  parseOverviewState,
  PERIOD_LABELS,
  type OverviewState,
} from "@/lib/overviewNavigation";
import {
  groupRevenue,
  money,
  describeWindows,
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
  const chartRequested = useRef(false);
  const ready = Boolean(report);
  const expandedPageId = report?.pages.find(
    (page) => page.pageLabel === state.row,
  )?.pageId;

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
    if (chartRequested.current) {
      chartRequested.current = false;
      document
        .getElementById("overview-chart")
        ?.scrollIntoView({ block: "start", behavior: "instant" });
      document
        .getElementById("overview-chart-scope")
        ?.focus({ preventScroll: true });
      return;
    }
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
  function showChart(scope: string, scroll = true) {
    chartRequested.current = scroll;
    if (scope === state.chart && scroll) {
      document
        .getElementById("overview-chart")
        ?.scrollIntoView({ block: "start", behavior: "instant" });
      document
        .getElementById("overview-chart-scope")
        ?.focus({ preventScroll: true });
      chartRequested.current = false;
    } else update({ chart: scope });
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
        className="v1-audience-link"
        to={to}
        title="Операции за это окно и итог по всему списку"
      >
        {money(value)}
      </Link>
    );
  }

  return (
    <div
      ref={root}
      className="v1-overview"
      onFocusCapture={(event) => {
        if (event.target.id) lastFocus.current = event.target.id;
      }}
    >
      <div className="v1-toolbar">
        <span className="text-text-muted">По сохранённым операциям Hub</span>
        <button
          id="overview-refresh"
          type="button"
          className="v1-text-button"
          disabled={revenue.isFetching || catalog.isFetching}
          onClick={() =>
            void Promise.all([revenue.refetch(), catalog.refetch()])
          }
        >
          Обновить
        </button>
      </div>
      <QueryNotice
        error={catalog.isError}
        stale={Boolean(catalog.data)}
        retry={catalog.refetch}
      />
      {catalog.isError && (
        <p className="v1-zero-note">
          Метаданные аудитории и сбора недоступны или устарели. Доход
          загружается отдельно.
        </p>
      )}
      <QueryNotice
        error={revenue.isError}
        stale={Boolean(report)}
        retry={revenue.refetch}
      />
      {revenue.isFetching && (
        <p className="v1-loading-note" role="status">
          {report ? "Обновляем выбранное окно…" : "Загружаем доход…"}
        </p>
      )}
      {report && report.pages.length === 0 && (
        <StatusPanel
          title="Нет страниц в доступной области"
          description="Добавьте страницу в настройках или проверьте доступ."
        />
      )}
      {report && report.pages.length > 0 && (
        <>
          {state.row &&
            !report.pages.some((page) => page.pageLabel === state.row) && (
              <p className="v1-query-error" role="status">
                Страница из ссылки недоступна в текущей области.{" "}
                <button
                  className="v1-text-button"
                  onClick={() => update({ row: null })}
                >
                  Закрыть раскрытие
                </button>
              </p>
            )}
          <div className="v1-table-wrap">
            <table
              className="v1-table"
              aria-label={`Страницы агентства, доход за период ${PERIOD_LABELS[state.period]}`}
            >
              <colgroup>
                <col className="v1-page-col" />
                <col className="v1-money-col" />
                <col className="v1-money-col v1-previous-col" />
                <col className="v1-change-col" />
                <col className="v1-access-col" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Страница</th>
                  <th scope="col">
                    Доход
                    <br />
                    {PERIOD_LABELS[state.period]}
                  </th>
                  <th scope="col" className="v1-previous">
                    Предыдущее
                    <br />
                    окно
                  </th>
                  <th
                    scope="col"
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
                      className="v1-sort-button"
                      title="Сортировать страницы внутри модели по изменению суммы"
                      onClick={() =>
                        update({
                          sort:
                            state.sort === "source"
                              ? "decline"
                              : state.sort === "decline"
                                ? "growth"
                                : "source",
                        })
                      }
                    >
                      Изменение{" "}
                      {state.sort === "source"
                        ? "↕"
                        : state.sort === "decline"
                          ? "↑"
                          : "↓"}
                    </button>
                  </th>
                  <th scope="col" className="v1-access">
                    Подписчики
                    <br />
                    страницы
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map(({ model, pages }) => (
                  <Fragment key={model.modelSlug}>
                    <tr className="v1-group-row">
                      <td>
                        <span className="v1-model-name">{model.modelName}</span>
                        <span className="v1-page-count">
                          {model.pageCount} стр.
                          {model.status === "retired" ? " · архив" : ""}
                        </span>
                      </td>
                      <td className="v1-number">
                        {money(model.netEarningsMills)}
                      </td>
                      <td className="v1-number v1-previous">
                        {money(model.previousNetEarningsMills)}
                      </td>
                      <td className="v1-number">
                        <RevenueDelta {...model} />
                      </td>
                      <td className="v1-number v1-access v1-audience-total">
                        —
                      </td>
                    </tr>
                    {pages.map((page) => {
                      const expanded = state.row === page.pageLabel;
                      const platform = page.platform ?? page.catalog?.platform;
                      const sync = page.catalog?.syncUx;
                      return (
                        <Fragment key={page.pageId}>
                          <tr
                            className={`v1-page-row${expanded ? " v1-expanded" : ""}`}
                          >
                            <td>
                              <div className="v1-page-cell">
                                <button
                                  id={`expand-${page.pageId}`}
                                  type="button"
                                  className="v1-expander"
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
                                  <span aria-hidden="true">
                                    {expanded ? "⌄" : "›"}
                                  </span>
                                </button>
                                <span
                                  className={`v1-sync-dot ${sync && isAlertState(sync) ? "v1-sync-attention" : sync?.state === "healthy" ? "v1-sync-ok" : "v1-sync-off"}`}
                                  role="img"
                                  aria-label={`Сбор: ${sync?.label ?? "неизвестно"}`}
                                  title={`Сбор: ${sync?.label ?? "неизвестно"}. Не подтверждает полноту дохода.`}
                                />
                                <div className="v1-page-identity">
                                  {page.status === "deleted" ? (
                                    <span className="v1-page-link">
                                      {page.pageLabel} · архив
                                    </span>
                                  ) : (
                                    <Link
                                      className="v1-page-link"
                                      to={buildPageRoute(page.pageLabel)}
                                      state={{ backTo }}
                                    >
                                      {page.pageLabel}
                                    </Link>
                                  )}
                                  {platform && (
                                    <span
                                      className={`v1-platform v1-${platform}`}
                                    >
                                      {PLATFORM_DISPLAY_NAME[platform]}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="v1-number v1-money-current">
                              {amount(page)}
                            </td>
                            <td className="v1-number v1-money-previous v1-previous">
                              {amount(page, true)}
                            </td>
                            <td className="v1-number">
                              <RevenueDelta {...page} />
                            </td>
                            <td className="v1-number v1-access">
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
                              showChart={showChart}
                              isOwner={user.data?.user.role === "owner"}
                            />
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                ))}
                <tr className="v1-total-row">
                  <td className="v1-total-label">Всего по агентству</td>
                  <td className="v1-number">
                    {money(report.netEarningsMills)}
                  </td>
                  <td className="v1-number v1-previous">
                    {money(report.comparison?.netEarningsMills)}
                  </td>
                  <td className="v1-number">
                    <RevenueDelta
                      deltaNetMills={report.comparison?.deltaNetMills}
                      deltaPct={report.comparison?.deltaPct}
                    />
                  </td>
                  <td className="v1-number v1-access v1-audience-total">—</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="v1-under-table">
            <p>
              <strong>Доход после комиссии платформ</strong>, включая pending,
              корректировки и неклассифицированные суммы. Не прибыль агентства и
              не сумма к выплате.
            </p>
            <p>
              {describeWindows(report.platformWindows)}. Даты UTC; текущий день
              не завершён.
            </p>
            <details>
              <summary>О данных и подписках</summary>
              <p>
                Суммы и сравнения — по сохранённым операциям Hub, без гарантии
                полноты захвата. Прочерк означает недоступное значение.
                Подписчики — текущий доступ к странице, включая бесплатный и
                пробный; число не зависит от выбранного периода. Аудитория
                разных страниц не складывается.
              </p>
              <p>
                У Fansly 7/30 дат, у OnlyFans 8/31; предыдущие окна имеют ту же
                длину для каждой платформы. Таблица, источники и графики
                загружаются отдельно и могут обновляться в разное время. Дата
                окна не является временем последнего сбора.
              </p>
            </details>
          </div>
          <RevenueCharts
            report={report}
            period={state.period}
            scope={state.chart}
            selectScope={(scope, scroll = false) => showChart(scope, scroll)}
          />
        </>
      )}
    </div>
  );
}
