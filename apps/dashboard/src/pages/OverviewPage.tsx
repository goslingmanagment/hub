import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Link, useLocation, useNavigationType, useSearchParams } from "react-router";
import { ArrowUpDown, ChevronRight, TrendingDown, TrendingUp } from "lucide-react";
import { CHATTER_SHIFT_END_IDLE_MINUTES, type OverviewRevenueResponse } from "@agency_hub_core/contracts";
import { millsFromDollars, millsToNumber } from "@agency_hub_core/shared";
import { useAuthMe, useOverview, useOverviewRevenue } from "@/api/queries";
import { useOfapiStatus } from "@/api/waiting";
import { usePeriodStore, type PeriodOption } from "@/stores/periodStore";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { MoneyDelta } from "@/components/money/Delta";
import { IncomeKinds, incomeKindRows } from "@/components/money/IncomeKinds";
import { RevenueDailyCard } from "@/components/money/RevenueDailyCard";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatDuration, formatMills } from "@/lib/format";
import { buildPageRoute } from "@/lib/navigation";
import { overviewSearch, parseOverviewState, PERIOD_LABELS, type OverviewState, type PageSort } from "@/lib/overviewNavigation";
import { revenueComparisonRange, revenuePreviousLabel, revenueWindowLabel, mainRevenueWindow } from "@/lib/revenueWindow";
import { OFAPI_FEED_NOTE, type OfapiStatus } from "@/lib/statusWords";
import { biggestMovers, groupRevenue, plural, type PageRow } from "./overview/presentation.js";
import { AudienceNow, FreeAudienceLink, PageKinds, PageSources, PaidSubscribersLink, pageTransactionsLink, pageWindowOf } from "./overview/PageSources.js";
import { HomeStrip } from "./overview/HomeStrip.js";


// Contains only UI position, never API data or account information. Kept per
// exact URL so Back, reload, and another tab's period cannot overwrite it.
function positionKey(search: string) {
  return `hub-overview-position:${search}`;
}
function readPosition(search: string): { y: number; focus: string } | null {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(positionKey(search)) ?? "null");
    if (
      saved && typeof saved === "object" &&
      "y" in saved && typeof saved.y === "number" && Number.isFinite(saved.y) &&
      "focus" in saved && typeof saved.focus === "string"
    )
      return { y: saved.y, focus: saved.focus };
  } catch {
    /* Storage can be disabled; navigation still works. */
  }
  return null;
}

/** Three states of one header: the server's order, then decline first, then
 *  growth first. Pages are sorted inside their model. */
const NEXT_SORT: Record<PageSort, PageSort> = { source: "decline", decline: "growth", growth: "source" };
const SORT_TEXT: Record<PageSort, string> = { source: "без сортировки", decline: "сначала падение", growth: "сначала рост" };

type Report = OverviewRevenueResponse;

/** What the table compares with: nothing for all time, yesterday for today. */
function compareMode(period: PeriodOption): "none" | "yesterday" | "full" {
  return period === "all" ? "none" : period === "today" ? "yesterday" : "full";
}

/** The tiles of every page: the same four as the old Overview. */
function AgencyTiles({ report, period }: { report: Report; period: PeriodOption }) {
  const comparison = report.comparison;
  const movers = biggestMovers(report.pages);
  const range = revenueComparisonRange(mainRevenueWindow(report.platformWindows));
  const previous = revenuePreviousLabel(report.platformWindows);
  const today = period === "today";
  const changeLine = today
    ? "День ещё идёт, сравнения нет"
    : period === "all"
      ? "Для «Всё время» сравнения нет"
      : comparison
        ? <><MoneyDelta mills={comparison.deltaNetMills} pct={comparison.deltaPct} />{range && ` к ${range}`}</>
        : "Сравнение недоступно";
  const mover = (page: PageRow | Report["pages"][number] | undefined, none: string) =>
    today || !comparison ? { value: "—", meta: today ? "День ещё идёт" : undefined }
      : page ? { value: page.pageLabel, meta: <MoneyDelta mills={page.deltaNetMills ?? null} pct={page.deltaPct ?? null} /> }
        : { value: "—", meta: none };
  const growth = mover(movers.growth, "Роста нет");
  const decline = mover(movers.decline, "Снижения нет");
  return (
    <StatGrid className="home-tiles">
      <Stat label={`Доход · ${PERIOD_LABELS[period].toLowerCase()}`} value={formatMills(report.netEarningsMills)} meta={changeLine} />
      <Stat
        label="Прошлый период"
        value={comparison ? formatMills(comparison.netEarningsMills) : "—"}
        meta={comparison ? previous : period === "all" ? "Сравнивать не с чем" : undefined}
      />
      <Stat label="Больше всего выросла" value={<span className="home-mover">{growth.value}</span>} meta={growth.meta} />
      <Stat label="Больше всего снизилась" value={<span className="home-mover">{decline.value}</span>} meta={decline.meta} />
    </StatGrid>
  );
}

