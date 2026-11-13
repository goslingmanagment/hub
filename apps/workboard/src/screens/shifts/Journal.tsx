import type { ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { Button, Count, Duration, Mark, Money, Person, Section, Skeleton, Spinner, Table, Tooltip, type Column, type SortState } from "@agency_hub_core/ui";
import { formatCount, formatMills } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { shiftDurationHint } from "@agency_hub_core/ui/shiftWhen";
import { CHATTER_SHIFT_PAGE_MIN_MESSAGES } from "@agency_hub_core/contracts";
import { personPath, shiftPath, useRowBackState } from "@/shared/links";
import { METRICS, formatAiUnedited, formatReplyMedian, formatUnanswered } from "@/shared/metrics";
import { ReportNoteLine } from "@/shared/ReportNote";
import type { PlacedNote } from "@/shared/reportNotes";
import { NO_NORMS, manyUnanswered, muchAi, slowReply, type JournalShift, type ShiftsModel, type TeamNorms } from "./data.js";

/** Rows shown before «Показать все»: a week of a whole team fits. */
const FIRST_ROWS = 50;

const NO_NOTES: ReadonlyMap<string, PlacedNote> = new Map();

/** A line of a header never ends on these: «ИИ / без правки», not «ИИ без / правки». */
const PREPOSITION = /^(без|к|с|в|на|по|до|от|и)$/i;

/**
 * A long label in two lines, always the same two (M5): «Ответ, / медиана»,
 * «Без ответа / к концу», «ИИ / без правки». One-line headers over short numbers
 * would leave 200+ px holes on 1920; the three quality columns read alike at any width.
 */
function twoLines(label: string): ReactNode {
  const words = label.split(" ");
  if (words.length < 2) return label;
  let best = 1;
  let bestScore = Infinity;
  for (let index = 1; index < words.length; index += 1) {
    const left = words.slice(0, index).join(" ");
    const right = words.slice(index).join(" ");
    const score = Math.max(left.length, right.length) + (PREPOSITION.test(words[index - 1]!) ? 100 : 0);
    if (score < bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return <>{words.slice(0, best).join(" ")}<br />{words.slice(best).join(" ")}</>;
}

type QualityState = "loading" | "failed" | "ready";

const SORT_KEYS = new Set(["who", "when", "worked", "sales", "perHour", "reply", "unanswered", "ai"]);

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
      return shift.quality?.aiUneditedShare ?? null;
    default:
      return null;
  }
}

/**
 * The journal's order and length in the address (`?sort=sales&dir=desc&all=1`):
 * «←» from a review, and the browser's «Назад», come back to the same rows.
 */
function useJournalAddress(): { sort: SortState | null; setSort: (next: SortState) => void; all: boolean; setAll: (all: boolean) => void } {
  const [search, setSearch] = useSearchParams();
  const key = search.get("sort");
  const sort: SortState | null = key && SORT_KEYS.has(key) ? { key, direction: search.get("dir") === "asc" ? "asc" : "desc" } : null;
  const setSort = (next: SortState) => setSearch((current) => {
    const updated = new URLSearchParams(current);
    updated.set("sort", next.key);
    updated.set("dir", next.direction);
    return updated;
  }, { replace: true });
  const all = search.get("all") === "1";
  const setAll = (next: boolean) => setSearch((current) => {
    const updated = new URLSearchParams(current);
    if (next) updated.set("all", "1");
    else updated.delete("all");
    return updated;
  }, { replace: true, preventScrollReset: true });
  return { sort, setSort, all, setAll };
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
  return (
    <Tooltip content={state === "failed" ? "Hub не ответил" : "Для этой смены чисел нет"}>
      <span className="ui-muted">—</span>
    </Tooltip>
  );
}

/** The shift's pages under the name: a page with too few messages to count is greyed. */
function PagesHint({ shift }: { shift: JournalShift }) {
  if (shift.pages.length === 0) return <>—</>;
  return (
    <span className="shifts-journal__pages">
      {shift.pages.map((page, index) => (
        <span key={page.pageLabel}>
          {index > 0 && ", "}
          <Tooltip
            content={page.counts
              ? `${page.pageLabel}: ${formatCount(page.messages)} ${ruPlural(page.messages, "сообщение", "сообщения", "сообщений")}`
              : `${page.pageLabel}: меньше ${CHATTER_SHIFT_PAGE_MIN_MESSAGES} сообщений, продажи этой страницы в смену не идут`}
          >
            <span className={page.counts ? undefined : "shifts-journal__page--quiet"}>{page.pageLabel}</span>
          </Tooltip>
        </span>
      ))}
    </span>
  );
}

/** On the shift's label: where a night counts (D12) and how much it wrote. */
function WhenHint({ shift }: { shift: JournalShift }) {
  const messages = `${formatCount(shift.messages)} ${ruPlural(shift.messages, "личное сообщение", "личных сообщения", "личных сообщений")} за смену`;
  return shift.when.payDayNote ? <>{shift.when.payDayNote}<br />{messages}</> : <>{messages}</>;
}

/** A shift's sales by the rule; under the day's last shift, what stands between the day and its report (shared/reportNotes.ts). */
function SalesCell({ shift, note, own }: { shift: JournalShift; note: PlacedNote | undefined; own: boolean }) {
  const money = shift.overlapNetMills > 0 ? (
    <Tooltip content={`Из них ${formatMills(shift.overlapNetMills)} на двоих: эти продажи видны и у другого чаттера, никто из двоих не писал этому фану`} align="end">
      <span className="shifts-journal__shared"><Money mills={shift.salesNetMills} strong /></span>
    </Tooltip>
  ) : <Money mills={shift.salesNetMills} strong />;
  if (note === undefined) return money;
  return (
    <span className="shifts-journal__money">
      {money}
      <ReportNoteLine placed={note} own={own} />
    </span>
  );
}

/** «Обычно у команды — 3 мин 49 с»: why a number is marked. */
function usual(text: string): string {
  return `Заметно хуже обычной смены команды за этот период. Обычно — ${text}`;
}

function columnsOf(state: QualityState, norms: TeamNorms, page: string | null, notes: ReadonlyMap<string, PlacedNote>, ruled: boolean, mine: boolean, isOwner: boolean): Column<JournalShift>[] {
  // E1: with a page picked, the quality columns still count the whole shift — said at the columns themselves.
  const scope = (hint: string) => (page ? `${hint} По всей смене, не только ${page}.` : hint);
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
      // D12: the one label of a shift — the start's weekday and the dates it touched, the clock under it.
      cell: (shift) => (
        <Tooltip content={<WhenHint shift={shift} />} align="start">
          <span className="shifts-journal__when">
            <span className="shifts-journal__day">{shift.when.days}</span>
            <span className={shift.ongoing ? "shifts-journal__span shifts-journal__span--now" : "shifts-journal__span"}>{shift.when.time}</span>
          </span>
        </Tooltip>
      ),
    },
    {
      // The time worked, pauses left out (D12): with them only on hover. No dotted header: the hint is the value's.
      key: "worked",
      header: "Отработал",
      numeric: true,
      sortValue: (shift) => shift.workedMinutes,
      cell: (shift) => {
        const words = shiftDurationHint(shift.when);
        return words ? <Tooltip content={words} align="end"><Duration minutes={shift.workedMinutes} /></Tooltip> : <Duration minutes={shift.workedMinutes} />;
      },
    },
    {
      key: "sales",
      header: "Продажи",
      // The rule's sum, not the pay's: people are paid by the day's report, and the day's last shift says what stands
      // between — to the owner of everyone's days (people's reports are the owner's), to anyone else of their own.
      ...(ruled ? { hint: isOwner
        ? "По правилу «чья продажа». Начисляют по отчёту дня: под числом — продажи, которых нет в отчётах, суммы по словам и правки поста."
        : "По правилу «чья продажа». Начисляют по отчёту дня, его сумма может отличаться." } : {}),
      numeric: true,
      sortValue: (shift) => shift.salesNetMills,
      cell: (shift) => <SalesCell shift={shift} note={notes.get(shift.key)} own={mine} />,
    },
    {
      // «Продажи» over «Отработал», the two columns to its left: said on the value, not as a dotted term.
      key: "perHour",
      header: "В час",
      numeric: true,
      sortValue: (shift) => shift.perHourMills,
      cell: (shift) => <Money mills={shift.perHourMills} hint={shift.perHourMills === null ? undefined : `${formatMills(shift.salesNetMills)} за ${shift.when.worked} работы`} />,
    },
    {
      key: "reply",
      header: twoLines(METRICS.reply.label),
      hint: scope(METRICS.reply.hint),
      headerWrap: true,
      numeric: true,
      sortValue: (shift) => shift.quality?.replyMedianSeconds ?? null,
      sortFirst: "desc",
      cell: (shift) => (
        <QualityCell
          state={state}
          shift={shift}
          render={(quality) => {
            if (quality.replyMedianSeconds === null) return <span className="ui-muted">—</span>;
            const text = formatReplyMedian(quality.replyMedianSeconds);
            return slowReply(quality, norms) ? <Mark hint={usual(formatReplyMedian(norms.replyMedianSeconds))}>{text}</Mark> : text;
          }}
        />
      ),
    },
    {
      key: "unanswered",
      header: twoLines(METRICS.unanswered.label),
      hint: scope(METRICS.unanswered.hint),
      headerWrap: true,
      numeric: true,
      sortValue: (shift) => shift.quality?.unansweredAtEnd ?? null,
      sortFirst: "desc",
      cell: (shift) => (
        <QualityCell
          state={state}
          shift={shift}
          render={(quality) => (manyUnanswered(quality, norms)
            ? <Mark hint={usual(formatUnanswered(norms.unansweredAtEnd))}>{formatUnanswered(quality.unansweredAtEnd)}</Mark>
            : <Count value={quality.unansweredAtEnd} />)}
        />
      ),
    },
    {
      key: "ai",
      header: twoLines(METRICS.aiUnedited.label),
      hint: scope(METRICS.aiUnedited.hint),
      headerWrap: true,
      numeric: true,
      sortValue: (shift) => shift.quality?.aiUneditedShare ?? null,
      sortFirst: "desc",
      cell: (shift) => (
        <QualityCell
          state={state}
          shift={shift}
          render={(quality) => {
            if (quality.aiUneditedShare === null) return <span className="ui-muted">—</span>;
            const text = formatAiUnedited(quality.aiUneditedShare);
            return muchAi(quality, norms) ? <Mark hint={usual(formatAiUnedited(norms.aiUneditedShare))}>{text}</Mark> : text;
          }}
        />
      ),
    },
  ];
}

