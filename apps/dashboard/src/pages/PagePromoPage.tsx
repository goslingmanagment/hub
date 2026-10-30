import { useParams } from "react-router";
import type { PagePromoResponse } from "@agency_hub_core/contracts";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import { usePagePromo } from "@/api/page-promo";
import { AnalyticsEmpty, AnalyticsError, AnalyticsLoading, AnalyticsPanel } from "@/components/analytics/AnalyticsPanel";
import { DayChart } from "@/components/creator-stats/DayChart";
import type { DayPoint } from "@/components/creator-stats/creator-stats-model";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatDate } from "@/lib/format";

/**
 * What the page sells and how, as Fansly's creator pages show it: the place
 * among creators per month («Top X%»), the tiers with their plans and
 * promotions, the tracking links (with what they brought in 7 and 30 days),
 * the gift links, the yearly Recap and the polls. Fansly only; the daily
 * lanes have collected all of it since 2026-08.
 */

type Promo = PagePromoResponse;

const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function money(value: number | null): string {
  return value === null ? "—" : formatUsdFromMills(value);
}

function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("ru-RU");
}

function plus(value: number | null): string {
  if (value === null) return "—";
  return value > 0 ? `+${value.toLocaleString("ru-RU")}` : value.toLocaleString("ru-RU");
}

function months(days: number | null): string {
  if (days === null) return "—";
  if (days % 30 === 0 || days === 365) return days === 365 ? "12 мес" : `${Math.round(days / 30)} мес`;
  return `${days} дн`;
}

function day(iso: string | null): string {
  return iso ? formatDate(iso, { includeYear: true }) : "—";
}

function topLabel(value: number): string {
  return `Top ${value.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`;
}

