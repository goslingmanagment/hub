import { Button, Card, EmptyState, ErrorState, Fan, Money, PageLabel, RateBar, Skeleton } from "@agency_hub_core/ui";
import { formatCount, formatDayRange } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { personSalesOf, usePersonRates, usePersonStats, type PersonSales, type RateRow, type ReadState } from "./data.js";
import { capitalized, DELAY_WORDS, KIND_OF, periodWords, PRICE_WORDS, shareOf, shareText } from "./words.js";

/**
 * «Продажи» (spec §4.4): what the person's money is made of, the fans who
 * brought the most, which prices and which reply speeds sell — the last two
 * exactly as «Что продаёт» shows this chatter (X1: the same window, the same
 * comparison with everyone together, the same small-sample rule). Bars are
 * drawn to 100 %, so 14 % looks like 14 %.
 */
export function SalesTab({ userId, name }: { userId: number; name: string }) {
  const { period, today } = usePeriod();
  const { page } = usePageFilter();
  const { query, days, stats, stranger } = usePersonStats(userId, period, today);
  const rates = usePersonRates(userId, period, today, page);

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
        <EmptyState title="Продаж не найдено">За последний 31 день у {name} не было смен на ваших страницах.</EmptyState>
      </Card>
    );
  }

  const sales = personSalesOf(stats, period, page);
  const sent = (rates.byPrice ?? []).reduce((sum, row) => sum + row.base, 0);
  const replied = (rates.byDelay ?? []).reduce((sum, row) => sum + row.base, 0);
  if (sales.totalNetMills === 0 && rates.byPrice !== null && rates.byDelay !== null && sent === 0 && replied === 0) {
    return (
      <Card>
        <EmptyState title={`${capitalized(periodWords(period))} продаж не было`}>Здесь появятся деньги по видам, цены, скорость ответа и лучшие фаны.</EmptyState>
      </Card>
    );
  }
  // What the price and speed blocks are of, once: the person's numbers are every page's; part of an old period may be out of reach.
  const scope = [
    page ? `${name}: по всем страницам (Hub не делит чаттера по страницам), черта: команда на ${page}` : null,
    rates.window.clipped || !rates.window.exact ? `за ${formatDayRange(rates.window.from, rates.window.to)}: дальше Hub не читает` : null,
  ].filter(Boolean).join("; ");

  return (
    <div className="people-grid">
      <Card title="Из чего продажи" description={`${capitalized(periodWords(period))}${page ? `, страница ${page}` : ""}`}>
        <Kinds sales={sales} />
      </Card>
      <Card
        title="Лучшие фаны"
        description={sales.fans && sales.fans.written > 0
          ? `В сменах ${formatCount(sales.fans.written)} ${ruPlural(sales.fans.written, "переписка", "переписки", "переписок")} с фанами${page ? " на всех страницах" : ""}, в ${formatCount(sales.fans.paid)} из них фан заплатил.`
          : "Кто больше всех принёс за смены периода."}
      >
        <Fans sales={sales} />
      </Card>
      {scope && <p className="people-note people-grid__wide">Цена и скорость ответа: {scope}.</p>}
      <Card title="Цена платных сообщений" description="Сколько из отправленных купили. Черта: вся команда, как в «Что продаёт».">
        <Rates
          rows={rates.byPrice}
          state={rates.price}
          min={rates.min.ppv}
          words={PRICE_WORDS}
          unit={["платного", "платных", "платных"]}
          empty="Личных платных сообщений не было."
          onRetry={rates.retry}
        />
      </Card>
      <Card
        title="Скорость ответа и покупки"
        description="Купил ли фан в течение суток после ответа, по тому, как быстро ответили. Ответы последних суток ещё не считаются."
      >
        <Rates
          rows={rates.byDelay}
          state={rates.speed}
          min={rates.min.replies}
          words={DELAY_WORDS}
          unit={["ответа", "ответов", "ответов"]}
          empty="Ответов ждущим фанам не было."
          onRetry={rates.retry}
        />
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
        <li className="people-kind people-kind--total">
          <span />
          <span>Всего</span>
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
                <PageLabel label={one.pageLabel} platform={one.platform} className="people-kind__page" />
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
            {fan.fanName
              ? <Fan name={fan.fanName} fanRef={`${fan.pageLabel}:${fan.fanName}`} className="people-fan__name" />
              : <span className="people-fan__name people-fan__name--unknown">фан без имени</span>}
            <PageLabel label={fan.pageLabel} />
          </span>
          <span className="people-fan__count">{fan.sales} {ruPlural(fan.sales, "покупка", "покупки", "покупок")}</span>
          <Money mills={fan.netMills} strong />
        </li>
      ))}
      {sales.restFans.count > 0 && (
        <li className="people-fan people-fan--rest">
          <span />
          <span className="people-fan__who">
            Ещё {sales.restFans.count} {ruPlural(sales.restFans.count, "фан", "фана", "фанов")}
          </span>
          <span />
          <Money mills={sales.restFans.netMills} />
        </li>
      )}
    </ol>
  );
}

/** Each bucket: its words, a bar to 100 % with everyone's tick, the share — pale «4 из 14» on a small sample — and everyone's share in words. */
function Rates({ rows, state, min, words, unit, empty, onRetry }: {
  rows: readonly RateRow[] | null;
  state: ReadState;
  min: number;
  words: Readonly<Record<string, string>>;
  unit: readonly [string, string, string];
  empty: string;
  onRetry: () => void;
}) {
  if (state === "off") return <p className="people-note">Hub отдаёт эти числа только за последний 31 день.</p>;
  if (rows === null) {
    if (state === "failed") {
      return (
        <div className="people-rates-failed">
          <p className="people-note">Не пришли: Hub не ответил. Это не ноль.</p>
          <Button size="sm" onClick={onRetry}>Повторить</Button>
        </div>
      );
    }
    return (
      <div className="people-skeleton-lines" aria-busy>
        {Array.from({ length: 5 }, (_, line) => <Skeleton key={line} width="100%" height={20} />)}
      </div>
    );
  }
  if (rows.every((row) => row.base === 0)) return <p className="people-note">{empty}</p>;
  return (
    <ul className="people-rates">
      {rows.map((row) => {
        const team = shareOf(row.teamHits, row.teamBase);
        const mine = shareOf(row.hits, row.base);
        const label = words[row.key] ?? row.label;
        return (
          <li key={row.key} className="people-rate">
            <span className="people-rate__label">{label}</span>
            <RateBar
              hits={row.hits}
              of={row.base}
              min={min}
              compare={team}
              compareLabel="вся команда"
              empty="—"
              emptyHint="Таких не было"
              detail={team === null ? null : `команда ${shareText(team)}`}
              detailWidth={120}
              hint={mine === null ? undefined : `${label}: купили ${formatCount(row.hits)} из ${formatCount(row.base)} ${ruPlural(row.base, ...unit)}, ${shareText(mine)}${team === null ? "" : `; вся команда: ${shareText(team)}`}${row.base < min ? `. Меньше ${min}: мало, чтобы судить` : ""}`}
            />
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
          <div className="people-skeleton-lines">
            {Array.from({ length: 5 }, (_, line) => <Skeleton key={line} width="100%" height={20} />)}
          </div>
        </Card>
      ))}
    </div>
  );
}
