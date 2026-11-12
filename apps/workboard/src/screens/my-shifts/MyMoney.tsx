import { RotateCw } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Button, Facts, Money, Tooltip, type Column, type FactItem } from "@agency_hub_core/ui";
import { formatDay, formatMills } from "@agency_hub_core/ui/format";
import type { MyShiftRow, MyShiftsWindow } from "./model.js";
import { accrualOfRows, useMyMoney, type MoneyDay, type MyMoneyRead } from "./money.js";
import "./my-money.css";

/**
 * «Мои деньги» on «Мои смены» (ecosystem package H1): above the journal, what is accrued for the period, what the
 * agency owes now and what it paid, with the date of the last payout; in each shift's row, under the report's sum, the
 * accrual of its day once the ledger has it. Behind the person's switch «видит свои деньги»: off — no block, no line,
 * the screen as before. Sums only: a rate is never on this screen.
 */

/** The day's accrual under a row's report sum: «начислено $13.75», its state on hover and in the shade of the words. */
function AccrualLine({ day }: { day: MoneyDay }) {
  const state = day.state === "paid" ? "оплачено" : day.paidMills > 0 ? `к выплате ${formatMills(day.unpaidMills)}` : "ждёт выплаты";
  return (
    <Tooltip content={`Начислено за день этой смены по отчёту дня (пост или сданный отчёт), вместе с долей общака: ${state}.`} align="end">
      <span className={day.state === "paid" ? "mym-line" : "mym-line mym-line--due"}>
        начислено {formatMills(day.amountMills)}{day.state === "paid" ? ", оплачено" : ""}
      </span>
    </Tooltip>
  );
}

function MoneyBlock({ read }: { read: MyMoneyRead }) {
  if (read.away) {
    return (
      <section className="mym" aria-label="Мои деньги">
        <span className="mym__title">Мои деньги</span>
        <span className="mym__away">
          сейчас не пришли
          <Button size="sm" variant="ghost" icon={RotateCw} loading={read.retrying} onClick={read.retry}>{read.retrying ? "Повторяем…" : "Повторить"}</Button>
        </span>
      </section>
    );
  }
  if (read.none) {
    return (
      <section className="mym" aria-label="Мои деньги">
        <span className="mym__title">Мои деньги</span>
        <span className="mym__away">начислений пока нет</span>
      </section>
    );
  }
  const pay = read.pay;
  if (pay === null) return null;
  const ahead = pay.balanceMills < 0;
  const items: FactItem[] = [
    {
      label: "Начислено за период",
      value: <Money mills={pay.accruedMills} />,
      meta: pay.reportsFrom ? `с ${formatDay(pay.reportsFrom)} по отчётам смен` : undefined,
      hint: "Что начислено за дни смен этого периода: по отчёту дня (пост или сданный отчёт), вместе с долей общака.",
    },
    {
      label: "К выплате",
      strong: true,
      value: <Money mills={ahead ? 0 : pay.balanceMills} strong />,
      meta: ahead ? `выплачено вперёд ${formatMills(-pay.balanceMills)}` : pay.oldestUnpaidDate ? `ждёт с ${formatDay(pay.oldestUnpaidDate)}` : "всё выплачено",
      hint: "Всё начисленное и ещё не выплаченное на сегодня, за любые дни, не только за этот период.",
    },
    {
      // The payouts made on the period's days, whatever days they paid for: not «paid for this period».
      label: "Выплачено в эти дни",
      value: <Money mills={pay.paidMills} />,
      meta: pay.lastPayout ? `последняя выплата ${formatDay(pay.lastPayout.date)}, ${formatMills(pay.lastPayout.amountMills)}` : "выплат ещё не было",
      hint: "Выплаты, сделанные в дни этого периода. Они могли закрыть и более ранние дни.",
    },
  ];
  return (
    <section className="mym" aria-label="Мои деньги">
      <span className="mym__title">Мои деньги</span>
      <Facts items={items} layout="stacked" columns={3} label="Мои деньги" className="mym__facts" />
      {pay.stale && <span className="mym__note">Суммы могли отстать: их пересчитывали больше двух часов назад.</span>}
    </section>
  );
}

/**
 * The block, and the journal's columns with the day's accrual under «По отчёту» (a column of its own would push the
 * report's state off a laptop's screen): the screen's one line of wiring. Until the switch is known to be on, the
 * block is nothing and the columns are the screen's own.
 */
export function useMyMoneyParts(window: MyShiftsWindow, columns: readonly Column<MyShiftRow>[], rows: readonly MyShiftRow[] | undefined): {
  block: ReactNode;
  columns: readonly Column<MyShiftRow>[];
} {
  const read = useMyMoney(window);
  const pay = read.pay;
  const accrual = useMemo(() => (pay && rows ? accrualOfRows(rows, pay.days) : new Map<string, MoneyDay>()), [pay, rows]);
  const withMoney = useMemo(() => {
    if (pay === null) return columns;
    return columns.map((column): Column<MyShiftRow> => (column.key !== "total" ? column : {
      ...column,
      cell: (row, index) => {
        const day = accrual.get(row.key);
        return day === undefined ? column.cell(row, index) : <span className="mym-total"><span className="mym-total__sum">{column.cell(row, index)}</span><AccrualLine day={day} /></span>;
      },
    }));
  }, [pay, columns, accrual]);
  return { block: <MoneyBlock read={read} />, columns: withMoney };
}
