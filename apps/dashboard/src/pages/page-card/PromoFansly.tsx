import { useParams } from "react-router";
import type { PagePromoResponse } from "@agency_hub_core/contracts";
import { usePagePromo } from "@/api/page-promo";
import { ChartTable } from "@/components/charts/ChartTable";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatBusinessDateShort, formatCount, formatDate, formatDayRange, formatMills } from "@/lib/format";
import { decodeRouteSegment } from "@/lib/navigation";
import { ruPlural } from "@/lib/plural";
import { formatMonth } from "@/components/creator-stats/creator-stats-model";

type Promo = PagePromoResponse;

const LINK_COLORS = ["var(--color-chart-blue)", "var(--color-chart-orange)", "var(--color-chart-aqua)", "var(--color-chart-violet)", "var(--color-chart-magenta)"];

function money(value: number | null): string {
  return value === null ? "—" : formatMills(value);
}

function count(value: number | null): string {
  return value === null ? "—" : formatCount(value);
}

function day(iso: string | null): string {
  return iso ? formatDate(iso, { includeYear: true }) : "—";
}

function topPercent(value: number): string {
  return `топ\u00A0${value.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}\u00A0%`;
}

function duration(days: number | null): string {
  if (days === null) return "—";
  if (days === 365) return "12 месяцев";
  if (days % 30 === 0) {
    const months = Math.round(days / 30);
    return `${months} ${ruPlural(months, "месяц", "месяца", "месяцев")}`;
  }
  return `${days} ${ruPlural(days, "день", "дня", "дней")}`;
}

function plus(value: number | null, one: string, few: string, many: string): string | null {
  if (value === null || value === 0) return null;
  return `${value > 0 ? "+" : ""}${formatCount(value)} ${ruPlural(Math.abs(value), one, few, many)}`;
}

function Growth({ growth }: { growth: Promo["trackingLinks"][number]["last7"] }) {
  if (growth === null) return <span className="text-text-muted">—</span>;
  const first = plus(growth.follows, "фоллов", "фоллова", "фолловов");
  const more = [
    plus(growth.subscriptions, "подписка", "подписки", "подписок"),
    growth.grossMills ? `+${formatMills(growth.grossMills)}` : null,
  ].filter(Boolean);
  const parts = first ? [first, more.join(", ")] : more;
  return parts.every((part) => !part) ? <span className="text-text-muted">без изменений</span> : <>{parts.filter(Boolean).map((part, index) => <div key={index} className={index === 0 ? "whitespace-nowrap" : "fan-cell-sub whitespace-nowrap"}>{part}</div>)}</>;
}

/** Subscriptions a day over the last 90 days: the five links that brought the most, the rest together. */
function linkDays(days: Promo["trackingDays"], links: Promo["trackingLinks"]) {
  if (days.length === 0) return null;
  const totals = new Map<string, number>();
  for (const row of days) totals.set(row.linkRef, (totals.get(row.linkRef) ?? 0) + (row.subscriptions ?? 0));
  const top = [...totals.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ref]) => ref);
  if (top.length === 0) return null;
  const label = new Map(links.map((link) => [link.linkRef, link.label ?? "без названия"]));
  const first = new Date(`${days[0]!.day}T00:00:00Z`).getTime();
  const last = new Date(`${days.at(-1)!.day}T00:00:00Z`).getTime();
  const rows: Array<Record<string, string | number>> = [];
  for (let at = first; at <= last; at += 86_400_000) {
    const point: Record<string, string | number> = { day: new Date(at).toISOString().slice(0, 10), other: 0 };
    for (const ref of top) point[ref] = 0;
    rows.push(point);
  }
  const byDay = new Map(rows.map((row) => [row.day as string, row]));
  for (const row of days) {
    const point = byDay.get(row.day);
    if (point === undefined) continue;
    const key = top.includes(row.linkRef) ? row.linkRef : "other";
    point[key] = (point[key] as number) + (row.subscriptions ?? 0);
  }
  const series = [
    ...top.map((ref, index) => ({ key: ref, label: label.get(ref) ?? ref, color: LINK_COLORS[index]! })),
    ...(rows.some((row) => (row.other as number) > 0) ? [{ key: "other", label: "Остальные", color: "var(--color-chart-lime)" }] : []),
  ];
  return { rows, series };
}

