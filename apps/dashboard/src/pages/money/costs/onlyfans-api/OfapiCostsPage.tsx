import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { X } from "lucide-react";
import { useAuthMe } from "@/api/queries";
import { downloadOfapiCreditsLedgerCsv, useAdminOfapiCreditsDaily, useAdminOfapiCreditsLedger, useAdminOfapiCreditsSummary } from "@/api/adminOfapiCredits";
import { useOfapiStatus } from "@/api/waiting";
import { Pagination } from "@/components/shared/Pagination";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatBusinessDateShort, formatDateTime, formatMills } from "@/lib/format";
import {
  BREAKDOWN_DAYS,
  BalanceChart,
  BudgetMeter,
  CHART_DAYS,
  LEDGER_PAGE_SIZE,
  LedgerRow,
  SOURCE_FILTER_OPTIONS,
  SOURCE_SERIES,
  computeRoi,
  credits,
  creditsToUsd,
  creditsWord,
  daysWord,
  fmtCredits,
  humanDay,
  incidentLabel,
  ledgerDateEndExclusive,
  ledgerDateStart,
  operationLabel,
} from "./OfapiCostsParts.js";
import { OfapiVendorReconcile } from "./OfapiVendorReconcile.js";

type BreakdownDays = (typeof BREAKDOWN_DAYS)[number];

/**
 * Деньги → Расходы → OnlyFans API: how many credits are left and what they went
 * on, by 1 November. Switched off is not broken: nothing red and nothing green
 * while the API is off; the code stays for the day the key comes back.
 */
