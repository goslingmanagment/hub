import { useState, type ReactNode } from "react";
import type { AdminAiSpendResponse, AiSpendRow } from "@agency_hub_core/contracts";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";

import { useAdminAiSpend } from "@/api/adminAiSpend";
import { StackedBarChart, type StackedBarChartSeries } from "@/components/shared/StackedBarChart";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { UsageDateNav } from "@/components/shared/UsageDateNav";
import { type UsagePeriod, shiftAnchor, usageDateLabel, usageRange } from "@/lib/format";
import { featureLabel } from "./account/accountView.js";

type Spend = AdminAiSpendResponse;

const LANE_LABELS: Readonly<Record<string, string>> = {
  "media-describe": "Описание картинок",
  "fan-facts": "Факты из чата",
};
const BRANCH_LABELS: Readonly<Record<string, string>> = { human: "Клик чаттера", background: "Фон хаба" };
const OUTCOME_LABELS: Readonly<Record<string, string>> = { completed: "Готово", failed: "Ошибка", cancelled: "Отменено" };
const EFFORT_LABELS: Readonly<Record<string, string>> = { off: "без размышлений", "—": "не записан" };
const SERIES_COLORS = [
  "var(--color-chart-blue)",
  "var(--color-chart-orange)",
  "var(--color-chart-aqua)",
  "var(--color-chart-violet)",
  "var(--color-chart-magenta)",
  "var(--color-chart-lime)",
];

function anyFeatureLabel(feature: string) {
  return LANE_LABELS[feature] ?? featureLabel(feature);
}

function usd(microUsd: number | null | undefined): string {
  if (microUsd === null || microUsd === undefined) return "—";
  const value = microUsd / 1_000_000;
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function workedHours(minutes: number | undefined): string {
  return minutes === undefined ? "—" : (minutes / 60).toFixed(1);
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} млн`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} тыс.`;
  return String(value);
}

function moscowTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { timeZone: MOSCOW_TIME_ZONE, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function todayISO(): string {
  return toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
}

function Tile(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs text-text-secondary">{props.label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{props.value}</div>
      {props.hint ? <div className="mt-0.5 text-xs text-text-muted">{props.hint}</div> : null}
    </div>
  );
}

