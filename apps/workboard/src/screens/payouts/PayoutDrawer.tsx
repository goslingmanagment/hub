import { Copy } from "lucide-react";
import { Button, Drawer, Facts, Money, Table, TimeMsk, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { sheetCell, sheetText, type PivotRow } from "@agency_hub_core/ui/payoutSheet";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { shiftDurationHint, shiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { sumMills } from "@agency_hub_core/shared";
import { PersonLink, ShiftLink } from "@/shared/links";
import { copySheet } from "./copy";
import { pastedMills, pastedRowMills, type PayoutChatter, type PayoutsView, type UnconfirmedShift } from "./data";
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
      // The row's cells as they paste, added up: the sheet's own sum after the paste (В-н1).
      cell: (row) => <Money mills={pastedRowMills(row)} strong />,
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
  /** Each page's cell of the day as it pastes (mills). */
  cells: Map<string, bigint>;
}

/**
 * One chatter's days in a narrow panel (В2): a day per row, a page per column
 * (one to three), the total at the end — every day of any window fits. Each
 * cell is the sheet's cell as it pastes, and every total adds those (В-н1): the
 * panel, the copy and the pasted sheet agree to the cent.
 */
function ChatterDays({ chatter }: { chatter: PayoutChatter }) {
  const pages = chatter.sheet.map((row) => row.pageLabel);
  const days = [...new Set(chatter.sheet.flatMap((row) => [...row.cells.keys()]))].sort();
  const rows: DayRow[] = days.map((day) => {
    const cells = new Map<string, bigint>();
    for (const row of chatter.sheet) {
      const value = row.cells.get(day);
      if (value !== undefined) cells.set(row.pageLabel, pastedMills(row.platform, value));
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
      footer: <Money mills={sumMills(rows.map((row) => row.cells.get(page) ?? 0n))} strong={pages.length === 1} />,
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

/** «8 ч 21 мин · ещё идёт»: the shift's worked time (D12, pauses only in the hint) and what holds it. */
function ShiftNote({ shift }: { shift: UnconfirmedShift }) {
  const when = shiftWhen(shift);
  const state = shift.ongoing ? "ещё идёт" : shift.tooLate ? "подтвердить уже нельзя" : null;
  const parts = [when.worked, state].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const hint = shiftDurationHint(when);
  const text = parts.join(" · ");
  return <span className="payouts-sub">{hint !== null && when.withPauses !== null ? <Tooltip content={hint} align="start">{text}</Tooltip> : text}</span>;
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
              // Nothing waits is a fact, not a missing answer: «нет», not «—».
              value: stake === 0 ? "нет" : chatter.atStakeMills === null ? "нет данных" : <Money mills={chatter.atStakeMills} />,
              ...(stake > 0 ? { meta: `${stake} ${ruPlural(stake, "смена", "смены", "смен")}` } : {}),
            },
          ]}
        />

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

        {stake > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Смены без подтверждения</h3>
            <ul className="payouts-shifts">
              {chatter.unconfirmed.map((shift) => {
                // One label of a shift on every screen (D12): «пт, 6–7 нояб. 21:45–07:31».
                const label = shiftWhen(shift).label;
                return (
                  <li key={shift.startedAt}>
                    <span>
                      {chatter.userId !== null ? <ShiftLink userId={chatter.userId} startedAt={shift.startedAt} backLabel="Выплаты">{label}</ShiftLink> : label}
                      <ShiftNote shift={shift} />
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
