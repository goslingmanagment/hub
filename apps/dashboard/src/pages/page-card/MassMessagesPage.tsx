import { useState } from "react";
import { useParams } from "react-router";
import type { PagePromoResponse } from "@agency_hub_core/contracts";
import { usePageMassMessages, usePagePromo, type MassMessageList } from "@/api/page-promo";
import { Pagination } from "@/components/shared/Pagination";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { Segmented } from "@/components/ui/Segmented";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatCount, formatDate, formatMills } from "@/lib/format";
import { decodeRouteSegment } from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { ruPlural } from "@/lib/plural";
import { useListParams } from "@/pages/fans/listParts";

const LIMIT = 50;

const LISTS: ReadonlyArray<{ value: MassMessageList; label: string }> = [
  { value: "all", label: "Все" },
  { value: "live", label: "Текущие" },
  { value: "scheduled", label: "Запланированные" },
  { value: "deleted", label: "Удалённые" },
];

const LIST_NOTE: Readonly<Record<string, string>> = { scheduled: "запланирована", deleted: "удалена" };

/** `triggerType` as the automated-message editor names it (bundle 2026-10-29). */
const TRIGGERS: Readonly<Record<number, string>> = {
  0: "Выключено",
  3: "Новый фолловер",
  15: "Новый подписчик",
  15002: "Новый подписчик по подарочной ссылке",
  15010: "Продление подписки",
  15012: "Продление по подарочной ссылке",
  7001: "Новые чаевые",
};

function percent(part: number | null, whole: number | null): string | null {
  if (part === null || whole === null || whole === 0) return null;
  return `${Math.round((part / whole) * 100)} %`;
}

function delay(seconds: number | null): string {
  if (seconds === null || seconds === 0) return "сразу";
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} ${ruPlural(days, "день", "дня", "дней")}`;
  }
  if (seconds % 3_600 === 0) return `${seconds / 3_600} ч`;
  if (seconds % 60 === 0) return `${seconds / 60} мин`;
  return `${seconds} с`;
}

function money(value: number | null): string {
  return value === null ? "—" : formatMills(value);
}

/** One text cell: two lines, a click opens all of it. */
function TextCell({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="text-text-muted">без текста</span>;
  return (
    <button type="button" className={`mass-text ${open ? "is-open" : ""}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {text}
    </button>
  );
}

