import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useLocation } from "react-router";
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Facts,
  LinkButton,
  Menu,
  Money,
  Notice,
  Skeleton,
  Tooltip,
  type FactItem,
  type MenuEntry,
} from "@agency_hub_core/ui";
import { formatCount, formatDayRange, formatOf } from "@agency_hub_core/ui/format";
import { addDays } from "@agency_hub_core/ui/moscow";
import { stepWeek, withPeriod } from "@agency_hub_core/ui/period";
import { periodWords } from "@agency_hub_core/ui/people/words";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { useBackState } from "@/shared/links";
import { CHATTER_NUMBERS_KEY } from "@/shared/reads";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { ShiftsTabs } from "@/shared/ShiftsTabs";
import { SHIFT_READS_MAX_DAYS, shiftsWindow } from "@/shared/shiftsWindow";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useSearchParam } from "@/shared/useSearchParam";
import { dayTitle, keeps, stateFilterOf, useReportNumbers, useTeamShiftReports, type Report, type StateFilter, type Tally } from "./data.js";
import { ReportCard } from "./ReportCard.js";
import "../my-shifts/my-shifts.css";
import "./shift-reports.css";

/**
 * Смены → Отчёты (owner, 2026-11-19: «отдельная вкладка Отчёты, где видно отчёты всех ребят»): every shift's report of
 * the teams the viewer sees, newest first, a day under its head — who, when, how much, what it is made of, the shift's
 * numbers, where the report stands. One card for one shift, the card of «Мои» with the person on it; it opens the
 * shift's page. Above the feed the period in a line that is also its filter (not handed in, waiting for «Подтверждаю»),
 * and the person's; the page is the header's filter. Every filter is in the address. Every number is Hub's
 * (`teamShiftReports`), each report as Hub counts it for this reader; nothing is summed here.
 */

// ───────────────────────────────────────────────────────────── The person

/** Whose reports: «Все люди», or one person (the address's `?person=`). The same chip as the page filter. */
function PersonFilter({ people, person, onPerson }: {
  people: ReadonlyArray<{ userId: number; name: string }>;
  person: number | null;
  onPerson: (userId: number | null) => void;
}) {
  const chosen = people.find((one) => one.userId === person) ?? null;
  const items: MenuEntry[] = [
    { label: "Все люди", checked: person === null, onSelect: () => onPerson(null) },
    ...(people.length > 0 ? [{ separator: true } as MenuEntry] : []),
    ...people.map((one): MenuEntry => ({ label: one.name, checked: person === one.userId, onSelect: () => onPerson(one.userId) })),
  ];
  return (
    <Menu
      label="Чьи отчёты"
      items={items}
      align="end"
      renderTrigger={({ ref, ...trigger }) => person === null ? (
        <button ref={ref} type="button" className="ui-chip ui-chip--md" {...trigger}>
          <span className="ui-chip__text">Все люди</span>
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
        </button>
      ) : (
        <span className="ui-chip ui-chip--md ui-chip--selected">
          <button ref={ref} type="button" className="ui-chip__main" aria-label={`Отчёты: ${chosen?.name ?? "один человек"}. Выбрать другого`} {...trigger}>
            <span className="ui-chip__text">{chosen?.name ?? "Один человек"}</span>
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className="ui-chip__remove" aria-label="Показать всех" title="Показать всех" onClick={() => onPerson(null)}>
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </span>
      )}
    />
  );
}

// ───────────────────────────────────────────────────────────── The period

/** «Не сданы: 3» as a filter: pressed — only those; the count is Hub's. */
function StateChip({ filter, value, count, onFilter, children }: {
  filter: StateFilter | null;
  value: StateFilter;
  count: number;
  onFilter: (next: StateFilter | null) => void;
  children: ReactNode;
}) {
  const on = filter === value;
  if (count === 0 && !on) return null;
  return (
    <Chip
      size="md"
      selected={on}
      onClick={() => onFilter(on ? null : value)}
      {...(on ? { onRemove: () => onFilter(null), removeLabel: "Показать все отчёты" } : {})}
    >
      {children}: {formatCount(count)}
    </Chip>
  );
}

