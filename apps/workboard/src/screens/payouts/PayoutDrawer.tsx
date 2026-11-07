import { Copy } from "lucide-react";
import { Button, Drawer, Facts, Money, Table, TimeMsk, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatDay, formatDuration, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { sheetCell, sheetText, type PivotRow } from "@agency_hub_core/ui/payoutSheet";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { sumMills } from "@agency_hub_core/shared";
import { PersonLink, ShiftLink } from "@/shared/links";
import { copySheet } from "./copy";
import type { PayoutChatter, PayoutsView, UnconfirmedShift } from "./data";
import type { RangeWords } from "./range";

/** «02.11»: a day's column, as the console's sheet heads it. */
function dayHead(day: string): string {
  return `${day.slice(8)}.${day.slice(5, 7)}`;
}

/**
 * The whole export by days, as it pastes (D10): a page per row, a day per
 * column, each cell written exactly as the payout sheet gets it (no «$»,
 * Fansly to the cent, OnlyFans whole dollars). The chatter, the page and the
 * total stay in place while a long window's days scroll; «ещё N дней →» says
 * how many are out of sight.
 */
export function SheetDayTable({ sheet, days, withChatter = false }: { sheet: readonly PivotRow[]; days: readonly string[]; withChatter?: boolean }) {
  const columns: Column<PivotRow>[] = [
    ...(withChatter ? [{
      key: "who",
      header: "Чаттер",
      nowrap: true,
      // A chatter's name heads their block only, as in the sheet.
      cell: (row: PivotRow, index: number) => (index === 0 || sheet[index - 1]?.username !== row.username ? <span className="payouts-strong">{row.username}</span> : ""),
    } satisfies Column<PivotRow>] : []),
    { key: "page", header: "Страница", nowrap: true, cell: (row) => row.pageLabel },
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
      cell: (row) => (row.cells.has(day) ? sheetCell(row.platform, row.cells.get(day)!) : ""),
    })),
  ];
  return (
    <Table
      label="Выгрузка по дням"
      columns={columns}
      rows={sheet}
      rowKey={(row) => `${row.username}\u0000${row.pageLabel}`}
      rowClassName={(row) => (sheet[0]?.username !== row.username && sheet.find((one) => one.username === row.username) === row ? "payouts-block-start" : undefined)}
      dense
      stickyHeader={false}
      stickyColumns={withChatter ? 3 : 2}
      moreLabel={(hidden) => `ещё ${hidden} ${ruPlural(hidden, "день", "дня", "дней")}`}
    />
  );
}

interface DayRow {
  day: string;
  cells: Map<string, number>;
}

/**
 * One chatter's days in a narrow panel (В2): a day per row, a page per column
 * (one to three), the total at the end — every day of any window fits.
 */
function ChatterDays({ chatter }: { chatter: PayoutChatter }) {
  const pages = chatter.sheet.map((row) => row.pageLabel);
  const days = [...new Set(chatter.sheet.flatMap((row) => [...row.cells.keys()]))].sort();
  const rows: DayRow[] = days.map((day) => {
    const cells = new Map<string, number>();
    for (const row of chatter.sheet) {
      const value = row.cells.get(day);
      if (value !== undefined) cells.set(row.pageLabel, value);
    }
    return { day, cells };
  });
  const columns: Column<DayRow>[] = [
    { key: "day", header: "День", nowrap: true, cell: (row) => formatWeekdayDay(row.day), footer: <span className="payouts-total">Итого</span> },
    ...pages.map((page): Column<DayRow> => ({
      key: `page:${page}`,
      header: page,
      numeric: true,
      nowrap: true,
      cell: (row) => (row.cells.has(page) ? <Money mills={row.cells.get(page)!} /> : <span className="text-ink-3">—</span>),
      footer: <Money mills={sumMills(rows.map((row) => row.cells.get(page) ?? 0))} strong={pages.length === 1} />,
    })),
    ...(pages.length > 1 ? [{
      key: "total",
      header: "За день",
      numeric: true,
      nowrap: true,
      cell: (row: DayRow) => <Money mills={sumMills(row.cells.values())} strong />,
      footer: <Money mills={chatter.confirmedMills} strong />,
    } satisfies Column<DayRow>] : []),
  ];
  return <Table label={`Выплата ${chatter.username} по дням`} columns={columns} rows={rows} rowKey={(row) => row.day} dense stickyHeader={false} />;
}

