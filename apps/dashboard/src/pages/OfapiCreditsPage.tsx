import { Fragment, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
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
import { formatUsdFromMills } from "@agency_hub_core/shared";
import type { OfapiCreditsLedgerResponse } from "@agency_hub_core/contracts";
import {
  useAdminOfapiCreditsDaily,
  useAdminOfapiCreditsLedger,
  useAdminOfapiCreditsSummary,
} from "@/api/queries";
import { downloadOfapiCreditsLedgerCsv } from "@/api/adminOfapiCredits";
import { EmptyState } from "@/components/shared/EmptyState";
import { Pagination } from "@/components/shared/Pagination";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";

const LEDGER_PAGE_SIZE = 50;
const CHART_DAYS = 30;

// Runway urgency thresholds (days of balance left) for the forecast card.
const RUNWAY_DANGER_DAYS = 3;
const RUNWAY_WARNING_DAYS = 7;

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

type ValueTone = "neutral" | "warning" | "danger";

function valueToneClass(tone: ValueTone | undefined) {
  if (tone === "danger") return "text-red-700";
  if (tone === "warning") return "text-amber-700";
  return "text-text-primary";
}

function Stat(props: {
  label: string;
  value: string;
  valueTone?: ValueTone;
  hint?: string;
  hintTone?: "muted" | "danger";
  children?: ReactNode;
}) {
  // C3: labels/hints carry meaning, so they use the accessible `text-secondary`
  // token (not the sub-AA `text-muted`).
  const hintClass = props.hintTone === "danger"
    ? "text-red-700 font-semibold"
    : "text-text-secondary";
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-text-secondary">
        {props.label}
      </div>
      <div className={`mt-1 text-[19px] font-semibold tabular-nums ${valueToneClass(props.valueTone)}`}>
        {props.value}
      </div>
      {props.hint && <div className={`text-[11px] ${hintClass}`}>{props.hint}</div>}
      {props.children}
    </div>
  );
}

// C1: dot-separated grey run-on strings are replaced by color-coded status chips.
// Healthy = neutral, warning = amber, blocked/incident = red.
function StatusChip(props: { tone: ValueTone; children: ReactNode; title?: string }) {
  const toneClass = props.tone === "danger"
    ? "border-red-500/40 bg-red-500/10 text-red-700"
    : props.tone === "warning"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
      : "border-border bg-hover-alt text-text-secondary";
  return (
    <span
      title={props.title}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px] font-medium ${toneClass}`}
    >
      {props.children}
    </span>
  );
}

function RetryButton(props: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-text-secondary hover:bg-hover"
    >
      Retry
    </button>
  );
}

// D2: deep-link a shown budget/floor/alert value to its Settings > Configuration
// entry (anchored by config key), without inline editing.
function ConfigLink(props: { configKey: string; children: ReactNode }) {
  return (
    <Link
      to={`/settings?tab=configuration#config-${props.configKey}`}
      className="font-medium text-accent underline-offset-2 hover:underline"
    >
      {props.children}
    </Link>
  );
}