function Summary({ totals, filter, onFilter, people, person, onPerson }: {
  totals: Tally;
  filter: StateFilter | null;
  onFilter: (next: StateFilter | null) => void;
  people: ReadonlyArray<{ userId: number; name: string }>;
  person: number | null;
  onPerson: (userId: number | null) => void;
}) {
  const items: FactItem[] = [
    {
      label: "Сдано",
      value: formatOf(totals.handedIn, totals.expected),
      hint: "Отчёты, сданные в Hub, из тех, что должны быть: смены, которые сдают доской и уже кончились. Смены, которые ещё идут или сдаются по-старому, не в счёте.",
    },
    {
      label: "По отчётам",
      strong: true,
      value: <Money mills={totals.reportedMills} strong />,
      hint: "Сумма сданных отчётов периода, как Hub считает их для вас: отчёт с чужими страницами — только по вашим.",
    },
  ];
  const quiet = [
    totals.ongoing > 0 ? `${ruPlural(totals.ongoing, "идёт", "идут", "идут")} ${formatCount(totals.ongoing)}` : null,
    totals.oldWay > 0 ? `по-старому ${formatCount(totals.oldWay)}` : null,
  ].filter((words): words is string => words !== null);
  return (
    <section className="rep-summary" aria-label="Отчёты периода">
      <Facts items={items} label="Отчёты периода" className="rep-summary__facts" />
      <span className="rep-summary__filters">
        <StateChip filter={filter} value="due" count={totals.notHandedIn} onFilter={onFilter}>Не сданы</StateChip>
        <StateChip filter={filter} value="confirm" count={totals.waitingConfirm} onFilter={onFilter}>Ждут подтверждения</StateChip>
        {quiet.length > 0 && (
          <Tooltip content="Смена, которая идёт, сдаётся в конце. По-старому: человек сдаёт смену постом в «Отчётности», в Hub отчёта нет, на карточке продажи по правилу." align="start">
            <span className="rep-summary__quiet">{quiet.join(" · ")}</span>
          </Tooltip>
        )}
      </span>
      <span className="rep-summary__person">
        <PersonFilter people={people} person={person} onPerson={onPerson} />
      </span>
    </section>
  );
}

