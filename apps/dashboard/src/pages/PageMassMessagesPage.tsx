import { useState } from "react";
import { useParams } from "react-router";
import type { PagePromoResponse } from "@agency_hub_core/contracts";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import { usePageMassMessages, usePagePromo, type MassMessageList } from "@/api/page-promo";
import { AnalyticsEmpty, AnalyticsError, AnalyticsLoading, AnalyticsPanel } from "@/components/analytics/AnalyticsPanel";
import { Pagination } from "@/components/shared/Pagination";
import { formatDate } from "@/lib/format";

/**
 * The page's mass messages as Fansly's stats lists show them (live, scheduled,
 * deleted — collected daily since 2026-08): how many got each, how many read
 * it, what its offers sold and earned; and the automated messages the page
 * sends on a follow, a subscription, a renewal or a tip. Fansly only.
 */

const LIMIT = 50;

const LISTS: { value: MassMessageList; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "live", label: "Текущие" },
  { value: "scheduled", label: "Запланированные" },
  { value: "deleted", label: "Удалённые" },
];

const LIST_LABEL: Record<string, string> = { live: "текущая", scheduled: "запланирована", deleted: "удалена" };

/** `triggerType` as the automated-message editor names it (bundle 2026-10-29). */
const TRIGGERS: Record<number, string> = {
  0: "Выключено",
  3: "Новый фолловер",
  15: "Новый подписчик",
  15002: "Новый подписчик по гифт-ссылке",
  15010: "Продление подписки",
  15012: "Продление по гифт-ссылке",
  7001: "Новый тип",
};

function money(value: number | null): string {
  return value === null ? "—" : formatUsdFromMills(value);
}

function percent(part: number | null, whole: number | null): string {
  if (part === null || whole === null || whole === 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

function duration(seconds: number | null): string {
  if (seconds === null || seconds === 0) return "сразу";
  if (seconds % 86_400 === 0) return `${seconds / 86_400} д`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} ч`;
  if (seconds % 60 === 0) return `${seconds / 60} мин`;
  return `${seconds} с`;
}

function Automations({ automations }: { automations: PagePromoResponse["automations"] }) {
  const active = automations.filter((a) => a.missingSince === null);
  return (
    <AnalyticsPanel title="Автосообщения" description="Что страница пишет сама: на подписку, фоллоу, продление, тип.">
      {active.length === 0 ? <AnalyticsEmpty reason="Автосообщений нет." /> : (
        <div className="card-body overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>Когда</th><th>Задержка</th><th>Пауза</th><th>Текст</th></tr></thead>
            <tbody>
              {active.map((a) => (
                <tr key={a.automationRef}>
                  <td>
                    {a.triggerType === null ? "—" : TRIGGERS[a.triggerType] ?? `Триггер ${a.triggerType}`}
                    {a.tierName ? <div className="text-xs text-muted">тир {a.tierName}</div> : null}
                  </td>
                  <td>{duration(a.delaySeconds)}</td>
                  <td>{a.cooldownSeconds ? duration(a.cooldownSeconds) : "—"}</td>
                  <td className="max-w-xl">
                    <span className="whitespace-pre-wrap">{a.messageText ?? ""}</span>
                    {a.attachmentCount > 0 ? <span className="badge ml-2">вложений: {a.attachmentCount}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

export function PageMassMessagesPage() {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  const [list, setList] = useState<MassMessageList>("all");
  const [offset, setOffset] = useState(0);
  const query = usePageMassMessages(pageLabel, list, LIMIT, offset);
  const promo = usePagePromo(pageLabel);
  const data = query.data;
  return (
    <div className="space-y-4">
      <AnalyticsPanel
        title="Массовые рассылки"
        description="Каждая рассылка: скольким ушла, сколько прочитали, что продали и заработали (чистыми). Как в статистике рассылок Fansly."
        headerExtra={(
          <div className="segmented" role="group" aria-label="Список">
            {LISTS.map((option) => (
              <button key={option.value} type="button" className="segment" aria-pressed={list === option.value} onClick={() => { setList(option.value); setOffset(0); }}>
                {option.label}
              </button>
            ))}
          </div>
        )}
      >
        {query.isPending ? <AnalyticsLoading what="Загружаем рассылки…" /> : query.isError || !data ? (
          <AnalyticsError message="Не удалось загрузить рассылки." onRetry={() => void query.refetch()} />
        ) : data.total === 0 ? <AnalyticsEmpty reason="Рассылок в этом списке нет." /> : (
          <div className="card-body space-y-4">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div><dt className="text-xs text-muted">Рассылок</dt><dd>{data.total}</dd></div>
              <div><dt className="text-xs text-muted">Отправлено</dt><dd>{data.totals.sent.toLocaleString("ru-RU")}</dd></div>
              <div><dt className="text-xs text-muted">Прочитали</dt><dd>{data.totals.read.toLocaleString("ru-RU")} · {percent(data.totals.read, data.totals.sent)}</dd></div>
              <div><dt className="text-xs text-muted">Продаж</dt><dd>{data.totals.salesCount}</dd></div>
              <div><dt className="text-xs text-muted">Заработали · типы</dt><dd>{money(data.totals.salesNetMills)} · {money(data.totals.tipsMills)}</dd></div>
            </dl>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr><th>Дата</th><th>Текст</th><th>Ушло</th><th>Прочитали</th><th>Предложение</th><th>Продаж</th><th>Заработали</th><th>Типы</th></tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={`${row.list}:${row.broadcastRef}`}>
                      <td className="whitespace-nowrap">
                        {formatDate(row.scheduledFor ?? row.createdAt ?? "", { includeYear: true })}
                        {list === "all" && row.list !== "live" ? <div className="text-xs text-muted">{LIST_LABEL[row.list] ?? row.list}</div> : null}
                      </td>
                      <td className="max-w-md">
                        <span title={row.text ?? ""} className="line-clamp-2">{row.text || "без текста"}</span>
                      </td>
                      <td>{row.sent ?? "—"}</td>
                      <td>{row.read ?? "—"} <span className="text-xs text-muted">{percent(row.read, row.sent)}</span></td>
                      <td className="whitespace-nowrap">
                        {row.offeredMedia + row.offeredBundles === 0 ? "—" : (
                          <>
                            {row.offeredMedia > 0 ? `медиа ${row.offeredMedia}` : ""}
                            {row.offeredBundles > 0 ? ` наборы ${row.offeredBundles}` : ""}
                            {/* A price only when Fansly served one above zero on the message's own offers. */}
                            {row.minPriceMills === null ? null : (
                              <div className="text-xs text-muted">
                                {row.minPriceMills === row.maxPriceMills ? money(row.minPriceMills) : `${money(row.minPriceMills)}–${money(row.maxPriceMills)}`}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td>{row.salesCount ?? "—"}</td>
                      <td className="whitespace-nowrap">
                        {money(row.salesNetMills)}
                        {row.salesPendingMills ? <div className="text-xs text-muted">в холде {money(row.salesPendingMills)}</div> : null}
                      </td>
                      <td>{row.tipsMills ? money(row.tipsMills) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination offset={offset} limit={LIMIT} total={data.total} onPageChange={setOffset} />
          </div>
        )}
      </AnalyticsPanel>
      {promo.isPending ? <AnalyticsLoading what="Загружаем автосообщения…" /> : promo.isError || !promo.data ? (
        <AnalyticsError message="Не удалось загрузить автосообщения." onRetry={() => void promo.refetch()} />
      ) : <Automations automations={promo.data.automations} />}
    </div>
  );
}