function Rank({ months: rows, current }: { months: Promo["months"]; current: Promo["currentRank"] }) {
  const ranked = rows.filter((row) => row.topPercent !== null && row.topPercent > 0).slice(0, 18);
  return (
    <AnalyticsPanel title="Место среди авторов" description="«Top X%» Fansly: чем меньше, тем выше страница среди всех авторов.">
      {ranked.length === 0 && current?.topPercent == null ? <AnalyticsEmpty reason="Fansly не прислал места." /> : (
        <div className="card-body overflow-x-auto">
          {current?.topPercent != null ? (
            <p className="mb-3">
              Последние 30 дней: <span className="badge badge-success">{topLabel(current.topPercent)}</span>
              <span className="ml-2 text-sm text-muted">доход {money(current.grossMills)} грязными, {money(current.netMills)} чистыми</span>
            </p>
          ) : null}
          <table className="data-table">
            <thead><tr><th>Месяц</th><th>Место</th><th>Доход (грязными)</th><th>Чистыми</th></tr></thead>
            <tbody>
              {ranked.map((row) => (
                <tr key={`${row.year}-${row.month}`}>
                  <td>{MONTHS[row.month - 1] ?? row.month} {row.year}</td>
                  <td><span className="badge badge-success">{topLabel(row.topPercent!)}</span></td>
                  <td>{money(row.grossMills)}</td>
                  <td>{money(row.netMills)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

function Tiers({ tiers }: { tiers: Promo["tiers"] }) {
  const live = tiers.filter((tier) => tier.missingSince === null);
  return (
    <AnalyticsPanel title="Тиры, цены и промо" description="Тиры подписки, цены планов на 1–12 месяцев и скидки на них.">
      {live.length === 0 ? <AnalyticsEmpty reason="Тиров Fansly не прислал." /> : (
        <div className="card-body space-y-4">
          {live.map((tier) => (
            <div key={tier.tierRef}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full" style={{ background: tier.color ?? "var(--color-border)" }} aria-hidden="true" />
                <span className="font-medium">{tier.name ?? "Тир"}</span>
                {tier.maxSubscribers ? <span className="text-sm text-muted">до {tier.maxSubscribers} подписчиков</span> : null}
              </div>
              {tier.benefits.length > 0 ? <p className="mt-0.5 text-sm text-muted">{tier.benefits.join(" · ")}</p> : null}
              <ul className="mt-1 space-y-1 text-sm">
                {tier.plans.filter((plan) => plan.missingSince === null).map((plan) => (
                  <li key={plan.planRef}>
                    {months(plan.durationDays)} — <span className="font-medium">{money(plan.priceMills)}</span>
                    {plan.promotions.map((promo, index) => (
                      <span key={promo.promoRef ?? index} className="ml-2">
                        <span className="badge badge-warning">промо {money(promo.priceMills)}{promo.durationDays ? ` на ${promo.durationDays} дн` : ""}</span>
                        <span className="ml-1 text-muted">
                          {promo.startsAt || promo.endsAt ? `${day(promo.startsAt)} — ${day(promo.endsAt)}` : ""}
                          {promo.newSubscribersOnly ? " · только новым" : ""}
                          {promo.maxUses ? ` · до ${promo.maxUses} раз` : ""}
                          {promo.description ? ` · ${promo.description}` : ""}
                        </span>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </AnalyticsPanel>
  );
}

type LinkGrowth = Promo["trackingLinks"][number]["last7"];

function Growth({ growth }: { growth: LinkGrowth }) {
  if (growth === null) return <>—</>;
  return (
    <>
      {plus(growth.follows)} фоллоу · {plus(growth.subscriptions)} подп.
      {growth.grossMills ? <div className="text-xs text-muted">+{money(growth.grossMills)}</div> : null}
    </>
  );
}

const LINK_COLORS = ["var(--color-chart-blue)", "var(--color-chart-magenta)", "var(--color-chart-orange)", "var(--color-chart-green)", "var(--color-chart-violet)"];

/** Subscriptions a day over the last 90 days: the five links that brought the
 *  most, the rest together. A day the history covers without a row is a zero. */
function LinkDaysChart({ days, links }: { days: Promo["trackingDays"]; links: Promo["trackingLinks"] }) {
  if (days.length === 0) return null;
  const totals = new Map<string, number>();
  for (const row of days) totals.set(row.linkRef, (totals.get(row.linkRef) ?? 0) + (row.subscriptions ?? 0));
  const top = [...totals.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ref]) => ref);
  if (top.length === 0) return null;
  const label = new Map(links.map((link) => [link.linkRef, link.label ?? "без названия"]));
  const first = new Date(`${days[0]!.day}T00:00:00Z`).getTime();
  const last = new Date(`${days.at(-1)!.day}T00:00:00Z`).getTime();
  const rows: DayPoint[] = [];
  for (let at = first; at <= last; at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    const point: DayPoint = { bucketStart: day, other: 0 };
    for (const ref of top) point[ref] = 0;
    rows.push(point);
  }
  const byDay = new Map(rows.map((row) => [row.bucketStart, row]));
  for (const row of days) {
    const point = byDay.get(row.day);
    if (point === undefined) continue;
    const key = top.includes(row.linkRef) ? row.linkRef : "other";
    point[key] = (point[key] as number) + (row.subscriptions ?? 0);
  }
  const series = [
    ...top.map((ref, index) => ({ key: ref, label: label.get(ref) ?? ref, color: LINK_COLORS[index]! })),
    ...(rows.some((row) => (row.other as number) > 0) ? [{ key: "other", label: "Остальные", color: "var(--color-chart-aqua)" }] : []),
  ];
  return (
    <div className="mb-4">
      <div className="mb-1 text-sm text-muted">Подписки по ссылкам за день, последние 90 дней</div>
      <DayChart rows={rows} series={series} />
    </div>
  );
}

function TrackingLinks({ links, days }: { links: Promo["trackingLinks"]; days: Promo["trackingDays"] }) {
  const live = links.filter((link) => link.missingSince === null);
  return (
    <AnalyticsPanel title="Трекинг-ссылки" description="Всего с создания ссылки и прирост за 7 и 30 дней (по ежедневным снимкам). Доход — грязными: чистый Fansly по ссылкам не отдаёт. Fansly FYP / Suggestions / Search — встроенные ссылки Fansly.">
      {live.length === 0 ? <AnalyticsEmpty reason="Трекинг-ссылок нет." /> : (
        <div className="card-body overflow-x-auto">
          <LinkDaysChart days={days} links={live} />
          <table className="data-table">
            <thead>
              <tr><th>Ссылка</th><th>Клики</th><th>Заходы</th><th>Фоллоу</th><th>Подписки</th><th>Доход (грязными)</th><th>За 7 дней</th><th>За 30 дней</th></tr>
            </thead>
            <tbody>
              {live.map((link) => (
                <tr key={link.linkRef}>
                  <td>
                    {link.label ?? "без названия"}
                    {link.linkType === 1 ? <span className="badge ml-2">Fansly</span> : null}
                    {link.createdAt ? <div className="text-xs text-muted">с {day(link.createdAt)}</div> : null}
                  </td>
                  <td>{count(link.clicks)}</td>
                  <td>{count(link.claims)}</td>
                  <td>{count(link.follows)}</td>
                  <td>{count(link.subscriptions)}</td>
                  <td>{money(link.grossMills)}</td>
                  <td className="whitespace-nowrap text-sm"><Growth growth={link.last7} /></td>
                  <td className="whitespace-nowrap text-sm"><Growth growth={link.last30} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

function GiftLinks({ links }: { links: Promo["giftLinks"] }) {
  const active = links.filter((link) => link.missingSince === null && link.status === 1);
  const ended = links.length - active.length;
  return (
    <AnalyticsPanel title="Гифт-ссылки" description={`Скидочные и бесплатные ссылки на подписку. Активных ${active.length}, завершённых или удалённых ${ended}.`}>
      {active.length === 0 ? <AnalyticsEmpty reason="Активных гифт-ссылок нет." /> : (
        <div className="card-body overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>Ссылка</th><th>Цена</th><th>Срок</th><th>Использовано</th><th>Действует</th></tr></thead>
            <tbody>
              {active.map((link) => (
                <tr key={link.linkRef}>
                  <td>{link.label ?? "без названия"}{link.newSubscribersOnly ? <div className="text-xs text-muted">только новым</div> : null}</td>
                  <td>
                    {link.priceMills === 0 ? "бесплатно" : money(link.priceMills)}
                    {link.originalPriceMills && link.originalPriceMills !== link.priceMills ? <div className="text-xs text-muted line-through">{money(link.originalPriceMills)}</div> : null}
                  </td>
                  <td>{link.durationDays === null ? "—" : `${link.durationDays} дн`}</td>
                  <td>{count(link.uses)}{link.maxUses ? ` из ${link.maxUses}` : ""}</td>
                  <td className="whitespace-nowrap text-sm">{link.startsAt || link.endsAt ? `${day(link.startsAt)} — ${day(link.endsAt)}` : "без срока"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

const RECAP_LABELS: Record<string, string> = {
  highest_earning_day: "Лучший день",
  highest_earning_month: "Лучший месяц",
  highest_earning_fan: "Больше всех принёс фан",
  top_earned_by_category: "Доход по видам",
  top_earn_position: "Место по доходу",
  fyp_stats: "For You",
  fyp_top_media: "Лучшее медиа в For You",
  fyp_impact_percent: "Вклад For You",
  discovery_stats: "Откуда пришли",
  follower_country_count: "Страны фолловеров",
  model_sub_follow_gains: "Прирост",
  model_total_uploaded: "Загружено",
};

/** A Recap value (JSON as served) as short `key: value` pairs. */
function recapText(value: string | null): string {
  if (value === null) return "—";
  try {
    const flat: string[] = [];
    const walk = (node: unknown, prefix: string) => {
      if (node !== null && typeof node === "object" && !Array.isArray(node)) {
        for (const [key, child] of Object.entries(node as Record<string, unknown>)) walk(child, prefix ? `${prefix}.${key}` : key);
      } else if (!/(^|\.)id$/.test(prefix)) {
        flat.push(`${prefix}: ${typeof node === "number" ? node.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) : String(node)}`);
      }
    };
    walk(JSON.parse(value), "");
    return flat.join(" · ");
  } catch {
    return value;
  }
}

function Recap({ recap }: { recap: Promo["recap"] }) {
  const years = [...new Set(recap.map((row) => row.year))];
  return (
    <AnalyticsPanel title="Recap Fansly" description="Годовые итоги, которые Fansly показывает автору.">
      {recap.length === 0 ? <AnalyticsEmpty reason="Recap Fansly не прислал." /> : (
        <div className="card-body space-y-3">
          {years.map((year) => (
            <div key={year}>
              <div className="font-medium">{year}</div>
              <ul className="mt-1 space-y-0.5 text-sm">
                {recap.filter((row) => row.year === year).map((row) => (
                  <li key={row.statRef}><span className="text-muted">{RECAP_LABELS[row.statName] ?? row.statName}:</span> {recapText(row.value)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </AnalyticsPanel>
  );
}

function Polls({ polls }: { polls: Promo["polls"] }) {
  return (
    <AnalyticsPanel title="Опросы" description={`Опросы в постах страницы: ${polls.length}.`}>
      {polls.length === 0 ? <AnalyticsEmpty reason="Опросов нет." /> : (
        <div className="card-body space-y-3">
          {polls.slice(0, 20).map((poll) => {
            const total = poll.options.reduce((sum, option) => sum + (option.votes ?? 0), 0);
            return (
              <div key={poll.pollRef}>
                <div className="font-medium">{poll.title || "Без названия"} <span className="text-sm text-muted">{day(poll.createdAt)} · голосов {total}</span></div>
                <ul className="mt-1 space-y-0.5 text-sm">
                  {poll.options.map((option, index) => (
                    <li key={index}>{option.title ?? "—"} — {option.votes ?? 0}{total > 0 ? ` (${Math.round(((option.votes ?? 0) / total) * 100)}%)` : ""}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </AnalyticsPanel>
  );
}

export function PagePromoPage() {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  const query = usePagePromo(pageLabel);
  if (query.isPending) return <AnalyticsLoading what="Загружаем промо…" />;
  if (query.isError || !query.data) return <AnalyticsError message="Не удалось загрузить промо." onRetry={() => void query.refetch()} />;
  const data = query.data;
  if (data.page.platform !== "fansly") return <StatusPanel title="Промо собирается только у страниц Fansly" />;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Rank months={data.months} current={data.currentRank} />
        <Tiers tiers={data.tiers} />
      </div>
      <TrackingLinks links={data.trackingLinks} days={data.trackingDays} />
      <GiftLinks links={data.giftLinks} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Recap recap={data.recap} />
        <Polls polls={data.polls} />
      </div>
    </div>
  );
}
