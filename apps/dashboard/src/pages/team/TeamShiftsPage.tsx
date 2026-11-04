import { useQueries } from "@tanstack/react-query";
import { Link } from "react-router";
import { CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES, CHATTER_SHIFT_PAGE_MIN_MESSAGES, type TeamShift } from "@agency_hub_core/contracts";
import { teamChatterStatsQueryOptions, useTeamShifts } from "@/api/team";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatCount, formatDateTime, formatDay, formatDuration, formatMills, formatTimeOfDay } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { TEAM_STATUS } from "@/lib/statusWords";
import { AuthorlessCard } from "./AuthorlessCard.js";
import { ChatterLink, PageLink } from "./teamLinks.js";

/**
 * Команда → Смены → Кто работал: who is on a shift now and who worked how much
 * in the period, from the chat extension's activity (`teamShifts`). Read-only;
 * the owner and team leads. The page filter goes to the server: with a page,
 * a shift is made of the work on that page alone.
 */

type RangeKey = "24h" | "3d" | "7d";
const RANGE_DAYS: Readonly<Record<RangeKey, number>> = { "24h": 1, "3d": 3, "7d": 7 };
const RANGE_WORDS: Readonly<Record<RangeKey, string>> = { "24h": "за сутки", "3d": "за 3 дня", "7d": "за 7 дней" };

/** The window of a range, its end on the minute: one query key per minute, not per render. */
function windowOf(range: RangeKey, now = Date.now()): { from: string; to: string } {
  const to = Math.floor(now / 60_000) * 60_000;
  return { from: new Date(to - RANGE_DAYS[range] * 24 * 60 * 60_000).toISOString(), to: new Date(to).toISOString() };
}

function pauseMinutes(shift: TeamShift): number {
  return shift.pauses.reduce((sum, pause) => sum + Math.round((Date.parse(pause.to) - Date.parse(pause.from)) / 60_000), 0);
}

/** «3 нояб., 10:44 – 19:30»; over midnight «3 нояб., 20:40 – 4 нояб., 03:12»; going on «– сейчас». */
export function shiftSpan(shift: Pick<TeamShift, "startedAt" | "endedAt" | "ongoing">): string {
  if (shift.ongoing) return `${formatDateTime(shift.startedAt)} – сейчас`;
  const sameDay = formatDay(shift.startedAt) === formatDay(shift.endedAt);
  return `${formatDateTime(shift.startedAt)} – ${sameDay ? formatTimeOfDay(shift.endedAt) : formatDateTime(shift.endedAt)}`;
}

function workedPages(shift: TeamShift) {
  return shift.pages.filter((page) => page.messages > 0);
}

