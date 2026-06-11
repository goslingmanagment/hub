import { Fragment, useId, useMemo, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { OfapiCreditsLedgerResponse } from "@agency_hub_core/contracts";
import {
  useAdminOfapiCreditsDaily,
  useAdminOfapiCreditsLedger,
  useAdminOfapiCreditsSummary,
} from "@/api/queries";
import { EmptyState } from "@/components/shared/EmptyState";
import { Pagination } from "@/components/shared/Pagination";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";

const LEDGER_PAGE_SIZE = 50;
const CHART_DAYS = 30;

const SOURCE_SERIES = [
  { key: "rest", label: "Core REST", color: "#4ead6b" },
  { key: "webhookAccrual", label: "Webhooks", color: "#5b8def" },
  { key: "external", label: "External", color: "#e0a14f" },
  { key: "adjustment", label: "Adjustments", color: "#9b7ede" },
] as const;

const SOURCE_FILTER_OPTIONS = [
  { value: "", label: "All sources" },
  { value: "rest", label: "Core REST" },
  { value: "webhook_accrual", label: "Webhook accrual" },
  { value: "external", label: "External" },
  { value: "refill", label: "Refill" },
  { value: "adjustment", label: "Adjustment" },
] as const;

const BREAKDOWN_PERIODS = [7, 30, 90] as const;

function fmtCredits(value: number) {
  return value.toLocaleString("en-US");
}

// All timestamps on this page are UTC (budgets reset at UTC midnight).
function utcDateTime(iso: string) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function utcTime(iso: string) {
  return `${iso.slice(11, 16)} UTC`;
}

function shortDay(day: string) {
  return day.slice(5);
}

function Stat(props: { label: string; value: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[10px] font-bold uppercase tracking-wide text-text-muted">
        {props.label}
      </div>
      <div className="mt-1 text-[19px] font-semibold tabular-nums text-text-primary">
        {props.value}
      </div>
      {props.hint && <div className="text-[11px] text-text-muted">{props.hint}</div>}
      {props.children}
    </div>
  );
}

function BalanceChart(props: {
  points: Array<{ day: string; value: number }>;
  refills: Array<{ day: string; credits: number }>;
}) {
  const gradientId = useId();
  const color = "#5b8def";

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[12px] text-text-muted uppercase tracking-wider font-semibold">
          Balance over time
        </h2>
        <span className="text-[12px] text-text-muted">Last {CHART_DAYS} days · UTC</span>
      </div>
      {props.points.length === 0 ? (
        <div className="flex h-[300px] items-center justify-center text-[13px] text-text-muted">
          No balance observations yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={props.points} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border, #333)" />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 11, fill: "var(--color-text-muted, #888)" }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
              tickFormatter={shortDay}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--color-text-muted, #888)" }}
              axisLine={false}
              tickLine={false}
              width={56}
              allowDecimals={false}
              tickFormatter={fmtCredits}
            />
            {props.refills.map((refill) => (
              <ReferenceLine
                key={`${refill.day}-${refill.credits}`}
                x={refill.day}
                stroke="#4ead6b"
                strokeDasharray="4 4"
              />
            ))}
            <Area
              type="monotone"
              dataKey="value"
              name="Balance"
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 4, fill: color, strokeWidth: 0 }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-card, #1a1a2e)",
                border: "1px solid var(--color-border, #333)",
                borderRadius: 8,
                fontSize: 13,
              }}
              wrapperStyle={{ zIndex: 20 }}
              formatter={(value) => [fmtCredits(Number(value ?? 0)), "Balance"]}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
      {props.refills.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {props.refills.map((refill) => (
            <span
              key={`${refill.day}-${refill.credits}-badge`}
              className="rounded-md border border-border bg-hover-alt/30 px-2 py-0.5 text-[11px] text-text-muted"
            >
              Refill +{fmtCredits(Math.abs(refill.credits))} on {refill.day}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const thClass = "px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted";
const tdClass = "px-4 py-2.5 text-[13px] text-text-secondary tabular-nums";

function LedgerRow(props: { row: OfapiCreditsLedgerResponse["rows"][number] }) {
  const [expanded, setExpanded] = useState(false);
  const { row } = props;

  return (
    <Fragment>
      <tr
        className="cursor-pointer border-t border-border-light hover:bg-hover"
        onClick={() => setExpanded((value) => !value)}
      >
        <td className={tdClass}>{utcDateTime(row.occurredAt)}</td>
        <td className={tdClass}>{row.source}</td>
        <td className={tdClass}>{row.operation ?? "—"}</td>
        <td className={tdClass}>{row.pageLabel ?? "—"}</td>
        <td className={`${tdClass} text-right ${row.credits < 0 ? "text-success" : ""}`}>
          {fmtCredits(row.credits)}
        </td>
        <td className={`${tdClass} text-right`}>
          {row.balanceAfter !== null ? fmtCredits(row.balanceAfter) : "—"}
        </td>
        <td className={`${tdClass} text-right`}>{row.httpStatus ?? "—"}</td>
        <td className={tdClass}>{row.estimated ? "~" : ""}</td>
      </tr>
      {expanded && (
        <tr className="border-t border-border-light bg-hover-alt/20">
          <td colSpan={8} className="px-4 py-2 text-[12px] text-text-muted">
            {row.requestId ? `Request ${row.requestId}` : "No request id"}
            {row.accrualDay ? ` · accrual day ${row.accrualDay}` : ""}
            {` · ledger #${row.id}`}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function OfapiCreditsPage() {
  const summaryQuery = useAdminOfapiCreditsSummary();
  const chartsQuery = useAdminOfapiCreditsDaily(CHART_DAYS);
  const [breakdownDays, setBreakdownDays] = useState<number>(30);
  const breakdownQuery = useAdminOfapiCreditsDaily(breakdownDays);

  const [ledgerOffset, setLedgerOffset] = useState(0);
  const [sourceFilter, setSourceFilter] = useState("");
  const [operationFilter, setOperationFilter] = useState("");
  const [pageFilter, setPageFilter] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");

  const ledgerQuery = useAdminOfapiCreditsLedger({
    offset: ledgerOffset,
    limit: LEDGER_PAGE_SIZE,
    source: sourceFilter || undefined,
    operation: operationFilter.trim() || undefined,
    pageId: pageFilter ? Number(pageFilter) : undefined,
    from: fromFilter ? `${fromFilter}T00:00:00.000Z` : undefined,
    to: toFilter ? `${toFilter}T23:59:59.999Z` : undefined,
  });

  const summary = summaryQuery.data;
  const charts = chartsQuery.data;
  const breakdown = breakdownQuery.data;
  const ledger = ledgerQuery.data;

  const balancePoints = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const point of charts?.balance ?? []) {
      byDay.set(point.at.slice(0, 10), point.value);
    }
    return Array.from(byDay.entries()).map(([day, value]) => ({ day, value }));
  }, [charts]);

  const refillMarkers = useMemo(
    () => (charts?.refills ?? []).map((refill) => ({
      day: refill.at.slice(0, 10),
      credits: refill.credits,
    })),
    [charts],
  );

  const dailyBars = useMemo(
    () => (charts?.days ?? []).map((day) => ({
      day: day.day,
      rest: day.bySource.rest,
      webhookAccrual: day.bySource.webhookAccrual,
      external: day.bySource.external,
      adjustment: day.bySource.adjustment,
    })),
    [charts],
  );

  const operationTotal = (breakdown?.byOperation ?? [])
    .reduce((sum, row) => sum + row.credits, 0);
  const pageTotal = (breakdown?.byPage ?? []).reduce((sum, row) => sum + row.credits, 0);

  const filterSelectClass =
    "rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px] text-text-secondary";

  if (summaryQuery.isLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <StatCardSkeleton count={4} />
      </div>
    );
  }

  if (summaryQuery.isError || !summary) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <StatusPanel
          title="Failed to load OFAPI credits"
          description="The credit summary endpoint returned an error. Retry shortly."
          tone="error"
        />
      </div>
    );
  }

  const parkedBudgets = summary.budgets.filter((budget) => budget.state !== "ok");

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-extrabold text-text-primary">OFAPI Credits</h1>
          <p className="mt-1 text-sm text-text-muted">
            Credit balance, spend, and ledger for the onlyfansapi.com integration · all times UTC
          </p>
        </div>
      </div>

      {!summary.enabled && (
        <div className="mb-5">
          <StatusPanel
            title="Credit ledger disabled"
            description="Set OFAPI_CREDIT_LEDGER_ENABLED=true to record per-request spend, webhook accrual, reconciliation, and burn alerts. The cards below only reflect the legacy day counter."
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Balance"
          value={summary.balance.value !== null ? `${fmtCredits(summary.balance.value)} cr` : "—"}
          hint={summary.balance.observedAt
            ? `as of ${utcTime(summary.balance.observedAt)}`
            : "no balance observed yet"}
        />
        <Stat label="Spent today" value={`${fmtCredits(summary.today.total)} cr`} hint={summary.today.day}>
          <div className="mt-1 space-y-0.5 text-[11px] text-text-muted tabular-nums">
            <div>core {fmtCredits(summary.today.bySource.rest)}</div>
            <div>webhooks {fmtCredits(summary.today.bySource.webhookAccrual)}</div>
            <div>external {fmtCredits(summary.today.bySource.external + summary.today.bySource.adjustment)}</div>
          </div>
        </Stat>
        <Stat
          label="Stream budgets"
          value={summary.budgets
            .map((budget) => `${budget.stream} ${fmtCredits(budget.spentToday)}/${fmtCredits(budget.dailyCeiling)}`)
            .join(" · ")}
          hint={summary.floor.blocked
            ? `floor ${fmtCredits(summary.floor.value)} BLOCKED`
            : `floor ${fmtCredits(summary.floor.value)} OK`}
        />
        <Stat
          label="Forecast"
          value={summary.forecast.daysLeft !== null ? `~${summary.forecast.daysLeft} days left` : "—"}
          hint={`avg ${summary.forecast.avgDailySpend7d} cr/day (7d)${
            summary.forecast.runOutDate ? ` · out ${summary.forecast.runOutDate}` : ""
          }`}
        />
      </div>

      <div className="mt-4 rounded-xl border border-border bg-card px-4 py-3 text-[12px] text-text-secondary">
        <span className="font-semibold uppercase tracking-wide text-text-muted">Ops</span>
        <span className="ml-3">
          {parkedBudgets.length > 0
            ? parkedBudgets
              .map((budget) =>
                `${budget.stream} parked (${budget.state === "floor_blocked"
                  ? "balance floor"
                  : `until ${budget.retryAt ? utcDateTime(budget.retryAt) : "budget reset"}`})`)
              .join(" · ")
            : "no parked streams"}
        </span>
        <span className="mx-2 text-text-muted">·</span>
        <span>
          {summary.incidents.length > 0
            ? `incidents: ${summary.incidents.map((incident) => incident.kind).join(", ")}`
            : "no open incidents"}
        </span>
        <span className="mx-2 text-text-muted">·</span>
        <span>
          {summary.reconciliation.lastRunAt
            ? `last reconcile ${utcDateTime(summary.reconciliation.lastRunAt)}, drift ${
              summary.reconciliation.lastDriftCredits ?? 0
            }`
            : "reconciliation has not run"}
        </span>
        <span className="mx-2 text-text-muted">·</span>
        <span>
          {summary.accrual.lastPostedDay
            ? `accrual posted for ${summary.accrual.lastPostedDay}`
            : "no accrual posted"}
        </span>
      </div>

      {summary.enabled && (
        <>
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <BalanceChart points={balancePoints} refills={refillMarkers} />
            <StackedBarChart
              title="Daily spend by source"
              data={dailyBars}
              xKey="day"
              series={[...SOURCE_SERIES]}
              xTickFormatter={shortDay}
              valueFormatter={fmtCredits}
              yAxisWidth={48}
              headerExtra={(
                <span className="text-[12px] text-text-muted">Last {CHART_DAYS} days · UTC</span>
              )}
            />
          </div>

          <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between px-4 py-3">
              <h2 className="text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                Breakdown
              </h2>
              <div className="flex overflow-hidden rounded-lg border border-border">
                {BREAKDOWN_PERIODS.map((period) => (
                  <button
                    key={period}
                    type="button"
                    onClick={() => setBreakdownDays(period)}
                    className={`px-3 py-1 text-[11px] font-semibold transition-colors ${
                      breakdownDays === period
                        ? "bg-accent text-white"
                        : "bg-card text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    {period}d
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-0 border-t border-border-light lg:grid-cols-2">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-hover-alt">
                    <th className={thClass}>Operation</th>
                    <th className={`${thClass} text-right`}>Requests</th>
                    <th className={`${thClass} text-right`}>Credits</th>
                    <th className={`${thClass} text-right`}>Share</th>
                    <th className={`${thClass} text-right`}>cr/day</th>
                  </tr>
                </thead>
                <tbody>
                  {(breakdown?.byOperation ?? []).map((row) => (
                    <tr key={row.operation ?? "unknown"} className="border-t border-border-light">
                      <td className={tdClass}>{row.operation ?? "unknown"}</td>
                      <td className={`${tdClass} text-right`}>{fmtCredits(row.requests)}</td>
                      <td className={`${tdClass} text-right`}>{fmtCredits(row.credits)}</td>
                      <td className={`${tdClass} text-right`}>
                        {operationTotal > 0 ? `${Math.round((row.credits / operationTotal) * 100)}%` : "—"}
                      </td>
                      <td className={`${tdClass} text-right`}>
                        {(row.credits / breakdownDays).toFixed(1)}
                      </td>
                    </tr>
                  ))}
                  {(breakdown?.byOperation ?? []).length === 0 && (
                    <tr className="border-t border-border-light">
                      <td colSpan={5} className={`${tdClass} text-text-muted`}>
                        No REST spend in this window
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <table className="w-full border-collapse lg:border-l lg:border-border-light">
                <thead>
                  <tr className="bg-hover-alt">
                    <th className={thClass}>Page</th>
                    <th className={`${thClass} text-right`}>Credits</th>
                    <th className={`${thClass} text-right`}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {(breakdown?.byPage ?? []).map((row) => (
                    <tr key={row.pageId} className="border-t border-border-light">
                      <td className={tdClass}>{row.pageLabel}</td>
                      <td className={`${tdClass} text-right`}>{fmtCredits(row.credits)}</td>
                      <td className={`${tdClass} text-right`}>
                        {pageTotal > 0 ? `${Math.round((row.credits / pageTotal) * 100)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                  {(breakdown?.byPage ?? []).length === 0 && (
                    <tr className="border-t border-border-light">
                      <td colSpan={3} className={`${tdClass} text-text-muted`}>
                        No page-attributed spend in this window
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <h2 className="mr-auto text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                Ledger
              </h2>
              <select
                value={sourceFilter}
                onChange={(event) => {
                  setSourceFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                className={filterSelectClass}
                aria-label="Filter by source"
              >
                {SOURCE_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <select
                value={pageFilter}
                onChange={(event) => {
                  setPageFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                className={filterSelectClass}
                aria-label="Filter by page"
              >
                <option value="">All pages</option>
                {(breakdown?.byPage ?? []).map((row) => (
                  <option key={row.pageId} value={String(row.pageId)}>{row.pageLabel}</option>
                ))}
              </select>
              <input
                value={operationFilter}
                onChange={(event) => {
                  setOperationFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                placeholder="operation"
                className={`${filterSelectClass} w-36`}
                aria-label="Filter by operation"
              />
              <input
                type="date"
                value={fromFilter}
                onChange={(event) => {
                  setFromFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                className={filterSelectClass}
                aria-label="From date (UTC)"
              />
              <input
                type="date"
                value={toFilter}
                onChange={(event) => {
                  setToFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                className={filterSelectClass}
                aria-label="To date (UTC)"
              />
            </div>
            {ledgerQuery.isLoading ? (
              <TableSkeleton rows={8} columns={8} />
            ) : (ledger?.rows.length ?? 0) === 0 ? (
              <EmptyState
                title="No ledger rows"
                description="No credit movement matches the current filters."
              />
            ) : (
              <>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-hover-alt">
                      <th className={thClass}>Time (UTC)</th>
                      <th className={thClass}>Source</th>
                      <th className={thClass}>Operation</th>
                      <th className={thClass}>Page</th>
                      <th className={`${thClass} text-right`}>Credits</th>
                      <th className={`${thClass} text-right`}>Balance after</th>
                      <th className={`${thClass} text-right`}>HTTP</th>
                      <th className={thClass}>Est.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(ledger?.rows ?? []).map((row) => (
                      <LedgerRow key={row.id} row={row} />
                    ))}
                  </tbody>
                </table>
                <Pagination
                  offset={ledgerOffset}
                  limit={LEDGER_PAGE_SIZE}
                  total={ledger?.total ?? 0}
                  onPageChange={setLedgerOffset}
                  emptyLabel="0 rows"
                />
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
