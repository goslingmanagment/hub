import { buildSettingsRoute } from "../lib/navigation.js";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
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
import {
  CHART_ANIMATION,
  CHART_MARGIN,
  ChartTooltipCard,
  activeDot,
  chartGridProps,
  lineCursor,
  useTickBudget,
  xAxisProps,
  yAxisProps,
  type ChartTooltipRenderProps,
} from "@/components/charts/ChartKit";
import { evenTickIndices, linearTicks } from "@/components/charts/scale";
import { formatBusinessDateShort } from "@/lib/format";
import { formatUsdFromMills } from "@agency_hub_core/shared";
import type {
  OfapiCreditsLedgerResponse,
  OfapiCreditsSummaryResponse,
} from "@agency_hub_core/contracts";
import {
  useAdminOfapiCreditsDaily,
  useAdminOfapiCreditsLedger,
  useAdminOfapiSpendComparison,
  useAdminOfapiCreditsSummary,
} from "@/api/queries";
import { downloadOfapiCreditsLedgerCsv } from "@/api/adminOfapiCredits";
import { EmptyState } from "@/components/shared/EmptyState";
import { Pagination } from "@/components/shared/Pagination";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { ruPlural } from "@/lib/plural";

const LEDGER_PAGE_SIZE = 50;
const CHART_DAYS = 30;

// Runway urgency thresholds (days of balance left) for the hero card.
const RUNWAY_DANGER_DAYS = 3;
const RUNWAY_WARNING_DAYS = 7;

// The validated chart hues in their categorical order (never the status
// colours: "Сверка баланса" is a source, not a warning).
const SOURCE_SERIES = [
  { key: "rest", label: "Приложение", color: "var(--color-chart-blue)" },
  { key: "webhookAccrual", label: "Вебхуки", color: "var(--color-chart-orange)" },
  { key: "external", label: "Сверка баланса", color: "var(--color-chart-aqua)" },
  { key: "adjustment", label: "Корректировки", color: "var(--color-text-muted)" },
] as const;

const SOURCE_FILTER_OPTIONS = [
  { value: "", label: "Все источники" },
  { value: "rest", label: "Приложение" },
  { value: "webhook_accrual", label: "Вебхуки" },
  { value: "external", label: "Сверка баланса" },
  { value: "refill", label: "Рост баланса" },
  { value: "adjustment", label: "Корректировки" },
] as const;

const LEDGER_SOURCE_LABELS: Record<string, string> = {
  rest: "Приложение",
  webhook_accrual: "Вебхук",
  external: "Сверка баланса",
  refill: "Рост баланса",
  adjustment: "Корректировка",
};

function sourceLabel(source: string) {
  return LEDGER_SOURCE_LABELS[source] ?? source;
}

// Plain-language names for the raw ledger operation ids. Bare ofapi_* ops are the
// hub's own background sync, ofapi_command_* are chatter actions, and
// ofapi_gateway_* are live reads proxied for the desktop app. Unknown ops fall
// back to the raw id so they stay filterable.
const OPERATION_LABELS: Record<string, string> = {
  ofapi_chats: "Синк чатов",
  ofapi_chat_messages: "Синк сообщений",
  ofapi_dm_conversations: "Синк диалогов",
  ofapi_transactions: "Синк транзакций",
  ofapi_fans_active: "Синк активных фанатов",
  ofapi_fans_expired: "Синк истёкших фанатов",
  ofapi_audience: "Синк аудитории",
  ofapi_audience_sweep: "Обход аудитории",
  ofapi_sync_events: "Синк событий",
  ofapi_balance_ping: "Проверка баланса",
  ofapi_admin_accounts: "Проверка аккаунта",
  ofapi_webhook_crud: "Настройка вебхуков",
  ofapi_command_send_text: "Отправка сообщения",
  ofapi_command_send_media: "Отправка медиа",
  ofapi_command_mark_chat_read: "Отметка чата прочитанным",
  ofapi_command_unsend_message: "Отзыв сообщения",
  ofapi_command_typing_active: "Индикатор набора",
  ofapi_gateway_chats: "Чаты (десктоп)",
  ofapi_gateway_chat_message: "Сообщение чата (десктоп)",
  ofapi_gateway_chat_messages: "Сообщения чата (десктоп)",
  ofapi_gateway_chat_media: "Медиа чата (десктоп)",
  ofapi_gateway_users_list: "Поиск фанатов (десктоп)",
  ofapi_gateway_user: "Профиль фаната (десктоп)",
  ofapi_gateway_transactions: "Транзакции (десктоп)",
  ofapi_gateway_fans_active: "Активные фанаты (десктоп)",
  ofapi_gateway_fans_expired: "Истёкшие фанаты (десктоп)",
  ofapi_gateway_user_lists: "Списки фанатов (десктоп)",
  ofapi_gateway_user_list_users: "Участники списка (десктоп)",
  ofapi_gateway_vault_media: "Медиа хранилища (десктоп)",
  ofapi_gateway_vault_lists: "Списки хранилища (десктоп)",
  ofapi_gateway_vault_media_item: "Файл хранилища (десктоп)",
  ofapi_gateway_upload_status: "Статус загрузки (десктоп)",
};

function operationLabel(operation: string) {
  return OPERATION_LABELS[operation] ?? operation;
}

const STREAM_LABELS: Record<string, string> = {
  dm: "Синк сообщений",
  audience: "Синк аудитории",
};

function streamLabel(stream: string) {
  return STREAM_LABELS[stream] ?? stream;
}

const INCIDENT_LABELS: Record<string, string> = {
  ofapi_burn_rate: "Кредиты сгорают необычно быстро",
  "ofapi_burn_rate:auto_redelivery_cap": "Исчерпан суточный лимит автоповтора вебхуков",
  ofapi_low_credit: "Баланс кредитов низкий",
  ofapi_credit_floor: "Баланс упал ниже порога автостопа",
  ofapi_daily_credit_budget: "Дневной бюджет синка исчерпан",
  ofapi_webhook_silence: "Вебхуки замолчали",
  ofapi_rate_limited: "Провайдер ограничивает запросы",
};

function incidentLabel(kind: string) {
  return INCIDENT_LABELS[kind] ?? kind.replace(/^ofapi_/, "").replace(/_/g, " ");
}

// Benign-status translations for the projection diagnostic; unknown statuses
// fall back to the raw id with underscores stripped.
const COMPARISON_STATUS_LABELS: Record<string, string> = {
  matched: "совпало",
  skipped: "пропущено",
  ppv_estimated: "PPV оценён",
  tips_blocked: "чаевые заблокированы",
  tips_signal: "чаевые (сигнал)",
  blocked: "заблокировано",
};