/** Б: who is on a shift now, and what their shift sold. */
function OnShiftNow({ shifts, filtered }: { shifts: readonly TeamShift[]; filtered: boolean }) {
  const ongoing = shifts.filter((shift) => shift.ongoing);
  const sales = useQueries({
    queries: ongoing.map((shift) => teamChatterStatsQueryOptions({ userId: shift.userId, days: 2 })),
  });
  if (ongoing.length === 0) return null;
  return (
    <section className="card" aria-labelledby="shifts-now">
      <header className="card-header"><h2 id="shifts-now" className="card-title">Сейчас на смене</h2></header>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Чаттер</th>
              <th scope="col">Страницы</th>
              <th scope="col">Идёт</th>
              <th scope="col" className="num">{filtered ? "Продажи за смену, все страницы" : "Продажи за смену"}</th>
            </tr>
          </thead>
          <tbody>
            {ongoing.map((shift, index) => {
              const query = sales[index];
              const stats = query?.data?.stats;
              const mine = stats && stats.user.userId === shift.userId ? stats : null;
              const live = mine?.shifts.find((one) => one.ongoing) ?? null;
              return (
                <tr key={shift.userId}>
                  <td><ChatterLink userId={shift.userId} username={shift.username} /></td>
                  <td>{workedPages(shift).map((page, at) => <span key={page.pageLabel}>{at > 0 && ", "}<PageLink label={page.pageLabel} /></span>)}</td>
                  <td>с {formatTimeOfDay(shift.startedAt)}, {formatDuration(shift.workedMinutes)}</td>
                  <td className="num">
                    {query?.isLoading
                      ? <span className="team-muted">…</span>
                      : live
                        ? <span className="font-medium">{formatMills(live.salesNetMills)}</span>
                        : query?.isError
                          ? <span className="team-muted" title="Hub не ответил">—</span>
                          : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** В: the period by chatter, only when someone had more than one shift. */
function ByChatter({ shifts }: { shifts: readonly TeamShift[] }) {
  const people = new Map<number, { userId: number; username: string; shifts: number; worked: number; paused: number; messages: number }>();
  for (const shift of shifts) {
    const row = people.get(shift.userId) ?? { userId: shift.userId, username: shift.username, shifts: 0, worked: 0, paused: 0, messages: 0 };
    row.shifts += 1;
    row.worked += shift.workedMinutes;
    row.paused += pauseMinutes(shift);
    row.messages += shift.authoredMessages;
    people.set(shift.userId, row);
  }
  if (shifts.length <= people.size) return null;
  const rows = [...people.values()].sort((a, b) => b.worked - a.worked);
  return (
    <section className="card" aria-labelledby="shifts-by-chatter">
      <header className="card-header"><h2 id="shifts-by-chatter" className="card-title">По чаттерам</h2></header>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Чаттер</th>
              <th scope="col" className="num">Смен</th>
              <th scope="col" className="num">Отработано</th>
              <th scope="col" className="num">Паузы</th>
              <th scope="col" className="num">Сообщений</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.userId}>
                <td><ChatterLink userId={row.userId} username={row.username} /></td>
                <td className="num">{row.shifts}</td>
                <td className="num">{formatDuration(row.worked)}</td>
                <td className="num muted">{row.paused > 0 ? formatDuration(row.paused) : "—"}</td>
                <td className="num">{formatCount(row.messages)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Г: every shift, the newest first, as the server orders them. */
function AllShifts({ shifts }: { shifts: readonly TeamShift[] }) {
  return (
    <section className="card" aria-labelledby="shifts-all">
      <header className="card-header"><h2 id="shifts-all" className="card-title">Все смены</h2></header>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Чаттер</th>
              <th scope="col">Смена</th>
              <th scope="col" className="num">Отработано</th>
              <th scope="col">Паузы</th>
              <th scope="col" className="num">Сообщения</th>
            </tr>
          </thead>
          <tbody>
            {shifts.map((shift) => {
              const paused = pauseMinutes(shift);
              return (
                <tr key={`${shift.userId}:${shift.startedAt}`} className="align-top">
                  <td><ChatterLink userId={shift.userId} username={shift.username} /></td>
                  <td>
                    <span className="whitespace-nowrap">{shiftSpan(shift)}</span>
                    {shift.ongoing && <span className="team-sub"><StatusBadge status={TEAM_STATUS.onShift} bare /></span>}
                  </td>
                  <td className="num">{formatDuration(shift.workedMinutes)}</td>
                  <td className="muted whitespace-nowrap">
                    {shift.pauses.length === 0
                      ? "—"
                      : `${formatDuration(paused)} · ${shift.pauses.length} ${ruPlural(shift.pauses.length, "пауза", "паузы", "пауз")}`}
                  </td>
                  <td className="num">
                    <span className="font-medium">{formatCount(shift.authoredMessages)}</span>
                    {workedPages(shift).map((page) => {
                      const counts = page.messages >= CHATTER_SHIFT_PAGE_MIN_MESSAGES;
                      return (
                        <span
                          key={page.pageLabel}
                          className={counts ? "team-sub" : "team-sub team-faint"}
                          title={counts ? undefined : `Меньше ${CHATTER_SHIFT_PAGE_MIN_MESSAGES} сообщений: продажи этой страницы в смену не идут`}
                        >
                          {page.pageLabel} · {formatCount(page.messages)}
                        </span>
                      );
                    })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HowItCounts({ page }: { page: string | null }) {
  return (
    <Disclosure>
      <p>
        Смена считается по расширению ChatGoose: начало — первое действие чаттера на странице (клавиша, клик, прокрутка),
        конец — час без действий. Закрытое расширение и перезапуск браузера смену не прерывают.
      </p>
      <p>
        Сменой считается работа от {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений.
        Меньше — работа вне смены, в этом списке её нет. Пара сообщений до начала смены или после её конца — тоже работа вне смены,
        а не часть смены.
      </p>
      <p>Первые 10 минут без действий — работа (читает чат, ждёт ответа фана); дальше — пауза до следующего действия. «Отработано» — смена без пауз.</p>
      <p>
        «Сообщения» — сколько сообщений за смену Hub записал на чаттера, всего и по страницам; сообщения с телефона и из
        браузера без расширения сюда не попадают. Страницы, где чаттер ничего не написал, а только заглядывал, не показаны.
        Серым — страница, где меньше {CHATTER_SHIFT_PAGE_MIN_MESSAGES} сообщений: её продажи в смену не идут.
      </p>
      <p>Смена, которая задела окно, показана целиком.</p>
      <p>
        С выбранной страницей смена собирается только из работы на ней{page ? ` (${page})` : ""}: чаттер, у которого на этой
        странице меньше {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений, не показан.
      </p>
      <p>
        Автор сообщения — чаттер, из чьего браузера с расширением ChatGoose оно ушло. Hub узнаёт его из запроса, который
        страница уже отправила, и привязывает к сообщению.
      </p>
      <p>
        Считаются личные сообщения: без рассылок Fansly и без одинакового текста, ушедшего пяти и больше фанам за час.
        Без автора остаются сообщения с телефона, из браузера без расширения и из старых версий расширения.
      </p>
      <p>«Пока расширение было открыто» — сообщения, ушедшие, когда у кого-то из команды было открыто расширение на этой странице.</p>
    </Disclosure>
  );
}

export function TeamShiftsPage() {
  const { key: period, select } = useScreenPeriod();
  const filter = usePageFilter();
  const pageLabel = filter.page;
  const range: RangeKey = period === "3d" ? "3d" : period === "7d" ? "7d" : "24h";
  // Read anew each render: the end moves with the minute, so a shift going on keeps up.
  const span = windowOf(range);
  const query = useTeamShifts({ ...span, ...(pageLabel === null ? {} : { pageLabel }) });
  const { data, isLoading, isFetching, isError, refetch, dataUpdatedAt } = query;

  const header = (
    <PageHeader
      window={`${formatDateTime(span.from)} – ${formatDateTime(span.to)}`}
      fresh={data ? { at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: isFetching } : undefined}
    />
  );
  const shifts = data?.shifts ?? [];
  const people = new Set(shifts.map((shift) => shift.userId)).size;
  const ongoing = shifts.filter((shift) => shift.ongoing).length;
  const worked = shifts.reduce((sum, shift) => sum + shift.workedMinutes, 0);
  const messages = shifts.reduce((sum, shift) => sum + shift.authoredMessages, 0);
  const failed = !data && isError;
  const dash = failed ? "—" : isLoading ? "…" : null;

  return (
    <div className="team-screen">
      {header}
      {pageLabel !== null && (
        <p className="team-note">
          Смены считаются только по работе на {pageLabel}: чаттер, у которого на этой странице меньше
          {" "}{formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений, здесь не показан.
        </p>
      )}
      <StatGrid>
        <Stat label="На смене сейчас" value={dash ?? formatCount(ongoing)} meta={failed ? "Hub не ответил" : data && ongoing === 0 ? "Никого" : undefined} />
        <Stat label={`Работали ${RANGE_WORDS[range]}`} value={dash ?? formatCount(people)} meta={failed ? "Hub не ответил" : undefined} />
        <Stat label="Отработано" value={dash ?? formatDuration(worked)} meta={failed ? "Hub не ответил" : "без пауз"} />
        <Stat label="Сообщений" value={dash ?? formatCount(messages)} meta={failed ? "Hub не ответил" : "под своим входом"} />
      </StatGrid>

      {data && <QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} />}
      {!data ? (
        isLoading ? <TableSkeleton rows={4} columns={5} /> : <NoAnswerPanel retry={refetch} />
      ) : shifts.length === 0 ? (
        pageLabel !== null ? (
          <StatusPanel
            title={`На ${pageLabel} ${RANGE_WORDS[range]} смен нет`}
            description="На этой странице никто не работал в расширении ChatGoose, или у чаттеров ещё старая версия расширения."
            action={<button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Показать все страницы</button>}
          />
        ) : (
          <StatusPanel
            title={`${RANGE_WORDS[range][0]!.toUpperCase()}${RANGE_WORDS[range].slice(1)} смен нет`}
            description="На этих страницах никто не работал в расширении ChatGoose, или у чаттеров ещё старая версия расширения."
            action={range === "7d" ? undefined : <button type="button" className="btn btn-sm" onClick={() => select("7d")}>Показать 7 дней</button>}
          />
        )
      ) : (
        <div className={`team-stack ${isFetching && !isLoading && query.isPlaceholderData ? "is-refreshing" : ""}`}>
          <OnShiftNow shifts={shifts} filtered={pageLabel !== null} />
          <ByChatter shifts={shifts} />
          <AllShifts shifts={shifts} />
        </div>
      )}

      <AuthorlessCard days={RANGE_DAYS[range]} page={pageLabel} />
      <HowItCounts page={pageLabel} />
    </div>
  );
}
