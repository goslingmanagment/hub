import { ChevronRight } from "lucide-react";
import { Button, Drawer, Facts, Money, Notice, Person, Table, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatAgo, formatDay, formatDayRange, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { PersonLink } from "@/shared/links";
import { Tiles, TilesSkeleton, type Tile } from "@/shared/Tiles";
import type { TeamLedgerPayoutPerson } from "@agency_hub_core/contracts";
import type { LedgerRow, LedgerView, StripDay } from "./ledger";

/**
 * Выплаты from the agency ledger, the screen's first block: four numbers, then
 * a row per person — what the agency owes them now, since when, the period's
 * days as a strip (paid, owed), accrued and paid. A row opens the person's
 * panel (`?person=`): the days owed and the period's days.
 */

const daysWord = (count: number) => `${count} ${ruPlural(count, "день", "дня", "дней")}`;

const STATE_WORD: Record<StripDay["state"], string> = {
  none: "не начислено",
  paid: "выплачено",
  owed: "ждёт выплаты",
  future: "ещё не наступил",
};

/** The period's days of one person, a cell per day: one look says who waits since when. */
function Strip({ strip }: { strip: readonly StripDay[] }) {
  return (
    <span className="payouts-strip" aria-hidden>
      {strip.map((day) => <i key={day.day} className={`payouts-strip__day payouts-strip__day--${day.state}`} title={`${formatWeekdayDay(day.day)} — ${STATE_WORD[day.state]}`} />)}
    </span>
  );
}

function PersonCell({ row }: { row: LedgerRow }) {
  const { person } = row;
  const hint = person.status === "left" ? "не работает" : person.hubUser === null ? "не связан с Hub" : null;
  return <Person name={person.name} status={person.status === "left" ? "disabled" : "away"} hint={hint} />;
}

function OwedCell({ row }: { row: LedgerRow }) {
  if (row.owedMills === 0n) return <span className="text-ink-3">—</span>;
  return (
    <span>
      <Money mills={row.owedMills} strong={row.owedMills > 0n} muted={row.owedMills < 0n} />
      {/* A minus: paid ahead of the accruals, the agency owes nothing. */}
      {row.owedMills < 0n && <span className="payouts-sub">выплачено вперёд</span>}
      {row.sheetDiffMills !== null && (
        <span className="payouts-sub payouts-drift">
          <Tooltip content="«К выплате» в таблице выплат не совпадает с подсчётом ledger: проверьте вкладку человека." align="end">
            <span>в таблице <Money mills={row.owedMills + row.sheetDiffMills} /></span>
          </Tooltip>
        </span>
      )}
    </span>
  );
}

/** A zero is a dash: the column reads by who has money in it. */
function ZeroDash({ mills }: { mills: bigint }) {
  return mills === 0n ? <span className="text-ink-3">—</span> : <Money mills={mills} />;
}

function WaitingCell({ row }: { row: LedgerRow }) {
  if (row.waitingDays === null || row.person.oldestUnpaidDate === null) return <span className="text-ink-3">—</span>;
  const long = row.waitingDays > 8;
  return (
    <span>
      <span className={long ? "payouts-late" : undefined}>{formatDay(row.person.oldestUnpaidDate)}</span>
      <span className="payouts-sub">{daysWord(row.waitingDays)}</span>
    </span>
  );
}

function tilesOf(view: LedgerView): Tile[] {
  const range = formatDayRange(view.from, view.to);
  return [
    {
      label: "Долг сейчас",
      value: <Money mills={view.owedMills} />,
      sub: view.owedPeople > 0 ? `${view.owedPeople} ${ruPlural(view.owedPeople, "человек", "человека", "человек")}` : "никому",
      hint: "Сколько агентство должно людям сейчас: начислено по таблицам выплат минус выплаты, по подсчёту ledger.",
    },
    {
      label: "Начислено",
      value: <Money mills={view.accruedMills} />,
      sub: range,
      hint: "Начислено за дни периода по таблицам выплат.",
    },
    {
      label: "Выплачено",
      value: <Money mills={view.paidMills} />,
      sub: range,
      hint: "Выплаты, записанные в ledger на дни периода.",
    },
    {
      label: "Дольше всех ждёт",
      value: view.oldest ? formatDay(view.oldest.date) : "—",
      sub: view.oldest ? view.oldest.row.person.name : "все выплачены",
      hint: "Самый старый невыплаченный день среди всех.",
    },
  ];
}

export function LedgerSkeleton() {
  return (
    <>
      <TilesSkeleton count={4} sub />
      <Table label="Выплаты по людям" columns={SKELETON_COLUMNS} rows={[]} rowKey={() => ""} loading skeletonRows={5} skeletonLines={2} />
    </>
  );
}

const SKELETON_COLUMNS: Column<never>[] = [
  { key: "who", header: "Человек", cell: () => null },
  { key: "owed", header: "Долг", numeric: true, width: 130, cell: () => null },
  { key: "since", header: "Ждёт с", width: 100, cell: () => null },
  { key: "accrued", header: "Начислено", numeric: true, width: 116, cell: () => null },
  { key: "paid", header: "Выплачено", numeric: true, width: 116, cell: () => null },
  { key: "days", header: "Дни периода", cell: () => null },
  { key: "go", header: "", width: 44, cell: () => null },
];

export function LedgerPayouts({ view, selected, onOpen }: { view: LedgerView; selected: string | null; onOpen: (slug: string) => void }) {
  const columns: Column<LedgerRow>[] = [
    { key: "who", header: "Человек", nowrap: true, cell: (row) => <PersonCell row={row} />, sortValue: (row) => row.person.name, footer: <span className="payouts-total">Итого</span> },
    { key: "owed", header: "Долг", numeric: true, width: 130, cell: (row) => <OwedCell row={row} />, sortValue: (row) => row.owedMills, footer: <Money mills={view.owedMills} strong /> },
    { key: "since", header: "Ждёт с", width: 100, cell: (row) => <WaitingCell row={row} />, sortValue: (row) => row.person.oldestUnpaidDate },
    { key: "accrued", header: "Начислено", numeric: true, width: 116, cell: (row) => <ZeroDash mills={row.accruedMills} />, sortValue: (row) => row.accruedMills, footer: <Money mills={view.accruedMills} /> },
    { key: "paid", header: "Выплачено", numeric: true, width: 116, cell: (row) => <ZeroDash mills={row.paidMills} />, sortValue: (row) => row.paidMills, footer: <Money mills={view.paidMills} /> },
    // Last: on a narrow screen the strip is what scrolls, never the money.
    { key: "days", header: "Дни периода", grow: true, cell: (row) => <Strip strip={row.strip} /> },
    { key: "go", header: <span className="ui-sr-only">Открыть</span>, width: 44, cell: () => <ChevronRight size={18} strokeWidth={1.75} aria-hidden className="payouts-go" /> },
  ];
  const collected = view.checks.lastSheetsCollectAt;
  return (
    <>
      {view.checks.stale && (
        <Notice tone="warning">
          Ledger давно не обновлялся{collected ? `: таблицы собраны в ${formatTimeOfDay(Date.parse(collected))}, ${formatAgo(Date.parse(collected), Date.now())}` : ""}. Суммы могут отставать.
        </Notice>
      )}
      <Tiles tiles={tilesOf(view)} label="Выплаты за период" />
      {view.rows.length === 0 ? (
        <p className="payouts-note">За {formatDayRange(view.from, view.to)} ни начислений, ни долгов.</p>
      ) : (
        <Table
          label="Выплаты по людям"
          columns={columns}
          rows={view.rows}
          rowKey={(row) => row.person.slug}
          onRowClick={(row) => onOpen(row.person.slug)}
          selectedKey={selected}
          align="first-line"
          skeletonLines={2}
        />
      )}
      <p className="payouts-legend" aria-hidden>
        <span><i className="payouts-strip__day payouts-strip__day--paid" /> выплачено</span>
        <span><i className="payouts-strip__day payouts-strip__day--owed" /> ждёт выплаты</span>
        <span><i className="payouts-strip__day payouts-strip__day--none" /> нет начисления</span>
        {collected && <span className="payouts-legend__fresh">таблицы собраны {formatAgo(Date.parse(collected), Date.now())}</span>}
      </p>
    </>
  );
}

type OwedDay = TeamLedgerPayoutPerson["unpaidDays"][number];
type AccruedDay = TeamLedgerPayoutPerson["days"][number];

/** One person's pay: what is owed day by day, and the period's accrued days. */
export function LedgerPersonDrawer({ row, view, onClose }: { row: LedgerRow; view: LedgerView; onClose: () => void }) {
  const { person } = row;
  const owedDays = person.unpaidDays;
  const accrued = person.days.filter((day) => day.amountMills !== 0);
  const owedDates = new Set(owedDays.filter((day) => day.kind === "day").map((day) => day.date));
  const owedColumns: Column<OwedDay>[] = [
    { key: "day", header: "День", nowrap: true, cell: (day) => (day.kind === "opening" ? `до ${formatDay(view.accrualFrom)}` : formatWeekdayDay(day.date)), footer: <span className="payouts-total">Итого</span> },
    { key: "model", header: "Модель", cell: (day) => day.model ?? (day.kind === "opening" ? "долг до учёта" : "—") },
    { key: "sum", header: "Сумма", numeric: true, cell: (day) => <Money mills={day.unpaidMills} />, footer: <Money mills={row.owedMills} strong /> },
  ];
  const dayColumns: Column<AccruedDay>[] = [
    { key: "day", header: "День", nowrap: true, cell: (day) => formatWeekdayDay(day.date) },
    { key: "model", header: "Модель", cell: (day) => day.model },
    { key: "state", header: "", cell: (day) => (owedDates.has(day.date) ? <span className="payouts-late">ждёт</span> : <span className="text-ink-3">выплачено</span>) },
    { key: "sum", header: "Сумма", numeric: true, cell: (day) => <Money mills={day.amountMills} /> },
  ];
  return (
    <Drawer
      open
      onClose={onClose}
      title={person.hubUser ? <PersonLink userId={person.hubUser.userId} name={person.name} backLabel="Выплаты" /> : person.name}
      subtitle={formatDayRange(view.from, view.to)}
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <div className="payouts-drawer">
        <Facts
          label={`Выплаты ${person.name}`}
          items={[
            { label: "Долг сейчас", value: <Money mills={row.owedMills} />, strong: true },
            ...(row.waitingDays !== null && person.oldestUnpaidDate !== null ? [{ label: "Ждёт с", value: formatDay(person.oldestUnpaidDate) }] : []),
            ...(row.sheetDiffMills !== null ? [{ label: "В таблице", value: <Money mills={row.owedMills + row.sheetDiffMills} /> }] : []),
            { label: "Начислено", value: <Money mills={row.accruedMills} /> },
            { label: "Выплачено", value: <Money mills={row.paidMills} /> },
          ]}
        />

        {owedDays.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Не выплачено</h3>
            <Table label={`Не выплачено ${person.name}`} columns={owedColumns} rows={owedDays} rowKey={(day) => `${day.kind}-${day.date}-${day.model ?? ""}`} dense stickyHeader={false} />
          </section>
        )}

        {accrued.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Начислено за период</h3>
            <Table label={`Начислено ${person.name} по дням`} columns={dayColumns} rows={accrued} rowKey={(day) => `${day.date}-${day.model}`} dense stickyHeader={false} />
          </section>
        )}
      </div>
    </Drawer>
  );
}