function shiftLine(shift: UnconfirmedShift): string {
  const minutes = Math.max(0, Math.round((Date.parse(shift.endedAt) - Date.parse(shift.startedAt)) / 60_000));
  return formatDuration(minutes);
}

/** One chatter's payout of the window: the days, their own amounts, the shifts not confirmed, the late changes; their block to copy. */
export function PayoutDrawer({ chatter, view, words, canCopy, onClose }: {
  chatter: PayoutChatter;
  view: PayoutsView;
  /** The export's days in words, with what still goes on («неделя ещё идёт»). */
  words: RangeWords;
  canCopy: boolean;
  onClose: () => void;
}) {
  const lines = chatter.sheet.length;
  const copy = () => void copySheet(
    sheetText(chatter.sheet, view.days),
    `Скопировано: блок ${chatter.username}, ${lines} ${ruPlural(lines, "строка", "строки", "строк")}, ${words.range}${words.copyNote}`,
  );
  const stake = chatter.unconfirmed.length;
  return (
    <Drawer
      open
      onClose={onClose}
      title={chatter.userId !== null ? <PersonLink userId={chatter.userId} name={chatter.username} backLabel="Выплаты" /> : chatter.username}
      subtitle={<>Выплата за {words.range}{words.note}, все страницы</>}
      footer={(
        <>
          <Button onClick={onClose}>Закрыть</Button>
          <Tooltip content={lines === 0 ? "Нечего копировать: подтверждённых отчётов нет" : `Блок ${chatter.username} за все дни периода, как в таблице выплат`} align="end">
            <Button variant="primary" icon={Copy} disabled={!canCopy || lines === 0} onClick={copy}>
              Скопировать блок {chatter.username}
            </Button>
          </Tooltip>
        </>
      )}
    >
      <div className="payouts-drawer">
        <Facts
          label={`Выплата ${chatter.username}`}
          items={[
            { label: "Подтверждено", value: <Money mills={chatter.confirmedMills} />, strong: true },
            { label: "Дней с продажами", value: chatter.days },
            {
              label: "Ждут подтверждения",
              value: stake === 0 ? "—" : <Money mills={chatter.atStakeMills} />,
              ...(stake > 0 ? { meta: `${stake} ${ruPlural(stake, "смена", "смены", "смен")}` } : {}),
            },
          ]}
        />

        {lines > 0 ? (
          <section className="payouts-block">
            <h3 className="payouts-block__title">По дням</h3>
            <ChatterDays chatter={chatter} />
            <p className="payouts-note">
              Здесь — дни с продажами. Скопируется блок за все {view.days.length} {ruPlural(view.days.length, "день", "дня", "дней")} периода, как в
              таблице выплат.
            </p>
          </section>
        ) : (
          <p className="payouts-note">Подтверждённых отчётов за эти дни нет: в выгрузку от {chatter.username} ничего не попадёт.</p>
        )}

        {chatter.ownAmounts.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Своя сумма вместо суммы Hub</h3>
            <ul className="payouts-shifts">
              {chatter.ownAmounts.map((own) => (
                <li key={own.saleRef}>
                  <span>{own.pageLabel}, <TimeMsk at={own.occurredAt} /><span className="payouts-sub">у Hub <Money mills={own.netMills} /></span></span>
                  <Money mills={own.amountMills} strong />
                </li>
              ))}
            </ul>
            <p className="payouts-note">В выгрузку идёт сумма чаттера.</p>
          </section>
        )}

        {stake > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Смены без подтверждения</h3>
            <ul className="payouts-shifts">
              {chatter.unconfirmed.map((shift) => {
                const when = <><TimeMsk at={shift.startedAt} show="weekday" />, <TimeMsk at={shift.startedAt} show="time" />–<TimeMsk at={shift.endedAt} show="time" /></>;
                return (
                  <li key={shift.startedAt}>
                    <span>
                      {chatter.userId !== null ? <ShiftLink userId={chatter.userId} startedAt={shift.startedAt} backLabel="Выплаты">{when}</ShiftLink> : when}
                      <span className="payouts-sub">
                        {shiftLine(shift)}
                        {shift.ongoing ? " · ещё идёт" : shift.tooLate ? " · подтвердить уже нельзя" : ""}
                      </span>
                    </span>
                    <Money mills={shift.salesNetMills} />
                  </li>
                );
              })}
            </ul>
            <p className="payouts-note">Продажи по сменам Hub, до отметок чаттера. В выгрузку попадут, когда чаттер подтвердит смену в кабинете.</p>
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