function Caret(props: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="10"
      height="10"
      aria-hidden="true"
      className={`transition-transform ${props.expanded ? "rotate-90" : ""}`}
    >
      <path
        d="M4 2l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Micro-USD per credit → a formatted USD estimate. 1 mill = 1000 micro-USD, so
// mills = credits * microUsdPerCredit / 1000; reuse the shared mills formatter so
// the estimate reads identically to the actual revenue figures on the page.
function creditsToUsd(credits: number, microUsdPerCredit: number) {
  return formatUsdFromMills(Math.round((credits * microUsdPerCredit) / 1000));
}

// C1: a compact per-stream budget meter replaces the run-on "dm 84/500 · …" text.
// The bar reddens once the stream is parked (exhausted or floor-blocked).
function BudgetMeter(props: {
  stream: string;
  spentToday: number;
  dailyCeiling: number;
  state: "ok" | "budget_exhausted" | "floor_blocked";
}) {
  const pct = props.dailyCeiling > 0
    ? Math.min(100, Math.round((props.spentToday / props.dailyCeiling) * 100))
    : 0;
  const parked = props.state !== "ok";
  const barClass = parked
    ? "bg-red-500"
    : pct >= 80
      ? "bg-amber-500"
      : "bg-accent";
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px] tabular-nums">
        <span className="font-medium uppercase tracking-wide text-text-secondary">{props.stream}</span>
        <span className={parked ? "text-red-700 font-semibold" : "text-text-secondary"}>
          {fmtCredits(props.spentToday)}/{fmtCredits(props.dailyCeiling)}
        </span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover-alt"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${props.stream} daily budget: ${props.spentToday} of ${props.dailyCeiling} credits`}
      >
        <div className={`h-full ${barClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// A page's revenue ÷ estimated credit cost, or null when it can't be computed
// (no configured price, or the page cost no credits). Returns a raw ratio so the
// caller can both format and tone-colour it.
function computeRoi(revenueMills: number, credits: number, microUsdPerCredit: number): number | null {
  if (microUsdPerCredit <= 0 || credits <= 0) {
    return null;
  }
  const costMills = (credits * microUsdPerCredit) / 1000;
  if (costMills <= 0) {
    return null;
  }
  return revenueMills / costMills;
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
        <h2 className="text-[12px] text-text-secondary uppercase tracking-wider font-semibold">
          Balance over time
        </h2>
        <span className="text-[12px] text-text-secondary">Last {CHART_DAYS} days · UTC</span>
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
              className="rounded-md border border-border bg-hover-alt/30 px-2 py-0.5 text-[11px] text-text-secondary"
            >
              Refill +{fmtCredits(Math.abs(refill.credits))} on {refill.day}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const thClass = "px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-secondary";
const tdClass = "px-4 py-2.5 text-[13px] text-text-secondary tabular-nums";
// A breakdown label that drills into the matching ledger filter.
const drillCellClass =
  "text-left text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent rounded";

function LedgerRow(props: { row: OfapiCreditsLedgerResponse["rows"][number] }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const { row } = props;
  const toggle = () => setExpanded((value) => !value);

  return (
    <Fragment>
      <tr
        className="cursor-pointer border-t border-border-light hover:bg-hover"
        onClick={toggle}
      >
        <td className={`${tdClass} w-8 pr-0`}>
          {/* C3: a real button gives keyboard + screen-reader access to the
              detail row; the row onClick stays as a mouse convenience. */}
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={expanded ? "Collapse ledger row details" : "Expand ledger row details"}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Caret expanded={expanded} />
          </button>
        </td>
        <td className={tdClass}>{utcDateTime(row.occurredAt)}</td>
        <td className={tdClass}>{row.source}</td>
        <td className={tdClass}>{row.operation ?? "—"}</td>
        <td className={tdClass}>{row.pageLabel ?? "—"}</td>
        <td className={`${tdClass} text-right ${row.credits < 0 ? "text-green" : ""}`}>
          {fmtCredits(row.credits)}
        </td>
        <td className={`${tdClass} text-right`}>
          {row.balanceAfter !== null ? fmtCredits(row.balanceAfter) : "—"}
        </td>
        <td className={`${tdClass} text-right`}>{row.httpStatus ?? "—"}</td>
        <td className={tdClass}>{row.estimated ? "~" : ""}</td>
      </tr>
      {expanded && (
        <tr id={detailId} className="border-t border-border-light bg-hover-alt/20">
          <td colSpan={9} className="px-4 py-2 text-[12px] text-text-secondary">
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
  const operationListId = useId();

  const [ledgerOffset, setLedgerOffset] = useState(0);
  const [sourceFilter, setSourceFilter] = useState("");
  const [operationFilter, setOperationFilter] = useState("");
  const [pageFilter, setPageFilter] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");

  const ledgerRef = useRef<HTMLElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [exportTruncated, setExportTruncated] = useState(false);

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

  const operationOptions = useMemo(
    () => Array.from(
      new Set(
        (breakdown?.byOperation ?? [])
          .map((row) => row.operation)
          .filter((operation): operation is string => operation !== null),
      ),
    ),
    [breakdown],
  );

  const operationTotal = (breakdown?.byOperation ?? [])
    .reduce((sum, row) => sum + row.credits, 0);

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
          action={<RetryButton onClick={() => summaryQuery.refetch()} />}
        />
      </div>
    );
  }

  const parkedBudgets = summary.budgets.filter((budget) => budget.state !== "ok");
  const pendingWebhookEstimate = summary.accrual.pendingToday ?? null;
  const hasAudienceBudget = summary.budgets.some((budget) => budget.stream === "audience");

  // USD context (goal 1): a display-only flat credit price from Settings. 0 means
  // unset, and every USD estimate on the page is suppressed.
  const microUsdPerCredit = summary.pricing?.microUsdPerCredit ?? 0;
  const priceKnown = microUsdPerCredit > 0;
  const usd = (credits: number) => creditsToUsd(credits, microUsdPerCredit);

  const focusLedger = () => {
    ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // Goal 4: a breakdown row drills straight into the matching ledger filter.
  const drillByOperation = (operation: string) => {
    setOperationFilter(operation);
    setLedgerOffset(0);
    focusLedger();
  };
  const drillByPage = (pageId: number) => {
    setPageFilter(String(pageId));
    setLedgerOffset(0);
    focusLedger();
  };

  const handleExport = async () => {
    setExporting(true);
    setExportError(false);
    setExportTruncated(false);
    try {
      const result = await downloadOfapiCreditsLedgerCsv({
        source: sourceFilter || undefined,
        operation: operationFilter.trim() || undefined,
        pageId: pageFilter ? Number(pageFilter) : undefined,
        from: fromFilter ? `${fromFilter}T00:00:00.000Z` : undefined,
        to: toFilter ? `${toFilter}T23:59:59.999Z` : undefined,
      });
      // The server caps a single export; warn so a capped extract is never
      // mistaken for a complete accounting export.
      setExportTruncated(result.truncated);
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  };
  const runwayTone: ValueTone = summary.forecast.daysLeft === null
    ? "neutral"
    : summary.forecast.daysLeft < RUNWAY_DANGER_DAYS
      ? "danger"
      : summary.forecast.daysLeft < RUNWAY_WARNING_DAYS
        ? "warning"
        : "neutral";

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-extrabold text-text-primary">OFAPI Credits</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Credit balance, spend, and ledger for the onlyfansapi.com integration · all times UTC
          </p>
        </div>
      </div>

      {!summary.enabled && (
        <div className="mb-5">
          <StatusPanel
            title="Credit ledger disabled"
            description="Turn on the OFAPI credit ledger in Settings → Configuration to record per-request spend, webhook accrual, reconciliation, burn alerts, and pending webhook estimates. It is a staged flag — enable OFAPI account health first, then the credit ledger."
            action={(
              <Link
                to="/settings?tab=configuration#config-ofapiCreditLedgerEnabled"
                className="inline-flex items-center rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-accent hover:bg-hover"
              >
                Open Configuration →
              </Link>
            )}
          />
        </div>
      )}

      {(summary.floor.blocked || summary.incidents.length > 0) && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-start gap-x-3 gap-y-1 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-700"
        >
          <span aria-hidden="true">⚠</span>
          {summary.floor.blocked && (
            <span>
              Balance floor blocked ({fmtCredits(summary.floor.value)} cr) — OFAPI spend is halted until
              the balance recovers above the floor.
            </span>
          )}
          {summary.incidents.length > 0 && (
            <span>Open incidents: {summary.incidents.map((incident) => incident.kind).join(", ")}.</span>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Balance"
          value={summary.balance.value !== null ? `${fmtCredits(summary.balance.value)} cr` : "—"}
          hint={summary.balance.observedAt
            ? `as of ${utcTime(summary.balance.observedAt)}`
            : "no balance observed yet"}
        >
          {priceKnown && summary.balance.value !== null && (
            <div className="mt-1 text-[11px] text-text-secondary tabular-nums">
              ≈ {usd(summary.balance.value)}
            </div>
          )}
        </Stat>
        <Stat
          label="Spent today"
          value={`${fmtCredits(summary.today.total)} cr`}
          hint={priceKnown ? `${summary.today.day} · ≈ ${usd(summary.today.total)}` : summary.today.day}
        >
          <div className="mt-1 space-y-0.5 text-[11px] text-text-secondary tabular-nums">
            <div>core {fmtCredits(summary.today.bySource.rest)}</div>
            <div>webhooks {fmtCredits(summary.today.bySource.webhookAccrual)}</div>
            <div>external {fmtCredits(summary.today.bySource.external + summary.today.bySource.adjustment)}</div>
          </div>
        </Stat>
        {/* C1/goal 3: per-stream budget meters instead of a run-on text value. */}
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-text-secondary">
            Stream budgets
          </div>
          <div className="mt-2 space-y-2">
            {summary.budgets.map((budget) => (
              <BudgetMeter
                key={budget.stream}
                stream={budget.stream}
                spentToday={budget.spentToday}
                dailyCeiling={budget.dailyCeiling}
                state={budget.state}
              />
            ))}
          </div>
          <div
            className={`mt-2 text-[11px] ${
              summary.floor.blocked ? "text-red-700 font-semibold" : "text-text-secondary"
            }`}
          >
            {summary.floor.blocked
              ? `floor ${fmtCredits(summary.floor.value)} BLOCKED`
              : `floor ${fmtCredits(summary.floor.value)} OK`}
          </div>
        </div>
        <Stat
          label="Forecast"
          valueTone={runwayTone}
          value={summary.forecast.daysLeft !== null ? `~${summary.forecast.daysLeft} days left` : "—"}
          hint={`avg ${summary.forecast.avgDailySpend7d} cr/day (7d)${
            priceKnown ? ` · ≈ ${usd(summary.forecast.avgDailySpend7d)}/day` : ""
          }${summary.forecast.runOutDate ? ` · out ${summary.forecast.runOutDate}` : ""}`}
        />
      </div>

      {/* D2: jump to each knob's Settings > Configuration entry. Burn alert is
          live-editable there; budgets/floor are env-only (runtimeApply "none"),
          so the copy must not imply an in-app / restart-applied override. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-secondary">
        <span className="text-[11px] font-bold uppercase tracking-wide text-text-secondary">Config</span>
        <ConfigLink configKey="ofapiDmDailyCreditBudget">DM budget</ConfigLink>
        {hasAudienceBudget && (
          <ConfigLink configKey="ofapiAudienceDailyCreditBudget">Audience budget</ConfigLink>
        )}
        <ConfigLink configKey="ofapiCreditFloor">Credit floor</ConfigLink>
        <ConfigLink configKey="ofapiBurnAlertCreditsPerHour">Burn alert</ConfigLink>
        <ConfigLink configKey="ofapiCreditMicroUsdPrice">Credit price</ConfigLink>
        <span className="text-text-secondary">· burn alert is editable there (live); price, budgets &amp; floor are env-only</span>
        {!priceKnown && (
          <span className="text-text-secondary">
            · set a credit price to show USD cost &amp; ROI
          </span>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-text-secondary">Ops</span>
          {parkedBudgets.length > 0
            ? parkedBudgets.map((budget) => (
              <StatusChip key={budget.stream} tone={budget.state === "floor_blocked" ? "danger" : "warning"}>
                {budget.stream} parked · {budget.state === "floor_blocked"
                  ? "balance floor"
                  : `until ${budget.retryAt ? utcDateTime(budget.retryAt) : "budget reset"}`}
              </StatusChip>
            ))
            : <StatusChip tone="neutral">No parked streams</StatusChip>}
          {summary.incidents.length > 0
            ? (
              <StatusChip tone="danger">
                incidents: {summary.incidents.map((incident) => incident.kind).join(", ")}
              </StatusChip>
            )
            : <StatusChip tone="neutral">No open incidents</StatusChip>}
          <StatusChip tone="neutral">
            {summary.reconciliation.lastRunAt
              ? `reconciled ${utcDateTime(summary.reconciliation.lastRunAt)} · drift ${
                summary.reconciliation.lastDriftCredits ?? 0
              }`
              : "reconciliation has not run"}
          </StatusChip>
          <StatusChip tone="neutral">
            {summary.accrual.lastPostedDay
              ? `accrual posted for ${summary.accrual.lastPostedDay}`
              : "no accrual posted"}
          </StatusChip>
          {pendingWebhookEstimate && (
            <StatusChip tone="neutral">
              pending today {fmtCredits(pendingWebhookEstimate.estimatedCredits)} cr from{" "}
              {fmtCredits(pendingWebhookEstimate.eventCount)} events
            </StatusChip>
          )}
        </div>
      </div>

      {summary.enabled && (
        <>
          {chartsQuery.isError ? (
            <div className="mt-6">
              <StatusPanel
                tone="error"
                title="Failed to load spend charts"
                description="The daily series endpoint returned an error."
                action={<RetryButton onClick={() => chartsQuery.refetch()} />}
              />
            </div>
          ) : (
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
                  <span className="text-[12px] text-text-secondary">Last {CHART_DAYS} days · UTC</span>
                )}
              />
            </div>
          )}

          <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between px-4 py-3">
              <h2 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary">
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
                        : "bg-card text-text-secondary hover:text-text-primary"
                    }`}
                  >
                    {period}d
                  </button>
                ))}
              </div>
            </div>
            {breakdownQuery.isError ? (
              <div className="border-t border-border-light p-4">
                <StatusPanel
                  tone="error"
                  title="Failed to load breakdown"
                  description="The breakdown endpoint returned an error."
                  action={<RetryButton onClick={() => breakdownQuery.refetch()} />}
                />
              </div>
            ) : (
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
                        <td className={tdClass}>
                          {row.operation ? (
                            <button
                              type="button"
                              onClick={() => drillByOperation(row.operation as string)}
                              className={drillCellClass}
                              title={`Filter ledger by ${row.operation}`}
                            >
                              {row.operation}
                            </button>
                          ) : (
                            "unknown"
                          )}
                        </td>
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
                      <th className={`${thClass} text-right`} title="Estimated USD cost at the configured credit price">Cost</th>
                      <th className={`${thClass} text-right`} title="Net creator earnings over this window">Revenue</th>
                      <th className={`${thClass} text-right`} title="Revenue ÷ estimated credit cost">ROI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(breakdown?.byPage ?? []).map((row) => {
                      const revenueMills = row.revenueMills ?? 0;
                      const roi = computeRoi(revenueMills, row.credits, microUsdPerCredit);
                      return (
                        <tr key={row.pageId} className="border-t border-border-light">
                          <td className={tdClass}>
                            <button
                              type="button"
                              onClick={() => drillByPage(row.pageId)}
                              className={drillCellClass}
                              title={`Filter ledger by ${row.pageLabel}`}
                            >
                              {row.pageLabel}
                            </button>
                          </td>
                          <td className={`${tdClass} text-right`}>{fmtCredits(row.credits)}</td>
                          <td className={`${tdClass} text-right`}>
                            {priceKnown ? usd(row.credits) : "—"}
                          </td>
                          <td className={`${tdClass} text-right`}>{formatUsdFromMills(revenueMills)}</td>
                          <td className={`${tdClass} text-right`}>
                            {roi === null
                              ? "—"
                              : (
                                <span className={roi >= 1 ? "text-green" : "text-red-700 font-medium"}>
                                  {roi.toFixed(1)}×
                                </span>
                              )}
                          </td>
                        </tr>
                      );
                    })}
                    {(breakdown?.byPage ?? []).length === 0 && (
                      <tr className="border-t border-border-light">
                        <td colSpan={5} className={`${tdClass} text-text-muted`}>
                          No page-attributed spend in this window
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section
            ref={ledgerRef}
            className="mt-6 scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card"
          >
            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <h2 className="mr-auto text-[12px] font-semibold uppercase tracking-wider text-text-secondary">
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
              {/* A3: exact-match filter fed by a datalist of real operations, so a
                  partial guess resolves to a known value instead of zero rows. */}
              <input
                value={operationFilter}
                onChange={(event) => {
                  setOperationFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                list={operationListId}
                placeholder="operation"
                className={`${filterSelectClass} w-36`}
                aria-label="Filter by operation"
              />
              <datalist id={operationListId}>
                {operationOptions.map((operation) => (
                  <option key={operation} value={operation} />
                ))}
              </datalist>
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
              {/* Goal 5: a real CSV export of every row matching the current
                  filters (not just the visible page) for accounting. */}
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting || (ledger?.total ?? 0) === 0}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-text-secondary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                title="Download every ledger row matching the current filters as CSV"
              >
                {exporting ? "Exporting…" : "Export CSV"}
              </button>
              {exportError && (
                <span role="alert" className="text-[12px] font-medium text-red-700">
                  Export failed — retry
                </span>
              )}
              {exportTruncated && !exportError && (
                <span role="alert" className="text-[12px] font-medium text-amber-700">
                  Export capped at 50,000 rows — narrow the filters for a complete extract
                </span>
              )}
            </div>
            {ledgerQuery.isLoading ? (
              <TableSkeleton rows={8} columns={9} />
            ) : ledgerQuery.isError ? (
              <div className="p-4">
                <StatusPanel
                  tone="error"
                  title="Failed to load ledger"
                  description="The ledger endpoint returned an error. Your filters are preserved."
                  action={<RetryButton onClick={() => ledgerQuery.refetch()} />}
                />
              </div>
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
                      <th className={`${thClass} w-8`}><span className="sr-only">Toggle details</span></th>
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
