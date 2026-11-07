import { useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { Button, Count, Duration, Mark, Money, Person, Section, Skeleton, Spinner, Table, Tooltip, type Column, type SortState } from "@agency_hub_core/ui";
import { formatCount, formatDuration, formatMills, formatPercent } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { CHATTER_SHIFT_PAGE_MIN_MESSAGES } from "@agency_hub_core/contracts";
import { personPath, shiftPath } from "@/shared/links";
import { manyUnanswered, muchAi, slowReply, type JournalShift, type ShiftsModel, type TeamNorms } from "./data.js";
import { daysOf, spanOf } from "./WeekGrid.js";

/** Rows shown before «Показать все»: a week of a whole team fits. */
const FIRST_ROWS = 50;

/** «2 мин 10 с» under 20 minutes, then minutes and hours: a reply time. */
export function replyText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} с`;
  if (total < 20 * 60) {
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`;
  }
  return formatDuration(Math.round(total / 60));
}

function percentOf(share: number): string {
  return formatPercent(share * 100);
}

type QualityState = "loading" | "failed" | "ready";

function sortValueOf(key: string, shift: JournalShift): number | string | null {
  switch (key) {
    case "who":
      return shift.username;
    case "when":
      return shift.startedAt;
    case "worked":
      return shift.workedMinutes;
    case "sales":
      return shift.salesNetMills;
    case "perHour":
      return shift.perHourMills;
    case "reply":
      return shift.quality?.replyMedianSeconds ?? null;
    case "unanswered":
      return shift.quality?.unansweredAtEnd ?? null;
    case "ai":
      return shift.quality?.aiShare ?? null;
    default:
      return null;
  }
}

const SORT_KEYS = new Set(["who", "when", "worked", "sales", "perHour", "reply", "unanswered", "ai"]);

/** The journal's order in the address (`?sort=sales&dir=desc`): «←» from a review comes back to the same order. */
function useJournalSort(): [SortState | null, (next: SortState) => void] {
  const [search, setSearch] = useSearchParams();
  const key = search.get("sort");
  const sort: SortState | null = key && SORT_KEYS.has(key) ? { key, direction: search.get("dir") === "asc" ? "asc" : "desc" } : null;
  const setSort = (next: SortState) => setSearch((current) => {
    const updated = new URLSearchParams(current);
    updated.set("sort", next.key);
    updated.set("dir", next.direction);
    return updated;
  }, { replace: true });
  return [sort, setSort];
}

function sorted(rows: readonly JournalShift[], sort: SortState | null): JournalShift[] {
  if (!sort) return [...rows];
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = sortValueOf(sort.key, left);
    const b = sortValueOf(sort.key, right);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    if (typeof a === "string" && typeof b === "string") return a.localeCompare(b, "ru") * factor;
    return (Number(a) - Number(b)) * factor;
  });
}

function QualityCell({ state, shift, render }: { state: QualityState; shift: JournalShift; render: (quality: NonNullable<JournalShift["quality"]>) => ReactNode }) {
  if (shift.quality) return <>{render(shift.quality)}</>;
  if (state === "loading") return <span className="shifts-skeleton-cell"><Skeleton width={48} /></span>;
  return <span className="ui-muted" title={state === "failed" ? "Hub не ответил" : "Для этой смены чисел нет"}>—</span>;
}

/** The shift's pages under the name: a page with too few messages to count is greyed. */
function PagesHint({ shift }: { shift: JournalShift }) {
  if (shift.pages.length === 0) return <>—</>;
  return (
    <span className="shifts-journal__pages">
      {shift.pages.map((page, index) => (
        <span
          key={page.pageLabel}
          className={page.counts ? undefined : "shifts-journal__page--quiet"}
          title={page.counts
            ? `${page.pageLabel}: ${formatCount(page.messages)} ${ruPlural(page.messages, "сообщение", "сообщения", "сообщений")}`
            : `${page.pageLabel}: меньше ${CHATTER_SHIFT_PAGE_MIN_MESSAGES} сообщений, продажи этой страницы в смену не идут`}
        >
          {index > 0 && ", "}{page.pageLabel}
        </span>
      ))}
    </span>
  );
}

