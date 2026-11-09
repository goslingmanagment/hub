import { useQueryClient } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { useLocation } from "react-router";
import { Button, EmptyState, ErrorState, LinkButton, Notice } from "@agency_hub_core/ui";
import { formatDay, formatDayRange } from "@agency_hub_core/ui/format";
import { addDays, daysInRange } from "@agency_hub_core/ui/moscow";
import { currentWeek, stepWeek, withPeriod, type ResolvedPeriod } from "@agency_hub_core/ui/period";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { AuthorlessLine } from "./Authorless.js";
import { AUTHORSHIP_MAX_DAYS, SHIFTS_MAX_DAYS, buildModel, shiftsWindow, useShiftsPeriod, windowColumns } from "./data.js";
import { HowItCounts } from "./HowItCounts.js";
import { Journal } from "./Journal.js";
import { NowOnShift } from "./NowOnShift.js";
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
 * Смены — the home of Workboard (spec §4.1): what waits for a decision, who is
 * on a shift now, the period by chatter × day, and the journal of every shift.
 * Every shift (a row, a cell, the «now» row) opens its review. Read-only.
 */
export function ShiftsScreen() {
  const { spec, period, today } = usePeriod();
  const { page, setPage } = usePageFilter();
  const { isOwner } = useMe();
  const location = useLocation();
  const queryClient = useQueryClient();
  const window = useMemo(() => shiftsWindow(period), [period]);
  const { sales, numbers } = useShiftsPeriod({ window, page, current: period.current });
  const model = useMemo(() => (sales.data ? buildModel(sales.data, numbers.data, window) : undefined), [sales.data, numbers.data, window]);

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
    void queryClient.invalidateQueries({ queryKey: ["decisions"] });
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
    body = page !== null ? (
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
        <div className="shifts-top">
          <WaitingLine />
          <NowOnShift page={page} />
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
          <AuthorlessLine days={authorshipDays} page={page} enabled={period.current} partial={authorshipDays < period.shownDays} />
          <HowItCounts page={page} />
        </div>
      </div>
    </>
  );
}