/** The tiles of one page: its sum and its previous window, both opening the operations. */
function PageTiles({ page, report, period, backTo }: { page: PageRow; report: Report; period: PeriodOption; backTo: string }) {
  const window = pageWindowOf(page, report.platformWindows);
  const range = window?.comparisonFrom && window.comparisonTo ? revenueComparisonRange(window) : null;
  const meta = period === "today"
    ? "День ещё идёт, сравнения нет"
    : period === "all"
      ? "Для «Всё время» сравнения нет"
      : page.deltaNetMills != null
        ? <><MoneyDelta mills={page.deltaNetMills} pct={page.deltaPct ?? null} />{range && ` к ${range}`}</>
        : "Сравнение недоступно";
  const current = pageTransactionsLink(page, window, backTo) ?? undefined;
  const previous = period !== "all" ? pageTransactionsLink(page, window, backTo, true) ?? undefined : undefined;
  return (
    <StatGrid className="home-tiles home-tiles-two">
      <Stat label={`Доход ${page.pageLabel}`} value={formatMills(page.netEarningsMills)} meta={meta} {...(current ? { to: current } : {})} />
      <Stat
        label="Прошлый период"
        value={page.previousNetEarningsMills == null ? "—" : formatMills(page.previousNetEarningsMills)}
        meta={range ?? (period === "all" ? "Сравнивать не с чем" : undefined)}
        {...(previous && page.previousNetEarningsMills != null ? { to: previous } : {})}
      />
    </StatGrid>
  );
}

function LoadingReport() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Загружаем доход…</span>
      <StatCardSkeleton count={4} />
      <div className="card"><TableSkeleton rows={6} columns={6} /></div>
    </div>
  );
}

/** «О данных»: the old words, plus the strip above the money. */
function AboutData({ frozen }: { frozen: boolean }) {
  return (
    <Disclosure label="О данных">
      <p>
        Это доход после комиссии площадок. Не прибыль агентства и не сумма к выплате. В него входят ожидающие
        подтверждения операции, возвраты, чарджбэки и прочее.
      </p>
      <p>
        Суммы считаются по операциям, которые сохранил Hub. Полноту сбора с площадки это не подтверждает. Сутки
        считаются по Москве, с полуночи до полуночи, текущие сутки ещё идут. Страница обновляется сама раз в минуту.
      </p>
      <p>Прошлый период — столько же дней прямо перед выбранными.</p>
      <p>
        Платные — подписчики, оплатившие текущий период. Бесплатные — на Fansly фолловеры, на OnlyFans бесплатные и
        пробные подписки. От выбранного периода эти числа не зависят, аудитория разных страниц не складывается,
        поэтому в строках моделей её нет.
      </p>
      {frozen && <p>Число подписок OnlyFans — по 1 ноября: полный обход шёл через OnlyFans API.</p>}
      <p>
        Ждут вас — только то, что без вас не сдвинется. Сбои OnlyFans API не считаются: он выключен с 1 ноября. Письма
        OnlyFans странице считаются: поздний ответ может заморозить её доход. На смене — смена идёт от первого действия
        в расширении и заканчивается после {formatDuration(CHATTER_SHIFT_END_IDLE_MINUTES)} без действий.
      </p>
      <p>Прочерк значит, что значения нет.</p>
    </Disclosure>
  );
}

/** The sentence under the money; the dates are in the header. */
function Footnote({ report, ofapi }: { report: Report; ofapi: OfapiStatus }) {
  const feed = ofapi === "off" && report.pages.some((page) => page.platform === "onlyfans");
  return (
    <p className="home-footnote">
      Суммы включают ожидающие подтверждения операции и корректировки.{feed ? ` ${OFAPI_FEED_NOTE}.` : ""}
    </p>
  );
}

