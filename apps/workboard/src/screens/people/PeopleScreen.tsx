import { useMemo, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES } from "@agency_hub_core/contracts";
import { Button, Card, Delta, Disclosure, Duration, EmptyState, ErrorState, Mark, Money, PageLabels, Person, Skeleton, Table, Tooltip, readDelta, type Column, type SortState } from "@agency_hub_core/ui";
import { formatDay, formatDuration } from "@agency_hub_core/ui/format";
import { PersonLink, personPath, useRowBackState } from "@/shared/links";
import { formatAiUnedited, formatReplyMedian, formatUnanswered, METRICS, PER_SHIFT_HINT } from "@/shared/metrics";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { useMe } from "@/shared/useMe";
import { Head } from "./Head.js";
import { pagesInOrder } from "./ShiftTable.js";
import { SlowFailed } from "./SlowFailed.js";
import { usePeopleList, type PeopleList, type PersonRef, type PersonSummary } from "./data.js";
import { capitalized, periodWords, ROLE_WORD, statusOf, versusTitle } from "./words.js";
import "./people.css";

/**
 * Люди (spec §4.3): everyone side by side for the period in one table — now,
 * money and its change, money per hour, how fast they answer, who was left
 * waiting at the end of a shift, how much the AI wrote unedited (each the
 * average per shift, by the review's rules) and what the AI cost. A row opens
 * the person. People without a shift stand under the table; the switched-off
 * are folded, or — with shifts in the period — always the last rows.
 */
export function PeopleScreen() {
  const { period, setPeriod } = usePeriod();
  const { page } = usePageFilter();
  const { isOwner } = useMe();
  const list = usePeopleList(period, page);
  const location = useLocation();
  const [sort, setSort] = useListSort();
  const columns = useColumns(list, isOwner, page);
  const rows = useMemo(() => sortedRows(list.rows, columns, sort), [list.rows, columns, sort]);
  const firstOff = rows.find(isQuiet);
  const rowState = useRowBackState("Люди");
  const noShifts = list.main === "ready" && list.rows.every((row) => !row.work || row.work.shifts === 0);

  return (
    <>
      <ScreenHeader
        title="Люди"
        period
        pageFilter
        meta={list.comparable ? undefined : <NothingToCompare knownSince={list.knownSince} />}
        updatedAt={list.updatedAt}
        stale={list.stale}
        onRefresh={list.refresh}
        refreshing={list.refreshing}
      />
      <div className="wb-content">
        {list.tooLong ? (
          <Card>
            <EmptyState
              title="Период длиннее 31 дня"
              action={<Button onClick={() => setPeriod({ kind: "days", days: 30 })}>Показать 30 дней</Button>}
            >
              Hub считает смены не больше чем за 31 день. Выберите период короче.
            </EmptyState>
          </Card>
        ) : list.main === "failed" ? (
          <Card><ErrorState onRetry={list.refresh} /></Card>
        ) : (
          <>
            {list.quality === "failed" && <SlowFailed onRetry={list.retryQuality} />}
            <Table
              label="Люди за период"
              className="people-table"
              columns={columns}
              rows={rows}
              rowKey={(row) => String(row.userId)}
              rowHref={(row) => personPath(row.userId, location.search)}
              rowState={rowState}
              rowQuiet={isQuiet}
              rowClassName={(row) => (row === firstOff && row !== rows[0] ? "people-row--off" : undefined)}
              sort={sort}
              onSortChange={setSort}
              align="first-line"
              loading={list.main === "loading"}
              refreshing={list.refreshing}
              skeletonRows={6}
              skeletonLines={2}
              empty={(
                <EmptyState
                  title={`${capitalized(periodWords(period))} смен не было`}
                  action={period.days < 30 ? <Button onClick={() => setPeriod({ kind: "days", days: 30 })}>Показать 30 дней</Button> : undefined}
                >
                  Никто не работал в расширении под своим входом{page ? ` на странице ${page}` : ""}.
                </EmptyState>
              )}
            />
            {noShifts && list.rows.length > 0 && (
              <p className="people-note">{capitalized(periodWords(period))} смен не было: в таблице те, у кого были смены в прошлый период.</p>
            )}
            <Aside list={list} page={page} />
          </>
        )}
        <HowItCounts versus={versusTitle(period)} />
      </div>
    </>
  );
}

