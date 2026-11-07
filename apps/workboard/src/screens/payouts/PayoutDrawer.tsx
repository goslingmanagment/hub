import { Copy } from "lucide-react";
import { Button, Drawer, Facts, Money, Table, TimeMsk, type Column } from "@agency_hub_core/ui";
import { formatDay, formatDayRange, formatDuration } from "@agency_hub_core/ui/format";
import { sheetText, type PivotRow } from "@agency_hub_core/ui/payoutSheet";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { sumMills } from "@agency_hub_core/shared";
import { PersonLink, ShiftLink } from "@/shared/links";
import { copySheet } from "./copy";
import type { PayoutChatter, PayoutsView, UnconfirmedShift } from "./data";

/** «02.11»: a day's column, as the console's sheet heads it. */
function dayHead(day: string): string {
  return `${day.slice(8)}.${day.slice(5, 7)}`;
}

/**
 * The sheet by days: a page per row, a day per column, the total at the end.
 * Money is written for reading here («$45.00»); the copy is the payout sheet's
 * own format (no «$», OnlyFans whole dollars). A long window scrolls sideways.
 */
export function SheetDayTable({ sheet, days, withChatter = false }: { sheet: readonly PivotRow[]; days: readonly string[]; withChatter?: boolean }) {
  const columns: Column<PivotRow>[] = [
    ...(withChatter ? [{ key: "who", header: "Чаттер", nowrap: true, cell: (row: PivotRow) => row.username } satisfies Column<PivotRow>] : []),
    { key: "page", header: "Страница", nowrap: true, cell: (row) => row.pageLabel },
    // The total right after the page: a long window scrolls sideways, and the total must never be off screen.
    {
      key: "total",
      header: "Итого",
      numeric: true,
      nowrap: true,
      cell: (row) => <Money mills={sumMills(row.cells.values())} strong />,
    },
    ...days.map((day): Column<PivotRow> => ({
      key: day,
      header: dayHead(day),
      numeric: true,
      nowrap: true,
      title: formatDay(day),
      cell: (row) => (row.cells.has(day) ? <Money mills={row.cells.get(day)!} /> : ""),
    })),
  ];
  return <Table label="Выгрузка по дням" columns={columns} rows={sheet} rowKey={(row) => `${row.username}\u0000${row.pageLabel}`} dense scrollX={days.length > 10} />;
}

function shiftLine(shift: UnconfirmedShift): string {
  const minutes = Math.max(0, Math.round((Date.parse(shift.endedAt) - Date.parse(shift.startedAt)) / 60_000));
  return formatDuration(minutes);
}

/** One chatter's payout of the window: the days, the block to copy, the shifts not confirmed. */
export function PayoutDrawer({ chatter, view, canCopy, onClose }: { chatter: PayoutChatter; view: PayoutsView; canCopy: boolean; onClose: () => void }) {
  const lines = chatter.sheet.length;
  const copy = () => void copySheet(
    sheetText(chatter.sheet, view.days),
    `Скопировано: блок ${chatter.username}, ${lines} ${ruPlural(lines, "строка", "строки", "строк")}, ${formatDayRange(view.from, view.to)}`,
  );
  return (
    <Drawer
      open
      onClose={onClose}
      width={720}
      title={chatter.userId !== null ? <PersonLink userId={chatter.userId} name={chatter.username} backLabel="Выплаты" /> : chatter.username}
      subtitle={<>Выплата за {formatDayRange(view.from, view.to)}, все страницы</>}
      footer={(
        <>
          <Button onClick={onClose}>Закрыть</Button>
          <Button variant="primary" icon={Copy} disabled={!canCopy || lines === 0} title={lines === 0 ? "Нечего копировать: подтверждённых отчётов нет" : undefined} onClick={copy}>
            Скопировать блок {chatter.username}
          </Button>
        </>
      )}
    >
      <div className="payouts-drawer">
        <Facts
          label={`Выплата ${chatter.username}`}
          items={[
            { label: "Подтверждено", value: <Money mills={chatter.confirmedMills} />, strong: true },
            { label: "Дней", value: chatter.days },
            { label: "Без подтверждения", value: `${chatter.unconfirmed.length} ${ruPlural(chatter.unconfirmed.length, "смена", "смены", "смен")}` },
          ]}
        />

        {lines > 0 ? (
          <section className="payouts-block">
            <h3 className="payouts-block__title">По дням</h3>
            <SheetDayTable sheet={chatter.sheet} days={view.days.filter((day) => chatter.sheet.some((row) => row.cells.has(day)))} />
            <p className="payouts-note">Скопируется блок за все {view.days.length} {ruPlural(view.days.length, "день", "дня", "дней")} периода, как в таблице выплат; здесь показаны дни с продажами.</p>
          </section>
        ) : (
          <p className="payouts-note">Подтверждённых отчётов за эти дни нет: в выгрузку от {chatter.username} ничего не попадёт.</p>
        )}

        {chatter.unconfirmed.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Смены без подтверждения</h3>
            <ul className="payouts-shifts">
              {chatter.unconfirmed.map((shift) => (
                <li key={shift.startedAt}>
                  <span>
                    {chatter.userId !== null
                      ? <ShiftLink userId={chatter.userId} startedAt={shift.startedAt} backLabel="Выплаты"><TimeMsk at={shift.startedAt} show="weekday" />, <TimeMsk at={shift.startedAt} show="time" />–<TimeMsk at={shift.endedAt} show="time" /></ShiftLink>
                      : <><TimeMsk at={shift.startedAt} show="weekday" />, <TimeMsk at={shift.startedAt} show="time" />–<TimeMsk at={shift.endedAt} show="time" /></>}
                    <span className="payouts-sub">
                      {shiftLine(shift)}
                      {shift.ongoing ? " · ещё идёт" : shift.tooLate ? " · подтвердить уже нельзя" : ""}
                    </span>
                  </span>
                  <Money mills={shift.salesNetMills} />
                </li>
              ))}
            </ul>
            <p className="payouts-note">Продажи по сменам Hub, до отметок чаттера. В выгрузку попадут, когда чаттер подтвердит смену в кабинете.</p>
          </section>
        )}

        {chatter.ownAmounts.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Своя сумма вместо суммы Hub</h3>
            <ul className="payouts-shifts">
              {chatter.ownAmounts.map((own) => (
                <li key={own.saleRef}>
                  <span>{own.pageLabel}, <TimeMsk at={own.occurredAt} /><span className="payouts-sub">Hub: <Money mills={own.netMills} /></span></span>
                  <Money mills={own.amountMills} strong />
                </li>
              ))}
            </ul>
          </section>
        )}

        {chatter.lateChanges.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Изменено после подтверждения дня</h3>
            <ul className="payouts-shifts">
              {chatter.lateChanges.map((late) => (
                <li key={`${late.change}-${late.saleRef}-${late.at}`}>
                  <span>{late.change === "added" ? "Дописано" : "Снято"} · {late.pageLabel}, день {formatDay(late.payDay)}<span className="payouts-sub">изменено <TimeMsk at={late.at} /></span></span>
                  <Money mills={late.creditedMills} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Drawer>
  );
}
