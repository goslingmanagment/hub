import { Bar, Card, EmptyState, ErrorState, Money, Skeleton } from "@agency_hub_core/ui";
import { formatCount, formatDayRange } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { PageChip } from "@/shared/PageChip";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { personSalesOf, usePersonStats, type PersonSales, type RateRow } from "./data.js";
import { capitalized, DELAY_WORDS, KIND_OF, periodWords, PRICE_WORDS, shareOf, shareText } from "./words.js";

/** A rate on fewer than this many is shown, but greyed: too few to trust. */
const WEAK_BASE = 10;

/**
 * «Продажи» (spec §4.4): what the person's money is made of, which prices and
 * which reply speeds sell — against the team on the same pages — and the fans
 * who brought the most. Bars are drawn to 100 %, so 14 % looks like 14 %.
 */
export function SalesTab({ userId, backLabel }: { userId: number; backLabel: string }) {
  const { period, today } = usePeriod();
  const { page } = usePageFilter();
  const { query, days, stats, stranger } = usePersonStats(userId, period, today);

  if (days === null) {
    return (
      <Card>
        <EmptyState title="Слишком давно">Продажи по фанам, ценам и скорости ответа Hub отдаёт только за последний 31 день.</EmptyState>
      </Card>
    );
  }
  if (query.isPending) return <SalesSkeleton />;
  if (query.isError) return <Card><ErrorState onRetry={() => void query.refetch()} retrying={query.isFetching} /></Card>;
  if (stranger || !stats) {
    return (
      <Card>
        <EmptyState title="Продаж не найдено">За последний 31 день {backLabel} не работал на ваших страницах.</EmptyState>
      </Card>
    );
  }

  const sales = personSalesOf(stats, period, today, page);
  if (sales.totalNetMills === 0 && sales.ppv.sent === 0 && sales.byDelay.every((row) => row.base === 0)) {
    return (
      <Card>
        <EmptyState title={`${capitalized(periodWords(period))} продаж не было`}>Здесь появятся деньги по видам, цены, скорость ответа и лучшие фаны.</EmptyState>
      </Card>
    );
  }
  // The price and speed buckets cannot be cut to a past period nor to one page: say what they are of, once.
  const caveat = [
    sales.wider ? `за ${formatDayRange(sales.wider.from, sales.wider.to)}: Hub считает их от первого дня периода до сегодня` : null,
    page ? "по всем страницам: Hub не делит их по страницам" : null,
  ].filter(Boolean).join("; ");

  return (
    <div className="people-grid">
      <Card title="Из чего продажи" description={`${capitalized(periodWords(period))}${page ? `, страница ${page}` : ""}`}>
        <Kinds sales={sales} />
      </Card>
      <Card
        title="Лучшие фаны"
        description={sales.fans && sales.fans.written > 0
          ? `Заплатили ${formatCount(sales.fans.paid)} из ${formatCount(sales.fans.written)} ${ruPlural(sales.fans.written, "фана", "фанов", "фанов")}, кому писал в сменах.`
          : "Кто больше всех принёс за смены периода."}
      >
        <Fans sales={sales} />
      </Card>
      {caveat && <p className="people-note people-grid__wide">Цена и скорость ответа — {caveat}.</p>}
      <Card title="Цена платных сообщений" description="Сколько из отправленных купили; черта — команда на тех же страницах.">
        <Rates rows={sales.byPrice} words={PRICE_WORDS} unit={["платное", "платных", "платных"]} empty="Личных платных сообщений не было." />
      </Card>
      <Card
        title="Скорость ответа и покупки"
        description="Купил ли фан в течение суток после ответа, по тому, как быстро ответили. Ответы последних суток ещё не считаются."
      >
        <Rates rows={sales.byDelay} words={DELAY_WORDS} unit={["ответ", "ответа", "ответов"]} empty="Ответов ждущим фанам не было." />
      </Card>
    </div>
  );
}

