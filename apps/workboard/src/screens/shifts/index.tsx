import { useQueryClient } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { Button, EmptyState, ErrorState, LinkButton, Notice } from "@agency_hub_core/ui";
import { formatDay, formatDayRange } from "@agency_hub_core/ui/format";
import { addDays, daysInRange } from "@agency_hub_core/ui/moscow";
import { currentWeek, stepWeek, withPeriod, type ResolvedPeriod } from "@agency_hub_core/ui/period";
import { useMattersActive } from "@/shared/matters";
import { usePeopleIndex } from "@/shared/people";
import { SHIFT_SALES_KEY, usersQuery } from "@/shared/reads";
import { liveLogins, personOfLogin, useTeamPeople } from "@/screens/people/registry";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { AuthorlessLine } from "./Authorless.js";
import { AUTHORSHIP_MAX_DAYS, SHIFTS_MAX_DAYS, buildModel, shiftsWindow, useShiftsPeriod, useShiftsReports, windowColumns } from "./data.js";
import { HowItCounts } from "./HowItCounts.js";
import { Journal } from "./Journal.js";
import { NowOnShift } from "./NowOnShift.js";
import { reportNotes } from "./reports.js";
import { WaitingLine } from "./WaitingLine.js";
import { WeekGrid, sentence } from "./WeekGrid.js";
import "./shifts.css";

/** «за эту неделю», «за 26 окт. – 1 нояб.», «за 14 дней». */
function periodWords(period: ResolvedPeriod): string {
  const { spec } = period;
  if (spec.kind === "week") return period.current ? "за эту неделю" : `за ${period.label}`;
  if (spec.kind === "days") return `за ${spec.days} дней`;
  return `за ${period.label}`;
}

/**
 * The viewer's own logins, for `?mine=1` («Мои смены» of the owner or a team
 * lead: Смены of one person, not a second screen): every live login of the
 * person holding theirs, or their own login alone. Null while not asked.
 */
function useOwnLogins(mine: boolean): ReadonlySet<number> | null {
  const { user } = useMe();
  const people = useTeamPeople();
  return useMemo(() => {
    if (!mine || !user) return null;
    const person = personOfLogin(people.data?.people ?? [], user.id);
    return new Set(person ? liveLogins(person).map((login) => login.userId) : [user.id]);
  }, [mine, people.data, user]);
}

/**
 * Смены — the home of Workboard (spec §4.1): who is on a shift now, the period
 * by chatter × day, and the journal of every shift (what waits is «Ждут вас»).
 * Every shift (a row, a cell, the «now» row) opens its review. Read-only.
 * `?mine=1`: only the viewer's own shifts (their «Мои смены», one screen).
 */