function columnsOf(state: QualityState, norms: TeamNorms): Column<JournalShift>[] {
  return [
    {
      key: "who",
      header: "Чаттер",
      sortValue: (shift) => shift.username,
      cell: (shift) => <Person name={shift.username} status={shift.ongoing ? "working" : "away"} hint={<PagesHint shift={shift} />} />,
    },
    {
      key: "when",
      header: "Смена",
      sortValue: (shift) => shift.startedAt,
      sortFirst: "desc",
      nowrap: true,
      cell: (shift) => (
        <Tooltip
          content={`${formatCount(shift.messages)} ${ruPlural(shift.messages, "сообщение", "сообщения", "сообщений")} · ${shift.pauseMinutes > 0 ? `паузы ${formatDuration(shift.pauseMinutes)}` : "без пауз"}`}
          align="start"
        >
          <span className="shifts-journal__day">{daysOf(shift)}</span>
          <span className={shift.ongoing ? "shifts-journal__span shifts-journal__span--now" : "shifts-journal__span"}>{spanOf(shift)}</span>
        </Tooltip>
      ),
    },
    {
      key: "worked",
      header: "Работа",
      title: "Отработано: смена без пауз",
      numeric: true,
      sortValue: (shift) => shift.workedMinutes,
      cell: (shift) => <Duration minutes={shift.workedMinutes} />,
    },
    {
      key: "sales",
      header: "Продажи",
      numeric: true,
      sortValue: (shift) => shift.salesNetMills,
      cell: (shift) => (shift.overlapNetMills > 0 ? (
        <Tooltip content={`Из них ${formatMills(shift.overlapNetMills)} на двоих: эти продажи видны и у другого чаттера, никто из двоих не писал этому фану`} align="end">
          <span className="shifts-journal__shared"><Money mills={shift.salesNetMills} strong /></span>
        </Tooltip>
      ) : <Money mills={shift.salesNetMills} strong />),
    },
    {
      key: "perHour",
      header: "В час",
      numeric: true,
      sortValue: (shift) => shift.perHourMills,
      cell: (shift) => <Money mills={shift.perHourMills} />,
    },
    {
      key: "reply",
      header: "Ответ",
      title: "Медиана: за сколько чаттер отвечал фану, который ждал",
      numeric: true,
      sortValue: (shift) => shift.quality?.replyMedianSeconds ?? null,
      sortFirst: "desc",
      cell: (shift) => (
        <QualityCell
          state={state}
          shift={shift}
          render={(quality) => {
            if (quality.replyMedianSeconds === null) return <span className="ui-muted">—</span>;
            const text = replyText(quality.replyMedianSeconds);
            return slowReply(quality, norms) ? <Mark title={`Обычно у команды — ${replyText(norms.replyMedianSeconds ?? 0)}`}>{text}</Mark> : text;
          }}
        />
      ),
    },
    {
      key: "unanswered",
      header: "Без ответа",
      headerWrap: true,
      title: "Фаны, чьё сообщение осталось последним к концу смены",
      numeric: true,
      sortValue: (shift) => shift.quality?.unansweredAtEnd ?? null,
      sortFirst: "desc",
      cell: (shift) => (
        <QualityCell
          state={state}
          shift={shift}
          render={(quality) => (manyUnanswered(quality, norms)
            ? <Mark title={`Обычно у команды — ${formatCount(Math.round(norms.unansweredAtEnd ?? 0))}`}>{formatCount(quality.unansweredAtEnd)}</Mark>
            : <Count value={quality.unansweredAtEnd} />)}
        />
      ),
    },
    {
      key: "ai",
      header: "ИИ",
      title: "Доля сообщений, вставленных кнопкой ИИ «Ответ»",
      numeric: true,
      sortValue: (shift) => shift.quality?.aiShare ?? null,
      sortFirst: "desc",
      cell: (shift) => (
        <QualityCell
          state={state}
          shift={shift}
          render={(quality) => {
            if (quality.aiShare === null) return <span className="ui-muted">—</span>;
            const text = percentOf(quality.aiShare);
            return muchAi(quality, norms) ? <Mark title={`Обычно у команды — ${percentOf(norms.aiShare ?? 0)}`}>{text}</Mark> : text;
          }}
        />
      ),
    },
  ];
}

/**
 * Журнал смен (spec §4.1.4): one table of every shift of the period, newest
 * first, a shift going on first; the whole row opens its review. Sort by any
 * column; an outlier against the team's usual shift gets one calm mark.
 */
export function Journal({ model, isOwner, quality, onRetryQuality, retryingQuality, loading = false, refreshing = false, page }: {
  model: ShiftsModel | undefined;
  isOwner: boolean;
  quality: QualityState;
  onRetryQuality: () => void;
  retryingQuality: boolean;
  loading?: boolean;
  refreshing?: boolean;
  page: string | null;
}) {
  const location = useLocation();
  const [sort, setSort] = useJournalSort();
  const [all, setAll] = useState(false);
  const rows = sorted(model?.journal ?? [], sort);
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  const columns = columnsOf(quality, model?.norms ?? { replyMedianSeconds: null, unansweredAtEnd: null, aiShare: null });
  const total = model?.journal.length ?? 0;
  const minutes = model?.journal.reduce((sum, shift) => sum + shift.workedMinutes, 0) ?? 0;

  const description = model
    ? [
      total === 0 ? null : `${formatCount(total)} ${ruPlural(total, "смена", "смены", "смен")}, ${formatDuration(minutes)} работы.`,
      isOwner ? "Строка открывает разбор смены." : "Строка открывает смены чаттера.",
      page ? "Ответ, без ответа и ИИ — по всей смене, на всех её страницах." : null,
    ].filter(Boolean).join(" ")
    : undefined;

  const status = quality === "loading" && model && total > 0 ? (
    <span className="shifts-card-note"><Spinner /> Считаем ответ, без ответа и долю ИИ…</span>
  ) : quality === "failed" ? (
    <span className="shifts-card-note">
      Ответ, без ответа и ИИ: Hub не ответил
      <Button size="sm" variant="ghost" loading={retryingQuality} onClick={onRetryQuality}>{retryingQuality ? "Повторяем…" : "Повторить"}</Button>
    </span>
  ) : undefined;

  return (
    <Section title="Журнал смен" description={description} actions={status}>
      <Table
        label="Журнал смен"
        className="shifts-journal"
        columns={columns}
        rows={shown}
        rowKey={(shift) => shift.key}
        rowHref={(shift) => (isOwner ? shiftPath(shift.userId, shift.startedAt, location.search) : personPath(shift.userId, location.search, "shifts"))}
        sort={sort}
        onSortChange={setSort}
        loading={loading}
        refreshing={refreshing}
        skeletonRows={8}
      />
      {rows.length > FIRST_ROWS && (
        <div className="shifts-more">
          <Button variant="ghost" onClick={() => setAll((was) => !was)}>
            {all ? "Свернуть" : `Показать все ${formatCount(rows.length)}`}
          </Button>
        </div>
      )}
    </Section>
  );
}