function Kinds({ sales }: { sales: PersonSales }) {
  if (sales.totalNetMills === 0) return <p className="people-note">Продаж не было.</p>;
  const shown = sales.byKind.filter((part) => part.netMills > 0);
  return (
    <>
      <div className="people-split" role="img" aria-label={shown.map((part) => `${KIND_OF[part.kind].label} ${shareText(shareOf(part.netMills, sales.totalNetMills))}`).join(", ")}>
        {shown.map((part) => (
          <span key={part.kind} style={{ flexGrow: part.netMills, background: KIND_OF[part.kind].color }} />
        ))}
      </div>
      <ul className="people-kinds">
        {sales.byKind.map((part) => (
          <li key={part.kind} className="people-kind">
            <span aria-hidden className="people-ribbon__key-bead" style={{ background: KIND_OF[part.kind].color }} />
            <span>{KIND_OF[part.kind].label}</span>
            <Money mills={part.netMills} muted={part.netMills === 0} />
            <span className="people-kind__share">{part.netMills > 0 ? shareText(shareOf(part.netMills, sales.totalNetMills)) : ""}</span>
          </li>
        ))}
        <li className="people-kind">
          <span />
          <span style={{ fontWeight: 600 }}>Всего</span>
          <Money mills={sales.totalNetMills} strong />
          <span />
        </li>
      </ul>
      {sales.pages.length > 1 && (
        <>
        <h3 className="people-subhead">По страницам</h3>
        <ul className="people-kinds" aria-label="По страницам">
          {sales.pages.map((one) => (
            <li key={one.pageLabel} className="people-kind">
              <span />
              <span><PageChip label={one.pageLabel} {...(one.platform ? { platform: one.platform } : {})} /></span>
              <Money mills={one.netMills} />
              <span className="people-kind__share">{shareText(shareOf(one.netMills, sales.totalNetMills))}</span>
            </li>
          ))}
        </ul>
        </>
      )}
    </>
  );
}

function Fans({ sales }: { sales: PersonSales }) {
  if (sales.topFans.length === 0) return <p className="people-note">За смены периода никто не платил.</p>;
  return (
    <ol className="people-fans">
      {sales.topFans.map((fan, index) => (
        <li key={`${fan.pageLabel}-${fan.fanName}`} className="people-fan">
          <span className="people-fan__rank">{index + 1}</span>
          <span className="people-fan__who">
            <span className="people-fan__name">{fan.fanName ?? "Фан без имени"}</span>
            <PageChip label={fan.pageLabel} />
          </span>
          <span className="people-fan__money">
            <Money mills={fan.netMills} strong />
            <span className="people-fan__count">{fan.sales} {ruPlural(fan.sales, "покупка", "покупки", "покупок")}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Rates({ rows, words, unit, empty }: { rows: readonly RateRow[]; words: Readonly<Record<string, string>>; unit: readonly [string, string, string]; empty: string }) {
  if (rows.every((row) => row.base === 0)) return <p className="people-note">{empty}</p>;
  return (
    <ul className="people-rates">
      {rows.map((row) => {
        const mine = shareOf(row.hits, row.base);
        const team = shareOf(row.teamHits, row.teamBase);
        const weak = row.base < WEAK_BASE;
        return (
          <li key={row.key} className="people-rate">
            <span className="people-rate__label">{words[row.key] ?? row.key}</span>
            <Bar
              value={mine ?? 0}
              compare={team}
              tone={weak ? "muted" : "neutral"}
              label={mine === null ? undefined : `${shareText(mine)} купили${team === null ? "" : `, команда ${shareText(team)}`}`}
            />
            <span className="people-rate__value" data-weak={weak || undefined} title={weak ? "Мало данных: на такой выборке процент случаен" : undefined}>
              {mine === null ? "—" : shareText(mine)}
            </span>
            <span className="people-rate__detail">
              {row.base === 0 ? `не было` : `${formatCount(row.hits)} из ${formatCount(row.base)} ${ruPlural(row.base, ...unit)}`}
              {team !== null && <span className="people-rate__team">команда {shareText(team)}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function SalesSkeleton() {
  return (
    <div className="people-grid" aria-busy>
      {Array.from({ length: 4 }, (_, index) => (
        <Card key={index} title={<Skeleton width={180} />}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {Array.from({ length: 5 }, (_, line) => <Skeleton key={line} width="100%" height={20} />)}
          </div>
        </Card>
      ))}
    </div>
  );
}
