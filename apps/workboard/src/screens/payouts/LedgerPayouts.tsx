import { useState, type CSSProperties } from "react";
import { ChevronRight } from "lucide-react";
import { Button, Drawer, Facts, Money, Notice, Person, Table, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatAgo, formatDay, formatDayRange, formatSignedMills, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { PersonLink } from "@/shared/links";
import { Tiles, TilesSkeleton, type Tile } from "@/shared/Tiles";
import type { LedgerDayState, TeamLedgerPayoutPerson, TeamLedgerPayoutPersonResponse } from "@agency_hub_core/contracts";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { reportOfDay, useLedgerReports, usePayoutPerson, type LedgerRow, type LedgerView, type StripDay } from "./ledger";
import { PayoutBrief } from "./PayoutBrief";
import { ReportDetail } from "./ReportDetail";
import { reportRowOf, sourceWord } from "./reportRows";

/**
 * «Выплаты → Долги» from the agency ledger: four numbers, then a row per person
 * — what the agency owes them now, since when, the period's days as a strip
 * (оплачено, к выплате), accrued and paid. A row opens the person's panel
 * (`?person=`): the payout calculation the ledger gives (its lines, the total,
 * what to look at first, the text to copy), the adjustments with their reason,
 * and the period's days with their state — each with where its amount came
 * from, a day with a report opening in place to it. Each number names its own
 * source: the debts are the ledger's (rebuilt hourly), «в таблице» alone is the
 * payout sheets' and alone carries their age.
 */

const daysWord = (count: number) => `${count} ${ruPlural(count, "день", "дня", "дней")}`;

const STATE_WORD: Record<StripDay["state"], string> = {
  none: "не начислено",
  paid: "оплачено",
  owed: "к выплате",
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

function OwedCell({ row, checks }: { row: LedgerRow; checks: LedgerView["checks"] }) {
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
      {row.sheetDiffMills !== null && <SheetNote row={row} checks={checks} />}
    </span>
  );
}

/** When the payout sheets were read, in words: «прочитаны в 09:40, 4 ч назад»; null — never. */
function sheetsReadWords(checks: LedgerView["checks"]): string | null {
  const at = checks.lastSheetsCollectAt;
  return at === null ? null : `прочитаны в ${formatTimeOfDay(Date.parse(at))}, ${formatAgo(Date.parse(at), Date.now())}`;
}

/** «в таблице $…»: the one number that still comes from the payout sheets, with their age when they are old. */
function SheetNote({ row, checks }: { row: LedgerRow; checks: LedgerView["checks"] }) {
  const read = sheetsReadWords(checks);
  return (
    <span className="payouts-sub payouts-drift">
      <Tooltip content={<>«К выплате» в таблице выплат не совпадает с подсчётом ledger: проверьте вкладку человека. Таблицы {read ?? "ещё не прочитаны"}.</>} align="end">
        <span>
          в таблице <Money mills={row.owedMills + (row.sheetDiffMills ?? 0n)} />
          {checks.sheetsStale && checks.lastSheetsCollectAt !== null && <span className="payouts-stale">, {formatAgo(Date.parse(checks.lastSheetsCollectAt), Date.now())}</span>}
        </span>
      </Tooltip>
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

/** Where the ledger's days come from: «по таблицам выплат, с 2 нояб. по фактам Hub, с 9 нояб. по отправленным отчётам». */
export function accrualWords(view: Pick<LedgerView, "factsFrom" | "reportsFrom">): string {
  const parts = ["по таблицам выплат"];
  if (view.factsFrom !== null && (view.reportsFrom === null || view.factsFrom < view.reportsFrom)) parts.push(`с ${formatDay(view.factsFrom)} по фактам Hub`);
  if (view.reportsFrom !== null) parts.push(`с ${formatDay(view.reportsFrom)} по отправленным отчётам`);
  return parts.join(", ");
}

/** When the ledger last rebuilt the debts: «сведены в 12:20, 37 мин назад»; null — never. */
function debtsWords(checks: LedgerView["checks"]): string | null {
  const at = checks.lastRebuildAt;
  return at === null ? null : `сведены в ${formatTimeOfDay(Date.parse(at))}, ${formatAgo(Date.parse(at), Date.now())}`;
}

function tilesOf(view: LedgerView): Tile[] {
  const range = formatDayRange(view.from, view.to);
  const accrual = accrualWords(view);
  return [
    {
      label: "Долг сейчас",
      value: <Money mills={view.owedMills} />,
      sub: view.owedPeople > 0 ? `${view.owedPeople} ${ruPlural(view.owedPeople, "человек", "человека", "человек")}` : "никому",
      hint: `Сколько агентство должно людям сейчас: начисленное (${accrual}) минус выплаты, по подсчёту ledger. Долги ${debtsWords(view.checks) ?? "ещё не сводились"}.`,
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
    { key: "owed", header: "Долг", numeric: true, width: 130, cell: (row) => <OwedCell row={row} checks={view.checks} />, sortValue: (row) => row.owedMills, footer: <Money mills={view.owedMills} strong /> },
    { key: "since", header: "Ждёт с", width: 100, cell: (row) => <WaitingCell row={row} />, sortValue: (row) => row.person.oldestUnpaidDate },
    { key: "accrued", header: "Начислено", numeric: true, width: 116, cell: (row) => <ZeroDash mills={row.accruedMills} />, sortValue: (row) => row.accruedMills, footer: <Money mills={view.accruedMills} /> },
    { key: "paid", header: "Выплачено", numeric: true, width: 116, cell: (row) => <ZeroDash mills={row.paidMills} />, sortValue: (row) => row.paidMills, footer: <Money mills={view.paidMills} /> },
    // Last: on a narrow screen the strip is what scrolls, never the money.
    { key: "days", header: "Дни периода", grow: true, cell: (row) => <Strip strip={row.strip} /> },
    { key: "go", header: <span className="ui-sr-only">Открыть</span>, width: 44, cell: () => <ChevronRight size={18} strokeWidth={1.75} aria-hidden className="payouts-go" /> },
  ];
  const rebuilt = view.checks.lastRebuildAt;
  const collected = view.checks.lastSheetsCollectAt;
  const tiles = tilesOf(view);
  return (
    <>
      {/* The debts are the ledger's own rebuild: only its age makes every sum here old. The sheets' age is «в таблице»'s. */}
      {view.checks.debtsStale && (
        <Notice tone="warning">
          Ledger давно не сводил долги{rebuilt ? `: последний раз в ${formatTimeOfDay(Date.parse(rebuilt))}, ${formatAgo(Date.parse(rebuilt), Date.now())}` : ""}. Суммы могут отставать.
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
        <span><i className="payouts-strip__day payouts-strip__day--paid" /> оплачено</span>
        <span><i className="payouts-strip__day payouts-strip__day--owed" /> к выплате</span>
        <span><i className="payouts-strip__day payouts-strip__day--none" /> нет начисления</span>
        <span className="payouts-legend__fresh">
          {[
            view.reportsFrom !== null ? `с ${formatDay(view.reportsFrom)} начисляют отправленные отчёты` : null,
            rebuilt ? `долги сведены ${formatAgo(Date.parse(rebuilt), Date.now())}` : null,
            collected ? `«в таблице»: таблицы выплат, прочитаны ${formatAgo(Date.parse(collected), Date.now())}` : null,
          ].filter(Boolean).join(" · ")}
        </span>
      </p>
    </>
  );
}

type OwedDay = TeamLedgerPayoutPerson["unpaidDays"][number];
type PendingChange = TeamLedgerPayoutPerson["pendingChanges"][number];
type Adjustment = TeamLedgerPayoutPersonResponse["adjustments"][number];

/** A day of the period in the panel: by date and model, its amount, where it came from and its state by the payouts. */
interface PanelDay {
  date: string;
  model: string;
  source: string;
  amountMills: number;
  state: LedgerDayState;
  paidMills: number;
  unpaidMills: number;
  /** The journal rows of the payouts that paid it; empty — not known (the person read did not come) or none. */
  paidBy: number[];
}

/** The ledger's two states of a day, in its words: «к выплате» (in part: what is left), «оплачено». */
function DayState({ day }: { day: PanelDay }) {
  if (day.state === "to_pay") {
    return <span className="payouts-late">{day.paidMills > 0 ? <>к выплате <Money mills={day.unpaidMills} /></> : "к выплате"}</span>;
  }
  if (day.state === "paid") {
    const by = day.paidBy.map((num) => `#${num}`).join(", ");
    return by === "" ? <span className="text-ink-3">оплачено</span> : (
      <Tooltip content={`Оплачено строкой журнала ${by}`} align="end"><span className="text-ink-3">оплачено</span></Tooltip>
    );
  }
  return <span className="text-ink-3">—</span>;
}

/**
 * The period's days of the panel: the person read's (each day's own state by the payouts), else, while it has not come
 * or did not, the payouts list's days with the state its unpaid days give.
 */
function panelDays(person: TeamLedgerPayoutPerson, read: TeamLedgerPayoutPersonResponse | undefined): PanelDay[] {
  if (read !== undefined) {
    return read.days.filter((day) => day.amountMills !== 0).map((day) => ({
      date: day.date, model: day.model, source: day.source, amountMills: day.amountMills, state: day.state,
      paidMills: day.paidMills, unpaidMills: day.unpaidMills, paidBy: day.paidBy,
    }));
  }
  const owed = new Map(person.unpaidDays.filter((day) => day.kind === "day").map((day) => [`${day.date}-${day.model ?? ""}`, day.unpaidMills]));
  return person.days.filter((day) => day.amountMills !== 0).map((day) => {
    const unpaid = owed.get(`${day.date}-${day.model}`);
    return {
      date: day.date, model: day.model, source: day.source, amountMills: day.amountMills,
      state: unpaid === undefined ? "paid" : "to_pay",
      paidMills: unpaid === undefined ? day.amountMills : day.amountMills - unpaid,
      unpaidMills: unpaid ?? 0,
      paidBy: [],
    };
  });
}

/**
 * One person's pay: the payout calculation (the ledger's lines, the total, what to look at first, the text to copy),
 * the paid days whose report changed since, the period's adjustments with their reason, and the period's days with
 * their state — each saying where its amount came from; a day with a report opens in place to it.
 */
export function LedgerPersonDrawer({ row, view, period, onClose }: { row: LedgerRow; view: LedgerView; period: ResolvedPeriod; onClose: () => void }) {
  const { person } = row;
  const pay = usePayoutPerson(person.slug, period);
  const days = panelDays(person, pay.data);
  const adjustments: readonly Adjustment[] = pay.data?.adjustments ?? [];
  const lastPayout = pay.data?.lastPayout ?? null;
  const reports = useLedgerReports(period, days.length > 0);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const dayKey = (day: PanelDay) => `${day.date}-${day.model}`;
  const owedColumns: Column<OwedDay>[] = [
    { key: "day", header: "День", nowrap: true, cell: (day) => (day.kind === "opening" ? `до ${formatDay(view.accrualFrom)}` : formatWeekdayDay(day.date)), footer: <span className="payouts-total">Итого</span> },
    { key: "model", header: "Модель", grow: true, cell: (day) => day.model ?? (day.kind === "opening" ? "долг до учёта" : "—") },
    { key: "sum", header: "Сумма", numeric: true, cell: (day) => <Money mills={day.unpaidMills} />, footer: <Money mills={row.owedMills} strong /> },
  ];
  const dayColumns: Column<PanelDay>[] = [
    { key: "day", header: "День", nowrap: true, cell: (day) => formatWeekdayDay(day.date) },
    { key: "model", header: "Модель", cell: (day) => day.model },
    // Where the amount came from, in one quiet word: «таблица», «отчёт», «факты».
    { key: "source", header: "Откуда", muted: true, nowrap: true, cell: (day) => sourceWord(day.source) },
    { key: "state", header: "Состояние", grow: true, nowrap: true, cell: (day) => <DayState day={day} /> },
    { key: "sum", header: "Сумма", numeric: true, cell: (day) => <Money mills={day.amountMills} /> },
  ];
  const adjustmentColumns: Column<Adjustment>[] = [
    { key: "day", header: "День", nowrap: true, cell: (one) => formatWeekdayDay(one.date) },
    { key: "why", header: "За что", grow: true, cell: (one) => (one.memo.trim() === "" ? <span className="text-ink-3">без пояснения</span> : one.memo) },
    { key: "sum", header: "Сумма", numeric: true, nowrap: true, cell: (one) => <span className={one.amountMills < 0 ? "payouts-minus" : undefined}>{formatSignedMills(one.amountMills)}</span> },
  ];
  const pendingColumns: Column<PendingChange>[] = [
    { key: "day", header: "День", nowrap: true, cell: (change) => formatWeekdayDay(change.day) },
    { key: "what", header: "Почему", grow: true, cell: (change) => <span>{change.model}{change.reason && <span className="payouts-sub">{change.reason}</span>}</span> },
    { key: "was", header: "Было", numeric: true, nowrap: true, cell: (change) => <Money mills={change.postedMills} muted /> },
    { key: "now", header: "Стало", numeric: true, nowrap: true, cell: (change) => <Money mills={change.newMills} strong /> },
  ];
  const detailOf = (day: PanelDay) => {
    // Until the reports come, no day offers to open: the chevrons appear with them, in their reserved place.
    if (reports.data === null) return null;
    const report = reportOfDay(reports.data, person.slug, day.date);
    return report === null ? null : <ReportDetail row={reportRowOf(report, reports.data)} panel />;
  };
  const sheets = sheetsReadWords(view.checks);
  // What is owed day by day stands in only when the ledger gives no calculation.
  const owedTable = person.unpaidDays.length > 0 ? (
    <section className="payouts-block">
      <h3 className="payouts-block__title">Не выплачено</h3>
      <Table label={`Не выплачено ${person.name}`} columns={owedColumns} rows={person.unpaidDays} rowKey={(day) => `${day.kind}-${day.date}-${day.model ?? ""}`} dense stickyHeader={false} fit={false} />
    </section>
  ) : null;
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
            { label: "К выплате", value: <Money mills={row.owedMills} />, strong: true },
            ...(row.waitingDays !== null && person.oldestUnpaidDate !== null ? [{ label: "Ждёт с", value: formatDay(person.oldestUnpaidDate) }] : []),
            ...(lastPayout !== null ? [{ label: "Последняя выплата", value: <><Money mills={lastPayout.amountMills} />, {formatDay(lastPayout.date)}</> }] : []),
            ...(row.sheetDiffMills !== null ? [{
              label: "В таблице",
              value: <Money mills={row.owedMills + row.sheetDiffMills} />,
              hint: `«К выплате» вкладок человека в таблицах выплат. Таблицы ${sheets ?? "ещё не прочитаны"}.`,
            }] : []),
            ...(row.unenteredDays > 0 ? [{ label: "Не занесено", value: <>≈ <Money mills={row.unenteredMills} /></>, meta: `${row.unenteredDays} дн.`, hint: UNENTERED_HINT }] : []),
            { label: "Начислено", value: <Money mills={row.accruedMills} /> },
            { label: "Выплачено", value: <Money mills={row.paidMills} /> },
          ]}
        />

        <PayoutBrief slug={person.slug} name={person.name} adjustments={adjustments} fallback={owedTable} />

        {row.pendingChanges.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Изменились выплаченные дни</h3>
            <p className="payouts-note">Отчёт поменялся после выплаты. Ledger сам выплаченный день не меняет: поправка войдёт в следующую выплату после вашего «да».</p>
            <Table label={`Изменились выплаченные дни ${person.name}`} columns={pendingColumns} rows={row.pendingChanges} rowKey={(change) => String(change.id)} dense stickyHeader={false} fit={false} />
          </section>
        )}

        {adjustments.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Поправки за период</h3>
            <p className="payouts-note">Ручные проводки на долг с пояснением. Плюс: премия. Минус: штраф или аванс.</p>
            <Table label={`Поправки ${person.name}`} columns={adjustmentColumns} rows={adjustments} rowKey={(one) => `${one.date}-${one.document ?? ""}-${one.amountMills}`} dense stickyHeader={false} fit={false} />
          </section>
        )}

        {days.length > 0 && (
          <section className="payouts-block">
            <h3 className="payouts-block__title">Дни периода</h3>
            <Table
              label={`Начислено ${person.name} по дням`}
              columns={dayColumns}
              rows={days}
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