function comparisonStatusLabel(status: string) {
  return COMPARISON_STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

const BREAKDOWN_PERIODS = [7, 30, 90] as const;

function fmtCredits(value: number) {
  return value.toLocaleString("ru-RU");
}

function creditsWord(value: number) {
  return ruPlural(value, "кредит", "кредита", "кредитов");
}

/** "1 500 кредитов": the amount with its unit, for prose. */
function credits(value: number) {
  return `${fmtCredits(value)} ${creditsWord(value)}`;
}

function daysWord(value: number) {
  return ruPlural(value, "день", "дня", "дней");
}

// All timestamps on this page are UTC (budgets reset at UTC midnight).
function utcDateTime(iso: string) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A table cell's time: the column header says UTC once. */
function utcCellTime(iso: string) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function utcTime(iso: string) {
  return `${iso.slice(11, 16)} UTC`;
}

const MONTH_NAMES = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function humanDay(day: string) {
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  if (!month || !date) {
    return day;
  }
  return `${date} ${MONTH_NAMES[month - 1]}`;
}

function ledgerDateStart(value: string) {
  return value ? `${value}T00:00:00.000Z` : undefined;
}

function ledgerDateEndExclusive(value: string) {
  if (!value) {
    return undefined;
  }
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!year || !month || !day) {
    return undefined;
  }

  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString();
}

type ValueTone = "neutral" | "warning" | "danger";

function toneBadge(tone: ValueTone) {
  return tone === "danger" ? "badge badge-danger" : tone === "warning" ? "badge badge-warning" : "badge";
}

function RetryButton(props: { onClick: () => void }) {
  return (
    <button type="button" onClick={props.onClick} className="btn btn-sm">
      Повторить
    </button>
  );
}

/**
 * A reference to a value's entry in the parameter list. Most credit values are
 * set when the server is configured and are read-only there, so this reads as
 * a footnote, not as an action.
 */
