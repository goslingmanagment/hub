import { buildSettingsRoute } from "../lib/navigation.js";
import { OfapiVendorEvidence } from "./settings/OfapiVendorEvidence.js";
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

const LEDGER_PAGE_SIZE = 50;
const CHART_DAYS = 30;

// Runway urgency thresholds (days of balance left) for the hero card.
const RUNWAY_DANGER_DAYS = 3;
const RUNWAY_WARNING_DAYS = 7;

const SOURCE_SERIES = [
  { key: "rest", label: "Приложение", color: "#4ead6b" },
  { key: "webhookAccrual", label: "Вебхуки", color: "#5b8def" },
  { key: "external", label: "Сверка баланса", color: "#e0a14f" },
  { key: "adjustment", label: "Корректировки", color: "#9b7ede" },
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

function streamConfigKey(stream: string) {
  return stream === "audience" ? "ofapiAudienceDailyCreditBudget" : "ofapiDmDailyCreditBudget";
}

const INCIDENT_LABELS: Record<string, string> = {
  ofapi_burn_rate: "Кредиты сгорают необычно быстро",
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
  tips_blocked: "типсы заблокированы",
  tips_signal: "типсы (сигнал)",
  blocked: "заблокировано",
};

function comparisonStatusLabel(status: string) {
  return COMPARISON_STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

const BREAKDOWN_PERIODS = [7, 30, 90] as const;

function fmtCredits(value: number) {
  return value.toLocaleString("ru-RU");
}

// Russian plural form: 1 день / 2 дня / 5 дней (with the 11–14 exception).
function ruPlural(value: number, one: string, few: string, many: string) {
  const mod10 = Math.abs(value) % 10;
  const mod100 = Math.abs(value) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function daysWord(value: number) {
  return ruPlural(value, "день", "дня", "дней");
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

const eyebrowClass = "text-[11px] font-bold uppercase tracking-wide text-text-secondary";

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
      Повторить
    </button>
  );
}

// Deep-links a shown value to its Settings > Configuration entry (anchored by
// config key), without inline editing.
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
    ? "bg-red-500"
    : pct >= 80
      ? "bg-amber-500"
      : "bg-accent";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <Link
          to={`/settings?tab=configuration#config-${streamConfigKey(props.stream)}`}
          title="Открыть этот бюджет в настройках"
          className="font-medium text-text-secondary underline-offset-2 hover:text-accent hover:underline"
        >
          {label}
        </Link>
        <span className={`tabular-nums ${paused ? "font-semibold text-red-700" : "text-text-secondary"}`}>
          {unlimited
            ? `${fmtCredits(props.spentToday)} кр · без дневного лимита`
            : `${fmtCredits(props.spentToday)} из ${fmtCredits(props.dailyCeiling)} кр`}
        </span>
      </div>
      {!unlimited && (
        <div
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover-alt"
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
        <p className="mt-1 text-[11px] font-medium text-amber-700">
          {props.state === "floor_blocked"
            ? "Пауза — баланс ниже порога автостопа."
            : `Пауза — дневной бюджет исчерпан. Продолжит ${
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
  usd?: (credits: number) => string;
}) {
  const gradientId = useId();
  const color = "#5b8def";

  // The x-axis spans the full requested window (dense day list from the API), so
  // "last 30 days" is honest even when balance readings only cover part of it,
  // and refill markers land on the axis no matter when they happened.
  const data = props.days.map((day) => ({
    day,
    value: props.balanceByDay.get(day) ?? null,
  }));
  const hasReadings = props.balanceByDay.size > 0;
  const refillCount = props.refills.reduce((sum, refill) => sum + refill.count, 0);
  const refillTotal = props.refills.reduce((sum, refill) => sum + refill.credits, 0);
  const firstReadingDay = hasReadings
    ? Array.from(props.balanceByDay.keys()).sort()[0]
    : null;
  // When readings start mid-window, say so — otherwise the mostly-empty plot
  // reads as broken rather than young.
  const readingsStartedLate = firstReadingDay !== null
    && props.days.length > 0
    && firstReadingDay > props.days[0];

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[12px] text-text-secondary uppercase tracking-wider font-semibold">
          Баланс
        </h2>
        <span className="text-[12px] text-text-secondary">Последние {CHART_DAYS} дней · UTC</span>
      </div>
      {!hasReadings ? (
        <div className="flex h-[300px] items-center justify-center px-6 text-center text-[13px] text-text-muted">
          Показаний баланса пока нет — график начнётся с первой проверки баланса у провайдера.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
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
                key={refill.day}
                x={refill.day}
                stroke="#4ead6b"
                strokeDasharray="4 4"
              />
            ))}
            <Area
              type="monotone"
              dataKey="value"
              name="Баланс"
              connectNulls
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
              formatter={(value) => {
                if (value === null || value === undefined) {
                  return ["нет показания", "Баланс"];
                }
                const credits = Number(value);
                return [
                  `${fmtCredits(credits)} кр${props.usd ? ` · ${props.usd(credits)}` : ""}`,
                  "Баланс",
                ];
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
      {(refillCount > 0 || readingsStartedLate) && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-secondary">
          {refillCount > 0 && (
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true" className="inline-block w-4 border-t-2 border-dashed border-green" />
              {refillCount} {ruPlural(refillCount, "увеличение", "увеличения", "увеличений")} баланса по сверке за
              период · +{fmtCredits(refillTotal)} кр
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

const thClass = "px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-secondary";
const tdClass = "px-4 py-2.5 text-[13px] text-text-secondary tabular-nums";
// A breakdown label that drills into the matching activity-log filter.
const drillCellClass =
  "text-left text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent rounded";

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

function LedgerRow(props: { row: OfapiCreditsLedgerResponse["rows"][number] }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const { row } = props;
  const estimateExplanation = row.estimated ? LEDGER_ESTIMATE_EXPLANATIONS[row.source] : null;
  const toggle = () => setExpanded((value) => !value);
  const failed = row.httpStatus !== null && row.httpStatus >= 400;

  return (
    <Fragment>
      <tr
        className="cursor-pointer border-t border-border-light hover:bg-hover"
        onClick={toggle}
      >
        <td className={`${tdClass} w-8 pr-0`}>
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
            className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Caret expanded={expanded} />
          </button>
        </td>
        <td className={tdClass}>{utcDateTime(row.occurredAt)}</td>
        <td className={tdClass}>{sourceLabel(row.source)}</td>
        <td className={tdClass}>
          {row.operation ? <span title={row.operation}>{operationLabel(row.operation)}</span> : "—"}
        </td>
        <td className={tdClass}>{row.pageLabel ?? "—"}</td>
        <td
          className={`${tdClass} text-right ${row.credits < 0 ? "font-medium text-green-700" : ""}`}
          title={estimateExplanation ?? undefined}
        >
          {ledgerAmount(row)}
        </td>
        <td className={`${tdClass} text-right`}>
          {row.balanceAfter !== null ? fmtCredits(row.balanceAfter) : "—"}
        </td>
        <td className={`${tdClass} text-right ${failed ? "font-medium text-red-700" : ""}`}>
          {row.httpStatus ?? "—"}
        </td>
      </tr>
      {expanded && (
        <tr id={detailId} className="border-t border-border-light bg-hover-alt/20">
          <td colSpan={8} className="px-4 py-2 text-[12px] text-text-secondary">
            {row.operation ? `Операция ${row.operation} · ` : ""}
            {row.requestId ? `запрос ${row.requestId}` : "без id запроса"}
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
      <div className="p-4">
        <StatusPanel
          tone="error"
          title="Не удалось загрузить точность проекций"
          description="Эндпоинт сравнения вернул ошибку."
          action={<RetryButton onClick={() => query.refetch()} />}
        />
      </div>
    );
  }

  const noData = data.summary.length === 0 && data.byPage.length === 0
    && data.samples.length === 0;
  if (noData) {
    return (
      <div className="pb-6">
        <EmptyState
          title="Пока нечего сравнивать"
          description="Теневая проекция оценивает выручку по событиям вебхуков до прихода синка, а эта диагностика проверяет её точность. За выбранный период ничего не спроецировано."
        />
        <div className="text-center text-[13px]">
          <ConfigLink configKey="ofapiSpendProjectionShadowEnabled">
            Включить теневую проекцию →
          </ConfigLink>
        </div>
      </div>
    );
  }

  const matched = data.summary.find((row) => row.status === "matched")?.count ?? 0;
  const drift = data.summary
    .filter((row) => !COMPARISON_BENIGN.has(row.status))
    .reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip tone={drift > 0 ? "danger" : "neutral"}>
          {fmtCredits(matched)} совпало · {fmtCredits(drift)}{" "}
          {ruPlural(drift, "расхождение", "расхождения", "расхождений")}
        </StatusChip>
        {data.summary
          .filter((row) => row.status !== "matched")
          .map((row) => (
            <StatusChip key={row.status} tone={comparisonTone(row.status)} title={row.status}>
              {comparisonStatusLabel(row.status)} · {fmtCredits(row.count)}
            </StatusChip>
          ))}
      </div>

      {data.samples.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-hover-alt">
                <th className={thClass}>Статус</th>
                <th className={thClass}>Страница</th>
                <th className={thClass}>Время (UTC)</th>
                <th className={thClass}>Событие</th>
                <th className={`${thClass} text-right`}>Прогноз (нетто)</th>
                <th className={`${thClass} text-right`}>Синк (нетто)</th>
              </tr>
            </thead>
            <tbody>
              {data.samples.map((sample) => (
                <tr key={sample.projectionId} className="border-t border-border-light">
                  <td className={tdClass}>
                    <StatusChip tone={comparisonTone(sample.comparisonStatus)} title={sample.comparisonStatus}>
                      {comparisonStatusLabel(sample.comparisonStatus)}
                    </StatusChip>
                  </td>
                  <td className={tdClass}>{sample.pageLabel}</td>
                  <td className={tdClass}>{utcDateTime(sample.occurredAt)}</td>
                  <td className={tdClass}>{sample.sourceEventType}</td>
                  <td className={`${tdClass} text-right`}>
                    {sample.creatorNetAmountMills !== null
                      ? formatUsdFromMills(sample.creatorNetAmountMills)
                      : "—"}
                  </td>
                  <td className={`${tdClass} text-right`}>
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
        <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-text-secondary">
          {data.limitations.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}

// Read-only shadow-projection diagnostic, collapsed by default so it only
// fetches (and runs the comparison) when an operator opens it.
function ProjectionAccuracySection() {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="border-t border-border-light">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-hover"
      >
        <span className="text-text-muted">
          <Caret expanded={open} />
        </span>
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary">
          Точность проекций
        </h3>
        <span className="text-[11px] text-text-secondary">
          диагностика — прогноз выручки против синка · последние 7 дней
        </span>
      </button>
      {open && (
        <div id={bodyId} className="border-t border-border-light">
          <SpendComparisonBody />
        </div>
      )}
    </div>
  );
}

// Everything an operator only needs when something is off: reconciliation,
// accrual posting, burn rate, stream states, incidents, settings links, and the
// projection diagnostic. Collapsed by default while healthy; opens itself when
// anything needs attention.
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
    <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-hover"
      >
        <span className="text-text-muted">
          <Caret expanded={open} />
        </span>
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary">
          Состояние системы
        </h2>
        {needsAttention
          ? (
            <StatusChip tone={summary.floor.blocked || summary.incidents.length > 0 || (burn?.alerting ?? false) ? "danger" : "warning"}>
              Требует внимания
            </StatusChip>
          )
          : <StatusChip tone="neutral">Всё в порядке</StatusChip>}
        {summary.reconciliation.lastRunAt && (
          <span className="text-[11px] text-text-secondary">
            баланс сверен {utcTime(summary.reconciliation.lastRunAt)}
          </span>
        )}
      </button>
      {open && (
        <div id={bodyId} className="border-t border-border-light">
          <dl className="space-y-3 px-4 py-4 text-[13px]">
            <div className="sm:flex sm:gap-3">
              <dt className="shrink-0 font-medium text-text-primary sm:w-44">Сверка баланса</dt>
              <dd className="text-text-secondary">
                {summary.reconciliation.lastRunAt
                  ? (
                    <>
                      Сверен с провайдером {utcDateTime(summary.reconciliation.lastRunAt)}
                      {drift === 0
                        ? " — последнее окно без расхождений."
                        : ` — расхождение ${fmtCredits(drift)} кр; источник изменения не подтверждён.`}
                    </>
                  )
                  : "Ещё не выполнялась. Приложение периодически сверяет свой журнал с реальным балансом провайдера."}
              </dd>
            </div>
            <div className="sm:flex sm:gap-3">
              <dt className="shrink-0 font-medium text-text-primary sm:w-44">Начисления вебхуков</dt>
              <dd className="text-text-secondary">
                {summary.accrual.lastPostedDay
                  ? `Проведены по ${summary.accrual.lastPostedDay}.`
                  : "Ещё ничего не проведено."}
                {pending && pending.eventCount > 0 && (
                  ` Сегодня: ~${fmtCredits(pending.estimatedCredits)} кр за ${fmtCredits(pending.eventCount)} ${
                    ruPlural(pending.eventCount, "событие", "события", "событий")
                  } — спишутся в полночь UTC.`
                )}
              </dd>
            </div>
            <div className="sm:flex sm:gap-3">
              <dt className="shrink-0 font-medium text-text-primary sm:w-44">Скорость трат</dt>
              <dd className="text-text-secondary">
                {burn
                  ? (
                    <>
                      <span className={burn.alerting ? "font-semibold text-red-700" : undefined}>
                        {fmtCredits(burn.total)} кр за последние {burn.windowMinutes} мин
                        {props.priceKnown ? ` (≈ ${props.usd(burn.total)})` : ""}
                      </span>
                      {burn.threshold > 0
                        ? ` · тревога выше ${fmtCredits(burn.threshold)} кр/ч`
                        : " · тревога выключена"}
                      {(burn.topOperations.length > 0 || burn.topPages.length > 0) && (
                        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px]">больше всего тратят:</span>
                          {burn.topOperations.map((op) => (
                            <StatusChip
                              key={`op-${op.operation ?? "unknown"}`}
                              tone={burn.alerting ? "danger" : "neutral"}
                              title={op.operation ?? undefined}
                            >
                              {op.operation ? operationLabel(op.operation) : "без атрибуции"} · {fmtCredits(op.credits)} кр
                            </StatusChip>
                          ))}
                          {burn.topPages.map((page) => (
                            <StatusChip key={`page-${page.pageId}`} tone={burn.alerting ? "danger" : "neutral"} title="страница">
                              {page.pageLabel} · {fmtCredits(page.credits)} кр
                            </StatusChip>
                          ))}
                        </span>
                      )}
                    </>
                  )
                  : "За последний час трат нет."}
              </dd>
            </div>
            <div className="sm:flex sm:gap-3">
              <dt className="shrink-0 font-medium text-text-primary sm:w-44">Потоки синка</dt>
              <dd className="text-text-secondary">
                {summary.budgets.length === 0
                  ? "Бюджеты синка не настроены."
                  : parked.length === 0
                    ? "Все работают."
                    : parked.map((budget) => (
                      <span key={budget.stream} className="block">
                        {streamLabel(budget.stream)} на паузе — {budget.state === "floor_blocked"
                          ? "баланс ниже порога автостопа."
                          : `дневной бюджет исчерпан; продолжит ${budget.retryAt ? `в ${utcDateTime(budget.retryAt)}` : "после полуночи UTC"}.`}
                      </span>
                    ))}
              </dd>
            </div>
            <div className="sm:flex sm:gap-3">
              <dt className="shrink-0 font-medium text-text-primary sm:w-44">Открытые инциденты</dt>
              <dd className="text-text-secondary">
                {summary.incidents.length === 0
                  ? "Нет."
                  : summary.incidents.map((incident) => (
                    <span key={`${incident.kind}-${incident.openedAt}`} className="block">
                      {incidentLabel(incident.kind)} — открыт с {utcDateTime(incident.openedAt)}.
                      {incident.errorSummary ? ` ${incident.errorSummary}.` : ""}
                    </span>
                  ))}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-light px-4 py-3 text-[12px] text-text-secondary">
            <span className={eyebrowClass}>Настройки</span>
            <Link
              to="/settings?tab=collection"
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              Настройки сбора
            </Link>
            <ConfigLink configKey="ofapiDmDailyCreditBudget">Бюджет сообщений</ConfigLink>
            {props.hasAudienceBudget && (
              <ConfigLink configKey="ofapiAudienceDailyCreditBudget">Бюджет аудитории</ConfigLink>
            )}
            <ConfigLink configKey="ofapiCreditFloor">Порог автостопа</ConfigLink>
            <ConfigLink configKey="ofapiBurnAlertCreditsPerHour">Тревога по тратам</ConfigLink>
            <ConfigLink configKey="ofapiCreditMicroUsdPrice">Цена кредита</ConfigLink>
            <span>· тревога по тратам меняется там и применяется сразу; цена, бюджеты и порог — только через переменные окружения</span>
          </div>
          <ProjectionAccuracySection />
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

  const ledgerRef = useRef<HTMLElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [exportTruncated, setExportTruncated] = useState(false);

  const ledgerFrom = ledgerDateStart(fromFilter);
  const ledgerTo = ledgerDateEndExclusive(toFilter);
  const ledgerQuery = useAdminOfapiCreditsLedger({
    offset: ledgerOffset,
    limit: LEDGER_PAGE_SIZE,
    source: sourceFilter || undefined,
    operation: operationFilter.trim() || undefined,
    pageId: pageFilter ? Number(pageFilter) : undefined,
    from: ledgerFrom,
    to: ledgerTo,
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
          title="Не удалось загрузить кредиты OFAPI"
          description="Эндпоинт сводки вернул ошибку. Повторите чуть позже."
          tone="error"
          action={<RetryButton onClick={() => summaryQuery.refetch()} />}
        />
      </div>
    );
  }

  const pendingWebhookEstimate = summary.accrual.pendingToday ?? null;
  const hasAudienceBudget = summary.budgets.some((budget) => budget.stream === "audience");

  // Display-only flat credit price from Settings. 0 means unset, and every USD
  // estimate on the page is suppressed.
  const microUsdPerCredit = summary.pricing?.microUsdPerCredit ?? 0;
  const priceKnown = microUsdPerCredit > 0;
  const usd = (credits: number) => creditsToUsd(credits, microUsdPerCredit);

  const focusLedger = () => {
    ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // A breakdown row drills straight into the matching activity-log filter.
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
        from: ledgerFrom,
        to: ledgerTo,
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
      ? "text-red-700"
      : forecast.daysLeft < RUNWAY_WARNING_DAYS
        ? "text-amber-700"
        : "text-text-primary";

  const burn = summary.recentBurn;
  const burnAlerting = burn?.alerting ?? false;
  const showAlarm = summary.floor.blocked || summary.incidents.length > 0 || burnAlerting;
  const burnDrivers = burn
    ? [
      ...burn.topOperations.map((op) =>
        `${op.operation ? operationLabel(op.operation) : "без атрибуции"} (${fmtCredits(op.credits)} кр)`),
      ...burn.topPages.map((page) => `${page.pageLabel} (${fmtCredits(page.credits)} кр)`),
    ]
    : [];

  const todaySources = SOURCE_SERIES
    .map((series) => ({ ...series, value: summary.today.bySource[series.key] }))
    .filter((series) => series.value !== 0);

  const refillRecommendation = forecast.refillRecommendation ?? null;
  const recordedActivityForecast = forecast.basis === "recorded_activity";
  const unverifiedResidual = forecast.unverifiedResidual;

  const heroValueClass = "mt-1 text-[28px] font-semibold leading-tight";
  const heroUnitClass = "text-[15px] font-medium text-text-secondary";
  const heroSubClass = "mt-1 text-[12px] text-text-secondary";

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-5">
        <div className="flex items-center justify-between gap-4"><h1 className="text-xl font-extrabold text-text-primary">Кредиты OFAPI</h1><Link className="text-sm text-accent" to={buildSettingsRoute("collection")}>Настройки сбора</Link></div>
        <p className="mt-1 text-sm text-text-secondary">
          Предоплаченные кредиты списываются за каждый запрос этого приложения к API OnlyFans —
          синк чатов, отправку сообщений, проверку фанатов. Всё время на странице — UTC.
        </p>
      </div>

      {!summary.enabled ? (
        <StatusPanel
          title="Журнал кредитов выключен"
          description="Включите журнал кредитов OFAPI в Настройки → Конфигурация, чтобы записывать траты по каждому запросу, начисления вебхуков, сверку баланса, тревоги по скорости трат и оценку несписанных событий. Это staged-флаг: сначала включите OFAPI account health, затем журнал кредитов."
          action={(
            <Link
              to="/settings?tab=configuration#config-ofapiCreditLedgerEnabled"
              className="inline-flex items-center rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-accent hover:bg-hover"
            >
              Открыть конфигурацию →
            </Link>
          )}
        />
      ) : (
        <>
          {showAlarm && (
            <div
              role="alert"
              className="mb-4 space-y-1.5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-700"
            >
              {summary.floor.blocked && (
                <p>
                  Траты остановлены — баланс ниже порога автостопа{" "}
                  {fmtCredits(summary.floor.value)} кр. Пополните баланс, чтобы синк продолжился.
                </p>
              )}
              {burnAlerting && burn && (
                <p>
                  Журнал показывает расход или разницу баланса: {fmtCredits(burn.total)} кр за последние{" "}
                  {burn.windowMinutes} минут (порог тревоги {fmtCredits(burn.threshold)} кр/ч).
                  {burnDrivers.length > 0 ? ` Больше всего тратят: ${burnDrivers.join(", ")}.` : ""}
                </p>
              )}
              {summary.incidents.map((incident) => (
                <p key={`${incident.kind}-${incident.openedAt}`}>
                  {incidentLabel(incident.kind)} — открыт с {utcDateTime(incident.openedAt)}.
                  {incident.errorSummary ? ` ${incident.errorSummary}.` : ""}
                </p>
              ))}
            </div>
          )}

          {/* The answer card: balance → runway → what to do about it. */}
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="grid gap-4 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-border">
              <div className="sm:pr-6">
                <div className={eyebrowClass}>Баланс</div>
                <div className={`${heroValueClass} text-text-primary`}>
                  {summary.balance.value !== null
                    ? (
                      <>
                        {fmtCredits(summary.balance.value)} <span className={heroUnitClass}>кр</span>
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
                <div className={eyebrowClass}>{recordedActivityForecast ? "Прогноз по операциям" : "Хватит на"}</div>
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
                        {forecast.runOutDate ? `закончатся ~${humanDay(forecast.runOutDate)} · ` : ""}
                        ~{fmtCredits(Math.round(forecast.avgDailySpend7d))} кр/день
                        {priceKnown ? ` ≈ ${usd(Math.round(forecast.avgDailySpend7d))}/день` : ""} (среднее за 7 дней)
                      </>
                    )
                    : forecast.avgDailySpend7d <= 0
                      ? "за последние 7 дней нет учтённых трат для прогноза"
                      : "ждём показание баланса"}
                </div>
              </div>
              <div className="sm:pl-6">
                <div className={eyebrowClass}>Пополнение</div>
                {refillRecommendation
                  ? refillRecommendation.credits > 0
                    ? (
                      <>
                        <div className={`${heroValueClass} text-amber-700`}>
                          +{fmtCredits(refillRecommendation.credits)} <span className={heroUnitClass}>кр</span>
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
                        <div className={`${heroValueClass} text-green-700`}>
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
              <p className="mt-4 text-[12px] text-text-secondary">
                Прогноз учитывает HTTP-запросы, их корректировки и оценку вебхуков.
                Необъяснённая разница баланса в прогноз не включена.
              </p>
            )}
            {unverifiedResidual && unverifiedResidual.credits > 0 && (
              <p role="note" className="mt-3 rounded-lg bg-amber-50 p-3 text-[12px] text-amber-800">
                По сверке за {utcDateTime(unverifiedResidual.from)} — {utcDateTime(unverifiedResidual.to)}:{" "}
                ещё {fmtCredits(unverifiedResidual.credits)} кр уменьшения баланса без подтверждённого источника.
                Фактический расход может быть выше прогноза; требуется проверка этой разницы.
              </p>
            )}
            {(forecast.monthToDateSpend !== undefined || forecast.monthEndProjection !== undefined) && (
              <div className="mt-4 border-t border-border-light pt-3 text-[12px] text-text-secondary">
                {forecast.monthToDateSpend !== undefined && (
                  <>
                    {recordedActivityForecast ? "По операциям за месяц: " : "Потрачено за месяц: "}{fmtCredits(forecast.monthToDateSpend)} кр
                    {priceKnown ? ` (≈ ${usd(forecast.monthToDateSpend)})` : ""}
                  </>
                )}
                {forecast.monthUnverifiedResidualCredits !== undefined && forecast.monthUnverifiedResidualCredits !== 0 && (
                  <> · разница баланса за месяц: {fmtCredits(forecast.monthUnverifiedResidualCredits)} кр</>
                )}
                {forecast.monthEndProjection !== undefined && (
                  <>
                    {forecast.monthToDateSpend !== undefined ? " · " : ""}
                    к концу месяца выйдет ~{fmtCredits(forecast.monthEndProjection)} кр
                    {priceKnown ? ` (≈ ${usd(forecast.monthEndProjection)})` : ""}
                  </>
                )}
              </div>
            )}
          </section>

          <section className="mt-4 rounded-xl border border-border bg-card p-5">
            <div className="grid gap-5 lg:grid-cols-[1fr_1.3fr]">
              <div>
                <div className={eyebrowClass}>Учтено сегодня · {summary.today.day}</div>
                <div className="mt-1 text-[22px] font-semibold leading-tight text-text-primary">
                  {fmtCredits(summary.today.total)} <span className={heroUnitClass}>кр</span>
                  {priceKnown && (
                    <span className="ml-2 text-[13px] font-medium text-text-secondary">
                      ≈ {usd(summary.today.total)}
                    </span>
                  )}
                </div>
                {todaySources.length > 0
                  ? (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-secondary tabular-nums">
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
                  : <p className="mt-2 text-[12px] text-text-secondary">Сегодня пока ничего не потрачено.</p>}
                {pendingWebhookEstimate && pendingWebhookEstimate.eventCount > 0 && (
                  <p className="mt-2 text-[12px] text-text-secondary">
                    + ~{fmtCredits(pendingWebhookEstimate.estimatedCredits)} кр за{" "}
                    {fmtCredits(pendingWebhookEstimate.eventCount)}{" "}
                    {ruPlural(pendingWebhookEstimate.eventCount, "событие", "события", "событий")} вебхуков
                    ещё не проведены — оценка добавится в журнал после завершения дня
                  </p>
                )}
              </div>
              <div>
                <div className={eyebrowClass}>Дневные бюджеты синка</div>
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
                    : <p className="text-[12px] text-text-secondary">Бюджеты синка не настроены.</p>}
                </div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border-light pt-3 text-[12px] text-text-secondary">
              {summary.floor.value > 0
                ? summary.floor.blocked
                  ? (
                    <span className="font-semibold text-red-700">
                      Порог автостопа: {fmtCredits(summary.floor.value)} кр — траты остановлены,
                      потому что баланс ниже порога.
                    </span>
                  )
                  : (
                    <span>
                      Порог автостопа: {fmtCredits(summary.floor.value)} кр — траты автоматически
                      остановятся, если баланс упадёт ниже.
                    </span>
                  )
                : <span>Порог автостопа не задан — траты никогда не останавливаются автоматически.</span>}
              <ConfigLink configKey="ofapiCreditFloor">
                {summary.floor.value > 0 ? "Изменить" : "Задать"}
              </ConfigLink>
            </div>
          </section>

          {chartsQuery.isLoading ? (
            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              <div className="h-[360px] animate-pulse rounded-xl border border-border bg-card" />
              <div className="h-[360px] animate-pulse rounded-xl border border-border bg-card" />
            </div>
          ) : chartsQuery.isError ? (
            <div className="mt-6">
              <StatusPanel
                tone="error"
                title="Не удалось загрузить графики"
                description="Эндпоинт дневной статистики вернул ошибку."
                action={<RetryButton onClick={() => chartsQuery.refetch()} />}
              />
            </div>
          ) : (
            <div className="mt-6 grid gap-4 lg:grid-cols-2">
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
                xTickFormatter={shortDay}
                valueFormatter={fmtCredits}
                tooltipValueFormatter={(value) =>
                  priceKnown ? `${fmtCredits(value)} кр · ${usd(value)}` : `${fmtCredits(value)} кр`}
                yAxisWidth={48}
                headerExtra={(
                  <span className="text-[12px] text-text-secondary">Последние {CHART_DAYS} дней · UTC</span>
                )}
              />
            </div>
          )}

          <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <h2 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary">
                Куда уходят кредиты
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
                    {period}д
                  </button>
                ))}
              </div>
            </div>
            {breakdownQuery.isLoading ? (
              <div className="border-t border-border-light p-4">
                <TableSkeleton rows={6} columns={6} />
              </div>
            ) : breakdownQuery.isError ? (
              <div className="border-t border-border-light p-4">
                <StatusPanel
                  tone="error"
                  title="Не удалось загрузить разбивку"
                  description="Эндпоинт разбивки вернул ошибку."
                  action={<RetryButton onClick={() => breakdownQuery.refetch()} />}
                />
              </div>
            ) : (
              <div className="grid border-t border-border-light lg:grid-cols-[1.4fr_1fr]">
                <div className="min-w-0 overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-hover-alt">
                        <th className={thClass}>Активность</th>
                        <th className={`${thClass} text-right`}>Запросы</th>
                        <th className={`${thClass} text-right`}>Кредиты</th>
                        {priceKnown && (
                          <th className={`${thClass} text-right`} title="Оценка стоимости в $ по заданной цене кредита">
                            Стоимость
                          </th>
                        )}
                        <th className={`${thClass} text-right`}>Доля</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(breakdown?.byOperation ?? []).map((row) => {
                        const sharePct = operationSharesComparable
                          ? Math.round((row.credits / operationTotal) * 100)
                          : null;
                        return (
                          <tr key={row.operation ?? "unknown"} className="border-t border-border-light">
                            <td className={tdClass}>
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
                            <td className={`${tdClass} text-right`}>{fmtCredits(row.requests)}</td>
                            <td className={`${tdClass} text-right`}>{fmtCredits(row.credits)}</td>
                            {priceKnown && (
                              <td className={`${tdClass} text-right`}>{usd(row.credits)}</td>
                            )}
                            <td className={`${tdClass} text-right`}>
                              {sharePct === null
                                ? "—"
                                : (
                                  <span className="inline-flex items-center justify-end gap-2">
                                    <span
                                      aria-hidden="true"
                                      className="h-1 w-10 overflow-hidden rounded-full bg-hover-alt"
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
                        <tr className="border-t border-border-light">
                          <td colSpan={priceKnown ? 5 : 4} className={`${tdClass} text-text-muted`}>
                            Нет трат через приложение за этот период
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="min-w-0 overflow-x-auto lg:border-l lg:border-border-light">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-hover-alt">
                        <th className={thClass}>Страница</th>
                        <th className={`${thClass} text-right`}>Кредиты</th>
                        {priceKnown && (
                          <th className={`${thClass} text-right`} title="Оценка стоимости в $ по заданной цене кредита">
                            Стоимость
                          </th>
                        )}
                        <th className={`${thClass} text-right`} title="Чистая выручка авторов за период">
                          Выручка
                        </th>
                        {priceKnown && (
                          <th className={`${thClass} text-right`} title="Выручка ÷ оценка стоимости кредитов">
                            ROI
                          </th>
                        )}
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
                                title={`Показать в журнале: ${row.pageLabel}`}
                              >
                                {row.pageLabel}
                              </button>
                            </td>
                            <td className={`${tdClass} text-right`}>{fmtCredits(row.credits)}</td>
                            {priceKnown && (
                              <td className={`${tdClass} text-right`}>{usd(row.credits)}</td>
                            )}
                            <td className={`${tdClass} text-right`}>{formatUsdFromMills(revenueMills)}</td>
                            {priceKnown && (
                              <td className={`${tdClass} text-right`}>
                                {roi === null
                                  ? "—"
                                  : (
                                    <span className={roi >= 1 ? "text-green" : "text-red-700 font-medium"}>
                                      {roi.toFixed(1)}×
                                    </span>
                                  )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                      {(breakdown?.byPage ?? []).length === 0 && (
                        <tr className="border-t border-border-light">
                          <td colSpan={priceKnown ? 5 : 3} className={`${tdClass} text-text-muted`}>
                            Нет трат с привязкой к страницам за этот период
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {!priceKnown && (
                    <p className="border-t border-border-light px-4 py-3 text-[12px] text-text-secondary">
                      Задайте <ConfigLink configKey="ofapiCreditMicroUsdPrice">цену кредита</ConfigLink>,
                      чтобы видеть стоимость в $ и ROI по страницам.
                    </p>
                  )}
                </div>
              </div>
            )}
          </section>

          <section
            ref={ledgerRef}
            className="mt-6 scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card"
          >
            <div className="flex flex-wrap items-center gap-2 px-4 py-3">
              <h2 className="mr-auto text-[12px] font-semibold uppercase tracking-wider text-text-secondary">
                Журнал операций
              </h2>
              <select
                value={sourceFilter}
                onChange={(event) => {
                  setSourceFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                className={filterSelectClass}
                aria-label="Фильтр по источнику"
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
                aria-label="Фильтр по странице"
              >
                <option value="">Все страницы</option>
                {pageOptions.map((row) => (
                  <option key={row.pageId} value={String(row.pageId)}>{row.pageLabel}</option>
                ))}
              </select>
              {/* Exact-match filter fed by a datalist of real operation ids, so a
                  partial guess resolves to a known value instead of zero rows. */}
              <input
                value={operationFilter}
                onChange={(event) => {
                  setOperationFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                list={operationListId}
                placeholder="операция"
                className={`${filterSelectClass} w-36`}
                aria-label="Фильтр по операции"
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
                aria-label="Дата с (UTC)"
                title="Дата с (UTC)"
              />
              <input
                type="date"
                value={toFilter}
                onChange={(event) => {
                  setToFilter(event.target.value);
                  setLedgerOffset(0);
                }}
                className={filterSelectClass}
                aria-label="Дата по (UTC)"
                title="Дата по (UTC)"
              />
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-text-secondary hover:bg-hover"
                  title="Сбросить все фильтры"
                >
                  Сбросить фильтры
                </button>
              )}
              {/* A real CSV export of every row matching the current filters (not
                  just the visible page) for accounting. */}
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting || (ledger?.total ?? 0) === 0}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-text-secondary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                title="Скачать все строки по текущим фильтрам в CSV"
              >
                {exporting ? "Экспортируем…" : "Экспорт CSV"}
              </button>
              {exportError && (
                <span role="alert" className="text-[12px] font-medium text-red-700">
                  Экспорт не удался — повторите
                </span>
              )}
              {exportTruncated && !exportError && (
                <span role="alert" className="text-[12px] font-medium text-amber-700">
                  Экспорт обрезан до 50 000 строк — сузьте фильтры, чтобы выгрузить всё
                </span>
              )}
            </div>
            {ledgerQuery.isLoading ? (
              <TableSkeleton rows={8} columns={8} />
            ) : ledgerQuery.isError ? (
              <div className="p-4">
                <StatusPanel
                  tone="error"
                  title="Не удалось загрузить журнал"
                  description="Эндпоинт журнала вернул ошибку. Фильтры сохранены."
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
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-hover-alt">
                        <th className={`${thClass} w-8`}><span className="sr-only">Развернуть детали</span></th>
                        <th className={thClass}>Время (UTC)</th>
                        <th className={thClass}>Источник</th>
                        <th className={thClass}>Активность</th>
                        <th className={thClass}>Страница</th>
                        <th className={`${thClass} text-right`}>Кредиты</th>
                        <th className={`${thClass} text-right`}>Баланс после</th>
                        <th className={`${thClass} text-right`}>HTTP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(ledger?.rows ?? []).map((row) => (
                        <LedgerRow key={row.id} row={row} />
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
                  previousLabel="Назад"
                  nextLabel="Вперёд"
                  formatRange={(start, end, total) => `${start}–${end} из ${fmtCredits(total)}`}
                />
              </>
            )}
          </section>

          <OfapiVendorEvidence />

          <SystemHealthSection
            summary={summary}
            hasAudienceBudget={hasAudienceBudget}
            priceKnown={priceKnown}
            usd={usd}
          />
        </>
      )}
    </div>
  );
}