export function OfapiCostsPage() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const user = useAuthMe();
  const ofapi = useOfapiStatus(user.data?.user.role ?? "team_lead");
  const off = ofapi === "off";
  const on = ofapi === "on";
  const rawDays = Number(search.get("days"));
  const breakdownDays: BreakdownDays = (BREAKDOWN_DAYS as readonly number[]).includes(rawDays) ? (rawDays as BreakdownDays) : 30;

  const summaryQuery = useAdminOfapiCreditsSummary();
  const chartsQuery = useAdminOfapiCreditsDaily(CHART_DAYS);
  const breakdownQuery = useAdminOfapiCreditsDaily(breakdownDays);
  const operationListId = useId();

  // The journal's filters live in the screen's state, as before: it promises no address.
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const [sourceFilter, setSourceFilter] = useState("");
  const [operationFilter, setOperationFilter] = useState("");
  const [pageFilter, setPageFilter] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [showHttp, setShowHttp] = useState(false);
  const ledgerRef = useRef<HTMLElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [exportTruncated, setExportTruncated] = useState(false);

  const ledgerFrom = ledgerDateStart(fromFilter);
  const ledgerTo = ledgerDateEndExclusive(toFilter);
  const ledgerFilters = {
    ...(sourceFilter ? { source: sourceFilter } : {}),
    ...(operationFilter.trim() ? { operation: operationFilter.trim() } : {}),
    ...(pageFilter ? { pageId: Number(pageFilter) } : {}),
    ...(ledgerFrom === undefined ? {} : { from: ledgerFrom }),
    ...(ledgerTo === undefined ? {} : { to: ledgerTo }),
  };
  const ledgerQuery = useAdminOfapiCreditsLedger({ offset: ledgerOffset, limit: LEDGER_PAGE_SIZE, ...ledgerFilters });

  const summary = summaryQuery.data;
  const charts = chartsQuery.data;
  const breakdown = breakdownQuery.data;
  const ledger = ledgerQuery.data;
  const pageOptions = ledger?.pageOptions ?? (breakdown?.byPage ?? []).map((row) => ({ pageId: row.pageId, pageLabel: row.pageLabel }));

  const chartDays = useMemo(() => (charts?.days ?? []).map((day) => day.day), [charts]);
  const balanceByDay = useMemo(() => new Map((charts?.balance ?? []).map((point) => [point.at.slice(0, 10), point.value])), [charts]);
  // Balance residuals can be tiny and frequent; they are not payment receipts.
  const refillsByDay = useMemo(() => {
    const byDay = new Map<string, { day: string; credits: number; count: number }>();
    for (const refill of charts?.refills ?? []) {
      const day = refill.at.slice(0, 10);
      const bucket = byDay.get(day) ?? { day, credits: 0, count: 0 };
      bucket.credits += Math.abs(refill.credits);
      bucket.count += 1;
      byDay.set(day, bucket);
    }
    return [...byDay.values()];
  }, [charts]);
  const dailyBars = useMemo(() => (charts?.days ?? []).map((day) => ({
    day: day.day,
    rest: day.bySource.rest,
    webhookAccrual: day.bySource.webhookAccrual,
    external: day.bySource.external,
    adjustment: day.bySource.adjustment,
  })), [charts]);
  const activeSeries = useMemo(() => {
    const active = SOURCE_SERIES.filter((series) => dailyBars.some((row) => row[series.key] !== 0));
    return active.length > 0 ? active : [...SOURCE_SERIES];
  }, [dailyBars]);
  const chartsEmpty = dailyBars.every((row) => SOURCE_SERIES.every((series) => row[series.key] === 0)) && balanceByDay.size === 0;
  const operationOptions = useMemo(
    () => [...new Set((breakdown?.byOperation ?? []).map((row) => row.operation).filter((operation): operation is string => operation !== null))],
    [breakdown],
  );
  const operationTotal = (breakdown?.byOperation ?? []).reduce((sum, row) => sum + row.credits, 0);
  // A signed net total is no share denominator: +10 and −9 would make 1000 % and −900 %.
  const sharesComparable = operationTotal > 0 && (breakdown?.byOperation ?? []).every((row) => row.credits >= 0);

  const microUsdPerCredit = summary?.pricing?.microUsdPerCredit ?? 0;
  const priceKnown = microUsdPerCredit > 0;
  const usd = (amount: number) => creditsToUsd(amount, microUsdPerCredit);

  const focusLedger = () => ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  const drillByOperation = (operation: string) => { setOperationFilter(operation); setLedgerOffset(0); focusLedger(); };
  const drillByPage = (pageId: number) => { setPageFilter(String(pageId)); setLedgerOffset(0); focusLedger(); };
  const setBreakdownDays = (days: BreakdownDays) => {
    const next = new URLSearchParams(search);
    if (days === 30) next.delete("days");
    else next.set("days", String(days));
    setSearch(next, { state: location.state });
  };
  const handleExport = async () => {
    setExporting(true);
    setExportError(false);
    setExportTruncated(false);
    try {
      const result = await downloadOfapiCreditsLedgerCsv(ledgerFilters);
      // A capped extract must never pass for a complete accounting export.
      setExportTruncated(result.truncated);
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  };
  const hasActiveFilters = Boolean(sourceFilter || operationFilter.trim() || pageFilter || fromFilter || toFilter);
  const clearFilters = () => {
    setSourceFilter("");
    setOperationFilter("");
    setPageFilter("");
    setFromFilter("");
    setToFilter("");
    setLedgerOffset(0);
  };
  const filterField = (label: string, control: ReactNode, hint?: string) => (
    <label className="tx-field">
      <span className="field-label">{label}</span>
      {control}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );

  const offNotice = off && (
    <Notice
      tone="off"
      action={<Link className="btn btn-sm" to="/system/onlyfans-api">Состояние</Link>}
      detail={<Link className="link" to="/system/onlyfans-api/collection">Правила сбора</Link>}
    >
      <b>OnlyFans API выключен с 1 ноября.</b> Баланс и траты ниже — по 1 ноября.
    </Notice>
  );
  const header = (
    <PageHeader
      fresh={summaryQuery.dataUpdatedAt ? { at: summaryQuery.dataUpdatedAt, refreshing: summaryQuery.isFetching, onRefresh: () => void Promise.all([summaryQuery.refetch(), chartsQuery.refetch(), breakdownQuery.refetch(), ledgerQuery.refetch()]) } : undefined}
    />
  );
  const howCounted = (
    <Disclosure>
      <p>
        Кредиты расходуются на платные запросы к OnlyFans API и на учитываемые события. Журнал разделяет запросы
        приложения, начисления за события и сверку баланса с поставщиком.
      </p>
      <p>
        «Хватит на» — баланс, делённый на средний дневной расход за последние 7 дней. Дневной лимит обнуляется в
        полночь UTC, то есть в 03:00 по Москве.
      </p>
      <p>
        Отношение «выручка / стоимость» включает всю выручку страницы за период. Оно не показывает, сколько выручки
        принесли запросы к OnlyFans API, и не учитывает остальные расходы.
      </p>
    </Disclosure>
  );

  if (!summary) {
    return (
      <div className="space-y-6">
        {header}
        {offNotice}
        {summaryQuery.isError ? <NoAnswerPanel retry={summaryQuery.refetch} /> : <StatCardSkeleton count={3} />}
        {howCounted}
      </div>
    );
  }

  const forecast = summary.forecast;
  const burn = summary.recentBurn;
  // The alarm only while the key works; switched off, there is nothing to raise.
  const showAlarm = on && (summary.floor.blocked || summary.incidents.length > 0 || (burn?.alerting ?? false));
  const runwayTone = !on || forecast.daysLeft === null ? "" : forecast.daysLeft < 3 ? "ofc-danger" : forecast.daysLeft < 7 ? "ai-warn" : "";
  const refill = forecast.refillRecommendation ?? null;
  const recorded = forecast.basis === "recorded_activity";
  const residual = forecast.unverifiedResidual;
  const todaySources = SOURCE_SERIES.map((series) => ({ ...series, value: summary.today.bySource[series.key] })).filter((series) => series.value !== 0);
  const pendingToday = summary.accrual.pendingToday ?? null;
  // One limit, on every spend; the per-stream ones are a dead branch (audit costs §3.1).
  const limited = summary.budgets.filter((budget) => budget.dailyCeiling > 0);
  const budgets = limited.some((budget) => budget.stream === "all") ? limited.filter((budget) => budget.stream === "all") : limited.slice(0, 1);

  return (
    <div className="space-y-6">
      {header}
      {offNotice}
      <QueryNotice error={summaryQuery.isError} stale retry={summaryQuery.refetch} at={summaryQuery.dataUpdatedAt} />
      {showAlarm && (
        <Notice tone="danger" role="alert" detail={summary.incidents.length > 0 ? <Link className="link" to="/system/failures">Все сбои</Link> : undefined}>
          {summary.floor.blocked && <p>Траты остановлены: баланс ниже порога автостопа ({credits(summary.floor.value)}). Пополните баланс, чтобы сбор продолжился.</p>}
          {burn?.alerting && (
            <p>
              Журнал показывает расход или разницу баланса: {credits(burn.total)} за последние {burn.windowMinutes} мин (порог тревоги — {credits(burn.threshold)} в час).
              {burn.topOperations.length + burn.topPages.length > 0 &&
                ` Больше всего тратят: ${[...burn.topOperations.map((op) => `${op.operation ? operationLabel(op.operation) : "без привязки"} (${fmtCredits(op.credits)})`), ...burn.topPages.map((page) => `${page.pageLabel} (${fmtCredits(page.credits)})`)].join(", ")}.`}
            </p>
          )}
          {summary.incidents.map((incident) => (
            <p key={`${incident.kind}-${incident.openedAt}`}>
              {incidentLabel(incident.kind)}, открыт с {formatDateTime(incident.openedAt)}.{incident.errorSummary ? ` ${incident.errorSummary}.` : ""}
            </p>
          ))}
        </Notice>
      )}

      <section className="space-y-3">
        <StatGrid className="ofc-tiles">
          <Stat
            label="Баланс"
            value={summary.balance.value !== null ? <>{fmtCredits(summary.balance.value)} <span className="ofc-unit">{creditsWord(summary.balance.value)}</span></> : "—"}
            meta={summary.balance.observedAt
              ? `${summary.balance.value !== null && priceKnown ? `≈ ${usd(summary.balance.value)}, ` : ""}на ${formatDateTime(summary.balance.observedAt)}`
              : "ждём первое показание баланса"}
          />
          {off ? (
            <Stat label="Хватит на" value="—" meta="API выключен, кредиты не тратятся" />
          ) : (
            <Stat
              label={recorded ? "Прогноз по операциям" : "Хватит на"}
              value={forecast.daysLeft !== null ? <span className={runwayTone}>~{fmtCredits(forecast.daysLeft)} <span className="ofc-unit">{daysWord(forecast.daysLeft)}</span></span> : "—"}
              meta={forecast.daysLeft !== null
                ? <>{forecast.runOutDate && <span className="block">закончатся ~{humanDay(forecast.runOutDate)}</span>}~{credits(Math.round(forecast.avgDailySpend7d))} в день{priceKnown ? ` (≈ ${usd(Math.round(forecast.avgDailySpend7d))})` : ""}, среднее за 7 дней</>
                : forecast.avgDailySpend7d <= 0 ? "за последние 7 дней нет учтённых трат для прогноза" : "ждём показание баланса"}
            />
          )}
          {off ? (
            <Stat label="Пополнение" value="—" meta="Не нужно, пока API выключен" />
          ) : refill ? (
            refill.credits > 0 ? (
              <Stat
                label="Пополнение"
                value={<span className={on ? "ai-warn" : undefined}>+{fmtCredits(refill.credits)} <span className="ofc-unit">{creditsWord(refill.credits)}</span></span>}
                meta={`чтобы хватило на ${refill.targetDays} ${daysWord(refill.targetDays)}${priceKnown ? `, ≈ ${usd(refill.credits)}` : ""}`}
              />
            ) : (
              <Stat
                label="Пополнение"
                value={<span className={on ? "ofc-good" : undefined}>{residual && residual.credits > 0 ? "Уточнить расход" : "Не нужно"}</span>}
                meta={`по учтённым операциям баланса хватит больше чем на ${refill.targetDays} ${daysWord(refill.targetDays)}`}
              />
            )
          ) : (
            <Stat label="Пополнение" value="—" meta="появится после нескольких дней истории трат" />
          )}
        </StatGrid>
        {recorded && !off && <p className="ofc-note">Прогноз учитывает запросы приложения, их корректировки и оценку событий. Необъяснённая разница баланса в прогноз не включена.</p>}
        {residual && residual.credits > 0 && (
          <Notice tone={off ? "off" : "warning"} role="status" detail={off ? undefined : "Фактический расход может быть выше прогноза; требуется проверка этой разницы."}>
            По сверке за {formatDateTime(residual.from)} – {formatDateTime(residual.to)}: ещё {credits(residual.credits)} уменьшения баланса без подтверждённого источника.
          </Notice>
        )}
        {(forecast.monthToDateSpend !== undefined || forecast.monthEndProjection !== undefined) && (
          <p className="ofc-note">
            {forecast.monthToDateSpend !== undefined && <>{recorded ? "По операциям за месяц: " : "Потрачено за месяц: "}{credits(forecast.monthToDateSpend)}{priceKnown ? ` (≈ ${usd(forecast.monthToDateSpend)})` : ""}</>}
            {forecast.monthUnverifiedResidualCredits !== undefined && forecast.monthUnverifiedResidualCredits !== 0 && <>, разница баланса за месяц: {credits(forecast.monthUnverifiedResidualCredits)}</>}
            {!off && forecast.monthEndProjection !== undefined && <>{forecast.monthToDateSpend !== undefined ? ", " : ""}к концу месяца выйдет ~{credits(forecast.monthEndProjection)}{priceKnown ? ` (≈ ${usd(forecast.monthEndProjection)})` : ""}</>}
            .
          </p>
        )}
      </section>

      <section className="card" aria-label="Учтено сегодня и дневной лимит">
        <div className="card-body ofc-today">
          <div>
            <p className="stat-label">Учтено сегодня, {humanDay(summary.today.day)}</p>
            <p className="ofc-today-value">
              {credits(summary.today.total)}
              {priceKnown && <span className="ofc-unit"> ≈ {usd(summary.today.total)}</span>}
            </p>
            {todaySources.length > 0 ? (
              <p className="ofc-sources">
                {todaySources.map((series) => (
                  <span key={series.key}><span className="ofc-dot" style={{ backgroundColor: series.color }} aria-hidden="true" />{series.label} {fmtCredits(series.value)}</span>
                ))}
              </p>
            ) : <p className="ofc-note">Сегодня пока ничего не потрачено.</p>}
            {pendingToday && pendingToday.eventCount > 0 && (
              <p className="ofc-note">
                Ещё ~{credits(pendingToday.estimatedCredits)} за {fmtCredits(pendingToday.eventCount)} событий ещё не проведены: оценка добавится в журнал после завершения дня.
              </p>
            )}
          </div>
          <div>
            <p className="stat-label">Дневной лимит кредитов</p>
            <div className="mt-2 space-y-3">
              {budgets.length > 0
                ? budgets.map((budget) => <BudgetMeter key={budget.stream} spentToday={budget.spentToday} dailyCeiling={budget.dailyCeiling} state={budget.state} retryAt={budget.retryAt} ofapi={ofapi} />)
                : <p className="ofc-note">Дневной лимит не задан.</p>}
            </div>
          </div>
        </div>
        <div className="card-footer justify-start">
          {summary.floor.value > 0
            ? `Порог автостопа: ${credits(summary.floor.value)}. Если баланс упадёт ниже, траты сами остановятся.`
            : "Автостоп по остатку не задан. Остальные ограничения расхода продолжают действовать."}
        </div>
      </section>

      {chartsQuery.isLoading ? (
        <div className="ofc-charts"><div className="card"><TableSkeleton rows={5} columns={2} /></div><div className="card"><TableSkeleton rows={5} columns={2} /></div></div>
      ) : !charts ? (
        <NoAnswerPanel retry={chartsQuery.refetch} />
      ) : chartsEmpty && off ? (
        <StatusPanel title={`За последние ${CHART_DAYS} дней движений нет: OnlyFans API выключен с 1 ноября.`} />
      ) : (
        <div className="ofc-charts">
          <BalanceChart days={chartDays} balanceByDay={balanceByDay} refills={refillsByDay} usd={priceKnown ? usd : undefined} frozen={off} />
          <StackedBarChart
            title="Движение кредитов по дням"
            data={dailyBars}
            xKey="day"
            series={[...activeSeries]}
            xTickFormatter={formatBusinessDateShort}
            valueFormatter={fmtCredits}
            tooltipValueFormatter={(value) => (priceKnown ? `${credits(value)} · ${usd(value)}` : credits(value))}
            yAxisWidth={56}
            height={260}
            headerExtra={<span className="text-sm text-text-secondary">Последние {CHART_DAYS} дней{off ? ", по 1 ноября" : ""}</span>}
          />
        </div>
      )}

      <section className="card" aria-labelledby="ofc-where-title">
        <div className="card-header">
          <div className="min-w-0">
            <h2 id="ofc-where-title" className="card-title">{on ? "Куда уходят кредиты" : "Куда уходили кредиты"}</h2>
            <p className="card-description">По видам запросов и по страницам. Нажмите строку, чтобы открыть её в журнале.</p>
          </div>
          <Segmented<`${BreakdownDays}`>
            label="Период"
            value={`${breakdownDays}`}
            onChange={(value) => setBreakdownDays(Number(value) as BreakdownDays)}
            options={BREAKDOWN_DAYS.map((days) => ({ value: `${days}` as const, label: `${days} ${daysWord(days)}` }))}
          />
        </div>
        {breakdownQuery.isLoading ? (
          <TableSkeleton rows={6} columns={5} />
        ) : !breakdown ? (
          <div className="card-body"><NoAnswerPanel retry={breakdownQuery.refetch} /></div>
        ) : (
          <>
            {breakdown.byOperation.length === 0 && breakdown.byPage.length === 0 && off ? (
              <div className="card-body">
                <div className="empty">
                  <p className="empty-title">За эти дни трат нет: OnlyFans API выключен с 1 ноября</p>
                  {breakdownDays !== 90 && <div className="empty-actions"><button type="button" className="btn btn-sm" onClick={() => setBreakdownDays(90)}>Показать 90 дней</button></div>}
                </div>
              </div>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data-table" aria-label="Траты по видам запросов">
                    <thead>
                      <tr>
                        <th scope="col">Активность</th>
                        <th scope="col" className="num">Запросы</th>
                        <th scope="col" className="num">Кредиты</th>
                        {priceKnown && <th scope="col" className="num" title="Оценка в $ по заданной цене кредита">Стоимость</th>}
                        <th scope="col" className="num">Доля</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.byOperation.map((row) => {
                        const share = sharesComparable ? Math.round((row.credits / operationTotal) * 100) : null;
                        return (
                          <tr key={row.operation ?? "unknown"}>
                            <td>
                              {row.operation
                                ? <button type="button" className="money-link text-left" title={`Показать в журнале: ${row.operation}`} onClick={() => drillByOperation(row.operation!)}>{operationLabel(row.operation)}</button>
                                : "Без привязки"}
                            </td>
                            <td className="num muted">{fmtCredits(row.requests)}</td>
                            <td className="num">{fmtCredits(row.credits)}</td>
                            {priceKnown && <td className="num muted">{usd(row.credits)}</td>}
                            <td className="num muted">
                              {share === null ? "—" : (
                                <span className="inline-flex items-center justify-end gap-2">
                                  <span aria-hidden="true" className="ofc-share"><span style={{ width: `${share}%` }} /></span>
                                  {share} %
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {breakdown.byOperation.length === 0 && <tr><td colSpan={priceKnown ? 5 : 4} className="muted">За эти дни трат через приложение нет</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div className="table-wrap ofc-second">
                  <table className="data-table" aria-label="Траты по страницам">
                    <thead>
                      <tr>
                        <th scope="col">Страница</th>
                        <th scope="col" className="num">Кредиты</th>
                        {priceKnown && <th scope="col" className="num">Стоимость</th>}
                        <th scope="col" className="num" title="Доход страницы за период">Выручка</th>
                        {priceKnown && <th scope="col" className="num" title="Вся выручка страницы ÷ оценка стоимости кредитов. Не доказывает влияние запросов на выручку.">Выручка / стоимость</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.byPage.map((row) => {
                        const roi = row.revenueMills == null ? null : computeRoi(row.revenueMills, row.credits, microUsdPerCredit);
                        return (
                          <tr key={row.pageId}>
                            <td><button type="button" className="money-link text-left" title={`Показать в журнале: ${row.pageLabel}`} onClick={() => drillByPage(row.pageId)}>{row.pageLabel}</button></td>
                            <td className="num">{fmtCredits(row.credits)}</td>
                            {priceKnown && <td className="num muted">{usd(row.credits)}</td>}
                            <td className="num muted">{row.revenueMills == null ? "Нет данных" : formatMills(row.revenueMills)}</td>
                            {priceKnown && <td className="num">{roi === null ? "—" : `${roi.toFixed(1).replace(".", ",")}×`}</td>}
                          </tr>
                        );
                      })}
                      {breakdown.byPage.length === 0 && <tr><td colSpan={priceKnown ? 5 : 3} className="muted">За эти дни трат с привязкой к страницам нет</td></tr>}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {!priceKnown && (
              <div className="card-footer justify-start">
                <span>
                  Цена кредита не задана: её задают при настройке сервера, чтобы видеть стоимость в $.{" "}
                  <Link className="link" to="/system/dev/config#config-ofapiCreditMicroUsdPrice">Текущее значение</Link>
                </span>
              </div>
            )}
          </>
        )}
      </section>

      <section ref={ledgerRef} className="card scroll-mt-20" aria-labelledby="ofc-ledger-title">
        <div className="card-header">
          <div className="min-w-0">
            <h2 id="ofc-ledger-title" className="card-title">Журнал операций</h2>
            <p className="card-description">Каждое движение кредитов.</p>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => void handleExport()} disabled={exporting || (ledger?.total ?? 0) === 0} title="Все строки по текущим фильтрам, не больше 50 000">
            {exporting ? "Скачиваем…" : "Скачать CSV"}
          </button>
        </div>
        <div className="card-body space-y-3 pb-4">
          <div className="tx-filters">
            {filterField("Источник", (
              <select className="select" value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value); setLedgerOffset(0); }}>
                {SOURCE_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            ))}
            {filterField("Страница", (
              <select className="select" value={pageFilter} onChange={(event) => { setPageFilter(event.target.value); setLedgerOffset(0); }}>
                <option value="">Все страницы</option>
                {pageOptions.map((row) => <option key={row.pageId} value={String(row.pageId)}>{row.pageLabel}</option>)}
              </select>
            ))}
            {filterField("С", <input type="date" className="input w-auto" value={fromFilter} onChange={(event) => { setFromFilter(event.target.value); setLedgerOffset(0); }} />)}
            {filterField("По", <input type="date" className="input w-auto" value={toFilter} onChange={(event) => { setToFilter(event.target.value); setLedgerOffset(0); }} />)}
            {hasActiveFilters && <button type="button" className="btn btn-ghost btn-sm mb-1" onClick={clearFilters}>Сбросить фильтры</button>}
          </div>
          <p className="ofc-note">Сутки по UTC, с 03:00 по Москве; «По» включительно.</p>
          {operationFilter.trim() && (
            <p className="ofc-note">
              <span className="chip chip-on">
                Активность: {operationLabel(operationFilter.trim())}
                <button type="button" className="chip-clear" aria-label="Убрать фильтр по активности" onClick={() => { setOperationFilter(""); setLedgerOffset(0); }}>
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            </p>
          )}
          <Disclosure label="Подробнее">
            <div className="tx-filters">
              {filterField("Код операции", (
                <input className="input w-56" value={operationFilter} list={operationListId} placeholder="например, ofapi_chats" onChange={(event) => { setOperationFilter(event.target.value); setLedgerOffset(0); }} />
              ))}
              <datalist id={operationListId}>{operationOptions.map((operation) => <option key={operation} value={operation} />)}</datalist>
              <label className="inline-flex items-center gap-2 pb-2">
                <input type="checkbox" checked={showHttp} onChange={(event) => setShowHttp(event.target.checked)} />
                Показывать код ответа (HTTP)
              </label>
            </div>
          </Disclosure>
          {exportError && <Notice tone="warning" role="alert">Экспорт не удался, повторите.</Notice>}
          {exportTruncated && !exportError && <Notice tone="warning" role="alert">Экспорт обрезан до 50 000 строк: сузьте фильтры, чтобы выгрузить всё.</Notice>}
        </div>
        {ledgerQuery.isLoading ? (
          <TableSkeleton rows={8} columns={7} />
        ) : !ledger ? (
          <div className="card-body">
            <StatusPanel
              title="Hub не ответил"
              description="Фильтры сохранены."
              action={<button type="button" className="btn btn-sm" onClick={() => void ledgerQuery.refetch()}>Повторить</button>}
            />
          </div>
        ) : ledger.rows.length === 0 ? (
          <div className="card-body"><StatusPanel title="Ничего не найдено" description="Под текущие фильтры не попало ни одного движения кредитов." /></div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table data-table-dense" aria-label="Журнал операций">
                <thead>
                  <tr>
                    <th scope="col" className="ofc-chevron"><span className="sr-only">Раскрыть</span></th>
                    <th scope="col">Время</th>
                    <th scope="col">Источник</th>
                    <th scope="col">Активность</th>
                    <th scope="col">Страница</th>
                    <th scope="col" className="num">Кредиты</th>
                    <th scope="col" className="num">Баланс после</th>
                    {showHttp && <th scope="col" className="num">HTTP</th>}
                  </tr>
                </thead>
                <tbody>{ledger.rows.map((row) => <LedgerRow key={row.id} row={row} showHttp={showHttp} ofapi={ofapi} />)}</tbody>
              </table>
            </div>
            <Pagination
              offset={ledgerOffset}
              limit={LEDGER_PAGE_SIZE}
              total={ledger.total}
              onPageChange={setLedgerOffset}
              emptyLabel="0 записей"
              formatRange={(start, end, total) => `${start}–${end} из ${fmtCredits(total)}`}
            />
          </>
        )}
      </section>

      <OfapiVendorReconcile ofapi={ofapi} />
      {howCounted}
    </div>
  );
}