/** «Что показать на графике»: the agency, a model, a page. The choice lives in `?chart=`. */
function ChartScope({ report, scope, valid, onChange }: { report: Report; scope: string; valid: boolean; onChange: (scope: string) => void }) {
  const models = [...report.models].sort((a, b) => b.netEarningsMills - a.netEarningsMills || a.modelSlug.localeCompare(b.modelSlug));
  const pages = report.pages.filter((page) => page.status !== "deleted").sort((a, b) => a.pageLabel.localeCompare(b.pageLabel));
  return (
    <select
      id="overview-chart-scope"
      className="select w-auto max-w-full sm:min-w-56"
      aria-label="Что показать на графике"
      value={scope}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="agency">Всё агентство</option>
      {!valid && <option value={scope}>Выбор недоступен</option>}
      <optgroup label="Модели">
        {models.map((model) => <option key={model.modelSlug} value={`model:${model.modelSlug}`}>{model.modelName}</option>)}
      </optgroup>
      <optgroup label="Страницы">
        {pages.map((page) => <option key={page.pageId} value={`page:${page.pageLabel}`}>{page.pageLabel}</option>)}
      </optgroup>
    </select>
  );
}

/** The agency's day bar, net: the owner's line on the whole agency's chart (2026-11-05). */
const AGENCY_DAY_GOAL = { mills: millsToNumber(millsFromDollars(1_000)), label: "$1 000" };

function AgencyChart({ report, period, scope, onScope, onShowWeek }: {
  report: Report;
  period: PeriodOption;
  scope: string;
  onScope: (scope: string) => void;
  onShowWeek: () => void;
}) {
  const selectedPage = scope.startsWith("page:") ? report.pages.find((page) => page.pageLabel === scope.slice(5)) : undefined;
  const selectedModel = scope.startsWith("model:") ? report.models.find((model) => model.modelSlug === scope.slice(6)) : undefined;
  const valid = scope === "agency" || Boolean(selectedModel) || Boolean(selectedPage && selectedPage.status !== "deleted");
  const windows = selectedPage?.platform
    ? report.platformWindows.filter((window) => window.platform === selectedPage.platform)
    : selectedModel
      ? report.platformWindows.filter((window) => report.pages.some((page) => page.modelSlug === selectedModel.modelSlug && page.platform === window.platform))
      : report.platformWindows;
  return (
    <div id="overview-chart">
      <RevenueDailyCard
        scope={scope}
        period={period}
        windowAt={report.windowAt}
        windows={windows}
        totalMills={valid ? (selectedPage ?? selectedModel ?? report).netEarningsMills : null}
        select={<ChartScope report={report} scope={scope} valid={valid} onChange={onScope} />}
        onShowWeek={onShowWeek}
        goal={scope === "agency" ? AGENCY_DAY_GOAL : undefined}
        enabled={valid}
      />
      {!valid && period !== "today" && <p className="home-footnote mt-2">Для этого выбора график недоступен.</p>}
    </div>
  );
}

