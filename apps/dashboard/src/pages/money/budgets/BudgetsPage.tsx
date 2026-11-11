import { useMemo } from "react";
import { useLocation, useSearchParams } from "react-router";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { useMoneyBudgets } from "@/api/budgets";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { PeriodStepper } from "@/components/ui/PeriodStepper";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatBusinessDateShort } from "@/lib/format";
import { HistoryCard, IncomeCard, ItemsCard, TrafficCard, TurnoverCard } from "./BudgetCards.js";
import { BudgetPlanEditor } from "./BudgetPlanEditor.js";
import { BulletBar, Hint } from "./BudgetParts.js";
import { formatUsd, monthViews, type MonthView } from "./budgetsModel.js";


function share(part: number, whole: number | null): string {
  if (whole === null || whole <= 0) return "";
  return `${Math.round((part / whole) * 100)} %`;
}

/** The four tiles: turnover against its plan, in, out, what is left. */
function Tiles({ view }: { view: MonthView }) {
  const turnoverPlan = view.current ? view.turnoverPlanToDate : view.turnoverPlanMonth;
  const forecast = view.current && view.elapsed > 0 ? (view.turnover / view.elapsed) * view.days : null;
  return (
    <StatGrid className="budget-tiles">
      <Stat
        label={<Hint text="Net страниц по дням МСК (как на Главной) против плана оборота ledger.">Оборот страниц</Hint>}
        value={formatUsd(view.turnover)}
        meta={turnoverPlan === null ? "без плана" : (
          <>
            <BulletBar value={view.turnover} plan={turnoverPlan} max={Math.max(view.turnover, turnoverPlan) * 1.05} tone="earn" />
            <span className="budget-tile-line">
              {view.current ? <>план к {formatBusinessDateShort(`${view.month}-${String(view.elapsed).padStart(2, "0")}`)} {formatUsd(turnoverPlan)}</> : <>план {formatUsd(turnoverPlan)}</>}
              {" · "}<b className={view.turnover >= turnoverPlan ? "budget-good" : "budget-over"}>{share(view.turnover, turnoverPlan)}</b>
            </span>
            {forecast !== null && view.turnoverPlanMonth !== null && (
              <span className="budget-tile-line">к концу ≈ {formatUsd(forecast)} из {formatUsd(view.turnoverPlanMonth)}</span>
            )}
          </>
        )}
      />
      <Stat
        label={<Hint text="Деньги, пришедшие на счета агентства за месяц: выводы платформ, кастомы, рефералы. Без денег владельца и возвратов.">Пришло</Hint>}
        value={formatUsd(view.income)}
        meta={(
          <>
            {view.earned !== null && (
              <Hint text="Заработано по ledger: доля агентства с оборота месяца; часть ещё в холде и в пути, придёт позже.">
                <span>заработано {formatUsd(view.earned)}</span>
              </Hint>
            )}
            {view.incomePlan !== null && (
              <span className="block">
                план дохода {formatUsd(view.incomePlan)}
                {!view.current && view.earned !== null && <> · <b className={view.earned >= view.incomePlan ? "budget-good" : "budget-over"}>{share(view.earned, view.incomePlan)}</b></>}
              </span>
            )}
          </>
        )}
      />
      <Stat
        label={<Hint text="Расходы месяца с зарплатой CEO, за вычетом возвратов. Деньги, вынутые владельцем, — не расход.">Ушло</Hint>}
        value={formatUsd(view.spent)}
        meta={view.planSpent === null ? "без плана" : (
          <>
            <BulletBar value={view.spent} plan={view.planSpent} max={Math.max(view.spent, view.planSpent) * 1.05} tone="spend" />
            <span className="budget-tile-line">
              план {formatUsd(view.planSpent)} · <b className={view.spent > view.planSpent ? "budget-over" : ""}>{share(view.spent, view.planSpent)}</b>
            </span>
            {view.unplanned > 0 && (
              <Hint text="Траты статей, у которых в этом месяце нет плана.">
                <span className="budget-tile-line">вне плана {formatUsd(view.unplanned)}</span>
              </Hint>
            )}
          </>
        )}
      />
      <Stat
        label={(
          <Hint text="Итог месяца по правилам ledger, как в закрытиях: цифра решения (заработано − застряло − расходы по дням работы) минус зарплата CEO по плану. У закрытого месяца — цифра на закрытии.">
            Прибыль
          </Hint>
        )}
        value={view.profit === null ? <span className="budget-muted">—</span> : <span className={view.profit < 0 ? "budget-over" : ""}>{formatUsd(view.profit)}</span>}
        meta={(
          <>
            {view.profit === null && <span className="budget-tile-line">ledger не считает этот месяц</span>}
            <Hint text="Пришло − ушло за месяц: сколько добавилось денег на счетах, без денег владельца.">
              <span className="budget-tile-line">кассой {formatUsd(view.cash, { sign: true })}</span>
            </Hint>
          </>
        )}
      />
    </StatGrid>
  );
}

