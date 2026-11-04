import type { ReactNode } from "react";
import type { AdminAiSpendResponse, AdminChatterUsageResponse, AiSpendRow } from "@agency_hub_core/contracts";
import { Disclosure } from "@/components/ui/Disclosure";
import { formatAiUnitPrice, formatAiUsd, formatCount, formatDateTime } from "@/lib/format";
import { CONFIG_COPY_RU } from "@/pages/settings/configCopyRu";
import { anyFeatureLabel, compact, sharePct } from "./aiShared.js";

type Spend = AdminAiSpendResponse;

const BRANCH: Readonly<Record<string, string>> = { human: "По кнопке чаттера", background: "Сам Hub" };
const OUTCOME: Readonly<Record<string, string>> = { completed: "Готово", failed: "Ошибка", cancelled: "Отменено" };
const EFFORT: Readonly<Record<string, string>> = { off: "без рассуждений", low: "низкое", medium: "среднее", high: "высокое", max: "максимальное", "—": "не записано" };

/** «Цена результата: вызовы чаттеров»: what a sent message cost, feature by feature. */
export function AiUnitPrices({ features }: { features: Spend["features"] }) {
  if (features.length === 0) return null;
  return (
    <section className="card" aria-labelledby="ai-unit-title">
      <div className="card-header"><h2 id="ai-unit-title" className="card-title">Цена результата: вызовы чаттеров</h2></div>
      <div className="table-wrap">
        <table className="data-table" aria-label="Цена результата">
          <thead>
            <tr>
              <th scope="col">Функция</th>
              <th scope="col" className="num">Траты</th>
              <th scope="col" className="num">За вызов</th>
              <th scope="col" className="num" title="Все траты функции, делённые на отправленные фанам сообщения">Отправленное сообщение</th>
              <th scope="col" className="num">Отправлено</th>
              <th scope="col" className="num" title="Ответы, которые не скопировали, не вставили и не отправили">Не использовано</th>
            </tr>
          </thead>
          <tbody>
            {features.map((feature) => (
              <tr key={feature.feature}>
                <td className="font-medium">{anyFeatureLabel(feature.feature)}</td>
                <td className="num">{formatAiUsd(feature.costMicroUsd)}</td>
                <td className="num">{feature.perCallMicroUsd == null ? "—" : formatAiUnitPrice(feature.perCallMicroUsd)}</td>
                <td className="num font-medium">{feature.tracksUse && feature.perSentMessageMicroUsd != null ? formatAiUsd(feature.perSentMessageMicroUsd) : "—"}</td>
                <td className="num">{feature.tracksUse ? formatCount(feature.sentMessages) : "—"}</td>
                <td className="num">
                  {feature.tracksUse
                    ? <>{formatAiUsd(feature.unusedMicroUsd)}<div className="ai-sub">{formatCount(feature.unusedCalls)} из {formatCount(feature.calls)}</div></>
                    : <span className="ai-sub">не отслеживается</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DetailSection({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="ai-detail-section">
      <h3 className="ai-subtitle">{title}{note && <span className="ai-subtitle-note">{note}</span>}</h3>
      {children}
    </section>
  );
}

function Cut({ title, rows, total, label }: { title: string; rows: readonly AiSpendRow[]; total: number; label?: (row: AiSpendRow) => string }) {
  if (rows.length === 0) return null;
  return (
    <div className="ai-cut">
      <table className="data-table data-table-dense" aria-label={title}>
        <thead>
          <tr>
            <th scope="col">{title}</th>
            <th scope="col" className="num">Траты</th>
            <th scope="col" className="num">Доля</th>
            <th scope="col" className="num">Вызовов</th>
            <th scope="col" className="num">За вызов</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{label ? label(row) : row.label}</td>
              <td className="num">{formatAiUsd(row.costMicroUsd)}</td>
              <td className="num muted">{sharePct(row.costMicroUsd, total)}</td>
              <td className="num">{formatCount(row.calls)}</td>
              <td className="num muted">{row.calls > 0 ? formatAiUnitPrice(Math.round(row.costMicroUsd / row.calls)) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function settingValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** «Подробнее»: everything the owner rarely needs, folded, without cards in cards. */
export function AiDetails({ data, usage }: { data: Spend; usage: AdminChatterUsageResponse | undefined }) {
  const total = data.total.costMicroUsd;
  const parts = data.total.parts;
  return (
    <Disclosure label="Подробнее" lazy className="ai-details">
      <DetailSection title="Из чего складывается цена" note={`вход без кэша ${sharePct(parts.inputMicroUsd, total)}, выход и рассуждения ${sharePct(parts.outputMicroUsd, total)}`}>
        <div className="table-wrap">
          <table className="data-table data-table-dense" aria-label="Из чего складывается цена">
            <thead>
              <tr>
                <th scope="col">Функция</th>
                <th scope="col" className="num" title="Вход по полной цене: не из кэша">Вход без кэша</th>
                <th scope="col" className="num">Чтение кэша</th>
                <th scope="col" className="num">Запись кэша</th>
                <th scope="col" className="num" title="Видимый ответ и рассуждения: Anthropic считает их вместе">Выход и рассуждения</th>
                <th scope="col" className="num" title="Оценки отменённых вызовов, цена другой модели, округление">Прочее</th>
                <th scope="col" className="num" title="Токенов входа на вызов: без кэша / из кэша">Вход на вызов</th>
              </tr>
            </thead>
            <tbody>
              {data.breakdowns.feature.map((row) => {
                const cell = (value: number) => <td className="num">{formatAiUsd(value)} <span className="ai-sub-inline">{sharePct(value, row.costMicroUsd)}</span></td>;
                return (
                  <tr key={row.key}>
                    <td>{anyFeatureLabel(row.key)}</td>
                    {cell(row.parts.inputMicroUsd)}
                    {cell(row.parts.cacheReadMicroUsd)}
                    {cell(row.parts.cacheWriteMicroUsd)}
                    {cell(row.parts.outputMicroUsd)}
                    {cell(row.parts.otherMicroUsd)}
                    <td className="num muted">{row.calls > 0 ? `${compact(Math.round(row.tokens.input / row.calls))} / ${compact(Math.round(row.tokens.cacheRead / row.calls))}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </DetailSection>

      {data.settingChanges.length > 0 && (
        <DetailSection title="Правки настроек ИИ">
          <div className="table-wrap">
            <table className="data-table data-table-dense" aria-label="Правки настроек ИИ">
              <thead>
                <tr>
                  <th scope="col">Когда</th>
                  <th scope="col">Что</th>
                  <th scope="col">Было → стало</th>
                  <th scope="col" className="num" title="Траты затронутых функций в сутки за 3 дня до правки">До, в сутки</th>
                  <th scope="col" className="num" title="Траты затронутых функций в сутки после правки, до 3 дней">После, в сутки</th>
                </tr>
              </thead>
              <tbody>
                {data.settingChanges.map((change) => (
                  <tr key={`${change.at}-${change.key}`}>
                    <td className="whitespace-nowrap">{formatDateTime(change.at)}{change.username && <div className="ai-sub">{change.username}</div>}</td>
                    <td>
                      {CONFIG_COPY_RU[change.key]?.title ?? change.key}
                      {change.features && `: ${change.features.map(anyFeatureLabel).join(", ")}`}
                      <div className="ai-sub">{change.key}</div>
                    </td>
                    <td className="ai-change">{settingValue(change.oldValue)} → {settingValue(change.newValue)}</td>
                    <td className="num">{change.before.perDayMicroUsd == null ? "—" : formatAiUsd(change.before.perDayMicroUsd)}</td>
                    <td className="num">
                      {change.after.perDayMicroUsd == null ? "—" : formatAiUsd(change.after.perDayMicroUsd)}
                      {change.after.hours < 72 && <div className="ai-sub">{Math.round(change.after.hours)} ч</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DetailSection>
      )}

      <DetailSection title="Разрезы">
        <div className="ai-cuts">
          <Cut title="Страница" rows={data.breakdowns.page} total={total} />
          <Cut title="Модель" rows={data.breakdowns.model} total={total} label={(row) => row.label.replace(/^anthropic:/, "")} />
          <Cut title="Усилие" rows={data.breakdowns.effort} total={total} label={(row) => EFFORT[row.key] ?? row.label} />
          <Cut title="Сколько сообщений читает ИИ" rows={data.breakdowns.window} total={total} label={(row) => (row.key === "—" ? "не записано" : row.label)} />
          <Cut title="Счёт Anthropic" rows={data.breakdowns.account} total={total} />
          <Cut title="Откуда вызов" rows={data.breakdowns.branch} total={total} label={(row) => BRANCH[row.key] ?? row.label} />
          <Cut title="Исход" rows={data.breakdowns.outcome} total={total} label={(row) => OUTCOME[row.key] ?? row.label} />
        </div>
      </DetailSection>

      {usage && usage.systemLanes.length > 0 && (
        <DetailSection title="Сам Hub">
          <div className="table-wrap">
            <table className="data-table data-table-dense" aria-label="Сам Hub">
              <thead><tr><th scope="col">Что делает</th><th scope="col" className="num">Вызовов</th><th scope="col" className="num">Траты</th></tr></thead>
              <tbody>
                {usage.systemLanes.map((lane) => (
                  <tr key={lane.feature}>
                    <td>{anyFeatureLabel(lane.feature)}</td>
                    <td className="num">{formatCount(lane.requestCount)}</td>
                    <td className="num">{lane.costApproximate ? "~" : ""}{formatAiUsd(lane.costMicroUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DetailSection>
      )}

      {data.conversations.top.length > 0 && (
        <DetailSection title="Самые дорогие чаты" note={`всего ${formatCount(data.conversations.count)}, в среднем ${data.conversations.perConversationMicroUsd == null ? "—" : formatAiUsd(data.conversations.perConversationMicroUsd)}`}>
          <div className="table-wrap">
            <table className="data-table data-table-dense" aria-label="Самые дорогие чаты">
              <thead><tr><th scope="col">Чат</th><th scope="col">Страница</th><th scope="col" className="num">Траты</th><th scope="col" className="num">Вызовов</th><th scope="col">Функции</th></tr></thead>
              <tbody>
                {data.conversations.top.map((chat) => (
                  <tr key={`${chat.pageLabel}-${chat.conversationId}`}>
                    <td className="tabular-nums text-text-secondary">{chat.conversationId}</td>
                    <td>{chat.pageLabel ?? "—"}</td>
                    <td className="num">{formatAiUsd(chat.costMicroUsd)}</td>
                    <td className="num">{formatCount(chat.calls)}</td>
                    <td className="muted">{chat.features.map(anyFeatureLabel).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DetailSection>
      )}

      {data.topCalls.length > 0 && (
        <DetailSection title="Самые дорогие вызовы">
          <div className="table-wrap">
            <table className="data-table data-table-dense" aria-label="Самые дорогие вызовы">
              <thead>
                <tr>
                  <th scope="col">Когда</th>
                  <th scope="col">Функция</th>
                  <th scope="col">Кто</th>
                  <th scope="col" className="num">Вход / кэш / запись / выход</th>
                  <th scope="col" className="num">Сообщений</th>
                  <th scope="col" className="num">Цена</th>
                </tr>
              </thead>
              <tbody>
                {data.topCalls.map((call) => (
                  <tr key={call.id}>
                    <td className="whitespace-nowrap">{formatDateTime(call.completedAt)} <span className="ai-sub-inline">#{call.id}</span></td>
                    <td>
                      {anyFeatureLabel(call.feature)}
                      <div className="ai-sub">
                        {[call.reasoningEffort ? EFFORT[call.reasoningEffort] ?? call.reasoningEffort : null, call.outcome !== "completed" ? OUTCOME[call.outcome] ?? call.outcome : null].filter(Boolean).join(", ")}
                      </div>
                    </td>
                    <td>{call.username ?? "Сам Hub"}{call.pageLabel && <div className="ai-sub">{call.pageLabel}</div>}</td>
                    <td className="num muted">{compact(call.inputTokens)} / {compact(call.cacheReadTokens)} / {compact(call.cacheWriteTokens)} / {compact(call.outputTokens)}</td>
                    <td className="num">{call.contextMessages ?? "—"}</td>
                    <td className="num font-medium">{call.costApproximate ? "~" : ""}{formatAiUsd(call.costMicroUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DetailSection>
      )}
    </Disclosure>
  );
}