/** «Сравнить не с чем: Hub пишет смены с 24 окт.» instead of the dates compared with, when nobody has a window before. */
function NothingToCompare({ knownSince }: { knownSince: string | null }) {
  return <span>Сравнить не с чем{knownSince ? `: Hub записывает смены с ${formatDay(knownSince)}` : ": у Hub нет прошлого периода"}</span>;
}

const SORT_KEYS = new Set(["who", "shifts", "sales", "hour", "reply", "unanswered", "ai", "spend"]);
const DEFAULT_SORT: SortState = { key: "sales", direction: "desc" };

/** The order in the address (`?sort=reply&dir=desc`): «←» from a person comes back to the same order. */
function useListSort(): [SortState, (next: SortState) => void] {
  const [search, setSearch] = useSearchParams();
  const key = search.get("sort");
  const sort: SortState = key && SORT_KEYS.has(key) ? { key, direction: search.get("dir") === "asc" ? "asc" : "desc" } : DEFAULT_SORT;
  const setSort = (next: SortState) => setSearch((current) => {
    const updated = new URLSearchParams(current);
    if (next.key === DEFAULT_SORT.key && next.direction === DEFAULT_SORT.direction) {
      updated.delete("sort");
      updated.delete("dir");
    } else {
      updated.set("sort", next.key);
      updated.set("dir", next.direction);
    }
    return updated;
  }, { replace: true });
  return [sort, setSort];
}

/** A row that is not one of the working people of the period: switched off, or no shift in it (only in the window before). */
function isQuiet(row: PersonSummary): boolean {
  return row.state === "disabled" || !row.work || row.work.shifts === 0;
}

/** The rows in the chosen order; the quiet ones always last, under a line (spec §4.3): they are not compared with the working ones. */
function sortedRows(rows: readonly PersonSummary[], columns: readonly Column<PersonSummary>[], sort: SortState): PersonSummary[] {
  const value = columns.find((column) => column.key === sort.key)?.sortValue;
  const factor = sort.direction === "asc" ? 1 : -1;
  const byValue = (left: PersonSummary, right: PersonSummary) => {
    if (!value) return 0;
    const a = value(left);
    const b = value(right);
    const aMissing = a === null || a === undefined;
    const bMissing = b === null || b === undefined;
    // Missing values stay last in both directions.
    if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
    if (typeof a === "string" && typeof b === "string") return a.localeCompare(b, "ru") * factor;
    return (Number(a) - Number(b)) * factor;
  };
  const off = (row: PersonSummary) => (isQuiet(row) ? 1 : 0);
  return [...rows].sort((left, right) => off(left) - off(right) || byValue(left, right) || left.username.localeCompare(right.username, "ru"));
}

/** A number with its change under it; nothing under it when there is nothing to compare with. */
function WithDelta({ children, change }: { children: ReactNode; change: ReactNode }) {
  return (
    <span className="people-num">
      <span>{children}</span>
      {change}
    </span>
  );
}

function Pending() {
  return <span className="people-pending"><Skeleton width={56} /></span>;
}

function Dash({ hint }: { hint: string }) {
  return <Tooltip content={hint} align="end"><span className="people-dash">—</span></Tooltip>;
}

/** A column of a quality number: its label says «в среднем за смену»; its hint, what it counts. */
function qualityHint(key: keyof typeof METRICS): ReactNode {
  return <>{METRICS[key].hint} {PER_SHIFT_HINT}</>;
}

