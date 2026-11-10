import { useState, type CSSProperties } from "react";
import { ChevronRight } from "lucide-react";
import { Button, Drawer, Facts, Money, Notice, Person, Table, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatAgo, formatDay, formatDayRange, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { PersonLink } from "@/shared/links";
import { Tiles, TilesSkeleton, type Tile } from "@/shared/Tiles";
import type { TeamLedgerPayoutPerson } from "@agency_hub_core/contracts";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { reportOfDay, useLedgerReports, type LedgerRow, type LedgerView, type StripDay } from "./ledger";
import { PayoutBrief } from "./PayoutBrief";
import { ReportDetail } from "./ReportDetail";
import { reportRowOf, sourceWord } from "./reportRows";

/**
 * «Выплаты → Долги» from the agency ledger: four numbers, then a row per person
 * — what the agency owes them now, since when, the period's days as a strip
 * (paid, owed), accrued and paid. A row opens the person's panel (`?person=`):
 * the payout, the days owed, and the period's days — each with where its amount
 * came from, a day with a report opening in place to it.
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

/** The app's one way to show a person: their Hub login; the ledger's name beside it when it says more. */
function PersonCell({ row }: { row: LedgerRow }) {
  const { person } = row;
  const name = person.hubUser?.username ?? person.name;
  const own = person.hubUser !== null && person.name.trim().toLowerCase() !== name.toLowerCase() ? person.name : null;
  const hint = person.status === "left" ? ["не работает", own].filter(Boolean).join(" · ") : person.hubUser === null ? "не связан с Hub" : own;
  return <Person name={name} status={person.status === "left" ? "disabled" : "away"} hint={hint} />;
}

/** «изменён выплаченный день»: a paid day whose report changed since waits for the owner's word. */
function PendingNote({ row }: { row: LedgerRow }) {
  const count = row.pendingChanges.length;
  if (count === 0) return null;
  const days = row.pendingChanges.map((change) => formatDay(change.day)).join(", ");
  return (
    <span className="payouts-sub payouts-drift">
      <Tooltip content={<>{days}: отчёт изменился после выплаты. Ledger не меняет выплаченный день сам — поправка войдёт в следующую выплату, когда вы её подтвердите.</>} align="end">
        <span>{count === 1 ? "изменён выплаченный день" : `изменены ${count} ${ruPlural(count, "выплаченный день", "выплаченных дня", "выплаченных дней")}`}</span>
      </Tooltip>
    </span>
  );
}

const UNENTERED_HINT = "Дни, когда Hub видит продажи в смене человека по графику, а в его вкладке таблицы выплат пусто. В долг не входят, пока их не занесут; сумма — оценка по ставке вкладки.";

/** «не занесено ≈ $648» under the debt: pay the sheet has not got yet (the days are in the hint and the panel). */
function Unentered({ row }: { row: LedgerRow }) {
  if (row.unenteredDays === 0) return null;
  return (
    <span className="payouts-sub payouts-drift">
      <Tooltip content={<>{row.unenteredDays} дн. · {UNENTERED_HINT}</>} align="end">
        <span>не занесено ≈ <Money mills={row.unenteredMills} /></span>
      </Tooltip>
    </span>
  );
}

function OwedCell({ row }: { row: LedgerRow }) {
  if (row.owedMills === 0n) {
    return row.unenteredDays > 0 || row.pendingChanges.length > 0
      ? <span><span className="text-ink-3">—</span><Unentered row={row} /><PendingNote row={row} /></span>
      : <span className="text-ink-3">—</span>;
  }
  return (
    <span>
      <Money mills={row.owedMills} strong={row.owedMills > 0n} muted={row.owedMills < 0n} />
      <Unentered row={row} />
      <PendingNote row={row} />
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

/** Where the ledger's days come from: «по таблицам выплат, с 2 нояб. — по фактам Hub, с 9 нояб. — по отправленным отчётам». */
export function accrualWords(view: Pick<LedgerView, "factsFrom" | "reportsFrom">): string {
  const parts = ["по таблицам выплат"];
  if (view.factsFrom !== null && (view.reportsFrom === null || view.factsFrom < view.reportsFrom)) parts.push(`с ${formatDay(view.factsFrom)} — по фактам Hub`);
  if (view.reportsFrom !== null) parts.push(`с ${formatDay(view.reportsFrom)} — по отправленным отчётам`);
  return parts.join(", ");
}

function tilesOf(view: LedgerView): Tile[] {
  const range = formatDayRange(view.from, view.to);
  const accrual = accrualWords(view);
  return [
    {
      label: "Долг сейчас",
      value: <Money mills={view.owedMills} />,
      sub: view.owedPeople > 0 ? `${view.owedPeople} ${ruPlural(view.owedPeople, "человек", "человека", "человек")}` : "никому",
      hint: `Сколько агентство должно людям сейчас: начисленное (${accrual}) минус выплаты, по подсчёту ledger.`,
    },
    {
      label: "Начислено",
      value: <Money mills={view.accruedMills} />,
      sub: range,
      hint: `Начислено за дни периода: ${accrual}.`,
    },
    {
      label: "Выплачено",
      value: <Money mills={view.paidMills} />,
      sub: range,
      hint: "Выплаты, записанные в ledger на дни периода.",
    },
    ...(view.unenteredMills > 0n ? [{
      label: "Не занесено",
      value: <>≈ <Money mills={view.unenteredMills} /></>,
      sub: `${view.unenteredPeople} ${ruPlural(view.unenteredPeople, "человек", "человека", "человек")}`,
      hint: UNENTERED_HINT,
    }] : []),
    {
      label: "Дольше всех ждёт",
      value: view.oldest ? formatDay(view.oldest.date) : "—",
      sub: view.oldest ? view.oldest.row.person.name : "все выплачены",
      hint: "Самый старый невыплаченный день среди всех.",
    },
  ];
}

export function LedgerSkeleton() {
  // The tiles' row and the table's, without the view's switch: it stands in the header.
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
  const tiles = tilesOf(view);
  return (
    <>
      {view.checks.stale && (
        <Notice tone="warning">
          Ledger давно не обновлялся{collected ? `: таблицы собраны в ${formatTimeOfDay(Date.parse(collected))}, ${formatAgo(Date.parse(collected), Date.now())}` : ""}. Суммы могут отставать.
        </Notice>
      )}
      {/* The ledger's four or five numbers stay one row down to a phone (payouts.css). */}
      <div style={{ "--payouts-tiles": tiles.length } as CSSProperties}>
        <Tiles tiles={tiles} label="Выплаты за период" />
      </div>
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
        <span className="payouts-legend__fresh">
          {[
            view.reportsFrom !== null ? `с ${formatDay(view.reportsFrom)} начисляют отправленные отчёты` : null,
            collected ? `таблицы собраны ${formatAgo(Date.parse(collected), Date.now())}` : null,
          ].filter(Boolean).join(" · ")}
        </span>
      </p>
    </>
  );
}

type OwedDay = TeamLedgerPayoutPerson["unpaidDays"][number];
type AccruedDay = TeamLedgerPayoutPerson["days"][number];
type PendingChange = TeamLedgerPayoutPerson["pendingChanges"][number];

/**
 * One person's pay: the payout to make, what is owed day by day, the paid days whose report changed since, and the
 * period's accrued days — each saying where its amount came from; a day with a report opens in place to it.
 */
export function LedgerPersonDrawer({ row, view, period, onClose }: { row: LedgerRow; view: LedgerView; period: ResolvedPeriod; onClose: () => void }) {
  const { person } = row;
  const owedDays = person.unpaidDays;
  const accrued = person.days.filter((day) => day.amountMills !== 0);
  const owedDates = new Set(owedDays.filter((day) => day.kind === "day").map((day) => day.date));
  const reports = useLedgerReports(period, accrued.length > 0);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const dayKey = (day: AccruedDay) => `${day.date}-${day.model}`;
  const owedColumns: Column<OwedDay>[] = [
    { key: "day", header: "День", nowrap: true, cell: (day) => (day.kind === "opening" ? `до ${formatDay(view.accrualFrom)}` : formatWeekdayDay(day.date)), footer: <span className="payouts-total">Итого</span> },
    { key: "model", header: "Модель", grow: true, cell: (day) => day.model ?? (day.kind === "opening" ? "долг до учёта" : "—") },
    { key: "sum", header: "Сумма", numeric: true, cell: (day) => <Money mills={day.unpaidMills} />, footer: <Money mills={row.owedMills} strong /> },
  ];
  const dayColumns: Column<AccruedDay>[] = [
    { key: "day", header: "День", nowrap: true, cell: (day) => formatWeekdayDay(day.date) },
    { key: "model", header: "Модель", cell: (day) => day.model },
    // Where the amount came from, in one quiet word: «таблица», «отчёт», «факты».
    { key: "source", header: "Откуда", muted: true, nowrap: true, cell: (day) => sourceWord(day.source) },
    { key: "state", header: "", grow: true, cell: (day) => (owedDates.has(day.date) ? <span className="payouts-late">ждёт</span> : <span className="text-ink-3">выплачено</span>) },
    { key: "sum", header: "Сумма", numeric: true, cell: (day) => <Money mills={day.amountMills} /> },
  ];
  const pendingColumns: Column<PendingChange>[] = [
    { key: "day", header: "День", nowrap: true, cell: (change) => formatWeekdayDay(change.day) },
    { key: "what", header: "Почему", grow: true, cell: (change) => <span>{change.model}{change.reason && <span className="payouts-sub">{change.reason}</span>}</span> },
    { key: "was", header: "Было", numeric: true, nowrap: true, cell: (change) => <Money mills={change.postedMills} muted /> },
    { key: "now", header: "Стало", numeric: true, nowrap: true, cell: (change) => <Money mills={change.newMills} strong /> },
  ];
  const detailOf = (day: AccruedDay) => {
    // Until the reports come, no day offers to open: the chevrons appear with them, in their reserved place.
    if (reports.data === null) return null;
    const report = reportOfDay(reports.data, person.slug, day.date);
    return report === null ? null : <ReportDetail row={reportRowOf(report, reports.data)} panel />;
  };
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={person.hubUser ? <PersonLink userId={person.hubUser.userId} name={person.hubUser.username} backLabel="Выплаты" /> : person.name}
      subtitle={[person.hubUser && person.name.toLowerCase() !== person.hubUser.username.toLowerCase() ? person.name : null, formatDayRange(view.from, view.to)].filter(Boolean).join(" · ")}
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <div className="payouts-drawer">
        <Facts
          label={`Выплаты ${person.name}`}
          items={[
            { label: "Долг сейчас", value: <Money mills={row.owedMills} />, strong: true },
            ...(row.waitingDays !== null && person.oldestUnpaidDate !== null ? [{ label: "Ждёт с", value: formatDay(person.oldestUnpaidDate) }] : []),
            ...(row.sheetDiffMills !== null ? [{ label: "В таблице", value: <Money mills={row.owedMills + row.sheetDiffMills} /> }] : []),
            ...(row.unenteredDays > 0 ? [{ label: "Не занесено", value: <>≈ <Money mills={row.unenteredMills} /></>, meta: `${row.unenteredDays} дн.`, hint: UNENTERED_HINT }] : []),
            { label: "Начислено", value: <Money mills={row.accruedMills} /> },
            { label: "Выплачено", value: <Money mills={row.paidMills} /> },
          ]}
        />

        <PayoutBrief slug={person.slug} name={person.name} />

        {row.pendingChanges.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Изменились выплаченные дни</h3>
            <p className="payouts-note">Отчёт поменялся после выплаты. Ledger сам выплаченный день не меняет: поправка войдёт в следующую выплату после вашего «да».</p>
            <Table label={`Изменились выплаченные дни ${person.name}`} columns={pendingColumns} rows={row.pendingChanges} rowKey={(change) => String(change.id)} dense stickyHeader={false} fit={false} />
          </section>
        )}

        {owedDays.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Не выплачено</h3>
            <Table label={`Не выплачено ${person.name}`} columns={owedColumns} rows={owedDays} rowKey={(day) => `${day.kind}-${day.date}-${day.model ?? ""}`} dense stickyHeader={false} fit={false} />
          </section>
        )}

        {accrued.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Начислено за период</h3>
            <Table
              label={`Начислено ${person.name} по дням`}
              columns={dayColumns}
              rows={accrued}
              rowKey={dayKey}
              rowDetail={detailOf}
              openKeys={open}
              onOpenChange={(day, next) => setOpen((current) => {
                const updated = new Set(current);
                if (next) updated.add(dayKey(day));
                else updated.delete(dayKey(day));
                return updated;
              })}
              dense
              stickyHeader={false}
              fit={false}
            />
          </section>
        )}
      </div>
    </Drawer>
  );
}
