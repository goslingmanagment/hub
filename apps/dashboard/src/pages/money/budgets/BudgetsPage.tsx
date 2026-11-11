import { useLocation, useSearchParams } from "react-router";
import { useAdminBudgets } from "@/api/budgets";
import { KernelApiError } from "@/api/sdk";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { StatCardSkeleton, TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { PeriodStepper } from "@/components/ui/PeriodStepper";
import { formatDay, formatMills } from "@/lib/format";
import { FlowCards, MonthTiles, MonthsCard, PromotionCard } from "./BudgetsParts.js";
import { monthLong, monthSince, pickMonth, runningDay } from "./budgetsView.js";
import type { BudgetMonth } from "@agency_hub_core/contracts";

/** What the header says about the month: it runs, it is over and not closed, it is closed. */
function monthState(month: BudgetMonth): string {
  if (month.state === "open") return `Месяц идёт: день ${runningDay(month)} из ${month.daysInMonth}`;
  if (month.state === "incomplete") return "Учёт неполный: только записанное в журнале";
  if (month.state === "closed") return month.closedAt ? `Месяц закрыт ${formatDay(month.closedAt)}` : "Месяц закрыт";
  const transit = month.figures?.transitMills ?? 0;
  return transit > 0 ? `Месяц не закрыт: ${formatMills(transit)} ещё в пути` : "Месяц не закрыт";
}

/**
 * Деньги → Бюджеты: every month of the agency as the agency ledger counts it — what was earned and from where, what
 * it went on, what is left, the plan, and what traffic and contractors cost by source. The month lives in the address
 * (`?month=2026-10`), the newest one without it. Reads only: the books are the ledger's.
 */
export function BudgetsPage() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const query = useAdminBudgets();
  const data = query.data;
  const picked = data ? pickMonth(data, search.get("month")) : null;

  function open(month: string) {
    const next = new URLSearchParams(search);
    if (month === data?.months.at(-1)?.month) next.delete("month");
    else next.set("month", month);
    setSearch(next, { state: location.state });
  }

  if (!data) {
    const ledgerDown = query.error instanceof KernelApiError && query.error.status === 503;
    return (
      <div className="space-y-6">
        <PageHeader />
        {ledgerDown ? (
          <StatusPanel
            tone="error"
            title="Ledger не ответил"
            description="Бюджеты считает ledger агентства: он не подключён к Hub или не ответил. Числа не пришли. Это не ноль."
            action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}
          />
        ) : query.isError ? (
          <NoAnswerPanel retry={query.refetch} />
        ) : (
          <div role="status" className="space-y-6">
            <span className="sr-only">Загружаем бюджеты…</span>
            <StatCardSkeleton count={4} />
            <div className="card"><TableSkeleton rows={5} columns={5} /></div>
          </div>
        )}
      </div>
    );
  }

  if (!picked) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <StatusPanel title="В ledger пока нет ни одного месяца" description="Месяц появится здесь, как только ledger посчитает его карточку." />
      </div>
    );
  }

  const { month, index } = picked;
  const months = data.months;
  return (
    <div className="space-y-6">
      <PageHeader
        actions={(
          <PeriodStepper
            label={monthLong(month.month)}
            prevLabel="Предыдущий месяц"
            nextLabel="Следующий месяц"
            canPrev={index > 0}
            canNext={index < months.length - 1}
            onPrev={() => open(months[index - 1]?.month ?? month.month)}
            onNext={() => open(months[index + 1]?.month ?? month.month)}
          />
        )}
        window={monthState(month)}
        fresh={{ at: data.ledgerAsOf ?? data.serverNow, refreshing: query.isFetching, onRefresh: () => void query.refetch() }}
      />
      <QueryNotice error={query.isError} stale retry={query.refetch} at={query.dataUpdatedAt} />
      {!month.figures && (
        <Notice tone="warning" role="status" detail={month.unknownReason ?? undefined}>
          Ledger не смог посчитать {monthLong(month.month).toLowerCase()}. Чисел месяца нет. Это не ноль.
        </Notice>
      )}
      {month.state === "incomplete" && (
        <Notice tone="off" role="status" detail="Показано то, что записано в журнале, по дате платежа. Настоящие расходы могли быть больше.">
          За {monthLong(month.month).toLowerCase()} учёт неполный: ledger считает месяцы целиком {monthSince(months.find((one) => one.state !== "incomplete")?.month ?? month.month)}.
        </Notice>
      )}
      <MonthTiles month={month} />
      <MonthsCard months={months} active={month.month} onPick={open} />
      {month.figures && <FlowCards month={month} figures={month.figures} promotion={data.promotion} />}
      <PromotionCard promotion={data.promotion} month={month} />
      <div className="help-row">
        <Disclosure>
          <p>
            Месяцы с пометкой «неполный» — до того, как ledger стал вести полный учёт: у них только записанное в журнале,
            по дате платежа, без оборота страниц, плана и ставки CEO. Остальные месяцы ledger считает целиком.
          </p>
          <p>
            Числа считает ledger агентства. «Заработано» — доля агентства от оборота страниц и поступлений мимо площадок,
            по времени платежа фана. «В пути» — деньги на холде, на странице и в переводе; «застряло» — остаток страницы
            ниже минимума вывода, в «Остаётся» он не входит.
          </p>
          <p>
            Расходы: чаттеры — по дням работы из таблиц выплат, предоплата на несколько месяцев — поровну по месяцам,
            остальное — по дате платежа. Зарплата CEO — ставка месяца; сколько выплачено, написано рядом. «Остаётся» —
            заработано минус застрявшее, расходы и зарплата CEO.
          </p>
          <p>
            «Трафик и подрядчики» — строки журнала по дате платежа: статьи «Трафик», «SFS», «YouTube» и «Подрядчик».
            «План в месяц» — регулярный платёж источнику из обязательств ledger, приведённый к месяцу («≈», если он
            назначен за неделю); у источника без обязательства плана нет. «План: до …» — капы реинвеста месяца: сколько
            владелец разрешил вложить в рост; рядом — сколько вложено в трафик и подрядчиков за месяц. План оборота — дневные планы страниц на число дней
            месяца, без поступлений мимо площадок.
          </p>
        </Disclosure>
        {month.figures && month.figures.notes.length > 0 && (
          <Disclosure label="Подробнее">
            {month.figures.notes.map((note) => <p key={note}>{note}</p>)}
          </Disclosure>
        )}
      </div>
    </div>
  );
}