function ConfigReference(props: { configKey: string; children: ReactNode }) {
  return (
    <Link
      to={`/settings?tab=configuration#config-${props.configKey}`}
      className="text-text-secondary underline decoration-dotted underline-offset-2 hover:text-text-primary"
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

// A page's revenue ÷ estimated credit cost, or null when it can't be computed
// (no configured price, or the page cost no credits).
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

function BudgetMeter(props: {
  stream: string;
  spentToday: number;
  dailyCeiling: number;
  state: "ok" | "budget_exhausted" | "floor_blocked";
  retryAt: string | null;
}) {
  const label = streamLabel(props.stream);
  const paused = props.state !== "ok";
  const unlimited = props.dailyCeiling <= 0;
  const pct = unlimited
    ? 0
    : Math.max(0, Math.min(100, Math.round((props.spentToday / props.dailyCeiling) * 100)));
  const barClass = paused
    ? "bg-danger"
    : pct >= 80
      ? "bg-warning"
      : "bg-accent";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-medium text-text-primary">{label}</span>
        <span className={`tabular-nums ${paused ? "font-semibold text-danger" : "text-text-secondary"}`}>
          {unlimited
            ? `${credits(props.spentToday)} · без дневного лимита`
            : `${fmtCredits(props.spentToday)} из ${credits(props.dailyCeiling)}`}
        </span>
      </div>
      {!unlimited && (
        <div
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-hover"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} — дневной бюджет: ${props.spentToday} из ${props.dailyCeiling} кредитов`}
        >
          <div className={`h-full ${barClass}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {paused && (
        <p className="mt-1 text-xs font-medium text-warning-dark">
          {props.state === "floor_blocked"
            ? "На паузе — баланс ниже порога автостопа."
            : `На паузе — дневной бюджет исчерпан. Продолжит ${
              props.retryAt ? `в ${utcDateTime(props.retryAt)}` : "после сброса бюджета в полночь UTC"
            }.`}
        </p>
      )}
    </div>
  );
}

function BalanceChart(props: {
  days: string[];
  balanceByDay: Map<string, number>;
  refills: Array<{ day: string; credits: number; count: number }>;
  usd?: ((credits: number) => string) | undefined;
}) {
  const gradientId = useId();
  const color = "var(--color-fansly)";

  // The x-axis spans the full requested window (dense day list from the API), so
  // "last 30 days" is honest even when balance readings only cover part of it,
  // and refill markers land on the axis no matter when they happened.
  const data = props.days.map((day) => ({
    day,
    value: props.balanceByDay.get(day) ?? null,
  }));
  const hasReadings = props.balanceByDay.size > 0;
  const { budget, onResize } = useTickBudget();
  // An area grows from zero, so its axis does too.
  const yScale = linearTicks(0, Math.max(0, ...props.balanceByDay.values()), { integer: true });
  const xTicks = evenTickIndices(data.length, budget).map((index) => data[index]!.day);
  const refillCount = props.refills.reduce((sum, refill) => sum + refill.count, 0);
  const refillTotal = props.refills.reduce((sum, refill) => sum + refill.credits, 0);
  const firstReadingDay = hasReadings
    ? Array.from(props.balanceByDay.keys()).sort()[0]
    : null;
  // When readings start mid-window, say so — otherwise the mostly-empty plot
  // reads as broken rather than young.
  const readingsStartedLate = firstReadingDay != null
    && props.days.length > 0
    && firstReadingDay > (props.days[0] ?? "");

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="card-title">Баланс</h2>
        <span className="text-[13px] text-text-secondary">Последние {CHART_DAYS} дней</span>
      </div>
      {!hasReadings ? (
        <div className="flex h-[300px] items-center justify-center px-6 text-center text-[13px] text-text-secondary">
          Показаний баланса пока нет — график начнётся с первой проверки баланса у провайдера.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={300} onResize={onResize}>
          <AreaChart data={data} margin={CHART_MARGIN}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.24} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid {...chartGridProps} />
            <XAxis {...xAxisProps} dataKey="day" ticks={xTicks} tickFormatter={formatBusinessDateShort} />
            <YAxis
              {...yAxisProps}
              domain={yScale.domain}
              ticks={yScale.ticks}
              tickFormatter={fmtCredits}
            />
            {props.refills.map((refill) => (
              <ReferenceLine
                key={refill.day}
                x={refill.day}
                stroke="var(--color-green)"
                strokeDasharray="4 4"
              />
            ))}
            <Area
              type="monotone"
              dataKey="value"
              name="Баланс"
              // A balance is a level: between two readings it moved from one to
              // the other, so the line bridges a day without a reading. The
              // tooltip still says that day had none.
              connectNulls
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={activeDot(color)}
              {...CHART_ANIMATION}
            />
            <Tooltip
              cursor={lineCursor}
              filterNull={false}
              isAnimationActive={false}
              wrapperStyle={{ zIndex: 20 }}
              content={(tooltip: ChartTooltipRenderProps) => (
                <ChartTooltipCard
                  {...tooltip}
                  series={[{ key: "value", label: "Баланс", color }]}
                  formatValue={(amount) =>
                    `${credits(amount)}${props.usd ? ` · ${props.usd(amount)}` : ""}`}
                  formatLabel={(label) => formatBusinessDateShort(String(label))}
                  emptyText="Нет показания баланса за этот день"
                />
              )}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
      {(refillCount > 0 || readingsStartedLate) && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text-secondary">
          {refillCount > 0 && (
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true" className="inline-block w-4 border-t-2 border-dashed border-green" />
              {refillCount} {ruPlural(refillCount, "увеличение", "увеличения", "увеличений")} баланса по сверке за
              период · +{credits(refillTotal)}
            </span>
          )}
          {refillCount > 0 && readingsStartedLate && <span aria-hidden="true">·</span>}
          {readingsStartedLate && firstReadingDay && (
            <span>показания с {humanDay(firstReadingDay)}</span>
          )}
        </p>
      )}
    </div>
  );
}

// A breakdown label that drills into the matching journal filter.
const drillCellClass = "link whitespace-nowrap text-left";

// Ledger credits are "credits spent": positive = balance went down, negative
// (top-ups, corrections) = balance went up. Render the balance impact a human
// expects from a transaction list, with "≈" marking estimated amounts.
function ledgerAmount(row: { credits: number; estimated: boolean }) {
  const approx = row.estimated ? "≈ " : "";
  if (row.credits === 0) {
    return `${approx}0`;
  }
  return row.credits < 0
    ? `${approx}+${fmtCredits(Math.abs(row.credits))}`
    : `${approx}-${fmtCredits(row.credits)}`;
}

const LEDGER_ESTIMATE_EXPLANATIONS: Record<OfapiCreditsLedgerResponse["rows"][number]["source"], string> = {
  rest: "Оценка при учёте HTTP-запроса; подтверждения и уточнения отражаются отдельными корректировками",
  webhook_accrual: "Оценка по числу полученных вебхуков, а не подтверждённое списание OFAPI",
  external: "Необъяснённое уменьшение баланса после учтённых расходов; источник не подтверждён",
  refill: "Увеличение баланса после учтённых расходов; платёж не подтверждён",
  adjustment: "Оценочная корректировка учёта кредитов",
};

function LedgerRow(props: { row: OfapiCreditsLedgerResponse["rows"][number]; showHttp: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const { row } = props;
  const estimateExplanation = row.estimated ? LEDGER_ESTIMATE_EXPLANATIONS[row.source] : null;
  const toggle = () => setExpanded((value) => !value);
  const failed = row.httpStatus !== null && row.httpStatus >= 400;

  return (
    <Fragment>
      <tr className="cursor-pointer" onClick={toggle}>
        <td className="w-8 pr-0">
          {/* A real button gives keyboard + screen-reader access to the detail
              row; the row onClick stays as a mouse convenience. */}
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={expanded ? "Свернуть детали записи" : "Развернуть детали записи"}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-text-muted hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Caret expanded={expanded} />
          </button>
        </td>
        <td className="muted whitespace-nowrap tabular-nums">{utcCellTime(row.occurredAt)}</td>
        <td className="muted">{sourceLabel(row.source)}</td>
        <td>
          {row.operation ? <span title={row.operation}>{operationLabel(row.operation)}</span> : "—"}
          {failed && !props.showHttp && <span className="badge badge-danger ml-2">ошибка {row.httpStatus}</span>}
        </td>
        <td className="muted">{row.pageLabel ?? "—"}</td>
        <td
          className={`num ${row.credits < 0 ? "font-medium text-green" : ""}`}
          title={estimateExplanation ?? undefined}
        >
          {ledgerAmount(row)}
        </td>
        <td className="num muted">
          {row.balanceAfter !== null ? fmtCredits(row.balanceAfter) : "—"}
        </td>
        {props.showHttp && (
          <td className={`num ${failed ? "font-medium text-danger" : "muted"}`}>
            {row.httpStatus ?? "—"}
          </td>
        )}
      </tr>
      {expanded && (
        <tr id={detailId}>
          <td colSpan={props.showHttp ? 8 : 7} className="bg-hover-alt text-[13px] text-text-secondary">
            {row.operation ? `Операция ${row.operation} · ` : ""}
            {row.requestId ? `запрос ${row.requestId}` : "без id запроса"}
            {row.httpStatus !== null ? ` · код ответа ${row.httpStatus}` : ""}
            {estimateExplanation ? ` · ${estimateExplanation}` : ""}
            {row.accrualDay ? ` · день начисления ${row.accrualDay}` : ""}
            {` · запись #${row.id}`}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// Comparison statuses other than "matched" that are expected/benign vs genuine drift.
const COMPARISON_BENIGN = new Set([
  "matched",
  "skipped",
  "ppv_estimated",
  "tips_blocked",
  "tips_signal",
  "blocked",
]);

function comparisonTone(status: string): ValueTone {
  if (status === "matched") return "neutral";
  return COMPARISON_BENIGN.has(status) ? "warning" : "danger";
}

function SpendComparisonBody() {
  const query = useAdminOfapiSpendComparison({ days: 7, sampleLimit: 25 });
  const data = query.data;

  if (query.isLoading) {
    return <TableSkeleton rows={6} columns={5} />;
  }
  if (query.isError || !data) {
    return (
      <StatusPanel
        tone="error"
        title="Не удалось загрузить точность проекций"
        description="Сервер не ответил. Повторите чуть позже."
        action={<RetryButton onClick={() => query.refetch()} />}
      />
    );
  }

  const noData = data.summary.length === 0 && data.byPage.length === 0
    && data.samples.length === 0;
  if (noData) {
    return (
      <div className="space-y-2">
        <p>
          Пока нечего сравнивать: за последние 7 дней теневая проекция ничего не оценила. Она оценивает выручку по
          событиям вебхуков до прихода синка, а эта проверка сравнивает оценку с синком.
        </p>
      </div>
    );
  }

  const matched = data.summary.find((row) => row.status === "matched")?.count ?? 0;
  const drift = data.summary
    .filter((row) => !COMPARISON_BENIGN.has(row.status))
    .reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={toneBadge(drift > 0 ? "danger" : "neutral")}>
          {fmtCredits(matched)} совпало · {fmtCredits(drift)}{" "}
          {ruPlural(drift, "расхождение", "расхождения", "расхождений")}
        </span>
        {data.summary
          .filter((row) => row.status !== "matched")
          .map((row) => (
            <span key={row.status} className={toneBadge(comparisonTone(row.status))} title={row.status}>
              {comparisonStatusLabel(row.status)} · {fmtCredits(row.count)}
            </span>
          ))}
      </div>

      {data.samples.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Статус</th>
                <th>Страница</th>
                <th>Время (UTC)</th>
                <th>Событие</th>
                <th className="num">Прогноз (нетто)</th>
                <th className="num">Синк (нетто)</th>
              </tr>
            </thead>
            <tbody>
              {data.samples.map((sample) => (
                <tr key={sample.projectionId}>
                  <td>
                    <span className={toneBadge(comparisonTone(sample.comparisonStatus))} title={sample.comparisonStatus}>
                      {comparisonStatusLabel(sample.comparisonStatus)}
                    </span>
                  </td>
                  <td>{sample.pageLabel}</td>
                  <td className="muted whitespace-nowrap">{utcCellTime(sample.occurredAt)}</td>
                  <td className="muted">{sample.sourceEventType}</td>
                  <td className="num">
                    {sample.creatorNetAmountMills !== null
                      ? formatUsdFromMills(sample.creatorNetAmountMills)
                      : "—"}
                  </td>
                  <td className="num">
                    {sample.coreCreatorNetAmountMills !== null
                      ? formatUsdFromMills(sample.coreCreatorNetAmountMills)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.limitations.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs">
          {data.limitations.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}

// Read-only shadow-projection diagnostic. Its body mounts (and fetches) only
// once an operator opens it.
function ProjectionAccuracySection() {
  const [open, setOpen] = useState(false);
  return (
    <details className="help" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Точность проекций — прогноз выручки против синка за 7 дней</summary>
      {open && (
        <div className="help-body max-w-none">
          <SpendComparisonBody />
        </div>
      )}
    </details>
  );
}

// Everything an operator only needs when something is off: reconciliation,
// webhook accrual and burn rate, plus where the values are set and the
// projection diagnostic. Collapsed by default while healthy; opens itself when
// anything needs attention. Open incidents, the floor and paused streams are
// told once elsewhere (the alarm, the budget meters), not repeated here.
function SystemHealthSection(props: {
  summary: OfapiCreditsSummaryResponse;
  hasAudienceBudget: boolean;
  priceKnown: boolean;
  usd: (credits: number) => string;
}) {
  const { summary } = props;
  const burn = summary.recentBurn;
  const parked = summary.budgets.filter((budget) => budget.state !== "ok");
  const needsAttention = summary.floor.blocked
    || summary.incidents.length > 0
    || (burn?.alerting ?? false)
    || (summary.forecast.unverifiedResidual?.credits ?? 0) !== 0
    || parked.length > 0;
  const urgent = summary.floor.blocked || summary.incidents.length > 0 || (burn?.alerting ?? false);
  const [open, setOpen] = useState(needsAttention);
  const bodyId = useId();

  // The summary refetches in the background; when a problem appears after mount,
  // open the section once (the operator can still collapse it again).
  useEffect(() => {
    if (needsAttention) {
      setOpen(true);
    }
  }, [needsAttention]);

  const drift = summary.reconciliation.lastDriftCredits ?? 0;
  const pending = summary.accrual.pendingToday ?? null;

  return (
    <section className="card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-[inherit] px-5 py-3.5 text-left hover:bg-hover-alt"
      >
        <h2 className="card-title">Состояние системы</h2>
        {needsAttention
          ? <span className={urgent ? "badge badge-danger" : "badge badge-warning"}>Требует внимания</span>
          : <span className="badge badge-success">Всё в порядке</span>}
        {summary.reconciliation.lastRunAt && (
          <span className="text-[13px] text-text-secondary">
            баланс сверен {utcTime(summary.reconciliation.lastRunAt)}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1.5 text-[13px] text-text-secondary">
          {open ? "Свернуть" : "Подробнее"}
          <Caret expanded={open} />
        </span>
      </button>
      {open && (
        <div id={bodyId} className="space-y-4 border-t border-border px-5 py-4">
          <dl className="space-y-3 text-sm">
            <div className="sm:flex sm:gap-4">
              <dt className="shrink-0 font-medium text-text-primary sm:w-44">Сверка баланса</dt>
              <dd className="text-text-secondary">
                {summary.reconciliation.lastRunAt
                  ? (
                    <>
                      Сверен с провайдером {utcDateTime(summary.reconciliation.lastRunAt)}
                      {drift === 0
                        ? " — последнее окно без расхождений."
                        : ` — расхождение ${credits(drift)}; источник изменения не подтверждён.`}
                    </>
                  )
                  : "Ещё не выполнялась. Приложение периодически сверяет свой журнал с реальным балансом провайдера."}
              </dd>
            </div>
            <div className="sm:flex sm:gap-4">
              <dt className="shrink-0 font-medium text-text-primary sm:w-44">Начисления вебхуков</dt>
              <dd className="text-text-secondary">
                {summary.accrual.lastPostedDay
                  ? `Проведены по ${summary.accrual.lastPostedDay}.`
                  : "Ещё ничего не проведено."}
                {pending && pending.eventCount > 0 && (
                  ` Сегодня: ~${credits(pending.estimatedCredits)} за ${fmtCredits(pending.eventCount)} ${
                    ruPlural(pending.eventCount, "событие", "события", "событий")
                  } — спишутся в полночь UTC.`
                )}
              </dd>
            </div>
            <div className="sm:flex sm:gap-4">
              <dt className="shrink-0 font-medium text-text-primary sm:w-44">Скорость трат</dt>
              <dd className="text-text-secondary">
                {burn
                  ? (
                    <>
                      <span className={burn.alerting ? "font-semibold text-danger" : undefined}>
                        {credits(burn.total)} за последние {burn.windowMinutes} мин
                        {props.priceKnown ? ` (≈ ${props.usd(burn.total)})` : ""}
                      </span>
                      {burn.threshold > 0
                        ? ` · тревога выше ${credits(burn.threshold)} в час`
                        : " · тревога выключена"}
                      {(burn.topOperations.length > 0 || burn.topPages.length > 0) && (
                        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="text-xs">больше всего тратят:</span>
                          {burn.topOperations.map((op) => (
                            <span
                              key={`op-${op.operation ?? "unknown"}`}
                              className={toneBadge(burn.alerting ? "danger" : "neutral")}
                              title={op.operation ?? undefined}
                            >
                              {op.operation ? operationLabel(op.operation) : "без атрибуции"} · {fmtCredits(op.credits)}
                            </span>
                          ))}
                          {burn.topPages.map((page) => (
                            <span key={`page-${page.pageId}`} className={toneBadge(burn.alerting ? "danger" : "neutral")} title="страница">
                              {page.pageLabel} · {fmtCredits(page.credits)}
                            </span>
                          ))}
                        </span>
                      )}
                    </>
                  )
                  : "За последний час трат нет."}
              </dd>
            </div>
          </dl>
          <details className="help">
            <summary>Технические детали</summary>
            <div className="help-body max-w-none">
              <p>
                Тревога по тратам меняется в списке параметров и применяется сразу. Цена кредита, дневные бюджеты
                и порог автостопа задаются при настройке сервера — в списке их можно только посмотреть:{" "}
                <ConfigReference configKey="ofapiBurnAlertCreditsPerHour">тревога по тратам</ConfigReference>
                {" · "}
                <ConfigReference configKey="ofapiDmDailyCreditBudget">бюджет сообщений</ConfigReference>
                {props.hasAudienceBudget && (
                  <>
                    {" · "}
                    <ConfigReference configKey="ofapiAudienceDailyCreditBudget">бюджет аудитории</ConfigReference>
                  </>
                )}
                {" · "}
                <ConfigReference configKey="ofapiCreditFloor">порог автостопа</ConfigReference>
                {" · "}
                <ConfigReference configKey="ofapiCreditMicroUsdPrice">цена кредита</ConfigReference>
              </p>
              <ProjectionAccuracySection />
            </div>
          </details>
        </div>
      )}
    </section>
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
  const [showHttp, setShowHttp] = useState(false);

  const ledgerRef = useRef<HTMLElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [exportTruncated, setExportTruncated] = useState(false);

  const ledgerFrom = ledgerDateStart(fromFilter);
  const ledgerTo = ledgerDateEndExclusive(toFilter);
  const ledgerQuery = useAdminOfapiCreditsLedger({
    offset: ledgerOffset,
    limit: LEDGER_PAGE_SIZE,
    ...(sourceFilter ? { source: sourceFilter } : {}),
    ...(operationFilter.trim() ? { operation: operationFilter.trim() } : {}),
    ...(pageFilter ? { pageId: Number(pageFilter) } : {}),
    ...(ledgerFrom === undefined ? {} : { from: ledgerFrom }),
    ...(ledgerTo === undefined ? {} : { to: ledgerTo }),
  });

  const summary = summaryQuery.data;
  const charts = chartsQuery.data;
  const breakdown = breakdownQuery.data;
  const ledger = ledgerQuery.data;
  const pageOptions = ledger?.pageOptions ?? (breakdown?.byPage ?? []).map((row) => ({
    pageId: row.pageId,
    pageLabel: row.pageLabel,
  }));

  const chartDays = useMemo(() => (charts?.days ?? []).map((day) => day.day), [charts]);

  const balanceByDay = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const point of charts?.balance ?? []) {
      byDay.set(point.at.slice(0, 10), point.value);
    }
    return byDay;
  }, [charts]);

  // Balance residuals can be tiny and frequent; they are not payment receipts.
  // The chart marks days, and the caption reports the inferred aggregate.
  const refillsByDay = useMemo(() => {
    const byDay = new Map<string, { day: string; credits: number; count: number }>();
    for (const refill of charts?.refills ?? []) {
      const day = refill.at.slice(0, 10);
      const bucket = byDay.get(day) ?? { day, credits: 0, count: 0 };
      bucket.credits += Math.abs(refill.credits);
      bucket.count += 1;
      byDay.set(day, bucket);
    }
    return Array.from(byDay.values());
  }, [charts]);

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
  // A signed net total is not a meaningful share denominator: +10 and -9
  // would otherwise produce 1000% and -900%. Keep the amounts, omit shares.
  const operationSharesComparable = operationTotal > 0
    && (breakdown?.byOperation ?? []).every((row) => row.credits >= 0);

  // Keep only sources that actually spent in this window, so the legend never
  // lists phantom series. Colors stay fixed per source either way.
  const activeSpendSeries = useMemo(() => {
    const active = SOURCE_SERIES.filter((series) =>
      dailyBars.some((row) => row[series.key] !== 0));
    return active.length > 0 ? active : [...SOURCE_SERIES];
  }, [dailyBars]);

  if (summaryQuery.isLoading) {
    return <StatCardSkeleton count={3} />;
  }

  if (!summary) {
    return (
      <StatusPanel
        title="Не удалось загрузить кредиты OnlyFans API"
        description="Сервер не ответил. Повторите чуть позже."
        tone="error"
        action={<RetryButton onClick={() => summaryQuery.refetch()} />}
      />
    );
  }

  const pendingWebhookEstimate = summary.accrual.pendingToday ?? null;
  const hasAudienceBudget = summary.budgets.some((budget) => budget.stream === "audience");

  // Display-only flat credit price from Settings. 0 means unset, and every USD
  // estimate on the page is suppressed.
  const microUsdPerCredit = summary.pricing?.microUsdPerCredit ?? 0;
  const priceKnown = microUsdPerCredit > 0;
  const usd = (amount: number) => creditsToUsd(amount, microUsdPerCredit);

  const focusLedger = () => {
    ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // A breakdown row drills straight into the matching journal filter.
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
        ...(sourceFilter ? { source: sourceFilter } : {}),
        ...(operationFilter.trim() ? { operation: operationFilter.trim() } : {}),
        ...(pageFilter ? { pageId: Number(pageFilter) } : {}),
        ...(ledgerFrom === undefined ? {} : { from: ledgerFrom }),
        ...(ledgerTo === undefined ? {} : { to: ledgerTo }),
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

  const hasActiveFilters = Boolean(
    sourceFilter || operationFilter.trim() || pageFilter || fromFilter || toFilter,
  );
  const clearFilters = () => {
    setSourceFilter("");
    setOperationFilter("");
    setPageFilter("");
    setFromFilter("");
    setToFilter("");
    setLedgerOffset(0);
  };

  const forecast = summary.forecast;
  const runwayToneClass = forecast.daysLeft === null
    ? "text-text-primary"
    : forecast.daysLeft < RUNWAY_DANGER_DAYS
      ? "text-danger"
      : forecast.daysLeft < RUNWAY_WARNING_DAYS
        ? "text-warning-dark"
        : "text-text-primary";

  const burn = summary.recentBurn;
  const burnAlerting = burn?.alerting ?? false;
  const showAlarm = summary.floor.blocked || summary.incidents.length > 0 || burnAlerting;
  const burnDrivers = burn
    ? [
      ...burn.topOperations.map((op) =>
        `${op.operation ? operationLabel(op.operation) : "без атрибуции"} (${fmtCredits(op.credits)})`),
      ...burn.topPages.map((page) => `${page.pageLabel} (${fmtCredits(page.credits)})`),
    ]
    : [];

  const todaySources = SOURCE_SERIES
    .map((series) => ({ ...series, value: summary.today.bySource[series.key] }))
    .filter((series) => series.value !== 0);

  const refillRecommendation = forecast.refillRecommendation ?? null;
  const recordedActivityForecast = forecast.basis === "recorded_activity";
  const unverifiedResidual = forecast.unverifiedResidual;

  const heroValueClass = "mt-1 text-[28px] font-semibold leading-tight tracking-tight tabular-nums";
  const heroUnitClass = "text-[15px] font-medium tracking-normal text-text-secondary";
  const heroSubClass = "mt-1 text-[13px] text-text-secondary";

  const selectClass = "select w-auto min-h-[34px] py-1.5 text-[13px]";
  const inputClass = "input w-auto min-h-[34px] py-1.5 text-[13px]";
  const filterField = (
    label: string,
    control: ReactNode,
  ) => (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {control}
    </label>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-3xl">
          <p className="text-sm text-text-secondary">
            Баланс кредитов OnlyFans API, на сколько его хватит и на что он уходит. Всё время на странице — UTC.
          </p>
          <details className="help mt-1">
            <summary>Как это считается</summary>
            <div className="help-body">
              <p>
                Кредиты расходуются на платные запросы к OnlyFans API и на учитываемые события. Журнал разделяет
                запросы приложения, начисления за вебхуки и сверку баланса с провайдером.
              </p>
              <p>
                «Хватит на» — баланс, делённый на средний дневной расход за последние 7 дней. Дневные бюджеты
                синка обнуляются в полночь UTC.
              </p>
              <p>
                Отношение «выручка / стоимость» включает всю выручку страницы за период. Оно не показывает, сколько
                выручки принесли запросы к OnlyFans API, и не учитывает остальные расходы.
              </p>
            </div>
          </details>
        </div>
        <Link className="btn btn-sm" to={buildSettingsRoute("collection")}>Настройки сбора</Link>
      </div>

      {summaryQuery.isError && (
        <div role="alert" className="notice notice-warning flex-wrap items-center justify-between">
          <p>Сводку не удалось обновить. Баланс, прогноз и ограничения ниже относятся к предыдущему ответу.</p>
          <RetryButton onClick={() => summaryQuery.refetch()} />
        </div>
      )}

      {showAlarm && (
        <div role="alert" className="notice notice-danger flex-col gap-1.5 font-medium">
          {summary.floor.blocked && (
            <p>
              Траты остановлены — баланс ниже порога автостопа ({credits(summary.floor.value)}).
              Пополните баланс, чтобы синк продолжился.
            </p>
          )}
          {burnAlerting && burn && (
            <p>
              Журнал показывает расход или разницу баланса: {credits(burn.total)} за последние{" "}
              {burn.windowMinutes} минут (порог тревоги — {credits(burn.threshold)} в час).
              {burnDrivers.length > 0 ? ` Больше всего тратят: ${burnDrivers.join(", ")}.` : ""}
            </p>
          )}
          {summary.incidents.map((incident) => (
            <p key={`${incident.kind}-${incident.openedAt}`}>
              {incidentLabel(incident.kind)} — открыт с {utcDateTime(incident.openedAt)}.
              {incident.errorSummary ? ` ${incident.errorSummary}.` : ""}
            </p>
          ))}
          {summary.incidents.length > 0 && (
            <p>
              <Link to="/incidents" className="font-semibold underline underline-offset-2">Все инциденты</Link>
            </p>
          )}
        </div>
      )}

      {/* The answer card: balance → runway → what to do about it. */}
      <section className="card p-5">
        <div className="grid gap-5 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-border">
          <div className="sm:pr-6">
            <div className="stat-label">Баланс</div>
            <div className={`${heroValueClass} text-text-primary`}>
              {summary.balance.value !== null
                ? (
                  <>
                    {fmtCredits(summary.balance.value)}{" "}
                    <span className={heroUnitClass}>{creditsWord(summary.balance.value)}</span>
                  </>
                )
                : "—"}
            </div>
            <div className={heroSubClass}>
              {summary.balance.value !== null && priceKnown ? `≈ ${usd(summary.balance.value)} · ` : ""}
              {summary.balance.observedAt
                ? `проверен ${utcTime(summary.balance.observedAt)}`
                : "ждём первое показание баланса"}
            </div>
          </div>
          <div className="sm:px-6">
            <div className="stat-label">{recordedActivityForecast ? "Прогноз по операциям" : "Хватит на"}</div>
            <div className={`${heroValueClass} ${runwayToneClass}`}>
              {forecast.daysLeft !== null
                ? (
                  <>
                    ~{fmtCredits(forecast.daysLeft)}{" "}
                    <span className={heroUnitClass}>{daysWord(forecast.daysLeft)}</span>
                  </>
                )
                : "—"}
            </div>
            <div className={heroSubClass}>
              {forecast.daysLeft !== null
                ? (
                  <>
                    {forecast.runOutDate ? <span className="block">закончатся ~{humanDay(forecast.runOutDate)}</span> : null}
                    <span className="block">
                      ~{credits(Math.round(forecast.avgDailySpend7d))} в день
                      {priceKnown ? ` (≈ ${usd(Math.round(forecast.avgDailySpend7d))})` : ""}, среднее за 7 дней
                    </span>
                  </>
                )
                : forecast.avgDailySpend7d <= 0
                  ? "за последние 7 дней нет учтённых трат для прогноза"
                  : "ждём показание баланса"}
            </div>
          </div>
          <div className="sm:pl-6">
            <div className="stat-label">Пополнение</div>
            {refillRecommendation
              ? refillRecommendation.credits > 0
                ? (
                  <>
                    <div className={`${heroValueClass} text-warning-dark`}>
                      +{fmtCredits(refillRecommendation.credits)}{" "}
                      <span className={heroUnitClass}>{creditsWord(refillRecommendation.credits)}</span>
                    </div>
                    <div className={heroSubClass}>
                      чтобы хватило на {refillRecommendation.targetDays}{" "}
                      {daysWord(refillRecommendation.targetDays)}
                      {priceKnown ? ` · ≈ ${usd(refillRecommendation.credits)}` : ""}
                    </div>
                  </>
                )
                : (
                  <>
                    <div className={`${heroValueClass} text-green`}>
                      {unverifiedResidual && unverifiedResidual.credits > 0 ? "Уточнить расход" : "Не нужно"}
                    </div>
                    <div className={heroSubClass}>
                      по учтённым операциям баланса хватит больше чем на {refillRecommendation.targetDays}{" "}
                      {daysWord(refillRecommendation.targetDays)}
                    </div>
                  </>
                )
              : (
                <>
                  <div className={`${heroValueClass} text-text-primary`}>—</div>
                  <div className={heroSubClass}>появится после нескольких дней истории трат</div>
                </>
              )}
          </div>
        </div>
        {recordedActivityForecast && (
          <p className="mt-4 text-[13px] text-text-secondary">
            Прогноз учитывает запросы приложения, их корректировки и оценку вебхуков.
            Необъяснённая разница баланса в прогноз не включена.
          </p>
        )}
        {unverifiedResidual && unverifiedResidual.credits > 0 && (
          <p role="note" className="notice notice-warning mt-3">
            По сверке за {utcDateTime(unverifiedResidual.from)} — {utcDateTime(unverifiedResidual.to)}:{" "}
            ещё {credits(unverifiedResidual.credits)} уменьшения баланса без подтверждённого источника.
            Фактический расход может быть выше прогноза; требуется проверка этой разницы.
          </p>
        )}
        {(forecast.monthToDateSpend !== undefined || forecast.monthEndProjection !== undefined) && (
          <div className="mt-4 border-t border-border-light pt-3 text-[13px] text-text-secondary">
            {forecast.monthToDateSpend !== undefined && (
              <>
                {recordedActivityForecast ? "По операциям за месяц: " : "Потрачено за месяц: "}{credits(forecast.monthToDateSpend)}
                {priceKnown ? ` (≈ ${usd(forecast.monthToDateSpend)})` : ""}
              </>
            )}
            {forecast.monthUnverifiedResidualCredits !== undefined && forecast.monthUnverifiedResidualCredits !== 0 && (
              <> · разница баланса за месяц: {credits(forecast.monthUnverifiedResidualCredits)}</>
            )}
            {forecast.monthEndProjection !== undefined && (
              <>
                {forecast.monthToDateSpend !== undefined ? " · " : ""}
                к концу месяца выйдет ~{credits(forecast.monthEndProjection)}
                {priceKnown ? ` (≈ ${usd(forecast.monthEndProjection)})` : ""}
              </>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-body grid gap-6 lg:grid-cols-[1fr_1.3fr]">
          <div>
            <div className="stat-label">Учтено сегодня, {humanDay(summary.today.day)}</div>
            <div className="mt-1 text-[22px] font-semibold leading-tight tabular-nums text-text-primary">
              {fmtCredits(summary.today.total)}{" "}
              <span className={heroUnitClass}>{creditsWord(summary.today.total)}</span>
              {priceKnown && (
                <span className="ml-2 text-[13px] font-medium text-text-secondary">
                  ≈ {usd(summary.today.total)}
                </span>
              )}
            </div>
            {todaySources.length > 0
              ? (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] tabular-nums text-text-secondary">
                  {todaySources.map((series) => (
                    <span key={series.key} className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: series.color }}
                      />
                      {series.label} {fmtCredits(series.value)}
                    </span>
                  ))}
                </div>
              )
              : <p className="mt-2 text-[13px] text-text-secondary">Сегодня пока ничего не потрачено.</p>}
            {pendingWebhookEstimate && pendingWebhookEstimate.eventCount > 0 && (
              <p className="mt-2 text-[13px] text-text-secondary">
                Ещё ~{credits(pendingWebhookEstimate.estimatedCredits)} за{" "}
                {fmtCredits(pendingWebhookEstimate.eventCount)}{" "}
                {ruPlural(pendingWebhookEstimate.eventCount, "событие", "события", "событий")} вебхуков
                ещё не проведены — оценка добавится в журнал после завершения дня.
              </p>
            )}
          </div>
          <div>
            <div className="stat-label">Дневные бюджеты синка</div>
            <div className="mt-2 space-y-3">
              {summary.budgets.length > 0
                ? summary.budgets.map((budget) => (
                  <BudgetMeter
                    key={budget.stream}
                    stream={budget.stream}
                    spentToday={budget.spentToday}
                    dailyCeiling={budget.dailyCeiling}
                    state={budget.state}
                    retryAt={budget.retryAt}
                  />
                ))
                : <p className="text-[13px] text-text-secondary">Бюджеты синка не заданы.</p>}
            </div>
          </div>
        </div>
        <div className="card-footer justify-start">
          {summary.floor.value > 0
            ? (
              <span>
                Порог автостопа: {credits(summary.floor.value)} — если баланс упадёт ниже, траты автоматически
                остановятся.
              </span>
            )
            : <span>Автостоп по остатку не задан. Остальные ограничения расхода продолжают действовать.</span>}
        </div>
      </section>

      {chartsQuery.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="h-[360px] animate-pulse rounded-xl border border-border bg-card" />
          <div className="h-[360px] animate-pulse rounded-xl border border-border bg-card" />
        </div>
      ) : chartsQuery.isError ? (
        <StatusPanel
          tone="error"
          title="Не удалось загрузить графики"
          description="Сервер не ответил. Повторите чуть позже."
          action={<RetryButton onClick={() => chartsQuery.refetch()} />}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <BalanceChart
            days={chartDays}
            balanceByDay={balanceByDay}
            refills={refillsByDay}
            usd={priceKnown ? usd : undefined}
          />
          <StackedBarChart
            title="Движение кредитов по дням"
            data={dailyBars}
            xKey="day"
            series={[...activeSpendSeries]}
            xTickFormatter={formatBusinessDateShort}
            valueFormatter={fmtCredits}
            tooltipValueFormatter={(value) =>
              priceKnown ? `${credits(value)} · ${usd(value)}` : credits(value)}
            yAxisWidth={48}
            headerExtra={(
              <span className="text-[13px] text-text-secondary">Последние {CHART_DAYS} дней</span>
            )}
          />
        </div>
      )}

      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Куда уходят кредиты</h2>
            <p className="card-description">По видам запросов и по страницам. Нажмите строку, чтобы открыть её в журнале.</p>
          </div>
          <div className="segmented" role="group" aria-label="Период">
            {BREAKDOWN_PERIODS.map((period) => (
              <button
                key={period}
                type="button"
                aria-pressed={breakdownDays === period}
                onClick={() => setBreakdownDays(period)}
                className="segment"
              >
                {period} {daysWord(period)}
              </button>
            ))}
          </div>
        </div>
        {breakdownQuery.isLoading ? (
          <div className="p-4">
            <TableSkeleton rows={6} columns={6} />
          </div>
        ) : breakdownQuery.isError ? (
          <div className="p-4">
            <StatusPanel
              tone="error"
              title="Не удалось загрузить разбивку"
              description="Сервер не ответил. Повторите чуть позже."
              action={<RetryButton onClick={() => breakdownQuery.refetch()} />}
            />
          </div>
        ) : (
          <div>
            <div className="min-w-0 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Активность</th>
                    <th className="num">Запросы</th>
                    <th className="num">Кредиты</th>
                    {priceKnown && (
                      <th className="num" title="Оценка стоимости в $ по заданной цене кредита">
                        Стоимость
                      </th>
                    )}
                    <th className="num">Доля</th>
                  </tr>
                </thead>
                <tbody>
                  {(breakdown?.byOperation ?? []).map((row) => {
                    const sharePct = operationSharesComparable
                      ? Math.round((row.credits / operationTotal) * 100)
                      : null;
                    return (
                      <tr key={row.operation ?? "unknown"}>
                        <td>
                          {row.operation ? (
                            <button
                              type="button"
                              onClick={() => drillByOperation(row.operation as string)}
                              className={drillCellClass}
                              title={`Показать в журнале: ${row.operation}`}
                            >
                              {operationLabel(row.operation)}
                            </button>
                          ) : (
                            "Без атрибуции"
                          )}
                        </td>
                        <td className="num muted">{fmtCredits(row.requests)}</td>
                        <td className="num">{fmtCredits(row.credits)}</td>
                        {priceKnown && (
                          <td className="num muted">{usd(row.credits)}</td>
                        )}
                        <td className="num muted">
                          {sharePct === null
                            ? "—"
                            : (
                              <span className="inline-flex items-center justify-end gap-2">
                                <span
                                  aria-hidden="true"
                                  className="h-1 w-10 overflow-hidden rounded-full bg-hover"
                                >
                                  <span
                                    className="block h-full rounded-full bg-text-muted"
                                    style={{ width: `${sharePct}%` }}
                                  />
                                </span>
                                {sharePct}%
                              </span>
                            )}
                        </td>
                      </tr>
                    );
                  })}
                  {(breakdown?.byOperation ?? []).length === 0 && (
                    <tr>
                      <td colSpan={priceKnown ? 5 : 4} className="muted">
                        Нет трат через приложение за этот период
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="min-w-0 overflow-x-auto border-t border-border">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Страница</th>
                    <th className="num">Кредиты</th>
                    {priceKnown && (
                      <th className="num" title="Оценка стоимости в $ по заданной цене кредита">
                        Стоимость
                      </th>
                    )}
                    <th className="num" title="Чистая выручка авторов за период">
                      Выручка
                    </th>
                    {priceKnown && (
                      <th className="num" title="Вся выручка страницы ÷ оценка стоимости кредитов. Не доказывает влияние запросов на выручку.">
                        Выручка / стоимость
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(breakdown?.byPage ?? []).map((row) => {
                    const revenueMills = row.revenueMills;
                    const roi = revenueMills == null ? null : computeRoi(revenueMills, row.credits, microUsdPerCredit);
                    return (
                      <tr key={row.pageId}>
                        <td>
                          <button
                            type="button"
                            onClick={() => drillByPage(row.pageId)}
                            className={drillCellClass}
                            title={`Показать в журнале: ${row.pageLabel}`}
                          >
                            {row.pageLabel}
                          </button>
                        </td>
                        <td className="num">{fmtCredits(row.credits)}</td>
                        {priceKnown && (
                          <td className="num muted">{usd(row.credits)}</td>
                        )}
                        <td className="num muted">{revenueMills == null ? "Нет данных" : formatUsdFromMills(revenueMills)}</td>
                        {priceKnown && (
                          <td className="num">
                            {roi === null ? "—" : <span>{roi.toFixed(1)}×</span>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {(breakdown?.byPage ?? []).length === 0 && (
                    <tr>
                      <td colSpan={priceKnown ? 5 : 3} className="muted">
                        Нет трат с привязкой к страницам за этот период
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {!priceKnown && !breakdownQuery.isLoading && !breakdownQuery.isError && (
          <div className="card-footer justify-start">
            <span>
              Цена кредита не задана: её задают при настройке сервера, чтобы видеть стоимость в $ и отношение
              выручки к стоимости по страницам.{" "}
              <ConfigReference configKey="ofapiCreditMicroUsdPrice">Текущее значение</ConfigReference>
            </span>
          </div>
        )}
      </section>

      <section ref={ledgerRef} className="card scroll-mt-20">
        <div className="card-header">
          <div>
            <h2 className="card-title">Журнал операций</h2>
            <p className="card-description">Каждое движение кредитов. Время — UTC.</p>
          </div>
          {/* A real CSV export of every row matching the current filters (not
              just the visible page) for accounting. */}
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || (ledger?.total ?? 0) === 0}
            className="btn btn-sm"
            title="Скачать все строки по текущим фильтрам в CSV"
          >
            {exporting ? "Экспортируем…" : "Экспорт CSV"}
          </button>
        </div>
        <div className="space-y-3 border-b border-border px-5 py-4">
          <div className="flex flex-wrap items-end gap-3">
            {filterField("Источник", (
              <select
                value={sourceFilter}
                onChange={(event) => {
                  setSourceFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                className={selectClass}
                aria-label="Фильтр по источнику"
              >
                {SOURCE_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ))}
            {filterField("Страница", (
              <select
                value={pageFilter}
                onChange={(event) => {
                  setPageFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                className={selectClass}
                aria-label="Фильтр по странице"
              >
                <option value="">Все страницы</option>
                {pageOptions.map((row) => (
                  <option key={row.pageId} value={String(row.pageId)}>{row.pageLabel}</option>
                ))}
              </select>
            ))}
            {filterField("С", (
              <input
                type="date"
                value={fromFilter}
                onChange={(event) => {
                  setFromFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                className={inputClass}
                aria-label="Дата с (UTC)"
              />
            ))}
            {filterField("По", (
              <input
                type="date"
                value={toFilter}
                onChange={(event) => {
                  setToFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                className={inputClass}
                aria-label="Дата по (UTC)"
              />
            ))}
            {hasActiveFilters && (
              <button type="button" onClick={clearFilters} className="btn btn-ghost btn-sm" title="Сбросить все фильтры">
                Сбросить фильтры
              </button>
            )}
          </div>
          {operationFilter.trim() && (
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-secondary">
              Активность:
              <span className="badge badge-accent" title={operationFilter}>
                {operationLabel(operationFilter.trim())}
                <button
                  type="button"
                  aria-label="Убрать фильтр по активности"
                  onClick={() => {
                    setOperationFilter("");
                    setLedgerOffset(0);
                  }}
                  className="ml-0.5 font-semibold"
                >
                  ×
                </button>
              </span>
            </div>
          )}
          <details className="help">
            <summary>Расширенный фильтр</summary>
            <div className="help-body max-w-none">
              <div className="flex flex-wrap items-end gap-4">
                {/* Exact-match filter fed by a datalist of real operation ids, so a
                    partial guess resolves to a known value instead of zero rows. */}
                {filterField("Код операции", (
                  <input
                    value={operationFilter}
                    onChange={(event) => {
                      setOperationFilter(event.target.value);
                      setLedgerOffset(0);
                    }}
                    list={operationListId}
                    placeholder="например, ofapi_chats"
                    className={`${inputClass} w-56`}
                    aria-label="Фильтр по операции"
                  />
                ))}
                <datalist id={operationListId}>
                  {operationOptions.map((operation) => (
                    <option key={operation} value={operation} />
                  ))}
                </datalist>
                <label className="flex min-h-[34px] items-center gap-2 text-[13px] text-text-primary">
                  <input type="checkbox" checked={showHttp} onChange={(event) => setShowHttp(event.target.checked)} />
                  Показывать код ответа (HTTP)
                </label>
              </div>
            </div>
          </details>
          {exportError && (
            <p role="alert" className="text-[13px] font-medium text-danger">
              Экспорт не удался — повторите.
            </p>
          )}
          {exportTruncated && !exportError && (
            <p role="alert" className="text-[13px] font-medium text-warning-dark">
              Экспорт обрезан до 50 000 строк — сузьте фильтры, чтобы выгрузить всё.
            </p>
          )}
        </div>
        {ledgerQuery.isLoading ? (
          <TableSkeleton rows={8} columns={7} />
        ) : ledgerQuery.isError ? (
          <div className="p-4">
            <StatusPanel
              tone="error"
              title="Не удалось загрузить журнал"
              description="Сервер не ответил. Фильтры сохранены."
              action={<RetryButton onClick={() => ledgerQuery.refetch()} />}
            />
          </div>
        ) : (ledger?.rows.length ?? 0) === 0 ? (
          <EmptyState
            title="Ничего не найдено"
            description="Под текущие фильтры не попало ни одного движения кредитов."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="relative w-8"><span className="sr-only">Развернуть детали</span></th>
                    <th>Время (UTC)</th>
                    <th>Источник</th>
                    <th>Активность</th>
                    <th>Страница</th>
                    <th className="num">Кредиты</th>
                    <th className="num">Баланс после</th>
                    {showHttp && <th className="num">HTTP</th>}
                  </tr>
                </thead>
                <tbody>
                  {(ledger?.rows ?? []).map((row) => (
                    <LedgerRow key={row.id} row={row} showHttp={showHttp} />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              offset={ledgerOffset}
              limit={LEDGER_PAGE_SIZE}
              total={ledger?.total ?? 0}
              onPageChange={setLedgerOffset}
              emptyLabel="0 записей"
              formatRange={(start, end, total) => `${start}–${end} из ${fmtCredits(total)}`}
            />
          </>
        )}
      </section>

      <SystemHealthSection
        summary={summary}
        hasAudienceBudget={hasAudienceBudget}
        priceKnown={priceKnown}
        usd={usd}
      />
    </div>
  );
}
