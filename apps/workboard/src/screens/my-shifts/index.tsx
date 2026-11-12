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
  Table,
  Tooltip,
  readDelta,
  type Column,
  type FactItem,
} from "@agency_hub_core/ui";
import { formatDay, formatDayRange, formatMills, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { addDays, moscowDayOf } from "@agency_hub_core/ui/moscow";
import { currentWeek, stepWeek, withPeriod, type ResolvedPeriod } from "@agency_hub_core/ui/period";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { REPORT_DRAFT_NEXT, reportStatusWord } from "@agency_hub_core/ui/shiftReports";
import { shiftDurationHint, shiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { ReportBody, useReportEdge } from "@/shared/ReportBody";
import { useRowBackState } from "@/shared/links";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { MyMatters } from "../waiting/MyMatters";
import { usePeriod } from "@/shared/usePeriod";
import {
  MY_SHIFTS_MAX_DAYS,
  comparisonOf,
  factsOf,
  joinShifts,
  myShiftsWindow,
  previousReportedMills,
  useMyShifts,
  usePreviousReports,
  useShiftNow,
  type MyShiftRow,
  type MyShiftsFacts,
  type StatsShift,
} from "./data";
import { useMyMoneyParts } from "./MyMoney";
import "./my-shifts.css";

/**
 * Мои смены — a chatter's own part of Workboard (owner, 2026-11-10): every
 * shift of the period with its report, one row each, newest first. The report
 * is the post in «Отчётность» — with the agent's draft or written by hand — and
 * a draft not posted yet. The row's one number is the report's: what the
 * chatter posted, else the draft's total; Hub's own sales figure shows only
 * where there is no report yet. A row opens in place to its report: the pages
 * as posted (the draft's amount beside a page that differs), the sales in the
 * total and those held out, and why. The period is the app's one period;
 * nothing here is pay, nothing is anyone else's.
 */

/** What a missing report asks of the chatter. */
const MISSING_NEXT = "попросите в чате: /smena";

/** «за эту неделю», «за 26 окт. – 1 нояб.», «за 14 дней». */
function periodWords(period: ResolvedPeriod): string {
  const { spec } = period;
  if (spec.kind === "week") return period.current ? "за эту неделю" : `за ${period.label}`;
  if (spec.kind === "days") return `за ${spec.days} дней`;
  return `за ${period.label}`;
}

/** «2 смены без отчёта». */
function withoutReportWords(count: number): string {
  return `${count} ${ruPlural(count, "смена", "смены", "смен")} без отчёта`;
}

// ───────────────────────────────────────────────────────────── The cells

/** The shift's one label (D12): the day on top, the clock under it; on a phone also the worked time, pages and Hub's figure. */
function WhenCell({ row }: { row: MyShiftRow }) {
  const hint = row.workedMinutes !== null ? shiftDurationHint(row.when) : null;
  return (
    <span className="mys-when">
      <span className="mys-when__day">{row.when.days}</span>
      <span className={row.shift?.ongoing ? "mys-when__time mys-when__time--now" : "mys-when__time"}>
        {row.when.time}
        {/* A phone has no room for the columns: the same facts, in the same order, under the day. */}
        <span className="mys-phone">
          {row.workedMinutes !== null && <> · <Tooltip content={hint ?? ""}><span>{row.when.worked}</span></Tooltip></>}
          {row.pages.length > 0 && <> · {row.pages.join(", ")}</>}
          {row.hubMills !== null && <> · по данным Hub {formatMills(row.hubMills)}</>}
          {row.shift === null && <> · смена в Hub не найдена</>}
        </span>
      </span>
    </span>
  );
}

function PagesCell({ row }: { row: MyShiftRow }) {
  return (
    <span className="mys-pages">
      {row.pages.length > 0 ? <PageLabels labels={row.pages} /> : <span className="ui-muted">—</span>}
      {row.shift === null && (
        <Tooltip
          content={row.report?.source === "post"
            ? "Hub не видел в этот день вашей работы в расширении ChatGoose: к какой смене относится отчёт, неизвестно."
            : "Hub не видел в это время вашей работы в расширении ChatGoose: отчёт собрали без смены."}
          align="start"
        >
          <span className="mys-pages__note">смена в Hub не найдена</span>
        </Tooltip>
      )}
    </span>
  );
}

function WorkedCell({ row }: { row: MyShiftRow }) {
  if (row.workedMinutes === null) return <span className="ui-muted">—</span>;
  const hint = shiftDurationHint(row.when);
  return hint ? <Tooltip content={hint} align="end"><Duration minutes={row.workedMinutes} /></Tooltip> : <Duration minutes={row.workedMinutes} />;
}

function TotalCell({ row }: { row: MyShiftRow }) {
  if (row.totalMills !== null && row.preliminary) {
    return (
      <Tooltip content="Черновик отчёта: сумма по правилу и вашим отметкам. Станет итоговой, когда вы сдадите смену." align="end">
        <span className="mys-pre"><Money mills={row.totalMills} /> <span className="mys-pre__word">предварительно</span></span>
      </Tooltip>
    );
  }
  if (row.totalMills !== null) return <Money mills={row.totalMills} strong />;
  if (row.hubMills === null) return <span className="ui-muted">—</span>;
  return (
    <Tooltip content="Продажи смены, как их видит Hub: это не отчёт. Сумма отчёта может быть другой: в нём делят продажи с коллегами и добавляют то, чего нет в Hub." align="end">
      <span className="mys-hub">по данным Hub <Money mills={row.hubMills} muted /></span>
    </Tooltip>
  );
}

/** The state in words; colour only where something is to be done. */
function StateCell({ row }: { row: MyShiftRow }) {
  switch (row.state) {
    case "posted":
      return (
        <span className="mys-state">
          <Badge tone="success" bare className="mys-state__badge">Пост отправлен</Badge>
          {/* The chatter's right, not an alarm: said quietly, under the word. */}
          {row.draftMills !== null && <span className="mys-state__was">в черновике было {formatMills(row.draftMills)}</span>}
        </span>
      );
    case "draft":
      return (
        <span className="mys-state">
          <Badge tone="warning" className="mys-state__badge">Собран</Badge>
          <span className="mys-state__next">{REPORT_DRAFT_NEXT}</span>
        </span>
      );
    case "missing":
      return (
        <span className="mys-state">
          <Badge tone="warning" className="mys-state__badge">Отчёта нет</Badge>
          <span className="mys-state__next">{MISSING_NEXT}</span>
        </span>
      );
    case "ongoing":
      return <span className="mys-state"><Badge tone="info" bare className="mys-state__badge">Идёт</Badge></span>;
    case "due":
      return (
        <span className="mys-state">
          <Badge tone="warning" className="mys-state__badge">Сдайте смену</Badge>
        </span>
      );
    case "handed":
      return (
        <span className="mys-state">
          <Badge tone="success" bare className="mys-state__badge">Сдан</Badge>
          {row.hub?.submittedAt && <span className="mys-state__was">в {formatTimeOfDay(row.hub.submittedAt)}{row.hub.version !== null && row.hub.version > 1 ? `, версия ${row.hub.version}` : ""}</span>}
        </span>
      );
    case "other":
      return <span className="mys-state"><Badge tone="off" bare className="mys-state__badge">{reportStatusWord(row.report?.status ?? "")}</Badge></span>;
    case "unknown":
      // The reports did not come: said once, in the line of facts; nothing per row.
      return <span className="mys-state" />;
  }
}

const COLUMNS: Column<MyShiftRow>[] = [
  { key: "when", header: "Смена", className: "mys-col-when", nowrap: true, cell: (row) => <WhenCell row={row} /> },
  { key: "pages", header: "Страницы", className: "mys-col-pages", muted: true, cell: (row) => <PagesCell row={row} /> },
  { key: "worked", header: "Отработано", className: "mys-col-worked", numeric: true, nowrap: true, cell: (row) => <WorkedCell row={row} /> },
  { key: "total", header: "По отчёту", className: "mys-col-total", numeric: true, nowrap: true, cell: (row) => <TotalCell row={row} /> },
  { key: "state", header: "Отчёт", className: "mys-col-state", grow: true, cell: (row) => <StateCell row={row} /> },
];

// ───────────────────────────────────────────────────────────── The facts

/** What of the reports did not come: all of them, or the posts alone (the drafts are shown). */
type Unavailable = "reports" | "posts" | null;

const UNAVAILABLE_HINT: Record<Exclude<Unavailable, null>, string> = {
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
  if (unavailable !== null) {
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

/** «Сейчас на смене» for oneself (spec §4.1.2, as the owner's row): since when, worked so far, the pages; the report comes after. */
function NowRow({ shift }: { shift: StatsShift }) {
  const when = shiftWhen({ startedAt: shift.startedAt, endedAt: shift.endedAt, ongoing: true, workedMinutes: shift.workedMinutes });
  const hint = shiftDurationHint(when);
  return (
    <section className="mys-now" aria-label="Сейчас на смене">
      <span aria-hidden className="mys-now__dot" />
      <span className="mys-now__title">Сейчас на смене</span>
      <span className="mys-now__fact">
        с {formatTimeOfDay(shift.startedAt)}
        <span className="mys-now__sep" aria-hidden>·</span>
        <Tooltip content={hint ?? when.label} align="start"><span>{when.worked} работы</span></Tooltip>
      </span>
      {shift.pages.length > 0 && <span className="mys-now__pages"><PageLabels labels={shift.pages} /></span>}
      <span className="mys-now__end">
        <Tooltip content="Продажи смены, как их видит Hub, пока она идёт: это не отчёт." align="end">
          <span className="mys-hub">по данным Hub <Money mills={shift.salesNetMills} muted /></span>
        </Tooltip>
        <span className="mys-now__note">отчёт в конце смены</span>
      </span>
    </section>
  );
}

// ───────────────────────────────────────────────────────────── The screen

export function MyShiftsScreen() {
  const { spec, period, today } = usePeriod();
  const location = useLocation();
  const queryClient = useQueryClient();
  const window = useMemo(() => myShiftsWindow(period), [period]);
  const read = useMyShifts(window, period.current);
  const previous = usePreviousReports(window);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const journal = useRef<HTMLDivElement>(null);
  useReportEdge(journal, COLUMNS.findIndex((column) => column.key === "total"));

  const data = read.data;
  const reports = data?.reports?.reports ?? null;
  // The drafts came, the posts did not: the drafts show, and nothing is claimed of a shift without one.
  const postsRead = data?.reports?.postsRead ?? true;
  const rows = useMemo(() => (data ? joinShifts({ shifts: data.stats.shifts, reports, postsRead, window, hub: data.hub }) : undefined), [data, reports, postsRead, window]);
  // A shift whose report is Hub's opens its own screen (ecosystem package F); the others open in place, as before.
  const backHere = useRowBackState("Мои смены");
  const facts = useMemo(() => (rows ? factsOf(rows, reports !== null && postsRead) : undefined), [rows, reports, postsRead]);
  // «Мои деньги» (ecosystem package H1): nothing until the person's switch is on.
  const money = useMyMoneyParts(window, COLUMNS, rows);
  const unavailable: Unavailable = data === undefined ? null : data.reports === null ? "reports" : postsRead ? null : "posts";

  // The shift going on is shown once: as the journal's first row when the period holds it, else above the journal
  // («Сейчас на смене», from the read of the last two days — a past period, or a night begun before its first day).
  const ongoing = rows?.find((row) => row.shift?.ongoing)?.shift ?? null;
  const now = useShiftNow(data !== undefined && ongoing === null);
  const nowShift = ongoing === null ? now.data ?? null : null;

  const comparison = comparisonOf(window, read.dataUpdatedAt || Date.now(), ongoing?.startedAt ?? null);
  // The window before without its posts is no comparison: its sums would be the drafts'.
  const previousMills = previousReportedMills(previous.data?.postsRead === false ? null : previous.data?.reports ?? null, comparison);
  const refreshing = read.isPlaceholderData && read.isFetching;
  const versus = `К ${comparison.label}${comparison.sameTime ? " на это же время" : ""}, по отчётам`;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["my-shifts"] });
  const toggle = (row: MyShiftRow, next: boolean) => setOpen((current) => {
    const updated = new Set(current);
    if (next) updated.add(row.key);
    else updated.delete(row.key);
    return updated;
  });
  // `?report=<day>` (a post to fix, «Ждут вас»): that day's report opens in its row, once the rows are here.
  const askedDay = new URLSearchParams(location.search).get("report");
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!rows || askedDay === null || opened.current === location.key) return;
    opened.current = location.key;
    const asked = rows.filter((row) => row.hub === null && row.report?.reportDate === askedDay).map((row) => row.key);
    if (asked.length > 0) setOpen((current) => new Set([...current, ...asked]));
  }, [rows, askedDay, location.key]);

  let meta: ReactNode;
  // No shift in the period: the empty state says it; a line of zeros would say nothing more.
  if (facts && facts.shifts === 0) {
    meta = <span />;
  } else if (facts) {
    meta = <FactsLine facts={facts} previous={previousMills} versus={versus} unavailable={unavailable} onRetry={() => void read.refetch()} retrying={read.isFetching} />;
  } else if (read.isPending) {
    meta = <FactsSkeleton />;
  } else {
    meta = <span />;
  }

  let body: ReactNode;
  if (!data && read.isError) {
    body = <ErrorState onRetry={refresh} retrying={read.isFetching}>Смены не пришли. Это не значит, что их нет: экран их просто не получил.</ErrorState>;
  } else {
    const since = data?.stats.activitySince ? moscowDayOf(data.stats.activitySince) : null;
    const beforeHub = since !== null && since > window.to;
    // Before Hub saw any of the chatter's work, an earlier week is as empty: back to this one instead.
    const elsewhere = beforeHub
      ? { label: "К этой неделе", search: withPeriod(new URLSearchParams(location.search), currentWeek(today)).toString() }
      : spec.kind === "week" ? { label: "Прошлая неделя", search: withPeriod(new URLSearchParams(location.search), stepWeek(spec, -1, today)).toString() } : null;
    const words = periodWords(period);
    body = (
      <div ref={journal} className="mys-journal-box">
        <Table
          label="Мои смены"
          className="mys-journal"
          columns={money.columns}
          rows={rows ?? []}
          rowKey={(row) => row.key}
          rowHref={(row) => (row.hub === null ? undefined : `/my/shifts/${row.hub.shiftId}`)}
          rowState={backHere}
          rowDetail={(row) => (row.hub === null && row.report ? <ReportBody report={row.report} /> : null)}
          openKeys={open}
          onOpenChange={toggle}
          loading={!rows}
          refreshing={refreshing}
          align="first-line"
          skeletonRows={6}
          skeletonLines={2}
          empty={(
            <EmptyState
              title={`${words[0]!.toUpperCase()}${words.slice(1)} смен нет`}
              action={elsewhere ? <LinkButton to={{ pathname: location.pathname, search: elsewhere.search }}>{elsewhere.label}</LinkButton> : undefined}
            >
              {beforeHub && since !== null
                ? `Hub видит вашу работу в расширении ChatGoose с ${formatDay(since)}`
                : "Смена появится здесь, когда вы поработаете в расширении ChatGoose, а отчёт появится, когда его соберут в конце смены."}
            </EmptyState>
          )}
        />
      </div>
    );
  }

  return (
    <>
      <ScreenHeader
        title="Мои смены"
        period
        meta={meta}
        updatedAt={data ? read.dataUpdatedAt : undefined}
        onRefresh={refresh}
        refreshing={read.isFetching}
        stale={read.isRefetchError}
      />
      <div className="wb-content mys">
        <MyMatters />
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