function useColumns(list: PeopleList, isOwner: boolean, page: string | null): Column<PersonSummary>[] {
  const { period } = usePeriod();
  const versus = versusTitle(period);
  const { team, comparable } = list;
  const crowd = list.rows.filter((row) => row.quality).length >= 3;
  return useMemo(() => {
    /**
     * The change against the window before, by the one rule of Delta (D13): calm better / worse colours as on «Смены»,
     * «было $X» / «впервые» at a small base; nothing when there is nothing to compare with. `base`: the money behind a rate.
     */
    const change = (current: number | null, previous: number | null | undefined, base?: number | null) => {
      if (!comparable || previous === null || previous === undefined) return null;
      if (readDelta(current ?? 0, previous, { base }).kind === "none") return null;
      return <Delta current={current ?? 0} previous={previous} base={base} title={versus} />;
    };
    const quality = (row: PersonSummary, show: (value: NonNullable<PersonSummary["quality"]>) => ReactNode) => {
      if (!row.work || row.work.shifts === 0) return <Dash hint="Смен не было" />;
      if (row.quality === undefined) return list.quality === "failed" ? <Dash hint="Hub не ответил" /> : <Pending />;
      if (row.quality === null) return <Dash hint="Смена ещё идёт: числа будут после её конца" />;
      return show(row.quality);
    };
    // E1: under a page filter each column says whether it is that page's or every page's.
    const perShift = page ? ["в среднем за смену", "все страницы"] : "в среднем за смену";
    const onPage = page ? { sub: page } : {};
    const columns: Column<PersonSummary>[] = [
      {
        key: "who",
        header: "Человек",
        grow: true,
        sortValue: (row) => row.username,
        cell: (row) => {
          const { status, words } = statusOf(row);
          const hint = [row.role && row.role !== "chatter" ? ROLE_WORD[row.role].toLowerCase() : "", words].filter(Boolean).join(" · ");
          return (
            <span className="people-who">
              <Person name={row.username} status={status} hint={hint} />
              {row.pages.length > 0 && <PageLabels labels={pagesInOrder(row.pages)} max={4} className="people-who__pages" />}
            </span>
          );
        },
      },
      {
        key: "shifts",
        header: "Смены",
        numeric: true,
        sortValue: (row) => row.work?.shifts ?? 0,
        cell: (row) => !row.work || row.work.shifts === 0
          ? <span className="people-dash">0</span>
          : (
            <span className="people-num">
              <span>{row.work.shifts}</span>
              <span className="people-num__sub"><Duration minutes={row.work.workedMinutes} /></span>
            </span>
          ),
      },
      {
        key: "sales",
        header: <Head lines={["Продажи"]} {...onPage} />,
        headerWrap: false,
        numeric: true,
        sortValue: (row) => row.work?.salesNetMills ?? 0,
        cell: (row) => {
          const work = row.work;
          if (!work) return <Dash hint="Смен не было" />;
          return (
            <WithDelta change={change(work.salesNetMills, work.previous?.salesNetMills)}>
              <Money mills={work.salesNetMills} strong />
            </WithDelta>
          );
        },
      },
      {
        key: "hour",
        header: <Head lines={["В час"]} {...onPage} />,
        headerWrap: false,
        numeric: true,
        sortValue: (row) => row.work?.perHourMills ?? null,
        cell: (row) => {
          const work = row.work;
          if (!work || work.perHourMills === null) return <Dash hint="Смен не было" />;
          return (
            <WithDelta change={change(work.perHourMills, work.previous?.perHourMills, work.previous?.salesNetMills)}>
              <Money mills={work.perHourMills} />
            </WithDelta>
          );
        },
      },
      {
        key: "reply",
        header: <Head lines={[METRICS.reply.label]} sub={perShift} />,
        headerWrap: false,
        numeric: true,
        hint: qualityHint("reply"),
        sortValue: (row) => row.quality?.replyMedianSeconds ?? null,
        sortFirst: "desc",
        cell: (row) => quality(row, (value) => {
          const text = formatReplyMedian(value.replyMedianSeconds);
          const slow = crowd && value.replyMedianSeconds !== null && team.replyMedianSeconds !== null
            && value.replyMedianSeconds >= 2 * team.replyMedianSeconds && value.replyMedianSeconds >= 120;
          return slow ? <Mark hint={`Вдвое дольше середины команды (${formatReplyMedian(team.replyMedianSeconds)})`}>{text}</Mark> : text;
        }),
      },
      {
        key: "unanswered",
        header: <Head lines={[METRICS.unanswered.label]} sub={perShift} />,
        headerWrap: false,
        numeric: true,
        hint: qualityHint("unanswered"),
        sortValue: (row) => row.quality?.unansweredAtEnd ?? null,
        sortFirst: "desc",
        cell: (row) => quality(row, (value) => {
          const text = formatUnanswered(value.unansweredAtEnd, { average: true });
          const many = crowd && value.unansweredAtEnd !== null && team.unansweredAtEnd !== null
            && value.unansweredAtEnd >= 3 && value.unansweredAtEnd >= 2 * Math.max(team.unansweredAtEnd, 1);
          return many ? <Mark hint={`Вдвое больше середины команды (${formatUnanswered(team.unansweredAtEnd, { average: true })})`}>{text}</Mark> : text;
        }),
      },
      {
        key: "ai",
        header: <Head lines={[METRICS.aiUnedited.label]} sub={perShift} />,
        headerWrap: false,
        numeric: true,
        hint: qualityHint("aiUnedited"),
        sortValue: (row) => row.quality?.aiUneditedShare ?? null,
        sortFirst: "desc",
        cell: (row) => quality(row, (value) => formatAiUnedited(value.aiUneditedShare)),
      },
    ];
    if (isOwner) {
      columns.push({
        key: "spend",
        header: <Head lines={["Траты", "на ИИ"]} {...(page ? { sub: "все страницы" } : {})} />,
        headerWrap: false,
        numeric: true,
        hint: "Сколько стоили запросы человека к ИИ за дни периода, по всем страницам",
        sortValue: (row) => row.aiSpendMicroUsd ?? null,
        sortFirst: "desc",
        cell: (row) => {
          if (row.aiSpendMicroUsd === undefined) return list.spend === "failed" ? <Dash hint="Hub не ответил" /> : <Pending />;
          return row.aiSpendMicroUsd === null ? <Dash hint="Запросов к ИИ не было" /> : <Money microUsd={row.aiSpendMicroUsd} />;
        },
      });
    }
    return columns;
  }, [isOwner, list.quality, list.spend, crowd, comparable, team.replyMedianSeconds, team.unansweredAtEnd, versus, page]);
}

