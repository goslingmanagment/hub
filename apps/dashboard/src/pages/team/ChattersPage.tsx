import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES, type KernelOperationResponse } from "@agency_hub_core/contracts";
import { teamChatterStatsQueryOptions, useTeamChatterPeople } from "@/api/team";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatCount, formatDayRange, formatDuration, formatMills, formatPercent } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { isPlainRowClick } from "@/lib/rowClick";
import { moscowOf, quickReplyShare, type Stats } from "@/pages/account/stats/statsView";
import { ChatterLink } from "./teamLinks.js";

/**
 * Команда → Чаттеры: the chatters side by side for the period, one row each.
 * Every row is its own `teamChatterStats` read (the key of the chatter's own
 * screen), three at a time; a row stands with its name at once and fills in.
 * No total row: a sale can count for two, a sum would be more than the truth.
 */

const AT_ONCE = 3;

type SortKey = "hours" | "sales" | "confirmed" | "paid" | "quick" | "fans";

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; value: (stats: Stats) => number }> = [
  { key: "hours", label: "Часы", value: (stats) => stats.totals.workedMinutes },
  { key: "sales", label: "Продажи", value: (stats) => stats.totals.salesNetMills },
  { key: "confirmed", label: "Подтверждено к выплате", value: (stats) => stats.totals.confirmedNetMills },
  { key: "paid", label: "Платные", value: (stats) => (stats.ppv.sent > 0 ? stats.ppv.bought / stats.ppv.sent : -1) },
  { key: "quick", label: "Ответ за 15 минут", value: (stats) => quickReplyShare(stats.replies.byDelay) ?? -1 },
  { key: "fans", label: "Фаны заплатили", value: (stats) => (stats.totals.fansWritten > 0 ? stats.totals.fansPaid / stats.totals.fansWritten : -1) },
];

function share(part: number, whole: number): string {
  return whole === 0 ? "—" : formatPercent((100 * part) / whole);
}

function Cells({ stats }: { stats: Stats }) {
  const { totals, ppv, replies } = stats;
  const quick = quickReplyShare(replies.byDelay);
  return (
    <>
      <td className="num">{formatDuration(totals.workedMinutes)}</td>
      <td className="num">
        <span className="font-medium">{formatMills(totals.salesNetMills)}</span>
        {totals.perHourMills !== null && <span className="team-sub">{formatMills(totals.perHourMills)} в час</span>}
      </td>
      <td className="num">{formatMills(totals.confirmedNetMills)}</td>
      <td className="num">
        {ppv.sent === 0 ? "—" : <>{formatCount(ppv.bought)} из {formatCount(ppv.sent)}</>}
        {ppv.sent > 0 && <span className="team-sub">{share(ppv.bought, ppv.sent)}</span>}
      </td>
      <td className="num">
        {quick === null ? "—" : formatPercent(quick * 100)}
        {replies.replies > 0 && <span className="team-sub">из {formatCount(replies.replies)} {ruPlural(replies.replies, "ответа", "ответов", "ответов")}</span>}
      </td>
      <td className="num">{totals.fansWritten === 0 ? "—" : <>{formatCount(totals.fansPaid)} из {formatCount(totals.fansWritten)}</>}</td>
    </>
  );
}

function SkeletonCells() {
  return (
    <>
      {COLUMNS.map((column) => <td key={column.key} className="num"><Skeleton width={72} className="ml-auto" /></td>)}
    </>
  );
}

function DashCells({ title }: { title: string }) {
  return <>{COLUMNS.map((column) => <td key={column.key} className="num team-muted" title={title}>—</td>)}</>;
}