/** One cut of the ledger: who or what the money went to. */
function SpendTable(props: { title: string; rows: readonly AiSpendRow[]; total: number; label?: (row: AiSpendRow) => string; extras?: ReadonlyArray<{ head: string; title?: string; cell: (row: AiSpendRow) => ReactNode }> }) {
  if (props.rows.length === 0) return null;
  return (
    <section aria-label={props.title} className="card">
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="data-table">
          <thead>
            <tr>
              <th>{props.title}</th>
              <th className="num">Траты</th>
              <th className="num">Доля</th>
              <th className="num">Вызовов</th>
              <th className="num">Вызов</th>
              {props.extras?.map((extra) => <th key={extra.head} className="num" title={extra.title}>{extra.head}</th>)}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.key}>
                <td className="font-medium">{props.label ? props.label(row) : row.label}</td>
                <td className="num">{usd(row.costMicroUsd)}</td>
                <td className="num text-text-secondary">{pct(row.costMicroUsd, props.total)}</td>
                <td className="num">{row.calls}</td>
                <td className="num text-text-secondary">{usd(row.calls > 0 ? Math.round(row.costMicroUsd / row.calls) : null)}</td>
                {props.extras?.map((extra) => <td key={extra.head} className="num">{extra.cell(row)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Where the cache would help: each feature's price by token type. */
function TokenPartsTable(props: { rows: readonly AiSpendRow[] }) {
  return (
    <section aria-label="Из чего складывается цена" className="card">
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Из чего складывается цена</th>
              <th className="num" title="Вход по полной цене: не из кеша">Вход без кеша</th>
              <th className="num">Чтение кеша</th>
              <th className="num">Запись кеша</th>
              <th className="num" title="Видимый ответ и размышления: Anthropic считает их вместе">Выход и размышления</th>
              <th className="num" title="Оценки отменённых вызовов, fallback по цене другой модели, округление">Прочее</th>
              <th className="num" title="Токенов входа на вызов: без кеша / из кеша">Вход на вызов</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => {
              const parts = row.parts;
              const total = row.costMicroUsd;
              const cell = (value: number) => (
                <td className="num">
                  {usd(value)} <span className="text-text-muted">{pct(value, total)}</span>
                </td>
              );
              return (
                <tr key={row.key}>
                  <td className="font-medium">{anyFeatureLabel(row.key)}</td>
                  {cell(parts.inputMicroUsd)}
                  {cell(parts.cacheReadMicroUsd)}
                  {cell(parts.cacheWriteMicroUsd)}
                  {cell(parts.outputMicroUsd)}
                  {cell(parts.otherMicroUsd)}
                  <td className="num text-text-secondary">
                    {row.calls > 0 ? `${compact(Math.round(row.tokens.input / row.calls))} / ${compact(Math.round(row.tokens.cacheRead / row.calls))}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UnitEconomics(props: { features: Spend["features"] }) {
  if (props.features.length === 0) return null;
  return (
    <section aria-label="Цена результата" className="card">
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Цена результата (вызовы чаттеров)</th>
              <th className="num">Траты</th>
              <th className="num">Вызов</th>
              <th className="num" title="Все траты функции, делённые на отправленные фанам сообщения">Отправленное сообщение</th>
              <th className="num">Отправлено</th>
              <th className="num" title="Ответы, которые не скопировали, не вставили и не отправили">Не использовано</th>
            </tr>
          </thead>
          <tbody>
            {props.features.map((feature) => (
              <tr key={feature.feature}>
                <td className="font-medium">{anyFeatureLabel(feature.feature)}</td>
                <td className="num">{usd(feature.costMicroUsd)}</td>
                <td className="num">{usd(feature.perCallMicroUsd)}</td>
                <td className="num font-semibold">{feature.tracksUse ? usd(feature.perSentMessageMicroUsd) : "—"}</td>
                <td className="num">{feature.tracksUse ? feature.sentMessages : "—"}</td>
                <td className="num">
                  {feature.tracksUse
                    ? <>{usd(feature.unusedMicroUsd)} <span className="text-text-muted">{feature.unusedCalls} из {feature.calls}</span></>
                    : <span className="text-text-muted">не отслеживается</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function settingValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function SettingChanges(props: { changes: Spend["settingChanges"] }) {
  if (props.changes.length === 0) return null;
  return (
    <section aria-label="Правки настроек ИИ" className="card">
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Правки настроек ИИ</th>
              <th>Что</th>
              <th className="num" title="Траты затронутых функций в сутки за 3 дня до правки">До, в сутки</th>
              <th className="num" title="Траты затронутых функций в сутки после правки (до 3 дней)">После, в сутки</th>
            </tr>
          </thead>
          <tbody>
            {props.changes.map((change) => (
              <tr key={`${change.at}-${change.key}`}>
                <td className="whitespace-nowrap">{moscowTime(change.at)} <span className="text-text-muted">{change.username ?? ""}</span></td>
                <td>
                  <div className="font-medium">{change.key}{change.features ? `: ${change.features.map(anyFeatureLabel).join(", ")}` : ""}</div>
                  <div className="text-xs text-text-muted">{settingValue(change.oldValue)} → {settingValue(change.newValue)}</div>
                </td>
                <td className="num">{usd(change.before.perDayMicroUsd)}</td>
                <td className="num">
                  {usd(change.after.perDayMicroUsd)}
                  <span className="ml-1 text-xs text-text-muted">{change.after.hours < 72 ? `${change.after.hours} ч` : ""}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DailyChart(props: { data: Spend; mode: UsagePeriod }) {
  const byHour = props.mode === "day";
  const features = props.data.breakdowns.feature.map((row) => row.key);
  const shown = features.slice(0, SERIES_COLORS.length);
  const series: StackedBarChartSeries[] = [
    ...shown.map((feature, index) => ({ key: feature, label: anyFeatureLabel(feature), color: SERIES_COLORS[index]! })),
    ...(features.length > shown.length ? [{ key: "other", label: "Остальное", color: "var(--color-border-strong)" }] : []),
  ];
  let rows: Array<Record<string, string | number>>;
  if (byHour) {
    rows = Array.from({ length: 24 }, (_, hour) => {
      const key = String(hour).padStart(2, "0");
      const row = props.data.breakdowns.hour.find((item) => item.key === key);
      return { x: key, total: (row?.costMicroUsd ?? 0) / 1_000_000 };
    });
  } else {
    // Every day of the period up to today, gaps included, so bars stay evenly spaced.
    const days: string[] = [];
    const last = props.data.to < todayISO() ? props.data.to : todayISO();
    for (let day = new Date(`${props.data.from}T00:00:00Z`); day.toISOString().slice(0, 10) <= last; day.setUTCDate(day.getUTCDate() + 1)) {
      days.push(day.toISOString().slice(0, 10));
    }
    rows = days.map((day) => {
      const row: Record<string, string | number> = { x: day };
      for (const item of props.data.breakdowns.dayFeature) {
        const [itemDay, feature] = item.key.split("|");
        if (itemDay !== day || feature === undefined) continue;
        const target = shown.includes(feature) ? feature : "other";
        row[target] = Number(row[target] ?? 0) + item.costMicroUsd / 1_000_000;
      }
      return row;
    });
  }
  // The owner's AI setting changes, one mark per day (or hour) they fell on.
  const marks = new Map<string, string[]>();
  for (const change of props.data.settingChanges) {
    const local = new Date(change.at).toLocaleString("sv-SE", { timeZone: MOSCOW_TIME_ZONE });
    const x = byHour ? local.slice(11, 13) : local.slice(0, 10);
    if (!rows.some((row) => row.x === x)) continue;
    marks.set(x, [...(marks.get(x) ?? []), change.key]);
  }
  // Short marks (⚙ and the count): the changes themselves are in the table below.
  const markers = [...marks.entries()].map(([x, keys]) => ({ x, label: `⚙${keys.length}` }));
  return (
    <StackedBarChart
      markers={markers}
      title={byHour ? "Траты по часам (МСК)" : "Траты по дням и функциям"}
      data={rows}
      xKey="x"
      series={byHour ? [{ key: "total", label: "Траты", color: "var(--color-chart-blue)" }] : series}
      xTickFormatter={(value) => (byHour ? `${value}:00` : value.slice(5))}
      valueFormatter={(value) => `$${value.toFixed(2)}`}
      height={260}
    />
  );
}

const PERIOD_INTRO: Record<UsagePeriod, string> = {
  day: "Траты на ИИ по журналу хаба за день: на что, кем и почему.",
  week: "Траты на ИИ по журналу хаба за неделю: на что, кем и почему.",
  month: "Траты на ИИ по журналу хаба за месяц: на что, кем и почему.",
};

export function AiSpendPage() {
  const [mode, setMode] = useState<UsagePeriod>("week");
  const [anchor, setAnchor] = useState(todayISO);
  const range = usageRange(anchor, mode);
  const canGoNext = range.to < todayISO();
  const { data, isLoading, isError, isFetching, refetch } = useAdminAiSpend(range);

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 max-w-2xl">
        <p className="text-sm text-text-secondary">{PERIOD_INTRO[mode]}</p>
        <details className="help mt-1">
          <summary>Как это считается</summary>
          <div className="help-body">
            <p>
              Цена каждого вызова — расчёт хаба по токенам и прайсу Anthropic, включая ошибки и отмены (провайдер берёт
              деньги и за них). Сверка с настоящим счётом Anthropic — на вкладке «AI».
            </p>
            <p>
              «Клик чаттера» — запрос из расширения; «Фон хаба» — факты из чата и описания картинок. «Отправленное
              сообщение» — все траты функции, делённые на сообщения, ушедшие фанам из её ответов. Дни по Москве.
            </p>
          </div>
        </details>
      </div>
      <UsageDateNav
        mode={mode}
        onModeChange={setMode}
        label={usageDateLabel(anchor, mode)}
        onPrev={() => setAnchor(shiftAnchor(anchor, mode, -1))}
        onNext={() => setAnchor(shiftAnchor(anchor, mode, 1))}
        canGoNext={canGoNext}
      />
    </div>
  );

  let body: ReactNode;
  if (isLoading) {
    body = <div className="card"><TableSkeleton rows={6} columns={5} /></div>;
  } else if (isError && !data) {
    body = (
      <StatusPanel
        title="Не удалось загрузить траты на ИИ"
        description="Сервер не ответил. Попробуйте ещё раз."
        tone="error"
        action={<button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">Повторить</button>}
      />
    );
  } else if (!data) {
    body = <StatusPanel title="Нет данных" description="Отчёт пришёл пустым." tone="error" />;
  } else {
    const total = data.total;
    const human = data.breakdowns.branch.find((row) => row.key === "human")?.costMicroUsd ?? 0;
    const background = data.breakdowns.branch.find((row) => row.key === "background")?.costMicroUsd ?? 0;
    const days = Math.max(1, data.breakdowns.day.length);
    body = (
      <>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Tile label="Всего" value={usd(total.costMicroUsd)} hint={`${total.calls} вызовов · ${usd(Math.round(total.costMicroUsd / days))} в день`} />
          <Tile label="Клик чаттера / фон" value={`${pct(human, total.costMicroUsd)} / ${pct(background, total.costMicroUsd)}`} hint={`${usd(human)} / ${usd(background)}`} />
          <Tile label="Вход без кеша" value={pct(total.parts.inputMicroUsd, total.costMicroUsd)} hint={`${usd(total.parts.inputMicroUsd)} · здесь помогает кеш`} />
          <Tile label="Выход и размышления" value={pct(total.parts.outputMicroUsd, total.costMicroUsd)} hint={usd(total.parts.outputMicroUsd)} />
          {/* Two overlapping sets (a failed regeneration is both): shown apart, never summed. */}
          <Tile
            label="Перегенерации"
            value={usd(total.regenerationMicroUsd)}
            hint={`ошибки и отмены ${usd(total.failedMicroUsd)}`}
          />
        </div>
        <DailyChart data={data} mode={mode} />
        <UnitEconomics features={data.features} />
        <TokenPartsTable rows={data.breakdowns.feature} />
        <SettingChanges changes={data.settingChanges} />
        <div className="grid gap-5 xl:grid-cols-2">
          <SpendTable
            title="Чаттер"
            rows={data.breakdowns.chatter}
            total={total.costMicroUsd}
            label={(row) => (row.key === "background" ? "Фон хаба" : row.label)}
            extras={[
              {
                head: "Часов работы",
                title: "Минуты с действиями в расширении; простой дольше 10 минут — пауза. Открытая вкладка без действий не считается",
                cell: (row) => workedHours(data.shifts.byChatter.find((item) => String(item.userId) === row.key)?.workedMinutes),
              },
              {
                head: "За час",
                title: "ИИ в сменах на час работы: так чаттеров честно сравнивать",
                cell: (row) => usd(data.shifts.byChatter.find((item) => String(item.userId) === row.key)?.perWorkedHourMicroUsd),
              },
            ]}
          />
          <SpendTable title="Страница" rows={data.breakdowns.page} total={total.costMicroUsd} />
          <SpendTable title="Модель" rows={data.breakdowns.model} total={total.costMicroUsd} label={(row) => row.label.replace(/^anthropic:/, "")} />
          <SpendTable title="Effort" rows={data.breakdowns.effort} total={total.costMicroUsd} label={(row) => EFFORT_LABELS[row.key] ?? row.label} />
          <SpendTable title="Окно, сообщений" rows={data.breakdowns.window} total={total.costMicroUsd} label={(row) => (row.key === "—" ? "не записано" : row.label)} />
          <SpendTable title="Ключ Anthropic" rows={data.breakdowns.account} total={total.costMicroUsd} />
          <SpendTable title="Ветка" rows={data.breakdowns.branch} total={total.costMicroUsd} label={(row) => BRANCH_LABELS[row.key] ?? row.label} />
          <SpendTable title="Исход" rows={data.breakdowns.outcome} total={total.costMicroUsd} label={(row) => OUTCOME_LABELS[row.key] ?? row.label} />
        </div>
        {data.shifts.shifts > 0 && (
          <p className="text-sm text-text-secondary">
            Смены с {moscowTime(data.shifts.from)} по {moscowTime(data.shifts.to)}: {data.shifts.shifts} смен, ИИ на смену{" "}
            {usd(data.shifts.perShiftMicroUsd)}, на час работы {usd(data.shifts.perWorkedHourMicroUsd)}; вне смен{" "}
            {usd(data.shifts.outsideShiftsMicroUsd)}.
          </p>
        )}
        <section aria-label="Самые дорогие чаты" className="card">
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Самые дорогие чаты <span className="font-normal text-text-muted">· всего {data.conversations.count}, в среднем {usd(data.conversations.perConversationMicroUsd)}</span></th>
                  <th>Страница</th>
                  <th className="num">Траты</th>
                  <th className="num">Вызовов</th>
                  <th>Функции</th>
                </tr>
              </thead>
              <tbody>
                {data.conversations.top.map((chat) => (
                  <tr key={`${chat.pageLabel}-${chat.conversationId}`}>
                    <td className="font-mono text-xs">{chat.conversationId}</td>
                    <td>{chat.pageLabel ?? "—"}</td>
                    <td className="num">{usd(chat.costMicroUsd)}</td>
                    <td className="num">{chat.calls}</td>
                    <td className="text-text-secondary">{chat.features.map(anyFeatureLabel).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section aria-label="Самые дорогие вызовы" className="card">
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Самые дорогие вызовы</th>
                  <th>Функция</th>
                  <th>Кто</th>
                  <th className="num">Вход / кеш / запись / выход</th>
                  <th className="num">Окно</th>
                  <th className="num">Цена</th>
                </tr>
              </thead>
              <tbody>
                {data.topCalls.map((call) => (
                  <tr key={call.id}>
                    <td className="whitespace-nowrap">{moscowTime(call.completedAt)} <span className="text-text-muted">#{call.id}</span></td>
                    <td>
                      {anyFeatureLabel(call.feature)}{" "}
                      <span className="text-text-muted">{call.reasoningEffort ?? ""}{call.outcome !== "completed" ? ` · ${OUTCOME_LABELS[call.outcome] ?? call.outcome}` : ""}</span>
                    </td>
                    <td>{call.username ?? "фон"} <span className="text-text-muted">{call.pageLabel ?? ""}</span></td>
                    <td className="num text-text-secondary">
                      {compact(call.inputTokens)} / {compact(call.cacheReadTokens)} / {compact(call.cacheWriteTokens)} / {compact(call.outputTokens)}
                    </td>
                    <td className="num">{call.contextMessages ?? "—"}</td>
                    <td className="num font-semibold">{call.costApproximate ? "~" : ""}{usd(call.costMicroUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </>
    );
  }

  return (
    <div className="space-y-5">
      {header}
      {body}
    </div>
  );
}
