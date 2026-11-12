import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { MOSCOW_TIME_ZONE, millsToWholeCents, toBusinessDate } from "@agency_hub_core/shared";
import type { TeamLedgerMonthCard } from "@agency_hub_core/contracts";
import { kernel, KernelApiError } from "@/api/sdk";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { PeriodStepper } from "@/components/ui/PeriodStepper";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDateTime, formatMills } from "@/lib/format";
import { monthWindow, stepMonth } from "./window";

/** The ledger's money, or «—» where it has none (a field it did not count is never a zero). */
const money = (mills: number | null) => (mills === null ? "—" : formatMills(mills));

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** «Ноябрь 2026». */
function monthWords(month: string): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const name = MONTHS[number - 1] ?? month;
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${year}`;
}

/** Where the month's money is, in the ledger's words, each with one plain line of what it means. */
const STATES: ReadonlyArray<{ key: keyof TeamLedgerMonthCard; label: string; means: string }> = [
  { key: "arrivedMills", label: "Пришло", means: "Выведено со страниц, перевод дошёл до агентства." },
  { key: "ridingMills", label: "Едет", means: "Вывод запрошен, перевод ещё не дошёл." },
  { key: "onPageMills", label: "На странице", means: "Можно выводить, вывод ещё не запрошен." },
  { key: "holdMills", label: "На холде", means: "Площадка ещё держит эти деньги, выводить рано." },
  { key: "stuckMills", label: "Застряло", means: "Меньше минимума вывода страницы: ждёт, пока наберётся." },
];

/**
 * «Деньги → Месяц»: the agency's month as the ledger keeps it (its month card, read
 * with Hub's payouts key). Hub counts nothing here: the card is the ledger's, and
 * its first line, «Доход страниц», is set beside Hub's own income of the same
 * Moscow month (the custom window Главная counts) with «равно Главной» or the
 * difference named. Honest states: a month the ledger could not prove, a ledger
 * that does not answer, an older ledger without the read.
 */
export function MonthPage() {
  const [search, setSearch] = useSearchParams();
  const today = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
  const current = today.slice(0, 7);
  const asked = search.get("month");
  const month = asked && MONTH_RE.test(asked) && asked <= current ? asked : current;
  const days = monthWindow(month);
  const card = useQuery({
    queryKey: ["ledger-month", month],
    queryFn: () => kernel.teamLedgerMonth({ query: { month } }),
    meta: { suppressGlobalError: true },
    retry: false,
  });
  const hub = useQuery({
    queryKey: ["overviewRevenue", "custom", days.from, days.to],
    queryFn: () => kernel.overviewRevenue({ query: { period: "custom", from: days.from, to: days.to } }),
    meta: { suppressGlobalError: true },
  });
  const go = (next: string) => {
    const query = new URLSearchParams(search);
    if (next === current) query.delete("month");
    else query.set("month", next);
    setSearch(query);
  };

  const data = card.data;
  const fresh = card.dataUpdatedAt ? { at: card.dataUpdatedAt, refreshing: card.isFetching || hub.isFetching, onRefresh: () => void Promise.all([card.refetch(), hub.refetch()]) } : undefined;

  return (
    <div className="space-y-6">
      <PageHeader window={`${monthWords(month)}, дни по Москве`} fresh={fresh} />
      <div className="month-bar">
        <PeriodStepper
          label={monthWords(month)}
          prevLabel="Предыдущий месяц"
          nextLabel="Следующий месяц"
          canNext={month < current}
          onPrev={() => go(stepMonth(month, -1))}
          onNext={() => go(stepMonth(month, 1))}
        />
        {month === current && <span className="month-bar-note">Месяц идёт: числа ещё растут.</span>}
      </div>
      {card.isLoading ? (
        <div className="card"><TableSkeleton rows={6} columns={4} /></div>
      ) : card.isError ? (
        <div className="card">
          {card.error instanceof KernelApiError && card.error.status === 503
            ? <StatusPanel title="Ledger не ответил" description="Карточка месяца не пришла. Это не ноль: деньги есть, экран их не получил." action={<button type="button" className="btn btn-sm" onClick={() => void card.refetch()}>Повторить</button>} />
            : <NoAnswerPanel retry={card.refetch} />}
        </div>
      ) : !data?.served || !data.card ? (
        <div className="card">
          <StatusPanel
            title="Ledger ещё не отдаёт месяц"
            description="Карточку месяца ledger пока не показывает Hub. Доход страниц за месяц есть на Главной."
            action={<Link className="btn btn-sm" to={`/?period=30d`}>На Главную</Link>}
          />
        </div>
      ) : data.card.pagesNetMills === null && data.card.earnedMills === null ? (
        <div className="card">
          <StatusPanel
            title="Ledger ещё не считал этот месяц"
            description={data.card.reason ?? "Карточки этого месяца у ledger нет. Доход страниц за месяц есть на Главной."}
            action={<Link className="btn btn-sm" to={`/?period=30d`}>На Главную</Link>}
          />
        </div>
      ) : (
        <Card card={data.card} hub={hub} />
      )}
    </div>
  );
}

function Card({ card, hub }: {
  card: TeamLedgerMonthCard;
  hub: { data?: { netEarningsMills: number } | undefined; isError: boolean; isLoading: boolean; refetch: () => unknown };
}) {
  const hubMills = hub.data?.netEarningsMills ?? null;
  // To the cent: the ledger keeps whole cents, Hub keeps mills; both are compared as the cents they print.
  const delta = hubMills === null || card.pagesNetMills === null ? null : (millsToWholeCents(card.pagesNetMills) - millsToWholeCents(hubMills)) * 10;
  return (
    <>
      {card.status === "unknown" && (
        <Notice tone="warning" role="status" detail={card.reason ?? undefined}>
          Ledger не смог подтвердить этот месяц: числа ниже его, они могут измениться.
        </Notice>
      )}
      <section className="card" aria-labelledby="month-pages-title">
        <div className="month-head">
          <div className="month-main">
            <h2 id="month-pages-title" className="month-label">Доход страниц</h2>
            <p className="month-value">{money(card.pagesNetMills)}</p>
            <p className="month-means">Что заплатили фаны на страницах за месяц, после комиссии площадок.</p>
            <p className="month-check">
              {hub.isLoading ? <Skeleton width={220} />
                : card.pagesNetMills === null ? null
                : hubMills === null ? (
                  <span className="text-text-muted">
                    Главную за месяц проверить не удалось. <button type="button" className="link" onClick={() => void hub.refetch()}>Повторить</button>
                  </span>
                )
                  : delta === 0 ? <span className="month-equal">равно Главной: {formatMills(hubMills)}</span>
                    : (
                      <span className="month-differs">
                        Главная за этот месяц: {formatMills(hubMills)}, ledger {delta! > 0 ? "больше" : "меньше"} на {formatMills(Math.abs(delta!))}
                      </span>
                    )}
            </p>
          </div>
          <div className="month-side">
            <MoneyLine label="Мимо площадок" mills={card.offPlatformMills} means="Деньги фанов мимо площадок, после доли модели." />
            <MoneyLine label="Оборот" mills={card.turnoverMills} means="Доход страниц и мимо площадок вместе." strong />
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="month-earned-title">
        <div className="card-header">
          <div>
            <h2 id="month-earned-title" className="card-title">Заработано: {money(card.earnedMills)}</h2>
            <p className="card-description">Доля агентства из денег месяца, по курсу вывода. Где она сейчас:</p>
          </div>
        </div>
        <ul className="month-states">
          {STATES.map((state) => (
            <li key={state.key}>
              <span className="month-state-label">{state.label}</span>
              <span className="month-state-means">{state.means}</span>
              <span className="month-state-value">{money(card[state.key] as number | null)}</span>
            </li>
          ))}
        </ul>
      </section>

      {card.models.length > 0 && (
        <section className="card" aria-labelledby="month-models-title">
          <div className="card-header"><h2 id="month-models-title" className="card-title">По моделям</h2></div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Модель</th>
                  <th scope="col" className="num">Доход страниц</th>
                  <th scope="col" className="num">Мимо площадок</th>
                  <th scope="col" className="num">Заработано</th>
                  <th scope="col" className="num">Пришло</th>
                  <th scope="col" className="num">Едет</th>
                </tr>
              </thead>
              <tbody>
                {card.models.map((line) => (
                  <tr key={line.model}>
                    <td>{line.model}</td>
                    <td className="num">{formatMills(line.pagesNetMills)}</td>
                    <td className="num">{line.offPlatformMills === 0 ? "—" : formatMills(line.offPlatformMills)}</td>
                    <td className="num">{formatMills(line.earnedMills)}</td>
                    <td className="num">{formatMills(line.arrivedMills)}</td>
                    <td className="num">{formatMills(line.ridingMills)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="month-foot">
        {card.notes.length > 0 && (
          <ul className="month-notes">
            {card.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        )}
        <p>
          Карточка ledger{card.asOf ? ` на ${formatDateTime(card.asOf, { yearUnlessCurrent: true })}` : ""}
          {card.computedAt ? `, посчитана ${formatDateTime(card.computedAt, { yearUnlessCurrent: true })}` : ""}. Hub только показывает её и сверяет доход страниц со своим.
        </p>
      </div>
    </>
  );
}

function MoneyLine({ label, mills, means, strong = false }: { label: string; mills: number | null; means: string; strong?: boolean }) {
  return (
    <div className="month-line">
      <span className={strong ? "month-line-label month-line-strong" : "month-line-label"}>{label}</span>
      <span className={strong ? "month-line-value month-line-strong" : "month-line-value"}>{money(mills)}</span>
      <span className="month-line-means">{means}</span>
    </div>
  );
}
