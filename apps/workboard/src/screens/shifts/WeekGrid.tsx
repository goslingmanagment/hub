import { useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Delta, Menu, Money, Section, Table, Tooltip, type Column, type MenuEntry } from "@agency_hub_core/ui";
import { formatDay, formatDayRange, formatDuration, formatMills, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { withPeriod } from "@agency_hub_core/ui/period";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { PersonLink, personPath, shiftPath, useBackState, type BackTarget } from "@/shared/links";
import { type GridCell, type GridColumn, type GridRow, type JournalShift, type ShiftsModel } from "./data.js";

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
      <Tooltip content={`${team ? "" : `${row.username}, `}${formatDayRange(column.from, column.to)}: ${tip}. Открыть по дням`}>
        <Link to={{ pathname: "/shifts", search: search.toString() }} className="shifts-cell">{money}</Link>
      </Tooltip>
    );
  }

  const open = (shift: JournalShift) => (isOwner ? shiftPath(shift.userId, shift.startedAt, location.search) : personPath(shift.userId, location.search));
  if (cell.list.length === 1) {
    const shift = cell.list[0]!;
    // D12: the shift's one label; a night says why it stands in this day's column.
    return (
      <Tooltip
        content={(
          <>
            {team ? `${shift.username}, ` : ""}{shift.when.label} · {shift.when.worked} работы
            {shift.when.payDayNote && <><br />{shift.when.payDayNote}</>}
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
      label: team ? `${shift.username} · ${shift.when.time}` : shift.when.time,
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

/**
 * The change against the window before, by the one rule of Delta (D13): a small
 * base reads «было $15.99», not «+100 %». Hub has no window before for someone it
 * began to see after that window began (`previous: null`): «нет сравнения», never
 * «новый» — they may have worked half of it.
 */
function TotalCell({ row, comparable, versus }: { row: GridRow; comparable: boolean; versus: string }) {
  if (row.gone) {
    return (
      <span className="shifts-stack">
        <span className="ui-muted">—</span>
        {row.previous && row.previous.shifts > 0 && <Delta current={0} previous={row.previous.salesNetMills} title={versus} className="shifts-stack__sub" />}
      </span>
    );
  }
  return (
    <span className="shifts-stack">
      <Money mills={row.totals.salesNetMills} strong />
      {row.unmatched ? (
        <Delta
          current={row.totals.salesNetMills}
          previous={null}
          noneText="нет сравнения"
          title={`Hub видит ${row.username} не с начала прошлого периода: сравнивать не с чем`}
          className="shifts-stack__sub"
        />
      ) : comparable && row.previous ? (
        <Delta current={row.totals.salesNetMills} previous={row.previous.salesNetMills} title={versus} className="shifts-stack__sub" />
      ) : null}
    </span>
  );
}

/** «$51.79» and, on hover, what it is made of: «$2,144.38 за 41 ч 24 мин работы». */
function PerHourCell({ row, comparable, versus }: { row: GridRow; comparable: boolean; versus: string }) {
  if (row.gone) return <span className="ui-muted">—</span>;
  const previous = row.previous;
  const madeOfHint = row.totals.perHourMills === null ? undefined : `${formatMills(row.totals.salesNetMills)} за ${formatDuration(row.totals.workedMinutes)} работы`;
  return (
    <span className="shifts-stack">
      <Money mills={row.totals.perHourMills} hint={madeOfHint} />
      {comparable && previous && !row.unmatched && previous.perHourMills !== null && (
        // A rate is judged by the money behind it: $2.15 an hour from $16 of sales is no base for a percent.
        <Delta current={row.totals.perHourMills} previous={previous.perHourMills} base={previous.salesNetMills} title={versus} className="shifts-stack__sub" />
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
export function WeekGrid({ model, isOwner, versus, loading = false, refreshing = false, weekly, page, columns, mine = false }: {
  model: ShiftsModel | undefined;
  isOwner: boolean;
  /** «Сравнение с 26 окт. – 1 нояб.»: what a change compares with, on its hover. */
  versus: string;
  loading?: boolean;
  refreshing?: boolean;
  /** The period is a calendar week. */
  weekly: boolean;
  page: string | null;
  /** The columns to show while loading. */
  columns: readonly GridColumn[];
  /** Only the viewer's own rows («Мои смены» of the owner): no team row. */
  mine?: boolean;
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
      cell: (row) => <PerHourCell row={row} comparable={comparable} versus={versus} />,
    },
  ];

  // One person in the grid (a page one chatter works): the team's row would only repeat theirs.
  const rows = model ? (model.chatters.length > 1 && !mine ? [model.team, ...model.chatters] : model.chatters) : [];
  const last = shown.at(-1);
  const description = [
    page ? `Только работа на ${page}.` : null,
    byChunk
      ? `${sentence(`Отсчёт назад от ${last?.today ? "сегодня" : last ? formatDay(last.to) : "конца периода"}`)} Клетка раскрывает свои дни.`
      : "Клетка открывает смену этого дня.",
  ].filter(Boolean).join(" ");

  return (
    <Section title={byChunk ? "Продажи по 7 дней" : "Продажи по дням"} description={description} actions={model ? <Outside outside={model.outside} /> : undefined}>
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

/**
 * «вне смен»: the period's sales no shift held — in look-ins (the chatter wrote to the fan last) and nobody's. Not in
 * the grid's money; one quiet figure beside its title, by page on hover.
 */
function Outside({ outside }: { outside: ShiftsModel["outside"] }) {
  // The one rule's lines (with `ruleFrom`): the pot, a PPV waiting for its sender, the owner's decision.
  const ruled = (one: { potNetMills?: number; waitingNetMills?: number; decideNetMills?: number }) =>
    (one.potNetMills ?? 0) + (one.waitingNetMills ?? 0) + (one.decideNetMills ?? 0);
  const total = outside.visitsNetMills + outside.nobodyNetMills + ruled(outside);
  if (total <= 0) return null;
  const lines: Array<[string, number | undefined]> = [
    ["в заходах", outside.visitsNetMills],
    ["общак", outside.potNetMills],
    ["ждут смены отправителя", outside.waitingNetMills],
    ["ждут решения", outside.decideNetMills],
    ["ничьи", outside.nobodyNetMills],
  ];
  const hint = (
    <span className="shifts-outside__hint">
      <span>
        {outside.potNetMills === undefined
          ? "Продажи страниц, которые не держала ни одна смена: в продажи за смены и в выплаты они не входят."
          : "Продажи страниц, которые правило не отдало ни одной смене: в продажи за смены и в выплаты они не входят."}
      </span>
      {lines.map(([label, mills]) => (mills ?? 0) > 0 && <span key={label} className="shifts-outside__row">{label}<Money mills={mills!} /></span>)}
      {outside.pages.map((page) => (
        <span key={page.pageLabel} className="shifts-outside__row shifts-outside__row--page">
          <span>{page.pageLabel}</span><Money mills={page.visitsNetMills + page.nobodyNetMills + ruled(page)} />
        </span>
      ))}
    </span>
  );
  return (
    <Tooltip content={hint} align="end">
      <span className="shifts-outside">вне смен ещё <Money mills={total} /></span>
    </Tooltip>
  );
}