function SummarySkeleton() {
  return (
    <div className="rep-summary" aria-hidden>
      <Skeleton width={120} height={20} />
      <Skeleton width={160} height={20} />
      <Skeleton width={140} height={32} radius={16} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────── A day

/** «4 отчёта · $1 240.00 · не сдан 1 · ждёт подтверждения 1 · идёт 1»: the day's tally, Hub's. */
function DayFacts({ day }: { day: Tally }) {
  const parts: ReactNode[] = [];
  if (day.handedIn > 0) {
    parts.push(<span>{formatCount(day.handedIn)} {ruPlural(day.handedIn, "отчёт", "отчёта", "отчётов")}</span>);
    parts.push(<Money mills={day.reportedMills} />);
  }
  if (day.notHandedIn > 0) parts.push(<span className="rep-day__due">не {ruPlural(day.notHandedIn, "сдан", "сданы", "сданы")} {formatCount(day.notHandedIn)}</span>);
  if (day.waitingConfirm > 0) parts.push(<span>{ruPlural(day.waitingConfirm, "ждёт", "ждут", "ждут")} подтверждения {formatCount(day.waitingConfirm)}</span>);
  if (day.ongoing > 0) parts.push(<span>{ruPlural(day.ongoing, "идёт", "идут", "идут")} {formatCount(day.ongoing)}</span>);
  if (day.oldWay > 0) parts.push(<span>по-старому {formatCount(day.oldWay)}</span>);
  if (parts.length === 0) parts.push(<span>отчётов нет</span>);
  return (
    <span className="rep-day__facts">
      {parts.map((part, index) => <span key={index} className="rep-day__fact">{part}</span>)}
    </span>
  );
}

function FeedSkeleton() {
  return (
    <div className="rep-feed" aria-busy>
      <div className="rep-day">
        <div className="rep-day__head"><Skeleton width={140} height={24} /><Skeleton width={200} height={18} /></div>
        <ol className="mys-feed">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="mys-card mys-card--skeleton">
              <div className="mys-card__head"><Skeleton width={160} height={28} radius={14} /><Skeleton width={120} height={16} /></div>
              <div className="mys-card__money"><Skeleton width={88} height={28} radius={6} /></div>
              <div className="mys-card__track"><Skeleton width="100%" height={20} radius={6} /></div>
              <div className="mys-card__kinds"><Skeleton width="100%" height={20} radius={6} /></div>
              <div className="mys-card__foot"><Skeleton width={160} height={24} radius={6} /></div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── The screen

export function ShiftReportsScreen() {
  const { spec, period, today } = usePeriod();
  const { page, setPage } = usePageFilter();
  const [search, setParam] = useSearchParam();
  const location = useLocation();
  const queryClient = useQueryClient();
  const window = useMemo(() => shiftsWindow(period), [period]);
  const personParam = Number(search.get("person"));
  const person = Number.isInteger(personParam) && personParam > 0 ? personParam : null;
  const filter = stateFilterOf(search.get("state"));
  const read = useTeamShiftReports({ window, page, person, current: period.current });
  const numbers = useReportNumbers(period, window, person, period.current);
  const back = useBackState("Отчёты");
  const data = read.data;

  const shown = useMemo(() => (data ? data.reports.filter((report) => keeps(report, filter)) : []), [data, filter]);
  // Every card's beads are sized against the period's biggest sale, so a big sale looks big on any card.
  const maxSaleMills = useMemo(() => Math.max(0, ...shown.flatMap((report) => (report.report?.parts ?? report.rule)?.sales.map((sale) => sale.netMills) ?? [])), [shown]);
  const days = useMemo(() => {
    if (!data) return [];
    return data.days
      .map((day) => ({ day, reports: shown.filter((report) => report.reportDate === day.date) }))
      .filter((one) => one.reports.length > 0);
  }, [data, shown]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
    void queryClient.invalidateQueries({ queryKey: CHATTER_NUMBERS_KEY });
  };
  const words = periodWords(period);
  const chosen = data?.people.find((one) => one.userId === person) ?? null;

  let body: ReactNode;
  if (!data && read.isError) {
    body = <ErrorState onRetry={refresh} retrying={read.isFetching}>Отчёты не пришли. Это не значит, что их нет: экран их просто не получил.</ErrorState>;
  } else if (!data) {
    body = <><SummarySkeleton /><FeedSkeleton /></>;
  } else if (data.reports.length === 0) {
    const previousWeek = spec.kind === "week" ? withPeriod(new URLSearchParams(location.search), stepWeek(spec, -1, today)).toString() : null;
    body = person !== null ? (
      <EmptyState title={`У ${chosen?.name ?? "этого человека"} ${words} смен нет`} action={<Button onClick={() => setParam("person", null)}>Все люди</Button>} />
    ) : page !== null ? (
      <EmptyState title={`На ${page} ${words} смен нет`} action={<Button onClick={() => setPage(null)}>Показать все страницы</Button>}>
        На этой странице никто не работал в расширении ChatGoose столько, чтобы это стало сменой.
      </EmptyState>
    ) : (
      <EmptyState
        title={`${words[0]!.toUpperCase()}${words.slice(1)} смен нет`}
        action={previousWeek ? <LinkButton to={{ pathname: location.pathname, search: previousWeek }}>Показать прошлую неделю</LinkButton> : undefined}
      >
        Отчёт появится здесь, когда кончится смена: её сдают доской «Отчёт», а кто сдаёт по-старому, постом в «Отчётности».
      </EmptyState>
    );
  } else {
    const summary = (
      <Summary
        totals={data.totals}
        filter={filter}
        onFilter={(next) => setParam("state", next)}
        people={data.people}
        person={person}
        onPerson={(next) => setParam("person", next === null ? null : String(next))}
      />
    );
    body = (
      <>
        {summary}
        {days.length === 0 ? (
          <EmptyState
            title={filter === "confirm" ? "Подтверждения никто не ждёт" : "Все отчёты сданы"}
            action={<Button onClick={() => setParam("state", null)}>Показать все отчёты</Button>}
          />
        ) : (
          <div className="rep-feed" data-refreshing={(read.isPlaceholderData && read.isFetching) || undefined}>
            {days.map(({ day, reports }) => (
              <section key={day.date} className="rep-day" aria-label={dayTitle(day.date, today)}>
                <header className="rep-day__head">
                  <h2 className="rep-day__title">{dayTitle(day.date, today)}</h2>
                  <DayFacts day={day} />
                </header>
                <ol className="mys-feed">
                  {reports.map((report: Report) => (
                    <ReportCard key={report.shiftId} report={report} numbers={numbers.data} maxSaleMills={maxSaleMills} back={back} />
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <ScreenHeader
        title="Смены"
        documentTitle="Отчёты смен"
        period
        pageFilter
        meta={<span>Отчёты смен по дням, новые сверху</span>}
        updatedAt={data ? read.dataUpdatedAt : undefined}
        onRefresh={refresh}
        refreshing={read.isFetching}
        stale={read.isRefetchError}
      />
      <div className="wb-content mys rep">
        <ShiftsTabs />
        {window.clipped && (
          <Notice title={`Отчёты видны не больше чем за ${SHIFT_READS_MAX_DAYS} день`}>
            Чтобы увидеть {formatDayRange(period.from, addDays(window.from, -1))}, выберите эти дни отдельно. Сейчас показаны {formatDayRange(window.from, window.to)}.
          </Notice>
        )}
        {body}
      </div>
    </>
  );
}