export function ChattersPage() {
  const { key: period, days } = useScreenPeriod();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const people = useTeamChatterPeople();
  const list = people.data?.people ?? [];
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "sales", descending: true });

  const results = useQueries({ queries: list.map((person) => ({ ...teamChatterStatsQueryOptions({ userId: person.userId, days }), enabled: false })) });
  // Three at a time: the next one starts when an earlier one has answered.
  const settled = results.filter((result) => result.data !== undefined || result.isError).length;
  const live = useQueries({
    queries: list.map((person, index) => ({
      ...teamChatterStatsQueryOptions({ userId: person.userId, days }),
      enabled: index < settled + AT_ONCE,
      // A new period keeps the same person's numbers, dimmed, until theirs come; never a neighbour's.
      placeholderData: (previous: KernelOperationResponse<"teamChatterStats"> | undefined, previousQuery?: { queryKey: readonly unknown[] }) =>
        (previousQuery?.queryKey[1] as { userId?: number } | undefined)?.userId === person.userId ? previous : undefined,
    })),
  });

  const rows = list.map((person, index) => {
    const query = live[index]!;
    const answer = query.data?.stats ?? null;
    // The hub answers a stranger with the first person it knows: only the asked one's numbers count.
    const stats = answer && answer.user.userId === person.userId ? answer : null;
    return { person, query, stats, wrong: answer !== null && stats === null };
  });
  const failed = rows.filter((row) => row.query.isError);
  const allIn = rows.every((row) => row.query.data !== undefined || row.query.isError);
  const working = rows.filter((row) => !(row.stats && row.stats.totals.shifts === 0) && !row.wrong);
  const idle = rows.filter((row) => row.stats && row.stats.totals.shifts === 0);
  const column = COLUMNS.find((item) => item.key === sort.key)!;
  const ordered = allIn
    ? [...working].sort((a, b) => {
      if (!a.stats || !b.stats) return a.stats ? -1 : b.stats ? 1 : a.person.username.localeCompare(b.person.username);
      const diff = column.value(a.stats) - column.value(b.stats);
      return (sort.descending ? -diff : diff) || a.person.username.localeCompare(b.person.username);
    })
    : [...working].sort((a, b) => a.person.username.localeCompare(b.person.username));

  const firstStats = rows.find((row) => row.stats)?.stats;
  const today = firstStats ? moscowOf(Date.parse(firstStats.serverNow)).day : null;
  const updatedAt = Math.max(0, ...live.map((query) => query.dataUpdatedAt));
  const refreshAll = () => {
    void people.refetch();
    for (const query of live) void query.refetch();
  };
  const showMonth = () => {
    const next = new URLSearchParams(search);
    next.set("period", "30d");
    setSearch(next);
  };

  const header = (
    <PageHeader
      window={firstStats && today ? formatDayRange(firstStats.from, today) : undefined}
      fresh={updatedAt > 0 ? { at: updatedAt, onRefresh: refreshAll, refreshing: live.some((query) => query.isFetching) } : undefined}
    />
  );

  if (!people.data) {
    return (
      <div className="team-screen">
        {header}
        {people.isLoading ? <TableSkeleton rows={6} columns={7} /> : <NoAnswerPanel retry={people.refetch} />}
      </div>
    );
  }
  if (!people.data.anyone || list.length === 0) {
    return (
      <div className="team-screen">
        {header}
        <StatusPanel title="Никто не работал" description="За последний месяц в расширении никто не работал на ваших страницах." />
      </div>
    );
  }

  const nobody = allIn && failed.length === 0 && working.length === 0;
  return (
    <div className="team-screen">
      {header}
      {failed.length > 0 && (
        <Notice
          tone="warning"
          role="alert"
          action={<button type="button" className="btn btn-sm" onClick={() => { for (const row of failed) void row.query.refetch(); }}>Повторить</button>}
        >
          Не пришли числа у {failed.length} {ruPlural(failed.length, "чаттера", "чаттеров", "чаттеров")}. Это не ноль.
        </Notice>
      )}
      {nobody ? (
        <StatusPanel
          title={`За ${days} ${ruPlural(days, "день", "дня", "дней")} смен нет`}
          description="Никто не работал в расширении под своим входом."
          action={days < 30 ? <button type="button" className="btn btn-sm" onClick={showMonth}>Показать 30 дней</button> : undefined}
        />
      ) : (
        <section className="card" aria-label="Чаттеры">
          <div className="table-wrap">
            <table className="data-table team-sticky-first team-wrap-head">
              <thead>
                <tr>
                  <th scope="col">Чаттер</th>
                  {COLUMNS.map((item) => {
                    const current = sort.key === item.key;
                    return (
                      <th
                        key={item.key}
                        scope="col"
                        className={`num ${current ? "is-sorted" : ""}`}
                        aria-sort={current ? (sort.descending ? "descending" : "ascending") : "none"}
                      >
                        <button
                          type="button"
                          className="sort team-sort"
                          onClick={() => setSort((was) => ({ key: item.key, descending: was.key === item.key ? !was.descending : true }))}
                        >
                          {current ? (sort.descending ? <ArrowDown size={16} aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />) : <span className="team-sort-space" />}
                          {item.label}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {ordered.map(({ person, query, stats }) => (
                  <tr
                    key={person.userId}
                    className={`team-row-link align-top ${query.isPlaceholderData ? "is-refreshing" : ""}`}
                    onClick={(event) => { if (isPlainRowClick(event)) navigate(`/team/chatters/${person.userId}?period=${period}`); }}
                  >
                    <td>
                      <ChatterLink userId={person.userId} username={person.username} period={period} />
                      {stats && (
                        <span className="team-sub whitespace-nowrap">
                          {formatCount(stats.totals.shifts)} {ruPlural(stats.totals.shifts, "смена", "смены", "смен")}
                          {stats.totals.unconfirmedShifts > 0 && ` · ${stats.totals.unconfirmedShifts} не ${ruPlural(stats.totals.unconfirmedShifts, "подтверждена", "подтверждены", "подтверждены")}`}
                        </span>
                      )}
                    </td>
                    {stats ? <Cells stats={stats} /> : query.isError ? <DashCells title="Hub не ответил" /> : <SkeletonCells />}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {idle.length > 0 && (
        <p className="team-note">
          Без смен за период:{" "}
          {idle.map((row, index) => (
            <span key={row.person.userId}>{index > 0 && ", "}<ChatterLink userId={row.person.userId} username={row.person.username} period={period} /></span>
          ))}
        </p>
      )}
      <Disclosure>
        <p>
          Смена — работа в расширении ChatGoose под своим входом: от {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и
          {" "}{CHATTER_SHIFT_MIN_MESSAGES} сообщений; конец — час без действий.
        </p>
        <p>
          Продажи — деньги после комиссии за смены, на страницах, где чаттер писал, с его первого действия на странице. Если
          страницу вели двое, продажа у того, кто последним писал этому фану; если никто из них не писал, она видна у обоих.
          Поэтому строки «Итого» нет: сумма была бы больше настоящей.
        </p>
        <p>Подтверждено к выплате — суммы из подтверждённых отчётов смен.</p>
        <p>Платные — сколько платных сообщений купили из отправленных. Ответ за 15 минут — доля ответов ждущим фанам. Ответы последних суток ещё не считаются.</p>
        <p>Это ориентир, а не основание для оплаты: к выплате идут подтверждённые отчёты смен и таблица.</p>
        <p>Средняя цена платных сообщений, их доля, медиана ответа и кто ждал в конце смены — на странице чаттера, они считаются дольше.</p>
      </Disclosure>
    </div>
  );
}