function Automations({ query }: { query: ReturnType<typeof usePagePromo> }) {
  const active = (query.data?.automations ?? []).filter((item) => item.missingSince === null);
  return (
    <section className="card" aria-labelledby="mass-auto-title">
      <div className="card-header">
        <div>
          <h2 id="mass-auto-title" className="card-title">Автосообщения</h2>
          <p className="card-description">Что страница пишет сама: на подписку, фоллов, продление, чаевые.</p>
        </div>
      </div>
      {!query.data ? (
        query.isError ? <div className="card-body"><NoAnswerPanel retry={query.refetch} /></div> : <TableSkeleton rows={3} columns={4} />
      ) : active.length === 0 ? (
        <div className="card-body"><p className="fan-muted-line">Автосообщений нет.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="data-table fan-table">
            <thead><tr><th scope="col">Когда</th><th scope="col">Задержка</th><th scope="col">Пауза</th><th scope="col">Текст</th></tr></thead>
            <tbody>
              {active.map((item: PagePromoResponse["automations"][number]) => (
                <tr key={item.automationRef}>
                  <td>
                    <div>{item.triggerType === null ? "—" : TRIGGERS[item.triggerType] ?? "Другое событие"}</div>
                    {item.tierName && <div className="fan-cell-sub">уровень {item.tierName}</div>}
                  </td>
                  <td>{delay(item.delaySeconds)}</td>
                  <td>{item.cooldownSeconds ? delay(item.cooldownSeconds) : <span className="text-text-muted">—</span>}</td>
                  <td className="mass-auto-text">
                    <span className="whitespace-pre-wrap">{item.messageText ?? ""}</span>
                    {item.attachmentCount > 0 && <span className="badge mass-attach">вложений: {item.attachmentCount}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** «Рассылки»: what mass messages brought, and what the page writes by itself. Reads only (§9.7). */
export function MassMessagesPage() {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  const label = decodeRouteSegment(pageLabel);
  const { search, update } = useListParams();
  const raw = search.get("list");
  const list: MassMessageList = LISTS.some((item) => item.value === raw) ? raw as MassMessageList : "all";
  const offset = listOffset(search.get("offset"));
  const query = usePageMassMessages(label, list, LIMIT, offset);
  const promo = usePagePromo(label);
  const data = query.data;

  return (
    <div className="pc-mass">
      {!data ? (
        query.isError ? <NoAnswerPanel retry={query.refetch} /> : <><StatCardSkeleton count={3} /><TableSkeleton rows={8} columns={7} /></>
      ) : (
        <>
          <div>
            <StatGrid className="mass-tiles">
              <Stat label="Заработали" value={formatMills(data.totals.salesNetMills)} meta={`${formatCount(data.totals.salesCount)} ${ruPlural(data.totals.salesCount, "продажа", "продажи", "продаж")}, чаевые ${formatMills(data.totals.tipsMills)}`} />
              <Stat label="Отправлено" value={formatCount(data.totals.sent)} meta={`${formatCount(data.total)} ${ruPlural(data.total, "рассылка", "рассылки", "рассылок")}`} />
              <Stat label="Прочитали" value={formatCount(data.totals.read)} meta={percent(data.totals.read, data.totals.sent) ?? "—"} />
            </StatGrid>
            <p className="fan-muted-line mass-note">После комиссии, как в статистике рассылок Fansly.</p>
          </div>
          <section className="card" aria-labelledby="mass-list-title">
            <div className="card-header">
              <h2 id="mass-list-title" className="card-title">Массовые рассылки</h2>
              <Segmented label="Список" value={list} onChange={(next) => update({ list: next === "all" ? null : next })} options={LISTS} />
            </div>
            <div className={`table-wrap ${query.isFetching && !query.isLoading ? "is-refreshing" : ""}`}>
              <table className="data-table fan-table mass-table">
                <thead>
                  <tr>
                    <th scope="col">Дата</th>
                    <th scope="col">Текст</th>
                    <th scope="col" className="num">Отправлено</th>
                    <th scope="col" className="num">Прочитали</th>
                    <th scope="col">Предложение</th>
                    <th scope="col" className="num">Продаж</th>
                    <th scope="col" className="num">Заработали</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && (
                    <tr><td colSpan={7} className="fan-empty-row"><div className="empty"><p className="empty-title">Рассылок в этом списке нет</p></div></td></tr>
                  )}
                  {data.rows.map((row) => {
                    const at = row.scheduledFor ?? row.createdAt;
                    const offer = [row.offeredMedia > 0 ? `медиа ${row.offeredMedia}` : null, row.offeredBundles > 0 ? `наборы ${row.offeredBundles}` : null].filter(Boolean).join(", ");
                    return (
                      <tr key={`${row.list}:${row.broadcastRef}`}>
                        <td>
                          <div>{at ? formatDate(at) : "—"}</div>
                          {list === "all" && LIST_NOTE[row.list] && <div className="fan-cell-sub">{LIST_NOTE[row.list]}</div>}
                        </td>
                        <td className="mass-text-cell"><TextCell text={row.text} /></td>
                        <td className="num">{row.sent === null ? "—" : formatCount(row.sent)}</td>
                        <td className="num">
                          <div>{row.read === null ? "—" : formatCount(row.read)}</div>
                          {percent(row.read, row.sent) && <div className="fan-cell-sub">{percent(row.read, row.sent)}</div>}
                        </td>
                        <td>
                          {offer === "" ? <span className="text-text-muted">—</span> : (
                            <>
                              <div className="mass-offer">{offer}</div>
                              {row.minPriceMills !== null && <div className="fan-cell-sub">{row.minPriceMills === row.maxPriceMills ? money(row.minPriceMills) : `${money(row.minPriceMills)}–${money(row.maxPriceMills)}`}</div>}
                            </>
                          )}
                        </td>
                        <td className="num">{row.salesCount === null ? "—" : formatCount(row.salesCount)}</td>
                        <td className="num">
                          <div>{money(row.salesNetMills)}</div>
                          {row.salesPendingMills ? <div className="fan-cell-sub">в холде {money(row.salesPendingMills)}</div> : null}
                          {row.tipsMills ? <div className="fan-cell-sub">чаевые {money(row.tipsMills)}</div> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {data.total > 0 && <Pagination offset={offset} limit={LIMIT} total={data.total} onPageChange={(next) => update({ offset: next === 0 ? null : String(next) })} />}
          </section>
        </>
      )}
      <Automations query={promo} />
    </div>
  );
}