export function OverviewPage() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const navigationType = useNavigationType();
  const storedPeriod = usePeriodStore((store) => store.period);
  const screenPeriod = useScreenPeriod();
  const period = screenPeriod.key as PeriodOption;
  const state: OverviewState = { ...parseOverviewState(search, storedPeriod), period };
  const filter = usePageFilter();
  const pageLabel = filter.page;
  const catalog = useOverview();
  const revenue = useOverviewRevenue(period);
  const user = useAuthMe();
  const role = user.data?.user.role ?? "team_lead";
  const isOwner = role === "owner";
  const ofapi = useOfapiStatus(role);
  const report = revenue.data;
  const groups = report ? groupRevenue(report, catalog.data?.pages ?? [], period === "7d" || period === "30d" ? state.sort : "source") : [];
  const backTo = `${location.pathname}?${overviewSearch(state)}`;
  const root = useRef<HTMLDivElement>(null);
  const lastFocus = useRef("");
  const restored = useRef<string | null>(null);
  const entryKey = useRef(location.key);
  const ready = Boolean(report);
  const expandedPageId = pageLabel === null ? report?.pages.find((page) => page.pageLabel === state.row)?.pageId : undefined;
  const refreshing = Boolean(revenue.isFetching || catalog.isFetching);
  const mode = compareMode(period);
  const columns = mode === "full" ? 6 : mode === "yesterday" ? 5 : 4;

  // The period goes into the address, so a link opens what its sender saw.
  useEffect(() => {
    if (search.get("period") === period) return;
    const next = new URLSearchParams(search);
    next.set("period", period);
    setSearch(next, { replace: true, state: location.state });
  }, [location.state, period, search, setSearch]);

  useLayoutEffect(() => {
    function save() {
      try {
        sessionStorage.setItem(positionKey(location.search), JSON.stringify({ y: window.scrollY, focus: lastFocus.current }));
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
        if (focus && document.activeElement !== focus) focus.focus({ preventScroll: true });
      };
      // The report mounts before the chart and the kinds settle. Retry after
      // layout growth; a user's first interaction takes control and cancels it.
      restore();
      const observer = new ResizeObserver(restore);
      if (root.current) observer.observe(root.current);
      const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
      const stop = () => {
        observer.disconnect();
        for (const event of events) window.removeEventListener(event, stop);
      };
      for (const event of events) window.addEventListener(event, stop, { once: true, passive: true });
      return stop;
    } else if (expandedPageId != null) {
      const button = document.getElementById(`expand-${expandedPageId}`);
      button?.scrollIntoView({ block: "center", behavior: "instant" });
      button?.focus({ preventScroll: true });
    }
  }, [ready, location.key, location.search, navigationType, expandedPageId]);

  /** The screen's own parameters change; the page and the period of the address stay. */
  function update(patch: Partial<OverviewState>) {
    const next = overviewSearch({ ...state, ...patch });
    const page = search.get("page");
    if (page !== null) next.set("page", page);
    setSearch(next, { state: location.state });
  }

  const onePage = pageLabel !== null && report ? report.pages.find((page) => page.pageLabel === pageLabel) : undefined;
  const onePageRow: PageRow | undefined = onePage ? { ...onePage, catalog: catalog.data?.pages.find((page) => page.id === onePage.pageId) } : undefined;
  const headerWindows = report
    ? onePage?.platform ? report.platformWindows.filter((window) => window.platform === onePage.platform) : report.platformWindows
    : [];
  const frozen = ofapi === "off" && Boolean(report?.pages.some((page) => page.platform === "onlyfans"));

  function amount(page: PageRow, previous = false): ReactNode {
    const value = previous ? page.previousNetEarningsMills : page.netEarningsMills;
    if (value == null) return "—";
    const to = pageTransactionsLink(page, pageWindowOf(page, report?.platformWindows ?? []), backTo, previous);
    if (!to) return formatMills(value);
    return (
      <Link id={`${previous ? "previous" : "current"}-money-${page.pageId}`} className="money-link" to={to} title="Открыть операции за этот период">
        {formatMills(value)}
      </Link>
    );
  }

  let body: ReactNode;
  if (!report && revenue.isError) {
    body = <NoAnswerPanel retry={revenue.refetch} />;
  } else if (!report) {
    body = <LoadingReport />;
  } else if (report.pages.length === 0) {
    body = isOwner
      ? <StatusPanel title="Страниц пока нет" description="Добавьте страницу в «Модели и страницы»." action={<Link to="/settings/pages" className="btn btn-sm">Модели и страницы</Link>} />
      : <StatusPanel title="Вам ещё не назначили страницы" />;
  } else if (pageLabel !== null) {
    // The filter is on one page: its tiles, its kinds in the table's place, its chart.
    const empty = !onePageRow || (onePageRow.netEarningsMills === 0 && !onePageRow.previousNetEarningsMills);
    body = empty ? (
      <StatusPanel
        title={`На ${pageLabel} за ${PERIOD_LABELS[period].toLowerCase()} дохода нет`}
        action={<button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Показать все страницы</button>}
      />
    ) : (
      <>
        <PageTiles page={onePageRow} report={report} period={period} backTo={backTo} />
        <section className="card" aria-labelledby="page-kinds-title">
          <div className="card-header">
            <h2 id="page-kinds-title" className="card-title">Виды дохода</h2>
          </div>
          <PageKinds page={onePageRow} period={period} windowAt={report.windowAt} windows={report.platformWindows} backTo={backTo} total />
          <div className="card-footer home-page-footer">
            <AudienceNow page={onePageRow} backTo={backTo} ofapi={ofapi} />
            <div className="flex flex-wrap gap-2">
              <Link className="btn btn-sm" to={`${buildPageRoute(onePageRow.pageLabel)}?${new URLSearchParams({ period })}`} state={{ backTo }}>Открыть страницу</Link>
              {pageTransactionsLink(onePageRow, pageWindowOf(onePageRow, report.platformWindows), backTo) && (
                <Link className="btn btn-sm" to={pageTransactionsLink(onePageRow, pageWindowOf(onePageRow, report.platformWindows), backTo)!}>Все операции за период</Link>
              )}
            </div>
          </div>
        </section>
        <div className="space-y-3">
          <Footnote report={{ ...report, pages: [onePage!] }} ofapi={ofapi} />
          <AboutData frozen={frozen && onePage?.platform === "onlyfans"} />
        </div>
        <RevenueDailyCard
          scope={`page:${pageLabel}`}
          period={period}
          windowAt={report.windowAt}
          windows={headerWindows}
          totalMills={onePageRow.netEarningsMills}
          onShowWeek={() => screenPeriod.select("7d")}
        />
      </>
    );
  } else {
    const kinds = incomeKindRows(report);
    body = (
      <>
        <AgencyTiles report={report} period={period} />
        {state.row && !report.pages.some((page) => page.pageLabel === state.row) && (
          <Notice role="status" action={<button type="button" className="btn btn-sm" onClick={() => update({ row: null })}>Закрыть</button>}>
            Страницы «{state.row}» нет среди ваших страниц.
          </Notice>
        )}
        <div className="space-y-3">
          <section className="card">
            <div className="table-wrap">
              <table className="data-table home-table" aria-label={`Страницы агентства, доход за период ${PERIOD_LABELS[period]}`}>
                <thead>
                  <tr>
                    <th scope="col">Страница</th>
                    <th scope="col" className="num">Доход</th>
                    {mode !== "none" && <th scope="col" className="num">{mode === "yesterday" ? "Вчера" : "Прошлый период"}</th>}
                    {mode === "full" && (
                      <th
                        scope="col"
                        className={`num${state.sort !== "source" ? " is-sorted" : ""}`}
                        aria-sort={state.sort === "source" ? "none" : state.sort === "decline" ? "ascending" : "descending"}
                      >
                        <button
                          id="overview-sort"
                          type="button"
                          className="home-sort"
                          data-active={state.sort !== "source"}
                          title={`Порядок страниц внутри модели: ${SORT_TEXT[state.sort]}. Нажмите — ${SORT_TEXT[NEXT_SORT[state.sort]]}.`}
                          onClick={() => update({ sort: NEXT_SORT[state.sort] })}
                        >
                          Изменение
                          {state.sort === "source" ? <ArrowUpDown size={16} aria-hidden="true" />
                            : state.sort === "decline" ? <TrendingDown size={16} aria-hidden="true" />
                              : <TrendingUp size={16} aria-hidden="true" />}
                          <span className="sr-only">, {SORT_TEXT[state.sort]}</span>
                        </button>
                      </th>
                    )}
                    <th scope="col" className="num" title="Оплатили текущий период подписки">Платные</th>
                    <th scope="col" className="num" title="Fansly — фолловеры; OnlyFans — бесплатные и пробные подписки">Бесплатные</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map(({ model, pages }) => (
                    <Fragment key={model.modelSlug}>
                      <tr className="row-group">
                        <td>
                          {model.modelName}
                          <span className="meta">
                            {model.pageCount} {plural(model.pageCount, "страница", "страницы", "страниц")}
                            {model.status === "retired" ? ", в архиве" : ""}
                          </span>
                        </td>
                        <td className="num">{formatMills(model.netEarningsMills)}</td>
                        {mode !== "none" && <td className="num">{model.previousNetEarningsMills == null ? "—" : formatMills(model.previousNetEarningsMills)}</td>}
                        {mode === "full" && <td className="num"><MoneyDelta mills={model.deltaNetMills ?? null} pct={model.deltaPct ?? null} bare /></td>}
                        <td colSpan={2} />
                      </tr>
                      {pages.map((page) => {
                        const expanded = state.row === page.pageLabel;
                        const platform = page.platform ?? page.catalog?.platform;
                        return (
                          <Fragment key={page.pageId}>
                            <tr className={expanded ? "is-expanded" : undefined}>
                              <td>
                                <div className="home-page-cell">
                                  <button
                                    id={`expand-${page.pageId}`}
                                    type="button"
                                    className="home-expander"
                                    aria-label={`${expanded ? "Свернуть" : "Раскрыть"} виды дохода ${page.pageLabel}`}
                                    aria-expanded={expanded}
                                    aria-controls={expanded ? `sources-${page.pageId}` : undefined}
                                    onClick={() => update({ row: expanded ? null : page.pageLabel })}
                                  >
                                    <ChevronRight size={16} aria-hidden="true" />
                                  </button>
                                  {page.status === "deleted" ? (
                                    <>
                                      <span className="text-text-secondary">{page.pageLabel}</span>
                                      <span className="badge">Архив</span>
                                    </>
                                  ) : (
                                    <Link className="home-page-link" to={`${buildPageRoute(page.pageLabel)}?${new URLSearchParams({ period })}`} state={{ backTo }}>
                                      {page.pageLabel}
                                    </Link>
                                  )}
                                  {platform && <PlatformBadge platform={platform} />}
                                </div>
                              </td>
                              <td className="num">{amount(page)}</td>
                              {mode !== "none" && <td className="num muted">{amount(page, true)}</td>}
                              {mode === "full" && <td className="num"><MoneyDelta mills={page.deltaNetMills ?? null} pct={page.deltaPct ?? null} bare /></td>}
                              <td className="num"><PaidSubscribersLink page={page} backTo={backTo} ofapi={ofapi} /></td>
                              <td className="num"><FreeAudienceLink page={page} backTo={backTo} ofapi={ofapi} /></td>
                            </tr>
                            {expanded && (
                              <PageSources
                                page={page}
                                period={period}
                                windowAt={report.windowAt}
                                windows={report.platformWindows}
                                backTo={backTo}
                                isOwner={isOwner}
                                ofapi={ofapi}
                                columns={columns}
                              />
                            )}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ))}
                  <tr className="row-total">
                    <td>Всего по агентству</td>
                    <td className="num">{formatMills(report.netEarningsMills)}</td>
                    {mode !== "none" && <td className="num">{report.comparison ? formatMills(report.comparison.netEarningsMills) : "—"}</td>}
                    {mode === "full" && <td className="num"><MoneyDelta mills={report.comparison?.deltaNetMills ?? null} pct={report.comparison?.deltaPct ?? null} bare /></td>}
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <Footnote report={report} ofapi={ofapi} />
          <AboutData frozen={frozen} />
        </div>
        <AgencyChart
          report={report}
          period={period}
          scope={state.chart}
          onScope={(scope) => update({ chart: scope })}
          onShowWeek={() => screenPeriod.select("7d")}
        />
        {kinds.length > 0 && (
          <section className="card" aria-labelledby="home-kinds-title">
            <div className="card-header">
              <h2 id="home-kinds-title" className="card-title">По видам дохода</h2>
            </div>
            <IncomeKinds
              rows={kinds}
              label="Доход агентства по видам"
              compare={period === "7d" || period === "30d"}
              total={{
                label: "Всего по агентству",
                currentNetMills: report.netEarningsMills,
                previousNetMills: report.comparison?.netEarningsMills ?? null,
                deltaNetMills: report.comparison?.deltaNetMills ?? null,
                deltaPct: report.comparison?.deltaPct ?? null,
              }}
            />
          </section>
        )}
      </>
    );
  }

  return (
    <div ref={root} className="space-y-6" onFocusCapture={(event) => { if (event.target.id) lastFocus.current = event.target.id; }}>
      <PageHeader
        window={report ? revenueWindowLabel({ windows: headerWindows, period, pageLabel }) : undefined}
        fresh={revenue.dataUpdatedAt ? {
          at: revenue.dataUpdatedAt,
          refreshing,
          onRefresh: () => void Promise.all([revenue.refetch(), catalog.refetch()]),
        } : undefined}
      />
      <HomeStrip />
      {catalog.isError && report && (
        <Notice tone="warning" role="status" action={<button type="button" className="btn btn-sm" onClick={() => void catalog.refetch()}>Повторить</button>}>
          Не удалось получить подписчиков и фолловеров. Деньги верные.
        </Notice>
      )}
      {report && <QueryNotice error={revenue.isError} stale retry={revenue.refetch} at={revenue.dataUpdatedAt} />}
      <div className={report && revenue.isFetching && !revenue.isRefetching ? "is-refreshing space-y-6" : "space-y-6"}>{body}</div>
    </div>
  );
}
