import { useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import {
  Badge,
  Button,
  Delta,
  Duration,
  EmptyState,
  ErrorState,
  Facts,
  LinkButton,
  Money,
  Notice,
  PageLabels,
  Skeleton,
  Tooltip,
  readDelta,
  type FactItem,
} from "@agency_hub_core/ui";
import { formatDay, formatDayRange, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { addDays, moscowDayOf } from "@agency_hub_core/ui/moscow";
import { currentWeek, stepWeek, withPeriod } from "@agency_hub_core/ui/period";
import { periodWords } from "@agency_hub_core/ui/people/words";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { shiftPauseText } from "@agency_hub_core/ui/shiftLive";
import { shiftDurationHint, shiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { noteParts, placeNotes, type NoteRow } from "@/shared/reportNotes";
import { useBackState } from "@/shared/links";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { ShiftsTabs } from "@/shared/ShiftsTabs";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import {
  MISSING_NEXT,
  MY_SHIFTS_MAX_DAYS,
  factsOf,
  myShiftsWindow,
  rowsOf,
  useMyNumbers,
  useMyShiftNotes,
  useMyShifts,
  useShiftNow,
  type MyShiftRow,
  type MyShiftsFacts,
  type StatsShift,
} from "./data";
import { useMyMoneyParts } from "./MyMoney";
import { MyPeriod, MyPeriodSkeleton } from "./MyPeriod";
import { PeriodQualityLine, numbersOfRow } from "./MyQuality";
import { ShiftCard } from "./ShiftCard";
import "./my-shifts.css";

/**
 * Мои смены — a chatter's own part of Workboard (owner, 2026-11-10; «отчёты в удобном и красивом виде», 2026-11-19):
 * the period in numbers, then every shift of the period as a card, newest first — its report at a glance (shared
 * with the old way: the post in «Отчётность», the agent's draft) and the one step to take when something is due. A card
 * opens the shift's page (its report, its numbers and its pulse in one place); its button opens the board. The period is
 * the app's one period; nothing here is pay, nothing is anyone else's.
 */

/** «2 смены без отчёта». */
function withoutReportWords(count: number): string {
  return `${count} ${ruPlural(count, "смена", "смены", "смен")} без отчёта`;
}

// ───────────────────────────────────────────────────────────── The day's note

/** A row's shift, for the day's note; a report Hub saw no shift for stands under no day. */
function noteRows(rows: readonly MyShiftRow[]): NoteRow[] {
  return rows.flatMap((row) => (row.shift === null ? [] : [{ key: row.key, userId: null, startedAt: row.shift.startedAt, endedAt: row.shift.endedAt, ongoing: row.shift.ongoing }]));
}

// ───────────────────────────────────────────────────────────── The facts

/**
 * What of the reports did not come: all of them, or the posts alone (the drafts are shown); `test` — a person of the test
 * team, whose reports the ledger never keeps (nothing is away, nothing to retry: what «Деньги» says to the test owner).
 */
type Unavailable = "reports" | "posts" | "test" | null;

const UNAVAILABLE_HINT: Record<Exclude<Unavailable, null>, string> = {
  test: "Отчёты в «Отчётности» и начисления считает ledger агентства, а тестовую команду он не знает. Отчёт смены, сданный доской, виден в строке смены.",
  reports: "Отчёты хранятся отдельно от Hub, и сейчас они не пришли. Смены видны и без них; суммы по отчётам появятся, когда отчёты снова откроются.",
  posts: "Отчёты, отправленные в Отчётность, сейчас не пришли: видны только черновики Генгара. Суммы по отчётам появятся, когда отправленные снова откроются.",
};

function FactsLine({ facts, previous, versus, unavailable, onRetry, retrying }: {
  facts: MyShiftsFacts;
  /** The report totals of the window before; null — nothing to compare with. */
  previous: number | null;
  versus: string;
  unavailable: Unavailable;
  onRetry: () => void;
  retrying: boolean;
}) {
  const items: FactItem[] = [
    { label: "Смен", value: String(facts.shifts) },
    { label: "Отработано", value: <Duration minutes={facts.workedMinutes} /> },
  ];
  if (unavailable === "test") {
    items.push({ label: "По отчётам", value: <span className="ui-muted">в тестовой команде их нет</span>, title: UNAVAILABLE_HINT.test });
  } else if (unavailable !== null) {
    items.push({
      label: "По отчётам",
      value: (
        <span className="mys-facts__away">
          {unavailable === "posts" ? "отправленные сейчас недоступны" : "сейчас недоступны"}
          <Button size="sm" variant="ghost" icon={RotateCw} loading={retrying} onClick={onRetry}>{retrying ? "Повторяем…" : "Повторить"}</Button>
        </span>
      ),
      title: UNAVAILABLE_HINT[unavailable],
    });
  } else {
    const showDelta = previous !== null && facts.reportedMills !== null && readDelta(facts.reportedMills, previous).kind !== "none";
    items.push({
      label: "По отчётам",
      strong: true,
      value: (
        <span className="mys-facts__money">
          <Money mills={facts.reportedMills} strong />
          {showDelta && <Delta current={facts.reportedMills} previous={previous} title={versus} />}
        </span>
      ),
    });
    items.push({
      label: "В час",
      value: <Money mills={facts.perHourMills} />,
      hint: "Сумма отчётов на отработанное время без пауз. Считаются только смены, у которых есть отчёт.",
    });
  }
  return (
    <div className="mys-facts">
      <Facts items={items} label="Итог периода" />
      {facts.withoutReport > 0 && (
        <Tooltip content={`Смена закончилась, а отчёта по ней нет. ${MISSING_NEXT[0]!.toUpperCase()}${MISSING_NEXT.slice(1)}. Агент соберёт его по продажам смены.`} align="end">
          <Badge tone="warning" className="mys-facts__mark">{withoutReportWords(facts.withoutReport)}</Badge>
        </Tooltip>
      )}
    </div>
  );
}

function FactsSkeleton() {
  return (
    <div className="mys-facts" aria-hidden>
      <Skeleton width={72} />
      <Skeleton width={140} />
      <Skeleton width={180} />
      <Skeleton width={96} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────── Now

/**
 * «Сейчас на смене» for oneself (spec §4.1.2, as the owner's row): since when, worked so far, a break going on now, the
 * pages; the report comes after.
 */
function NowRow({ shift }: { shift: StatsShift }) {
  const when = shiftWhen({ startedAt: shift.startedAt, endedAt: shift.endedAt, ongoing: true, workedMinutes: shift.workedMinutes });
  const hint = shiftDurationHint(when);
  const pause = shiftPauseText(shift);
  return (
    <section className="mys-now" aria-label="Сейчас на смене">
      <span aria-hidden className="mys-now__dot" />
      <span className="mys-now__title">Сейчас на смене</span>
      <span className="mys-now__fact">
        с {formatTimeOfDay(shift.startedAt)}
        <span className="mys-now__sep" aria-hidden>·</span>
        <Tooltip content={hint ?? when.label} align="start"><span>{when.worked} работы</span></Tooltip>
        {pause !== null && (
          <>
            <span className="mys-now__sep" aria-hidden>·</span>
            <span>{pause}</span>
          </>
        )}
      </span>
      {shift.pages.length > 0 && <span className="mys-now__pages"><PageLabels labels={shift.pages} /></span>}
      <span className="mys-now__end">
        <Tooltip content="Продажи смены по правилу «чья продажа», как их видит Hub, пока она идёт: это не отчёт." align="end">
          <span className="mys-hub">по правилу <Money mills={shift.salesNetMills} muted /></span>
        </Tooltip>
        <span className="mys-now__note">отчёт в конце смены</span>
      </span>
    </section>
  );
}

// ───────────────────────────────────────────────────────────── The screen

/** The feed while the first read comes: three cards as tall as the ones to come. */
function FeedSkeleton() {
  return (
    <ol className="mys-feed" aria-busy>
      {Array.from({ length: 3 }, (_, index) => (
        <li key={index} className="mys-card mys-card--skeleton">
          <div className="mys-card__when"><Skeleton width={120} height={20} /><Skeleton width={96} height={16} /></div>
          <div className="mys-card__money"><Skeleton width={88} height={28} radius={6} /></div>
          <div className="mys-card__track"><Skeleton width="100%" height={20} radius={6} /></div>
          <div className="mys-card__kinds"><Skeleton width="100%" height={20} radius={6} /></div>
          <div className="mys-card__foot"><Skeleton width={140} height={24} radius={6} /></div>
        </li>
      ))}
    </ol>
  );
}

export function MyShiftsScreen() {
  const { test } = useMe();
  const { spec, period, today } = usePeriod();
  const location = useLocation();
  const queryClient = useQueryClient();
  const window = useMemo(() => myShiftsWindow(period), [period]);
  const read = useMyShifts(window, period.current);
  const numbers = useMyNumbers(window, period.current);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const feed = useRef<HTMLOListElement>(null);

  const data = read.data;
  // The drafts came, the posts did not: the drafts show, and nothing is claimed of a shift without one.
  const postsRead = data?.postsRead ?? true;
  // Which report is which shift's is Hub's (`accountShifts`): the rows come paired.
  const rows = useMemo(() => (data ? rowsOf(data.rows) : undefined), [data]);
  // A card opens the shift's page; «←» there comes back here, this period.
  const backHere = useBackState("Мои смены");
  const facts = useMemo(() => (rows && data ? factsOf(rows, data.reportsRead && postsRead) : undefined), [rows, data, postsRead]);
  // «Мои деньги» (ecosystem package H1): nothing until the person's switch is on.
  const money = useMyMoneyParts(window, rows);
  // The day's note under its last shift: only a day that has something to say here (the report's sum is the card's own).
  const dayNotes = useMyShiftNotes(window);
  const notes = useMemo(
    () => new Map([...placeNotes(noteRows(rows ?? []), dayNotes)].filter(([, placed]) => noteParts(placed, { sum: false }).length > 0)),
    [rows, dayNotes],
  );
  // Every card's beads are sized against the period's biggest sale, so a big sale looks big on any card.
  const maxSaleMills = useMemo(() => Math.max(0, ...(rows ?? []).flatMap((row) => row.shift?.sales.map((sale) => sale.netMills) ?? [])), [rows]);
  const unavailable: Unavailable = data === undefined ? null : !data.reportsRead ? (test ? "test" : "reports") : postsRead ? null : "posts";

  // The shift going on is shown once: as the feed's first card when the period holds it, else above it («Сейчас на
  // смене», from the read of the last two days — a past period, or a night begun before its first day).
  const ongoing = rows?.find((row) => row.shift?.ongoing)?.shift ?? null;
  const now = useShiftNow(data !== undefined && ongoing === null);
  const nowShift = ongoing === null ? now.data ?? null : null;

  // The window before, cut at the same point while this one goes on (Hub's): its reports' sum, or nothing to compare with.
  const previousStarts = data ? Date.parse(data.previous.startsAt) : window.startsAt;
  const previousEnds = data ? Date.parse(data.previous.endsAt) : window.startsAt;
  const comparison = { label: formatDayRange(moscowDayOf(previousStarts), moscowDayOf(Math.max(previousStarts, previousEnds - 1))), sameTime: data?.previous.sameTime ?? false };
  const previousMills = data?.previous.reportedMills ?? null;
  const refreshing = read.isPlaceholderData && read.isFetching;
  const versus = `К ${comparison.label}${comparison.sameTime ? " на это же время" : ""}, по отчётам`;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["my-shifts"] });
  const toggle = (row: MyShiftRow, next: boolean) => setOpen((current) => {
    const updated = new Set(current);
    if (next) updated.add(row.key);
    else updated.delete(row.key);
    return updated;
  });
  // `?report=<day>` (a post to fix, «Ждут вас»): that day's report opens in its card, once the rows are here.
  const askedDay = new URLSearchParams(location.search).get("report");
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!rows || askedDay === null || opened.current === location.key) return;
    opened.current = location.key;
    const asked = rows.filter((row) => row.hub === null && row.report?.reportDate === askedDay).map((row) => row.key);
    if (asked.length === 0) return;
    setOpen((current) => new Set([...current, ...asked]));
    // The asked card in view, once it has opened.
    requestAnimationFrame(() => feed.current?.querySelector(`[data-key="${CSS.escape(asked[0]!)}"]`)?.scrollIntoView({ block: "start" }));
  }, [rows, askedDay, location.key]);

  let meta: ReactNode;
  // No shift in the period: the empty state says it; a line of zeros would say nothing more.
  if (facts && facts.shifts === 0) {
    meta = <span />;
  } else if (facts) {
    meta = (
      <div className="mys-meta">
        <FactsLine facts={facts} previous={previousMills} versus={versus} unavailable={unavailable} onRetry={() => void read.refetch()} retrying={read.isFetching} />
        {numbers.data && <PeriodQualityLine answer={numbers.data} />}
      </div>
    );
  } else if (read.isPending) {
    meta = <FactsSkeleton />;
  } else {
    meta = <span />;
  }

  const words = periodWords(period);
  let body: ReactNode;
  if (!data && read.isError) {
    body = <ErrorState onRetry={refresh} retrying={read.isFetching}>Смены не пришли. Это не значит, что их нет: экран их просто не получил.</ErrorState>;
  } else if (!rows || !data) {
    body = <><MyPeriodSkeleton /><FeedSkeleton /></>;
  } else if (rows.length === 0) {
    const since = data.stats.activitySince ? moscowDayOf(data.stats.activitySince) : null;
    const beforeHub = since !== null && since > window.to;
    // Before Hub saw any of the chatter's work, an earlier week is as empty: back to this one instead.
    const elsewhere = beforeHub
      ? { label: "К этой неделе", search: withPeriod(new URLSearchParams(location.search), currentWeek(today)).toString() }
      : spec.kind === "week" ? { label: "Прошлая неделя", search: withPeriod(new URLSearchParams(location.search), stepWeek(spec, -1, today)).toString() } : null;
    body = (
      <EmptyState
        title={`${words[0]!.toUpperCase()}${words.slice(1)} смен нет`}
        action={elsewhere ? <LinkButton to={{ pathname: location.pathname, search: elsewhere.search }}>{elsewhere.label}</LinkButton> : undefined}
      >
        {beforeHub && since !== null
          ? `Hub видит вашу работу в расширении ChatGoose с ${formatDay(since)}`
          : "Смена появится здесь, когда вы поработаете в расширении ChatGoose, а отчёт появится, когда его соберут в конце смены."}
      </EmptyState>
    );
  } else {
    const userId = data.stats.user.userId;
    body = (
      <>
        {data.stats.totals.shifts > 0 && <MyPeriod stats={data.stats} numbers={numbers.data} numbersFailed={numbers.isError && !numbers.data} today={today} words={words} />}
        <section className="mys-shifts" aria-label="Смены" data-refreshing={refreshing || undefined}>
          <h2 className="mys-shifts__title">Смены</h2>
          <ol ref={feed} className="mys-feed">
            {rows.map((row) => (
              <ShiftCard
                key={row.key}
                row={row}
                userId={userId}
                numbers={numbersOfRow(numbers.data, row.shift)}
                maxSaleMills={maxSaleMills}
                accrual={money.accrual.get(row.key)}
                note={notes.get(row.key)}
                open={open.has(row.key)}
                onOpen={(next) => toggle(row, next)}
                back={backHere}
              />
            ))}
          </ol>
        </section>
      </>
    );
  }

  return (
    <>
      <ScreenHeader
        title="Смены"
        period
        meta={meta}
        updatedAt={data ? read.dataUpdatedAt : undefined}
        onRefresh={refresh}
        refreshing={read.isFetching}
        stale={read.isRefetchError}
      />
      <div className="wb-content mys">
        <ShiftsTabs />
        {/* From «Отчёт» with no shift to report (the board's tab leads here). */}
        {new URLSearchParams(location.search).get("noreport") === "1" && (
          <Notice title="Смены для отчёта нет">Отчёт откроется, когда начнётся смена: кнопка «Отчёт» в расширении или карточка смены здесь.</Notice>
        )}
        {window.clipped && (
          <Notice title={`Смены видны не больше чем за ${MY_SHIFTS_MAX_DAYS} день`}>
            Чтобы увидеть {formatDayRange(period.from, addDays(window.from, -1))}, выберите эти дни отдельно. Сейчас показаны {formatDayRange(window.from, window.to)}.
          </Notice>
        )}
        {nowShift && <NowRow shift={nowShift} />}
        {money.block}
        {body}
      </div>
    </>
  );
}