/**
 * Журнал смен (spec §4.1.4): one table of every shift of the period, newest
 * first, a shift going on first; the whole row opens its review, and the
 * review's «←» comes back to this very period, page and order. The three
 * quality numbers are the review's own (D1: same rules, same words). Sort by
 * any column; an outlier against the team's usual shift gets one calm mark.
 */
export function Journal({ model, isOwner, quality, onRetryQuality, retryingQuality, loading = false, refreshing = false, page, reportNotes = NO_NOTES, ruled = false, mine = false }: {
  model: ShiftsModel | undefined;
  isOwner: boolean;
  quality: QualityState;
  onRetryQuality: () => void;
  retryingQuality: boolean;
  loading?: boolean;
  refreshing?: boolean;
  page: string | null;
  /** A day's note by the key of the row it stands under, the day's last shift (shared/reportNotes.ts). */
  reportNotes?: ReadonlyMap<string, PlacedNote>;
  /** The sales are counted by the rule «чья продажа» (`ruleFrom`): the column says so. */
  ruled?: boolean;
  /** Only the viewer's own shifts are shown (`?mine=1`): a note speaks of «ваши» sales. */
  mine?: boolean;
}) {
  const location = useLocation();
  const { sort, setSort, all, setAll } = useJournalAddress();
  const rowState = useRowBackState("Смены");
  const rows = sorted(model?.journal ?? [], sort);
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  const columns = columnsOf(quality, model?.norms ?? NO_NORMS, page, reportNotes, ruled, mine, isOwner);

  const description = [
    isOwner ? "Строка открывает разбор смены." : "Строка открывает карточку чаттера.",
    page ? `Ответ, без ответа и ИИ — по всей смене, не только ${page}.` : null,
  ].filter(Boolean).join(" ");

  const status = quality === "loading" && model && model.journal.length > 0 ? (
    <span className="shifts-card-note"><Spinner /> Считаем ответ, без ответа и ИИ без правки…</span>
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
        rowHref={(shift) => (isOwner ? shiftPath(shift.userId, shift.startedAt, location.search) : personPath(shift.userId, location.search))}
        rowState={rowState}
        sort={sort}
        onSortChange={setSort}
        loading={loading}
        refreshing={refreshing}
        align="first-line"
        skeletonRows={8}
        skeletonLines={2}
      />
      {rows.length > FIRST_ROWS && (
        <div className="shifts-more">
          <Button variant="ghost" onClick={() => setAll(!all)}>
            {all ? "Свернуть" : `Показать все ${formatCount(rows.length)}`}
          </Button>
        </div>
      )}
    </Section>
  );
}
