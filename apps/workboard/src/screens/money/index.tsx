import { Navigate, useLocation } from "react-router";
import { EmptyState, Money, Section, Table, type Column } from "@agency_hub_core/ui";
import { formatDay } from "@agency_hub_core/ui/format";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useMe } from "@/shared/useMe";
import { usePeriod } from "@/shared/usePeriod";
import { MoneyBlock } from "../my-shifts/MyMoney";
import { useMyMoney, type MoneyDay } from "../my-shifts/money";
import "../my-shifts/my-money.css";

/**
 * «Деньги» (products plan §2.3): the address opens the role's tab — the owner's «Долги» (`/money/debts`, with
 * «Отчёты» beside it: the team's route, screens/payouts), anyone else's «Мои деньги» (`/money/mine`). It was «Выплаты»
 * at `/payouts`, which leads to the owner's tabs (packages/ui old-addresses.ts).
 */
export function MoneyHome() {
  const { isOwner } = useMe();
  const location = useLocation();
  return <Navigate to={{ pathname: isOwner ? "/money/debts" : "/money/mine", search: location.search }} replace />;
}

const STATE_WORDS: Readonly<Record<MoneyDay["state"], string>> = { paid: "оплачено", to_pay: "к выплате", none: "не начислено" };

const DAY_COLUMNS: Column<MoneyDay>[] = [
  { key: "date", header: "День", cell: (day) => formatDay(day.date), grow: true },
  { key: "amount", header: "Начислено", numeric: true, cell: (day) => <Money mills={day.amountMills} /> },
  { key: "paid", header: "Выплачено", numeric: true, cell: (day) => <Money mills={day.paidMills} muted={day.paidMills === 0} /> },
  { key: "state", header: "Сейчас", cell: (day) => STATE_WORDS[day.state], nowrap: true },
];

/**
 * «Мои деньги»: the person's own pay as the agency ledger keeps it (`accountPay`, the session's own only), behind the
 * person's right «видит свои деньги». Off — the words that say so and nothing else; the owner's tabs are not here.
 * The same block «Мои смены» shows above its journal, and the period's days under it. Sums only, never a rate.
 */
export function MineScreen() {
  const { isOwner } = useMe();
  const location = useLocation();
  const { period } = usePeriod();
  const read = useMyMoney({ from: period.from, to: period.to });
  if (isOwner) return <Navigate to={{ pathname: "/money/debts", search: location.search }} replace />;
  const off = read.off;
  const days = (read.pay?.days ?? []).filter((day) => day.date >= period.from && day.date <= period.to && day.amountMills !== 0).sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <ScreenHeader title="Деньги" period={!off} meta={"\u00a0"} />
      <div className="wb-content">
        {off ? (
          <EmptyState title="Деньги здесь пока не показываются">
            Их включает владелец. Когда включит, здесь будет видно, сколько вам начислено, к выплате и выплачено.
          </EmptyState>
        ) : (
          <>
            <MoneyBlock read={read} />
            {read.pay !== null && (
              <Section title="По дням" description="Начисления за дни смен этого периода, по отчёту дня.">
                <Table
                  label="Начисления по дням"
                  columns={DAY_COLUMNS}
                  rows={days}
                  rowKey={(day) => day.date}
                  empty={<EmptyState compact title="За эти дни начислений нет">Начисление появится, когда ledger примет отчёт дня.</EmptyState>}
                />
              </Section>
            )}
          </>
        )}
      </div>
    </>
  );
}