export function ShiftsScreen() {
  const { spec, period, today } = usePeriod();
  const { page, setPage } = usePageFilter();
  const { isOwner } = useMe();
  const location = useLocation();
  const [search] = useSearchParams();
  const queryClient = useQueryClient();
  const window = useMemo(() => shiftsWindow(period), [period]);
  const { sales, numbers } = useShiftsPeriod({ window, page, current: period.current });
  const mine = search.get("mine") === "1";
  const { active: waitingFromMatters } = useMattersActive();
  const own = useOwnLogins(mine);
  const people = usePeopleIndex();
  const full = useMemo(() => (sales.data ? buildModel(sales.data, numbers.data, window, people) : undefined), [sales.data, numbers.data, window, people]);
  const model = useMemo(() => (full && own ? {
    ...full,
    chatters: full.chatters.filter((row) => row.userId !== null && own.has(row.userId)),
    journal: full.journal.filter((shift) => own.has(shift.userId)),
  } : full), [full, own]);
  // The owner's: where the day's report pays by another sum than the rule's shifts of it (reports.ts).
  const ruleFrom = sales.data?.ruleFrom ?? null;
  const reports = useShiftsReports(window, isOwner && ruleFrom !== null);
  const notes = useMemo(
    () => reportNotes({ shifts: model?.journal ?? [], reports, page, ruleFrom, people }),
    [model, reports, page, ruleFrom, people],
  );
  const everyone = new URLSearchParams(location.search);
  everyone.delete("mine");

  const quality = numbers.data ? "ready" : numbers.isError ? "failed" : "loading";
  const refreshing = sales.isPlaceholderData && sales.isFetching;
  const versus = spec.kind === "week" && period.current ? "Сравнение с прошлой неделей на это же время" : `Сравнение с ${period.previousLabel}`;
  const authorshipDays = Math.min(AUTHORSHIP_MAX_DAYS, daysInRange(period.from, today));
  const empty = model !== undefined && model.journal.length === 0 && model.chatters.length === 0;
  // The whole period lies before Hub began counting shifts: nothing to show, nothing to compare.
  const beforeCounting = model !== undefined && model.knownSince !== null && window.to < model.knownSince;
  // A period longer than Hub reads, whose days cut off all lie before Hub counted.
  const cutBeforeCounting = window.clipped && model !== undefined && model.knownSince !== null && addDays(window.from, -1) < model.knownSince;

  // The comparison is said once, here; the grid's cells only carry it on hover.
  let meta: ReactNode;
  // Before Hub counted: the empty state says it once, the header says nothing to compare.
  if (beforeCounting) meta = <span />;
  else if (model && !model.comparable) {
    meta = <span>{model.knownSince ? `Сравнения нет: Hub считает смены с ${formatDay(model.knownSince)}` : "Сравнения нет"}</span>;
  } else if (spec.kind === "week" && period.current) meta = <span>Эта неделя · сравнение с {period.previousLabel} на это же время</span>;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["shifts"] });
    // Every period's shifts with sales, as ["shifts"] covered before they became the entries Люди and Выплаты share.
    void queryClient.invalidateQueries({ queryKey: SHIFT_SALES_KEY });
    void queryClient.invalidateQueries({ queryKey: ["decisions"] });
    // Решения's people list, which ["decisions"] covered before it became the shared entry.
    void queryClient.invalidateQueries({ queryKey: usersQuery.queryKey, exact: true });
    // The reports behind «в отчёте $…», the entry «Выплаты → Отчёты» shares.
    void queryClient.invalidateQueries({ queryKey: ["payouts", "reports"] });
  };

  let body;
  if (!sales.data && sales.isError) {
    body = <ErrorState onRetry={refresh} retrying={sales.isFetching} />;
  } else if (empty && beforeCounting) {
    const thisWeek = withPeriod(new URLSearchParams(location.search), currentWeek(today)).toString();
    body = (
      <EmptyState
        title={`Hub считает смены с ${formatDay(model.knownSince!)}`}
        action={<LinkButton to={{ pathname: "/shifts", search: thisWeek }}>К этой неделе</LinkButton>}
      >
        Раньше этого дня расширение ChatGoose не сообщало Hub о работе чаттеров, поэтому смен здесь нет.
      </EmptyState>
    );
  } else if (empty) {
    const words = periodWords(period);
    const previousWeek = spec.kind === "week" ? withPeriod(new URLSearchParams(location.search), stepWeek(spec, -1, today)).toString() : null;
    body = mine ? (
      <EmptyState
        title={`У вас ${words} смен нет`}
        action={<LinkButton to={{ pathname: "/shifts", search: everyone.toString() ? `?${everyone.toString()}` : "" }}>Все смены</LinkButton>}
      />
    ) : page !== null ? (
      <EmptyState
        title={`На ${page} ${words} смен нет`}
        action={<Button onClick={() => setPage(null)}>Показать все страницы</Button>}
      >
        На этой странице никто не работал в расширении ChatGoose столько, чтобы это стало сменой.
      </EmptyState>
    ) : (
      <EmptyState
        title={`${words[0]!.toUpperCase()}${words.slice(1)} смен нет`}
        action={previousWeek ? <LinkButton to={{ pathname: "/shifts", search: previousWeek }}>Показать прошлую неделю</LinkButton> : undefined}
      >
        Никто не работал в расширении ChatGoose, или у чаттеров ещё старая версия расширения.
      </EmptyState>
    );
  } else {
    body = (
      <>
        <WeekGrid
          model={model}
          isOwner={isOwner}
          versus={versus}
          loading={!model}
          refreshing={refreshing}
          weekly={spec.kind === "week"}
          page={page}
          columns={windowColumns(window, today)}
          mine={mine}
        />
        <Journal
          model={model}
          isOwner={isOwner}
          quality={quality}
          onRetryQuality={() => void numbers.refetch()}
          retryingQuality={numbers.isFetching}
          loading={!model}
          refreshing={refreshing}
          page={page}
          reportNotes={notes}
          ruled={ruleFrom !== null}
        />
      </>
    );
  }

  return (
    <>
      <ScreenHeader
        title="Смены"
        period
        pageFilter
        meta={meta}
        updatedAt={sales.dataUpdatedAt}
        stale={sales.isRefetchError}
        onRefresh={refresh}
        refreshing={sales.isFetching}
      />
      <div className="wb-content shifts">
        {mine && (
          <p className="shifts-mine">
            Только ваши смены.{" "}
            <Link className="ui-link" to={{ pathname: "/shifts", search: everyone.toString() ? `?${everyone.toString()}` : "" }}>Все смены</Link>
          </p>
        )}
        <div className="shifts-top">
          {/* What waits has one place, «Ждут вас» with its number in the menu; this older line stays only while the
              owner's switch `mattersReadEnabled` is off (the list is then the old queues). */}
          {waitingFromMatters === false && <WaitingLine />}
          <NowOnShift page={page} only={own} />
        </div>
        {/* Cut off only days before Hub counted: the header's «Hub считает смены с …» says it all, no advice to pick them. */}
        {window.clipped && model !== undefined && !cutBeforeCounting && (
          <Notice title={`Hub считает смены не больше чем за ${SHIFTS_MAX_DAYS} день`}>
            Чтобы увидеть {formatDayRange(period.from, addDays(window.from, -1))}, выберите эти дни отдельно. Сейчас показаны
            {" "}{sentence(formatDayRange(window.from, window.to))}
          </Notice>
        )}
        {body}
        <div className="shifts-foot">
          {!mine && <AuthorlessLine days={authorshipDays} page={page} enabled={period.current} partial={authorshipDays < period.shownDays} />}
          <HowItCounts page={page} ruleFrom={sales.data?.ruleFrom ?? null} />
        </div>
      </div>
    </>
  );
}