function Aside({ list, page }: { list: PeopleList; page: string | null }) {
  if (list.main !== "ready") return null;
  const { idle, disabled } = list;
  if (idle.length === 0 && disabled.length === 0 && !page) return null;
  return (
    <div className="people-aside">
      {idle.length > 0 && (
        <div className="people-idle">
          <span className="people-idle__label">{page ? `Без смен на ${page}:` : "Без смен за период:"}</span>
          {idle.map((person) => <IdlePerson key={person.userId} person={person} />)}
        </div>
      )}
      {disabled.length > 0 && (
        <Disclosure summary="Отключённые" hint={String(disabled.length)} size="md">
          <div className="people-folded">
            {disabled.map((person) => <IdlePerson key={person.userId} person={person} />)}
          </div>
        </Disclosure>
      )}
      {page && (
        <p className="people-note">
          Фильтр {page} сужает смены и продажи. Ответ, без ответа к концу, ИИ без правки и траты на ИИ — по всем страницам: Hub пока не
          делит их по страницам.
        </p>
      )}
    </div>
  );
}

function IdlePerson({ person }: { person: PersonRef }) {
  const { status, words } = statusOf({ state: person.state, disabledAt: person.disabledAt, now: { onShiftSince: null, lastShiftEnd: null, quietDays: 0 } });
  const role = ROLE_WORD[person.role].toLowerCase();
  const hint = person.state === "active" ? role : words;
  return <PersonLink userId={person.userId} name={person.username} status={status} hint={hint} backLabel="Люди" />;
}

function HowItCounts({ versus }: { versus: string }) {
  return (
    <Disclosure summary="Как это считается" className="people-help">
      <p>
        Смена — работа в расширении под своим входом: от {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений,
        конец — час без действий. Статус рядом с именем — тоже по сменам, не по открытому расширению.
      </p>
      <p>
        Продажи — деньги после комиссии площадки за смены, на страницах, где человек писал. Если страницу вели двое, продажа у того,
        кто последним писал фану; если не писал никто, она видна у обоих. Поэтому строки «Итого» нет: сумма была бы больше настоящей.
      </p>
      <p><b>{METRICS.reply.label}.</b> {METRICS.reply.hint}</p>
      <p><b>{METRICS.unanswered.label}.</b> {METRICS.unanswered.hint}</p>
      <p><b>{METRICS.aiUnedited.label}.</b> {METRICS.aiUnedited.hint}</p>
      <p>{PER_SHIFT_HINT} Изменение — {versus}; это ориентир, а не основание для оплаты.</p>
    </Disclosure>
  );
}
