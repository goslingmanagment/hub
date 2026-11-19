import type { ChatterStats, KernelOperationResponse } from "@agency_hub_core/contracts";
import { Card, Money, Skeleton, Tooltip } from "@agency_hub_core/ui";
import { formatCount, formatDuration, formatMills, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { KINDS, KIND_OF, capitalized, shareOf, shareText } from "@agency_hub_core/ui/people/words";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { SaleKinds, TopFans } from "@/shared/SalesParts";
import { Tiles, TilesSkeleton, type Tile } from "@/shared/Tiles";
import { KIND_SHORT } from "./model";

/**
 * «Мои смены»: the period in numbers, above the shifts — what a lead's card of the person shows them («Команда →
 * Работа, Продажи»), from the person's own reads, drawn by the same blocks (shared/Tiles.tsx, shared/SalesParts.tsx):
 *   - the tiles: PPV sent and bought and their average price, the fans who paid (`accountShiftNumbers`, the person's,
 *     all pages: the same read as each card's numbers); the best shift, the biggest sale and the days in a row
 *     (`accountShifts` → `stats.records`);
 *   - the sales by day and what they are made of, and the best fans (`stats.daily`, `stats.totals.byKind`,
 *     `stats.topFans`): the shifts' sales by the rule, Hub's sums, never added up here.
 * The reports' sum is the header's «По отчётам»; nothing here is pay, nothing is anyone else's.
 */

type Numbers = KernelOperationResponse<"accountShiftNumbers">;

/** «вс», «пн»… of a Moscow day. */
const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] as const;
const weekdayOf = (day: string) => WEEKDAY[new Date(`${day}T12:00:00+03:00`).getUTCDay()]!;

/** «$210» on the chart's scale: whole dollars. */
const wholeDollars = (mills: number) => `$${Math.round(mills / 1000).toLocaleString("en-US")}`;

function tilesOf(stats: ChatterStats, numbers: Numbers | undefined, numbersFailed: boolean): Tile[] {
  const pending = numbers === undefined && !numbersFailed;
  const wait = (value: () => Tile["value"]) => (pending ? <Skeleton width={72} height={24} radius={6} /> : numbers === undefined ? <span className="mys-tile-away">не пришли</span> : value());
  const own = numbers?.period.numbers;
  const ppvShare = own ? shareOf(own.ppvBought, own.ppvSent) : null;
  const fansShare = own ? shareOf(own.fansPaid, own.fansWritten) : null;
  const { bestShift, biggestSale, streakDays, longestStreakDays } = stats.records;
  return [
    {
      label: "PPV куплено",
      value: wait(() => (own!.ppvSent === 0 ? "0" : `${formatCount(own!.ppvBought)} из ${formatCount(own!.ppvSent)}`)),
      sub: ppvShare === null ? undefined : shareText(ppvShare),
      hint: "Платные сообщения, которые вы отправили фанам в сменах периода, и сколько из них купили. На всех страницах, рассылки не в счёте.",
    },
    {
      label: "Цена PPV",
      value: wait(() => (own!.ppvAveragePriceMills === null ? <span className="mys-tile-away">нет</span> : <Money mills={own!.ppvAveragePriceMills} />)),
      sub: own && own.ppvSent > 0 ? "средняя" : undefined,
      hint: "Средняя цена платных сообщений, которые вы отправили в сменах периода.",
    },
    {
      label: "Фаны заплатили",
      value: wait(() => (own!.fansWritten === 0 ? "0" : `${formatCount(own!.fansPaid)} из ${formatCount(own!.fansWritten)}`)),
      sub: fansShare === null ? undefined : shareText(fansShare),
      hint: "Фаны, которым вы писали в смену, и сколько из них заплатили на той же странице до конца смены. По каждой смене, сложено за период.",
    },
    {
      label: "Лучшая смена",
      value: bestShift === null ? <span className="mys-tile-away">нет</span> : <Money mills={bestShift.salesNetMills} />,
      sub: bestShift === null ? undefined : formatWeekdayDay(bestShift.startedAt),
      hint: "Смена периода с самыми большими продажами по правилу.",
    },
    {
      label: "Лучшая продажа",
      value: biggestSale === null ? <span className="mys-tile-away">нет</span> : <Money mills={biggestSale.netMills} />,
      sub: biggestSale === null ? undefined : [KIND_SHORT[biggestSale.kind], biggestSale.fanName].filter(Boolean).join(", "),
      hint: biggestSale === null ? "Самая крупная продажа в сменах периода." : `Самая крупная продажа в сменах периода: ${KIND_OF[biggestSale.kind].one.toLowerCase()}, ${formatWeekdayDay(biggestSale.at)}, ${biggestSale.pageLabel}.`,
    },
    {
      label: "Дней подряд",
      value: `${streakDays} ${ruPlural(streakDays, "день", "дня", "дней")}`,
      sub: longestStreakDays > streakDays ? `рекорд ${longestStreakDays}` : streakDays > 0 ? "это рекорд" : undefined,
      hint: "Дни подряд со сменой, по сегодня (или по вчера, пока сегодня смены нет). Рекорд: самая длинная серия за этот период и прошлый.",
    },
  ];
}