/**
 * Деньги → Бюджеты: the agency's budget by month from the ledger — what came in
 * and from where, what went out and on what against the plan, traffic by
 * channel, the pages' turnover against their plan, and every month in one
 * table. The month is the screen's own (`?month=`), the current one by default.
 */
export function BudgetsPage() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const query = useMoneyBudgets();
  const data = query.data;
  const months = useMemo(() => (data ? monthViews(data) : []), [data]);

  const asked = search.get("month");
  const view = months.find((month) => month.month === asked) ?? months.find((month) => month.current) ?? months.at(-1) ?? null;
  const index = view ? months.indexOf(view) : -1;

  function go(month: string) {
    const next = new URLSearchParams(search);
    if (data && month === data.currentMonth) next.delete("month");
    else next.set("month", month);
    setSearch(next, { state: location.state });
  }

  const unavailable = query.isError && hubErrorStatus(query.error) === 503;
  return (
    <div className="space-y-6">
      <PageHeader
        actions={view && (
          <PeriodStepper
            label={view.label}
            onPrev={() => index > 0 && go(months[index - 1]!.month)}
            onNext={() => index < months.length - 1 && go(months[index + 1]!.month)}
            canNext={index < months.length - 1}
            prevLabel="Предыдущий месяц"
            nextLabel="Следующий месяц"
          />
        )}
        window={view ? (view.current ? `идёт ${view.elapsed}-й день из ${view.days}` : view.closed ? "месяц закрыт" : "месяц не закрыт") : undefined}
        fresh={data ? { at: data.generatedAt, refreshing: query.isFetching, onRefresh: () => void query.refetch() } : undefined}
      />
      {data && <QueryNotice error={query.isError} stale retry={query.refetch} at={query.dataUpdatedAt} />}
      {!data && unavailable ? (
        <StatusPanel
          title="Ledger не подключён"
          description="Бюджеты живут в ledger: Hub читает их ключом с правом budgets (LEDGER_BUDGETS_KEY). Ключа нет или ledger не ответил."
          action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}
        />
      ) : !data && query.isError ? (
        <NoAnswerPanel retry={query.refetch} />
      ) : !data || !view ? (
        <div role="status" className="space-y-6">
          <span className="sr-only">Загружаем бюджеты…</span>
          <StatCardSkeleton count={4} />
          <div className="card"><TableSkeleton rows={6} columns={4} /></div>
        </div>
      ) : (
        <>
          {!view.complete && (
            <Notice tone="warning" detail={data.fullLedgerFrom ? `Полный учёт — с ${formatBusinessDateShort(data.fullLedgerFrom)}.` : undefined}>
              В этом месяце учёт неполный: в журнале только часть движений.
            </Notice>
          )}
          <Tiles view={view} />
          <div className="budget-grid">
            <div className="budget-col budget-col-left">
              <IncomeCard view={view} names={data.modelNames} />
              <TrafficCard view={view} months={months} names={data.modelNames} />
            </div>
            <div className="budget-col budget-col-right">
              <ItemsCard view={view} names={data.modelNames} editor={<BudgetPlanEditor view={view} previous={months[index - 1] ?? null} />} />
            </div>
          </div>
          <TurnoverCard view={view} />
          <HistoryCard months={months} selected={view.month} onSelect={go} />
          <div className="help-row">
            <Disclosure>
              <p>
                Пришло и ушло — из журнала ledger: оплаченные строки по дате платежа. «Пришло» — выводы платформ, кастомы и
                прочий доход. «Ушло» — расходы с зарплатой CEO; возвраты расходов их уменьшают. Аванс за следующий месяц
                (пометка «за») считается в том месяце, за который заплачен. Вложенное и вынутое владельцем — ни доход, ни расход.
              </p>
              <p>
                Прибыль — итог месяца по правилам ledger, как в закрытиях: цифра решения (заработано − застряло − расходы,
                чаттеры по дням работы, предоплаты поровну) минус зарплата CEO по плану. У закрытого месяца — на закрытии.
                «Кассой» — пришло − ушло.
              </p>
              <p>
                Трафик — статья «Трафик» и подрядчики, чья работа — трафик (SFS, FYP): канал подрядчика задаёт настройка ledger
                traffic_channels. Сетевые комиссии платежей остаются в «Комиссиях».
              </p>
              <p>
                План статьи пишет владелец («Изменить план»), он хранится в ledger. У зарплаты CEO без своего плана план — ставка
                месяца. План дохода — на базе «заработано». Оборот — net страниц в Hub по дням МСК, как на Главной; план оборота —
                ledger, $ в день по страницам.
              </p>
            </Disclosure>
          </div>
        </>
      )}
    </div>
  );
}