function TrackingLinks({ links, days }: { links: Promo["trackingLinks"]; days: Promo["trackingDays"] }) {
  const live = links.filter((link) => link.missingSince === null);
  const chart = linkDays(days, live);
  return (
    <section className="card" aria-labelledby="promo-tracking-title">
      <div className="card-header">
        <div>
          <h2 id="promo-tracking-title" className="card-title">Трекинг-ссылки</h2>
          <p className="card-description">Всего с создания ссылки и прирост за 7 и 30 дней. Доход — до комиссии: после комиссии Fansly по ссылкам не отдаёт.</p>
        </div>
      </div>
      {live.length === 0 ? <div className="card-body"><p className="fan-muted-line">Трекинг-ссылок нет.</p></div> : (
        <>
          {chart && (
            <div className="card-body promo-chart">
              <h3 className="fan-subtitle">Подписки по ссылкам за день, последние 90 дней</h3>
              <StackedBarChart title="" data={chart.rows} xKey="day" series={chart.series} xTickFormatter={formatBusinessDateShort} valueFormatter={(value) => formatCount(value)} height={220} />
              <ChartTable
                rows={chart.rows}
                rowKey={(row) => String(row.day)}
                caption="Подписки по ссылкам за день"
                columns={[
                  { key: "day", label: "День", value: (row) => formatBusinessDateShort(String(row.day)) },
                  ...chart.series.map((series) => ({ key: series.key, label: series.label, num: true, value: (row: Record<string, string | number>) => formatCount(Number(row[series.key] ?? 0)) })),
                ]}
              />
            </div>
          )}
          <div className="table-wrap">
            <table className="data-table fan-table">
              <thead>
                <tr>
                  <th scope="col">Ссылка</th>
                  <th scope="col" className="num">Клики</th>
                  <th scope="col" className="num">Фолловы</th>
                  <th scope="col" className="num">Подписки</th>
                  <th scope="col" className="num">До комиссии</th>
                  <th scope="col">За 7 дней</th>
                  <th scope="col">За 30 дней</th>
                </tr>
              </thead>
              <tbody>
                {live.map((link) => (
                  <tr key={link.linkRef}>
                    <td>
                      <div>{link.label ?? "без названия"}{link.linkType === 1 && <span className="badge promo-badge">Fansly</span>}</div>
                      {link.createdAt && <div className="fan-cell-sub">с {day(link.createdAt)}</div>}
                    </td>
                    <td className="num">
                      <div>{count(link.clicks)}</div>
                      {link.claims !== null && <div className="fan-cell-sub">визитов {formatCount(link.claims)}</div>}
                    </td>
                    <td className="num">{count(link.follows)}</td>
                    <td className="num">{count(link.subscriptions)}</td>
                    <td className="num">{money(link.grossMills)}</td>
                    <td><Growth growth={link.last7} /></td>
                    <td><Growth growth={link.last30} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function GiftLinks({ links }: { links: Promo["giftLinks"] }) {
  const active = links.filter((link) => link.missingSince === null && link.status === 1);
  const ended = links.length - active.length;
  return (
    <section className="card" aria-labelledby="promo-gift-title">
      <div className="card-header">
        <div>
          <h2 id="promo-gift-title" className="card-title">Подарочные ссылки</h2>
          <p className="card-description">Скидочные и бесплатные ссылки на подписку. Активных {active.length}, завершённых или удалённых {ended}.</p>
        </div>
      </div>
      {active.length === 0 ? <div className="card-body"><p className="fan-muted-line">Активных подарочных ссылок нет.</p></div> : (
        <div className="table-wrap">
          <table className="data-table fan-table">
            <thead><tr><th scope="col">Ссылка</th><th scope="col" className="num">Цена</th><th scope="col">Срок</th><th scope="col" className="num">Использовано</th><th scope="col">Действует</th></tr></thead>
            <tbody>
              {active.map((link) => (
                <tr key={link.linkRef}>
                  <td>
                    <div>{link.label ?? "без названия"}</div>
                    {link.newSubscribersOnly && <div className="fan-cell-sub">только новым</div>}
                  </td>
                  <td className="num">
                    <div>{link.priceMills === 0 ? "бесплатно" : money(link.priceMills)}</div>
                    {link.originalPriceMills !== null && link.originalPriceMills !== link.priceMills && <div className="fan-cell-sub line-through">{money(link.originalPriceMills)}</div>}
                  </td>
                  <td>{duration(link.durationDays)}</td>
                  <td className="num">{count(link.uses)}{link.maxUses ? ` из ${formatCount(link.maxUses)}` : ""}</td>
                  <td>{link.startsAt && link.endsAt ? formatDayRange(link.startsAt, link.endsAt) : link.endsAt ? `до ${day(link.endsAt)}` : "без срока"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Tiers({ tiers }: { tiers: Promo["tiers"] }) {
  const live = tiers.filter((tier) => tier.missingSince === null);
  return (
    <section className="card" aria-labelledby="promo-tiers-title">
      <div className="card-header">
        <div>
          <h2 id="promo-tiers-title" className="card-title">Цены и промо</h2>
          <p className="card-description">Уровни подписки, цены на 1–12 месяцев и скидки на них.</p>
        </div>
      </div>
      <div className="card-body promo-tiers">
        {live.length === 0 ? <p className="fan-muted-line">Уровней подписки Fansly не прислал.</p> : live.map((tier) => (
          <div key={tier.tierRef} className="promo-tier">
            <p className="promo-tier-name">
              {tier.name ?? "Уровень"}
              {tier.maxSubscribers ? <span className="fan-cell-sub"> · до {formatCount(tier.maxSubscribers)} подписчиков</span> : null}
            </p>
            {tier.benefits.length > 0 && <p className="fan-cell-sub">{tier.benefits.join(" · ")}</p>}
            <table className="promo-plans">
              <tbody>
                {tier.plans.filter((plan) => plan.missingSince === null).map((plan) => (
                  <tr key={plan.planRef}>
                    <td>{duration(plan.durationDays)}</td>
                    <td className="num">{money(plan.priceMills)}</td>
                    <td className="promo-plan-promo">
                      {plan.promotions.map((promo, index) => (
                        <span key={promo.promoRef ?? index}>
                          {[
                            `Промо ${money(promo.priceMills)}${promo.durationDays ? ` на ${duration(promo.durationDays)}` : ""}`,
                            promo.startsAt && promo.endsAt ? formatDayRange(promo.startsAt, promo.endsAt) : null,
                            promo.newSubscribersOnly ? "только новым" : null,
                            promo.maxUses ? `до ${formatCount(promo.maxUses)} раз` : null,
                            promo.description,
                          ].filter(Boolean).join(", ")}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}

function Rank({ months, current }: { months: Promo["months"]; current: Promo["currentRank"] }) {
  const ranked = months.filter((row) => row.topPercent !== null && row.topPercent > 0).slice(0, 18);
  return (
    <section className="card" aria-labelledby="promo-rank-title">
      <div className="card-header">
        <div>
          <h2 id="promo-rank-title" className="card-title">Место среди авторов</h2>
          <p className="card-description">Топ X % авторов Fansly: чем меньше, тем выше страница.</p>
        </div>
      </div>
      {ranked.length === 0 && current?.topPercent == null ? <div className="card-body"><p className="fan-muted-line">Fansly не прислал места.</p></div> : (
        <>
          {current?.topPercent != null && (
            <p className="promo-rank-now">
              Последние 30 дней: {topPercent(current.topPercent)}, {money(current.netMills)} после комиссии, {money(current.grossMills)} до комиссии
            </p>
          )}
          <div className="table-wrap">
            <table className="data-table fan-table">
              <thead><tr><th scope="col">Месяц</th><th scope="col">Место</th><th scope="col" className="num">После комиссии</th><th scope="col" className="num">До комиссии</th></tr></thead>
              <tbody>
                {ranked.map((row) => (
                  <tr key={`${row.year}-${row.month}`}>
                    <td className="whitespace-nowrap">{formatMonth(row.year, row.month)}</td>
                    <td className="whitespace-nowrap">{topPercent(row.topPercent!)}</td>
                    <td className="num">{money(row.netMills)}</td>
                    <td className="num muted">{money(row.grossMills)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** «Продвижение» of a Fansly page: links, prices and promotions, the rank. Reads only (§9.5). */
export function PromoFansly() {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  const query = usePagePromo(decodeRouteSegment(pageLabel));
  if (!query.data) {
    return query.isError ? <NoAnswerPanel retry={query.refetch} /> : <div className="pc-promo"><TableSkeleton rows={6} columns={7} /><TableSkeleton rows={3} columns={5} /></div>;
  }
  const data = query.data;
  return (
    <div className="pc-promo">
      <TrackingLinks links={data.trackingLinks} days={data.trackingDays} />
      <GiftLinks links={data.giftLinks} />
      <div className="promo-grid">
        <Tiers tiers={data.tiers} />
        <Rank months={data.months} current={data.currentRank} />
      </div>
    </div>
  );
}