/** The period's sales by day, a column a day: each column stacked by kind, the best day at the top of the scale. */
function DailyBars({ daily, today }: { daily: ChatterStats["daily"]; today: string }) {
  const max = Math.max(0, ...daily.map((day) => day.salesNetMills));
  // A long period labels every few days, so the labels never touch.
  const every = daily.length <= 10 ? 1 : daily.length <= 16 ? 2 : 4;
  return (
    <div className="mys-days" data-dense={daily.length > 10 || undefined}>
      <div className="mys-days__plot">
        {max > 0 && (
          <>
            <span className="mys-days__rule" style={{ bottom: "100%" }}><span>{wholeDollars(max)}</span></span>
            <span className="mys-days__rule" style={{ bottom: "50%" }}><span>{wholeDollars(max / 2)}</span></span>
          </>
        )}
        {daily.map((day) => {
          const future = day.date > today;
          const parts = KINDS.filter((kind) => day.byKind[kind.kind] > 0);
          const height = max > 0 ? (day.salesNetMills / max) * 100 : 0;
          const words = `${formatWeekdayDay(day.date)}: ${future ? "ещё впереди" : day.shifts === 0 ? "смены не было" : `${formatMills(day.salesNetMills)}, ${day.shifts} ${ruPlural(day.shifts, "смена", "смены", "смен")}`}`;
          return (
            <Tooltip
              key={day.date}
              className="mys-days__tip"
              content={(
                <span className="mys-days__hint">
                  <span className="mys-days__hint-head">{formatWeekdayDay(day.date)}{day.date === today ? ", сегодня" : ""}</span>
                  {future ? <span>Ещё впереди</span> : day.shifts === 0 ? <span>Смены не было</span> : (
                    <>
                      <span className="mys-days__hint-row"><span>Продажи по правилу</span><Money mills={day.salesNetMills} strong /></span>
                      {parts.map((kind) => (
                        <span key={kind.kind} className="mys-days__hint-row">
                          <span><span aria-hidden className="wb-kind-key" style={{ background: kind.color }} /> {kind.label}</span>
                          <Money mills={day.byKind[kind.kind]} />
                        </span>
                      ))}
                      <span className="mys-days__hint-note">{day.shifts} {ruPlural(day.shifts, "смена", "смены", "смен")}, {formatDuration(day.workedMinutes)}</span>
                    </>
                  )}
                </span>
              )}
            >
              <span className="mys-days__col" tabIndex={0} aria-label={words} data-today={day.date === today || undefined} data-future={future || undefined}>
                {day.salesNetMills > 0 && (
                  <span className="mys-days__stack" style={{ height: `${height}%` }}>
                    {parts.map((kind) => <i key={kind.kind} style={{ flexGrow: day.byKind[kind.kind], background: kind.color }} />)}
                  </span>
                )}
                {day.salesNetMills <= 0 && !future && day.shifts > 0 && <span className="mys-days__zero" />}
              </span>
            </Tooltip>
          );
        })}
      </div>
      <div className="mys-days__axis" aria-hidden>
        {daily.map((day, index) => {
          // Today is always named; a label next to it gives way, so the two never touch.
          const nearToday = every > 1 && day.date !== today && (daily[index - 1]?.date === today || daily[index + 1]?.date === today);
          const named = day.date === today || (index % every === 0 && !nearToday);
          return (
            <span key={day.date} data-today={day.date === today || undefined}>
              {named ? (daily.length <= 10 ? <>{weekdayOf(day.date)}<br />{Number(day.date.slice(8))}</> : Number(day.date.slice(8))) : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function MyPeriod({ stats, numbers, numbersFailed, today, words }: {
  stats: ChatterStats;
  numbers: Numbers | undefined;
  numbersFailed: boolean;
  today: string;
  /** «за эту неделю», «за 14 дней». */
  words: string;
}) {
  const { totals } = stats;
  const kinds = {
    byKind: KINDS.map((kind) => ({ kind: kind.kind, netMills: totals.byKind[kind.kind] })),
    totalNetMills: totals.salesNetMills,
    pages: stats.pages.map((page) => ({ pageLabel: page.pageLabel, platform: page.platform || null, netMills: page.salesNetMills })),
  };
  return (
    <section className="mys-period" aria-label={`Смены ${words} в цифрах`}>
      <h2 className="mys-period__title">{capitalized(words)}</h2>
      <Tiles tiles={tilesOf(stats, numbers, numbersFailed)} label={`Смены ${words} в цифрах`} />
      <div className="mys-period__grid">
        <Card title="Продажи по дням" description="По правилу «чья продажа», после комиссии площадки.">
          <DailyBars daily={stats.daily} today={today} />
        </Card>
        <Card title="Из чего продажи" description="Те же продажи по видам и по страницам.">
          <SaleKinds sales={kinds} />
        </Card>
        <Card title="Лучшие фаны" description="Кто больше всех принёс в ваших сменах.">
          <TopFans sales={{ topFans: stats.topFans, restFans: { count: 0, netMills: 0 } }} empty={`${capitalized(words)} никто не платил.`} />
        </Card>
      </div>
    </section>
  );
}

export function MyPeriodSkeleton() {
  return (
    <section className="mys-period" aria-busy>
      <Skeleton width={180} height={24} radius={6} />
      <TilesSkeleton sub />
      <div className="mys-period__grid">
        {Array.from({ length: 3 }, (_, index) => (
          <Card key={index} title={<Skeleton width={140} />}>
            <div className="mys-period__lines">{Array.from({ length: 5 }, (_, line) => <Skeleton key={line} width="100%" height={20} />)}</div>
          </Card>
        ))}
      </div>
    </section>
  );
}
