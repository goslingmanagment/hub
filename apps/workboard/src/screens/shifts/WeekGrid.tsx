import { useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Delta, Menu, Money, Section, Table, Tooltip, type Column, type MenuEntry } from "@agency_hub_core/ui";
import { formatDay, formatDayRange, formatDuration, formatMills, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { moscowDayOf, moscowToday } from "@agency_hub_core/ui/moscow";
import { withPeriod } from "@agency_hub_core/ui/period";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { PersonLink, personPath, shiftPath, useBackState, type BackTarget } from "@/shared/links";
import { COMPARE_FLOOR_MILLS, changePct, type GridCell, type GridColumn, type GridRow, type JournalShift, type ShiftsModel, type Totals } from "./data.js";

const WEEKDAY = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
const DAY_OF_MONTH = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

/** A day still to come: a narrow column (nothing there yet). */
const FUTURE_COLUMN_WIDTH = 64;
/**
 * With few columns (14 days: two chunks) the name column keeps its width and the
 * money columns share the rest evenly, so half a screen never lies between a name
 * and its money.
 */
const WHO_COLUMN_WIDTH = 260;

function noon(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

/** A sentence that may end on an abbreviation («…1 нояб.»): one full stop, never two. */
export function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

function shiftsWord(count: number): string {
  return `${count} ${ruPlural(count, "смена", "смены", "смен")}`;
}

/** «2 смены · 9 ч 12 мин»: what a row or a cell is made of. */
function madeOf(shifts: number, minutes: number): string {
  return shifts === 0 ? "смен не было" : `${shiftsWord(shifts)} · ${formatDuration(minutes)}`;
}

function ColumnHead({ column }: { column: GridColumn }) {
  if (column.kind === "chunk") {
    return (
      <span className={column.today ? "shifts-grid__head shifts-grid__head--today" : "shifts-grid__head"}>
        <span>{formatDayRange(column.from, column.to)}</span>
        <span className="shifts-grid__head-sub">{column.today ? "по сегодня" : `${column.days} ${ruPlural(column.days, "день", "дня", "дней")}`}</span>
      </span>
    );
  }
  return (
    <span className={column.today ? "shifts-grid__head shifts-grid__head--today" : "shifts-grid__head"}>
      <span>{WEEKDAY.format(noon(column.from))}</span>
      <span className="shifts-grid__head-sub">{column.today ? "сегодня" : DAY_OF_MONTH.format(noon(column.from))}</span>
    </span>
  );
}

/** «09:12–16:40», over midnight the same; going on «18:02 – сейчас». */
export function spanOf(shift: Pick<JournalShift, "startedAt" | "endedAt" | "ongoing">): string {
  return shift.ongoing ? `${formatTimeOfDay(shift.startedAt)} – сейчас` : `${formatTimeOfDay(shift.startedAt)}–${formatTimeOfDay(shift.endedAt)}`;
}

function firstAndLastDay(shift: Pick<JournalShift, "startedAt" | "endedAt" | "ongoing">): [string, string] {
  return [moscowDayOf(shift.startedAt), shift.ongoing ? moscowToday() : moscowDayOf(shift.endedAt)];
}

/**
 * The days a shift ran: «сб, 7 нояб.»; a night over midnight «пт, 6–7 нояб.»
 * (from Friday to Saturday). In the grid it counts for the day holding most of
 * it, as the payout sheet does.
 */
export function daysOf(shift: Pick<JournalShift, "startedAt" | "endedAt" | "ongoing">): string {
  const [first, last] = firstAndLastDay(shift);
  if (first === last) return formatWeekdayDay(first);
  return `${WEEKDAY.format(noon(first))}, ${formatDayRange(first, last)}`;
}

/** A night shift over midnight, in a cell of one day: «ночь с пт на сб, в сетке — сб, как в выплатах». */
function nightNote(shift: JournalShift): string | null {
  const [first, last] = firstAndLastDay(shift);
  if (first === last) return null;
  const weekday = (day: string) => WEEKDAY.format(noon(day));
  return `Ночь с ${weekday(first)} на ${weekday(last)}: в сетке — ${weekday(shift.date)}, где большая часть смены, как в выплатах.`;
}

/**
 * A cell of the grid. A day with one shift opens it; with several, a short
 * list to pick from; a cell of a longer period opens those days, a column a
 * day. Nothing there: «—», a day ahead: empty, a day before Hub counted: «нет
 * данных».
 */
function CellView({ row, cell, isOwner, back }: { row: GridRow; cell: GridCell; isOwner: boolean; back: BackTarget }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { column } = cell;
  if (column.future) return null;
  if (column.unknown) {
    return (
      <Tooltip content="Hub тогда ещё не считал смены">
        <span className="ui-muted">нет данных</span>
      </Tooltip>
    );
  }
  if (cell.shifts === 0) return <span className="shifts-grid__none">—</span>;

  const team = row.userId === null;
  const money = <Money mills={cell.salesNetMills} strong={team} />;
  const tip = madeOf(cell.shifts, cell.workedMinutes);

  if (column.kind === "chunk") {
    const search = withPeriod(new URLSearchParams(location.search), { kind: "range", from: column.from, to: column.to });
    return (
      <Tooltip content={`${team ? "" : `${row.username}, `}${formatDayRange(column.from, column.to)}: ${tip}. Открыть эти дни по дням`}>
        <Link to={{ pathname: "/shifts", search: search.toString() }} className="shifts-cell">{money}</Link>
      </Tooltip>
    );
  }

  const open = (shift: JournalShift) => (isOwner ? shiftPath(shift.userId, shift.startedAt, location.search) : personPath(shift.userId, location.search));
  if (cell.list.length === 1) {
    const shift = cell.list[0]!;
    const night = nightNote(shift);
    return (
      <Tooltip
        content={(
          <>
            {team ? `${shift.username}, ` : ""}{daysOf(shift)}, {spanOf(shift)} · {formatDuration(shift.workedMinutes)} работы
            {night && <><br />{night}</>}
          </>
        )}
      >
        <Link to={open(shift)} state={{ back }} className="shifts-cell">{money}</Link>
      </Tooltip>
    );
  }
  if (cell.list.length === 0) {
    return <Tooltip content={tip}>{money}</Tooltip>;
  }
  const items: MenuEntry[] = [
    { group: `${team ? "Смены" : `${row.username}: смены`} за ${formatWeekdayDay(column.from)}` },
    ...cell.list.map((shift): MenuEntry => ({
      label: team ? `${shift.username} · ${spanOf(shift)}` : spanOf(shift),
      hint: formatMills(shift.salesNetMills),
      onSelect: () => navigate(open(shift), { state: { back } }),
    })),
  ];
  return (
    <Menu
      label={`${row.username}: ${tip}`}
      items={items}
      align="end"
      renderTrigger={({ ref, ...trigger }) => (
        <Tooltip content={`${tip}. Выбрать смену`}>
          <button ref={ref} type="button" className="shifts-cell" {...trigger}>{money}</button>
        </Tooltip>
      )}
    />
  );
}

/** The window before was too small for a percent to mean anything: «было $15.99» says more than «+100 %». */
function smallBefore(previous: Totals | null): previous is Totals {
  return previous !== null && previous.shifts > 0 && previous.salesNetMills < COMPARE_FLOOR_MILLS;
}

function TotalCell({ row, comparable, versus }: { row: GridRow; comparable: boolean; versus: string }) {
  if (row.gone) {
    return (
      <span className="shifts-stack">
        <span className="ui-muted">—</span>
        {row.previous && row.previous.shifts > 0 && <Delta was={row.previous.salesNetMills} title={versus} className="shifts-stack__sub" />}
      </span>
    );
  }
  return (
    <span className="shifts-stack">
      <Money mills={row.totals.salesNetMills} strong />
      {row.isNew ? (
        <span className="shifts-stack__sub ui-muted">новый</span>
      ) : comparable && row.previous ? (
        smallBefore(row.previous) && row.userId !== null
          ? <Delta was={row.previous.salesNetMills} title={versus} className="shifts-stack__sub" />
          : <Delta pct={changePct(row.totals.salesNetMills, row.previous.salesNetMills)} title={versus} className="shifts-stack__sub" />
      ) : null}
    </span>
  );
}

function PerHourCell({ row, comparable, versus }: { row: GridRow; comparable: boolean; versus: string }) {
  if (row.gone) return <span className="ui-muted">—</span>;
  const previous = row.previous;
  return (
    <span className="shifts-stack">
      <Money mills={row.totals.perHourMills} />
      {comparable && previous && !row.isNew && previous.perHourMills !== null && (
        smallBefore(previous) && row.userId !== null
          ? <Delta was={previous.perHourMills} title={versus} className="shifts-stack__sub" />
          : <Delta pct={changePct(row.totals.perHourMills, previous.perHourMills)} title={versus} className="shifts-stack__sub" />
      )}
    </span>
  );
}

/**
 * Неделя (spec §4.1.3): the chatter × day money grid of #1006, the team on
 * top. «За неделю» and «В час» against the window before (this week so far
 * against last week up to the same hour), «было $X» for someone gone or a
 * window before too small for a percent. A cell opens that day's shift; a
 * longer period has a column per 7 days back from today (D4), which opens
 * those days. The chatter's name opens their card for the same period.
 */
export function WeekGrid({ model, isOwner, versus, loading = false, refreshing = false, weekly, page, columns }: {
  model: ShiftsModel | undefined;
  isOwner: boolean;
  /** «к 26 окт. – 1 нояб.»: what the percents compare with. */
  versus: string;
  loading?: boolean;
  refreshing?: boolean;
  /** The period is a calendar week. */
  weekly: boolean;
  page: string | null;
  /** The columns to show while loading. */
  columns: readonly GridColumn[];
}) {
  const { back } = useBackState("Смены");
  const shown = model?.columns ?? columns;
  const byChunk = shown[0]?.kind === "chunk";
  const comparable = model?.comparable ?? false;
  const working = useMemo(() => new Set(model?.journal.filter((shift) => shift.ongoing).map((shift) => shift.userId) ?? []), [model]);

  const tableColumns: Column<GridRow>[] = [
    {
      key: "who",
      header: "Чаттер",
      ...(byChunk ? { width: WHO_COLUMN_WIDTH } : {}),
      cell: (row) => row.userId === null ? (
        <span className="shifts-grid__team">
          <span className="shifts-grid__team-name">Вся команда</span>
          <span className="shifts-grid__team-hint">{madeOf(row.totals.shifts, row.totals.workedMinutes)}</span>
        </span>
      ) : (
        <PersonLink
          userId={row.userId}
          name={row.username}
          status={working.has(row.userId) ? "working" : "away"}
          hint={row.gone ? "смен не было" : madeOf(row.totals.shifts, row.totals.workedMinutes)}
          backLabel="Смены"
        />
      ),
    },
    ...shown.map((column): Column<GridRow> => ({
      key: column.key,
      header: <ColumnHead column={column} />,
      numeric: true,
      headerWrap: true,
      ...(column.future ? { width: FUTURE_COLUMN_WIDTH } : {}),
      cell: (row) => {
        const cell = row.cells.find((one) => one.column.key === column.key);
        return cell ? <CellView row={row} cell={cell} isOwner={isOwner} back={back} /> : null;
      },
    })),
    {
      key: "total",
      header: weekly ? "За неделю" : "За период",
      numeric: true,
      cell: (row) => <TotalCell row={row} comparable={comparable} versus={versus} />,
    },
    {
      key: "perHour",
      header: "В час",
      numeric: true,
      hint: "Продажи, делённые на отработанное время без пауз",
      cell: (row) => <PerHourCell row={row} comparable={comparable} versus={versus} />,
    },
  ];

  const rows = model ? [model.team, ...model.chatters] : [];
  const last = shown.at(-1);
  const description = [
    page ? `Только работа на ${page}.` : null,
    byChunk
      ? `Столбцы по 7 дней назад от ${last?.today ? "сегодня" : last ? formatDay(last.to) : "конца периода"}. Клетка открывает эти дни по дням.`
      : "Клетка открывает смену этого дня.",
  ].filter(Boolean).join(" ");

  return (
    <Section title={byChunk ? "Продажи по 7 дней" : "Продажи по дням"} description={description}>
      <Table
        label={byChunk ? "Продажи за смены по 7 дней" : "Продажи за смены по дням"}
        className="shifts-grid"
        columns={tableColumns}
        rows={rows}
        rowKey={(row) => (row.userId === null ? "team" : String(row.userId))}
        rowEmphasis={(row) => row.userId === null}
        rowQuiet={(row) => row.gone}
        align="first-line"
        stickyColumns={1}
        moreLabel={(hidden) => `ещё ${hidden} ${ruPlural(hidden, "столбец", "столбца", "столбцов")}`}
        loading={loading}
        refreshing={refreshing}
        skeletonRows={5}
        skeletonLines={2}
      />
    </Section>
  );
}
