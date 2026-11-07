import { useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Delta, Menu, Money, Person, Section, Table, Tooltip, type Column, type MenuEntry } from "@agency_hub_core/ui";
import { formatDay, formatDayRange, formatDuration, formatMills, formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { daysInRange, moscowDayOf, moscowToday } from "@agency_hub_core/ui/moscow";
import { withPeriod } from "@agency_hub_core/ui/period";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { personPath, shiftPath, type BackTarget } from "@/shared/links";
import { changePct, type GridCell, type GridColumn, type GridRow, type JournalShift, type ShiftsModel } from "./data.js";

const WEEKDAY = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
const DAY_OF_MONTH = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

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
  if (column.kind === "week") {
    const days = daysInRange(column.from, column.to);
    return (
      <span className="shifts-grid__head">
        <span>{formatDayRange(column.from, column.to)}</span>
        <span className="shifts-grid__head-sub">{column.today ? "эта неделя" : days === 7 ? "неделя" : `${days} ${ruPlural(days, "день", "дня", "дней")}`}</span>
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

/**
 * The days a shift ran: «сб, 7 нояб.»; a night over midnight «пт, 6–7 нояб.»
 * (from Friday to Saturday). In the grid it counts for the day holding most of
 * it, as the payout sheet does.
 */
export function daysOf(shift: Pick<JournalShift, "startedAt" | "endedAt" | "ongoing">): string {
  const first = moscowDayOf(shift.startedAt);
  const last = shift.ongoing ? moscowToday() : moscowDayOf(shift.endedAt);
  if (first === last) return formatWeekdayDay(first);
  return `${WEEKDAY.format(noon(first))}, ${formatDayRange(first, last)}`;
}

/**
 * A cell of the grid. A day with one shift opens it; with several, a short
 * list to pick from; a week's cell opens that week. Nothing there: «—», a day
 * ahead: empty, a day before Hub counted: «нет данных».
 */
function CellView({ row, cell, isOwner, back }: { row: GridRow; cell: GridCell; isOwner: boolean; back: BackTarget }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { column } = cell;
  if (column.future) return null;
  if (column.unknown) return <span className="ui-muted" title="Hub тогда ещё не считал смены">нет данных</span>;
  if (cell.shifts === 0) return <span className="shifts-grid__none">—</span>;

  const team = row.userId === null;
  const money = <Money mills={cell.salesNetMills} strong={team} />;
  const tip = madeOf(cell.shifts, cell.workedMinutes);

  if (column.kind === "week") {
    const search = withPeriod(new URLSearchParams(location.search), { kind: "week", monday: column.from });
    return (
      <Tooltip content={`${tip}. Открыть эту неделю`}>
        <Link to={{ pathname: "/shifts", search: search.toString() }} className="shifts-cell">{money}</Link>
      </Tooltip>
    );
  }

  const open = (shift: JournalShift) => (isOwner ? shiftPath(shift.userId, shift.startedAt, location.search) : personPath(shift.userId, location.search, "shifts"));
  if (cell.list.length === 1) {
    const shift = cell.list[0]!;
    return (
      <Tooltip content={`${team ? `${shift.username}, ` : ""}${daysOf(shift)}, ${spanOf(shift)} · ${formatDuration(shift.workedMinutes)} работы`}>
        <Link to={open(shift)} state={{ back }} className="shifts-cell">{money}</Link>
      </Tooltip>
    );
  }
  if (cell.list.length === 0) {
    return <span title={tip}>{money}</span>;
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

function TotalCell({ row, comparable, versus }: { row: GridRow; comparable: boolean; versus: string }) {
  if (row.gone) {
    return (
      <span className="shifts-stack">
        <span className="ui-muted">—</span>
        {row.previous && row.previous.shifts > 0 && <Delta was={row.previous.salesNetMills} title={versus} />}
      </span>
    );
  }
  return (
    <span className="shifts-stack">
      <Money mills={row.totals.salesNetMills} strong />
      {row.isNew ? (
        <span className="shifts-stack__sub ui-muted">новый</span>
      ) : comparable && row.previous ? (
        <Delta pct={changePct(row.totals.salesNetMills, row.previous.salesNetMills)} title={versus} className="shifts-stack__sub" />
      ) : null}
    </span>
  );
}

function PerHourCell({ row, comparable, versus }: { row: GridRow; comparable: boolean; versus: string }) {
  if (row.gone) return <span className="ui-muted">—</span>;
  return (
    <span className="shifts-stack">
      <Money mills={row.totals.perHourMills} />
      {comparable && row.previous && !row.isNew && row.previous.perHourMills !== null && (
        <Delta pct={changePct(row.totals.perHourMills, row.previous.perHourMills)} title={versus} className="shifts-stack__sub" />
      )}
    </span>
  );
}

/**
 * Неделя (spec §4.1.3): the chatter × day money grid of #1006, the team on
 * top. «За неделю» and «В час» against the window before (this week so far
 * against last week up to the same hour), «было $X» for someone gone. A cell
 * opens that day's shift; a longer period has a column a week, which opens the
 * week. The chatter's name opens their card for the same period.
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
  const location = useLocation();
  const back: BackTarget = { to: `${location.pathname}${location.search}`, label: "Смены" };
  const shown = model?.columns ?? columns;
  const byWeek = shown[0]?.kind === "week";
  const comparable = model?.comparable ?? false;
  const working = useMemo(() => new Set(model?.journal.filter((shift) => shift.ongoing).map((shift) => shift.userId) ?? []), [model]);

  const tableColumns: Column<GridRow>[] = [
    {
      key: "who",
      header: "Чаттер",
      cell: (row) => row.userId === null ? (
        <span className="shifts-grid__team">
          <span className="shifts-grid__team-name">Вся команда</span>
          <span className="shifts-grid__team-hint">{madeOf(row.totals.shifts, row.totals.workedMinutes)}</span>
        </span>
      ) : (
        <Person
          name={row.username}
          status={working.has(row.userId) ? "working" : "away"}
          hint={row.gone ? "смен не было" : madeOf(row.totals.shifts, row.totals.workedMinutes)}
        />
      ),
    },
    ...shown.map((column): Column<GridRow> => ({
      key: column.key,
      header: <ColumnHead column={column} />,
      numeric: true,
      headerWrap: true,
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
      title: "Продажи, делённые на отработанное время без пауз",
      cell: (row) => <PerHourCell row={row} comparable={comparable} versus={versus} />,
    },
  ];

  const rows = model ? [model.team, ...model.chatters] : [];
  const description = [
    page ? `Только работа на ${page}.` : null,
    byWeek ? "Клетка открывает неделю." : "Клетка открывает смену этого дня.",
    model && !model.comparable
      ? model.knownSince ? `Сравнения нет: Hub считает смены с ${formatDay(model.knownSince)}, а прошлый период начинается раньше.` : null
      : sentence(`Проценты — ${versus}`),
  ].filter(Boolean).join(" ");

  return (
    <Section title={byWeek ? "Продажи по неделям" : "Продажи по дням"} description={description}>
      <Table
        label={byWeek ? "Продажи за смены по неделям" : "Продажи за смены по дням"}
        className="shifts-grid"
        columns={tableColumns}
        rows={rows}
        rowKey={(row) => (row.userId === null ? "team" : String(row.userId))}
        rowHref={(row) => (row.userId === null ? undefined : personPath(row.userId, location.search))}
        rowQuiet={(row) => row.gone}
        loading={loading}
        refreshing={refreshing}
        skeletonRows={5}
      />
    </Section>
  );
}
