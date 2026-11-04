import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  CHATTER_SHIFT_MIN_MESSAGES,
  CHATTER_SHIFT_MIN_WORKED_MINUTES,
  CHATTER_SHIFT_PAGE_MIN_MESSAGES,
  CHATTER_SHIFTS_MAX_WINDOW_DAYS,
  type KernelOperationResponse,
  type TeamShift,
} from "@agency_hub_core/contracts";
import { useTeamShiftSales } from "@/api/team";
import { ChartTable } from "@/components/charts/ChartTable";
import { usdAxisFormatter } from "@/components/charts/format";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatCount, formatDateTime, formatDay, formatDayRange, formatDuration, formatMills, formatSignedPercent, formatTimeOfDay } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { isPlainRowClick } from "@/lib/rowClick";
import { TEAM_STATUS } from "@/lib/statusWords";
import { change, moscowOf, shortDay } from "@/pages/account/stats/statsView";
import { AuthorlessCard } from "./AuthorlessCard.js";
import { DayBars } from "./DayBars.js";
import { ChatterLink, PageLink } from "./teamLinks.js";

/**
 * Команда → Смены → Заработок: who earned what in their shifts and when, against
 * the window before; who is on a shift now; every shift with its money
 * (`teamShiftSales`). Read-only; the owner and team leads. The page filter goes
 * to the server: with a page, a shift is made of the work on that page alone,
 * and its money is that page's.
 */

type Data = KernelOperationResponse<"teamShiftSales">;
type Chatter = Data["chatters"][number];
type MoneyShift = Data["shifts"][number];

const SHIFTS_AT_FIRST = 30;

/** «3 нояб., 10:44 – 19:30»; over midnight «3 нояб., 20:40 – 4 нояб., 03:12»; going on «– сейчас». */
export function shiftSpan(shift: Pick<TeamShift, "startedAt" | "endedAt" | "ongoing">): string {
  if (shift.ongoing) return `${formatDateTime(shift.startedAt)} – сейчас`;
  const sameDay = formatDay(shift.startedAt) === formatDay(shift.endedAt);
  return `${formatDateTime(shift.startedAt)} – ${sameDay ? formatTimeOfDay(shift.endedAt) : formatDateTime(shift.endedAt)}`;
}

function pauseMinutes(shift: TeamShift): number {
  return shift.pauses.reduce((sum, pause) => sum + Math.round((Date.parse(pause.to) - Date.parse(pause.from)) / 60_000), 0);
}

function workedPages(shift: TeamShift) {
  return shift.pages.filter((page) => page.messages > 0);
}

function perHourOf(salesNetMills: number, minutes: number): number | null {
  return minutes === 0 ? null : Math.round((salesNetMills * 60) / minutes);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function Delta({ value, label }: { value: number | null; label?: string }) {
  if (value === null) return null;
  const whole = Math.round(value * 100);
  const tone = whole > 0 ? "delta-up" : whole < 0 ? "delta-down" : "delta-pct";
  return <span className={`delta ${tone}`}>{formatSignedPercent(value * 100)}{label ? ` ${label}` : ""}</span>;
}

/** The window before in words: «к 22–28 окт.», or why there is nothing to compare with yet. */
function useVersus(data: Data) {
  const today = moscowOf(Date.parse(data.serverNow)).day;
  const first = data.team.daily[0]?.date ?? today;
  const days = data.team.daily.length;
  const versus = `к ${formatDayRange(addDays(first, -days), addDays(first, -1))}`;
  const knownDay = data.knownSince === null ? null : moscowOf(Date.parse(data.knownSince)).day;
  // The first day the window before is all inside what Hub has watched.
  const comparableFrom = knownDay === null ? null : addDays(knownDay, 2 * days);
  const waiting = data.previous === null && knownDay !== null
    ? `Сравнение с прошлыми ${days} ${ruPlural(days, "днём", "днями", "днями")} — с ${shortDay(comparableFrom!)}: Hub считает смены с ${shortDay(knownDay)}`
    : null;
  return { today, versus, waiting, knownDay };
}

function TeamStats({ data, failed }: { data: Data | undefined; failed: boolean }) {
  if (!data) {
    const dash = failed ? "—" : "…";
    const meta = failed ? "Hub не ответил" : undefined;
    return (
      <StatGrid>
        <Stat label="Продажи за смены" value={dash} meta={meta} />
        <Stat label="В час работы" value={dash} meta={meta} />
        <Stat label="Смен" value={dash} meta={meta} />
        <Stat label="На смене сейчас" value={dash} meta={meta} />
      </StatGrid>
    );
  }
  return <TeamStatsOf data={data} />;
}

function TeamStatsOf({ data }: { data: Data }) {
  const { team, previous } = data;
  const { versus, waiting } = useVersus(data);
  const ongoing = data.shifts.filter((shift) => shift.ongoing);
  const compare = (current: number | null, before: number | null | undefined): ReactNode =>
    previous === null ? (waiting ? "Сравнения пока нет" : undefined) : <Delta value={change(current ?? 0, before)} label={versus} />;
  return (
    <StatGrid>
      <Stat label="Продажи за смены" value={formatMills(team.salesNetMills)} meta={compare(team.salesNetMills, previous?.salesNetMills)} />
      <Stat label="В час работы" value={team.perHourMills === null ? "—" : formatMills(team.perHourMills)} meta={compare(team.perHourMills, previous?.perHourMills)} />
      <Stat
        label="Смен"
        value={formatCount(team.shifts)}
        meta={`${formatDuration(team.workedMinutes)} работы${previous ? `, было ${formatCount(previous.shifts)}` : ""}`}
      />
      <Stat
        label="На смене сейчас"
        value={formatCount(ongoing.length)}
        meta={ongoing.length === 0 ? "Никого" : ongoing.map((shift) => shift.username).join(", ")}
      />
    </StatGrid>
  );
}

/** Б: the team's money by day; on hover, whose it was. */
function ByDay({ data }: { data: Data }) {
  const { today, knownDay } = useVersus(data);
  // A day before Hub counted shifts carries no value: «нет данных», never a zero.
  const rows = data.team.daily.map((day): Record<string, string | number> => {
    const row: Record<string, string | number> = { date: day.date };
    if (knownDay === null || day.date >= knownDay) row.sales = day.salesNetMills;
    return row;
  });
  const whoOn = (date: string) => data.chatters
    .map((chatter) => ({ chatter, day: chatter.daily.find((one) => one.date === date) }))
    .filter((one) => one.day !== undefined && one.day.shifts > 0)
    .sort((a, b) => b.day!.salesNetMills - a.day!.salesNetMills);
  const note = (row: Record<string, unknown>) => {
    const date = typeof row.date === "string" ? row.date : "";
    const people = whoOn(date);
    return (
      <>
        {people.map(({ chatter, day }) => (
          <div key={chatter.userId} className="team-tip-row">
            <span>{chatter.username}</span>
            <span>{formatMills(day!.salesNetMills)}</span>
          </div>
        ))}
        {people.length === 0 && typeof row.sales === "number" && <div>Смен не было</div>}
        {date === today && <div>День ещё идёт, число вырастет.</div>}
      </>
    );
  };
  return (
    <section className="card" aria-labelledby="shifts-by-day">
      <header className="card-header">
        <div>
          <h2 id="shifts-by-day" className="card-title">Продажи за смены по дням</h2>
          <p className="card-description">После комиссии. Наведите на день — кто сколько продал.</p>
        </div>
      </header>
      <div className="card-body">
        <StackedBarChart
          title=""
          data={rows}
          xKey="date"
          series={[{ key: "sales", label: "Продажи", color: "var(--color-chart-blue)" }]}
          xTickFormatter={shortDay}
          valueFormatter={(value) => formatMills(value)}
          axisFormatter={usdAxisFormatter}
          tickSpacing={{ spacing: 72, max: 8 }}
          totalLabel={null}
          note={note}
          height={240}
        />
      </div>
      <div className="team-card-inner">
        <ChartTable
          caption="Продажи за смены по дням"
          rows={[...data.team.daily].reverse()}
          rowKey={(day) => day.date}
          columns={[
            { key: "date", label: "День", value: (day) => shortDay(day.date) },
            { key: "sales", label: "Продажи", num: true, value: (day) => (knownDay !== null && day.date < knownDay ? "—" : formatMills(day.salesNetMills)) },
            { key: "shifts", label: "Смен", num: true, value: (day) => formatCount(day.shifts) },
            { key: "worked", label: "Работы", num: true, value: (day) => (day.workedMinutes > 0 ? formatDuration(day.workedMinutes) : "—") },
            { key: "who", label: "Кто", value: (day) => whoOn(day.date).map(({ chatter, day: of }) => `${chatter.username} ${formatMills(of!.salesNetMills)}`).join(", ") || "—" },
          ]}
        />
      </div>
    </section>
  );
}

function ChangeCell({ current, before, isNew }: { current: number | null; before: number | null | undefined; isNew: boolean }) {
  if (isNew) return <span className="team-sub team-faint">новый</span>;
  if (before === null || before === undefined) return null;
  const value = change(current ?? 0, before);
  if (value === null) return <span className="team-sub team-faint">было {formatMills(before)}</span>;
  return <span className="team-sub"><Delta value={value} /></span>;
}

/** В: one row a chatter: their days on the team's one scale, money, per hour, against the window before. */
function ByChatter({ data, period }: { data: Data; period: string }) {
  const navigate = useNavigate();
  const { today, versus, waiting } = useVersus(data);
  const working = data.chatters.filter((chatter) => chatter.shifts > 0);
  const gone = data.chatters.filter((chatter) => chatter.shifts === 0);
  const isNew = (chatter: Chatter) => data.previous !== null && chatter.previous === null;
  return (
    <section className="card" aria-labelledby="shifts-by-chatter">
      <header className="card-header">
        <div>
          <h2 id="shifts-by-chatter" className="card-title">Кто сколько заработал</h2>
          <p className="card-description">
            Столбики — продажи по дням, у каждого в своём масштабе: видно, растёт он или проседает.
            {data.previous !== null ? ` Проценты — ${versus}` : waiting ? ` ${waiting}` : ""}
          </p>
        </div>
      </header>
      <div className="table-wrap">
        <table className="data-table team-sticky-first">
          <thead>
            <tr>
              <th scope="col">Чаттер</th>
              <th scope="col">По дням</th>
              <th scope="col" className="num">Продажи</th>
              <th scope="col" className="num">В час</th>
              <th scope="col" className="num">За смену</th>
            </tr>
          </thead>
          <tbody>
            {working.map((chatter) => (
              <tr
                key={chatter.userId}
                className="team-row-link align-top"
                onClick={(event) => { if (isPlainRowClick(event)) navigate(`/team/chatters/${chatter.userId}?period=${period}`); }}
              >
                <td>
                  <ChatterLink userId={chatter.userId} username={chatter.username} period={period} />
                  <span className="team-sub whitespace-nowrap">
                    {formatCount(chatter.shifts)} {ruPlural(chatter.shifts, "смена", "смены", "смен")}, {formatDuration(chatter.workedMinutes)}
                  </span>
                </td>
                <td>
                  <DayBars
                    days={chatter.daily}
                    today={today}
                    label={`${chatter.username} по дням: ${chatter.daily.filter((day) => day.shifts > 0).map((day) => `${shortDay(day.date)} ${formatMills(day.salesNetMills)}`).join(", ")}`}
                  />
                </td>
                <td className="num">
                  <span className="font-medium">{formatMills(chatter.salesNetMills)}</span>
                  <ChangeCell current={chatter.salesNetMills} before={chatter.previous?.salesNetMills} isNew={isNew(chatter)} />
                </td>
                <td className="num">
                  {chatter.perHourMills === null ? "—" : formatMills(chatter.perHourMills)}
                  <ChangeCell current={chatter.perHourMills} before={chatter.previous?.perHourMills} isNew={false} />
                </td>
                <td className="num">
                  {formatMills(Math.round(chatter.salesNetMills / chatter.shifts))}
                  {chatter.previous !== null && chatter.previous.shifts > 0 && (
                    <span className="team-sub team-faint">было {formatMills(Math.round(chatter.previous.salesNetMills / chatter.previous.shifts))}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {gone.length > 0 && (
        <div className="card-footer justify-start">
          <span>
            Без смен за период:{" "}
            {gone.map((chatter, index) => (
              <span key={chatter.userId}>
                {index > 0 && ", "}
                <ChatterLink userId={chatter.userId} username={chatter.username} period={period} />
                {chatter.previous && chatter.previous.shifts > 0 && (
                  <span className="team-faint"> (до этого {formatCount(chatter.previous.shifts)} {ruPlural(chatter.previous.shifts, "смена", "смены", "смен")}, {formatMills(chatter.previous.salesNetMills)})</span>
                )}
              </span>
            ))}
          </span>
        </div>
      )}
    </section>
  );
}

/** Г: who is on a shift now, and what their shift sold so far. */
function OnShiftNow({ shifts }: { shifts: readonly MoneyShift[] }) {
  const ongoing = shifts.filter((shift) => shift.ongoing);
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
              <th scope="col" className="num">Продажи за смену</th>
              <th scope="col" className="num">В час</th>
            </tr>
          </thead>
          <tbody>
            {ongoing.map((shift) => {
              const perHour = perHourOf(shift.salesNetMills, shift.workedMinutes);
              return (
                <tr key={shift.userId}>
                  <td><ChatterLink userId={shift.userId} username={shift.username} /></td>
                  <td>{workedPages(shift).map((page, at) => <span key={page.pageLabel}>{at > 0 && ", "}<PageLink label={page.pageLabel} /></span>)}</td>
                  <td>с {formatTimeOfDay(shift.startedAt)}, {formatDuration(shift.workedMinutes)}</td>
                  <td className="num font-medium">{formatMills(shift.salesNetMills)}</td>
                  <td className="num">{perHour === null ? "—" : formatMills(perHour)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Д: every shift, the newest first, with its money. */
function AllShifts({ shifts }: { shifts: readonly MoneyShift[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? shifts : shifts.slice(0, SHIFTS_AT_FIRST);
  return (
    <section className="card" aria-labelledby="shifts-all">
      <header className="card-header"><h2 id="shifts-all" className="card-title">Все смены</h2></header>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Чаттер</th>
              <th scope="col">Смена</th>
              <th scope="col" className="num">Продажи</th>
              <th scope="col" className="num">Отработано</th>
              <th scope="col">Паузы</th>
              <th scope="col" className="num">Сообщения</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((shift) => {
              const paused = pauseMinutes(shift);
              const perHour = perHourOf(shift.salesNetMills, shift.workedMinutes);
              return (
                <tr key={`${shift.userId}:${shift.startedAt}`} className="align-top">
                  <td><ChatterLink userId={shift.userId} username={shift.username} /></td>
                  <td>
                    <span className="whitespace-nowrap">{shiftSpan(shift)}</span>
                    {shift.ongoing && <span className="team-sub"><StatusBadge status={TEAM_STATUS.onShift} bare /></span>}
                  </td>
                  <td className="num">
                    <span className="font-medium">{formatMills(shift.salesNetMills)}</span>
                    {perHour !== null && <span className="team-sub">{formatMills(perHour)} в час</span>}
                    {shift.overlapNetMills > 0 && <span className="team-sub team-faint" title="Эти продажи видны и у другого чаттера: никто из двоих не писал этому фану">{formatMills(shift.overlapNetMills)} на двоих</span>}
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
      {shifts.length > SHIFTS_AT_FIRST && (
        <div className="card-footer justify-start">
          <button type="button" className="link" onClick={() => setAll((was) => !was)}>
            {all ? "Свернуть" : `Показать все ${formatCount(shifts.length)}`}
          </button>
        </div>
      )}
    </section>
  );
}

function HowItCounts({ page }: { page: string | null }) {
  return (
    <Disclosure>
      <p>
        Продажи смены — деньги после комиссии на страницах, где чаттер в смену писал (от {CHATTER_SHIFT_PAGE_MIN_MESSAGES} сообщений),
        с его первого действия на странице до конца смены. Если страницу вели двое, продажа у того, кто последним писал этому
        фану; если никто из них не писал, она видна у обоих («на двоих»). В итогах команды каждая продажа одна.
      </p>
      <p>
        «В час работы» — продажи, делённые на отработанное время без пауз. Проценты сравнивают с таким же периодом прямо
        перед выбранным. Смена относится к дню, на который приходится большая её часть, как в таблице выплат.
      </p>
      <p>Это ориентир, а не основание для оплаты: к выплате идут подтверждённые отчёты смен и таблица.</p>
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
      <p>
        С выбранной страницей смена собирается только из работы на ней{page ? ` (${page})` : ""}, и продажи — только её:
        чаттер, у которого на этой странице меньше {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений, не показан.
      </p>
      <p>
        Автор сообщения — чаттер, из чьего браузера с расширением ChatGoose оно ушло. Hub узнаёт его из запроса, который
        страница уже отправила, и привязывает к сообщению.
      </p>
    </Disclosure>
  );
}

export function TeamShiftsPage() {
  const { key: period, days, select } = useScreenPeriod();
  const filter = usePageFilter();
  const pageLabel = filter.page;
  const query = useTeamShiftSales(pageLabel === null ? { days } : { days, pageLabel });
  const { data, isLoading, isFetching, isError, refetch, dataUpdatedAt } = query;
  const today = data ? moscowOf(Date.parse(data.serverNow)).day : null;

  const header = (
    <PageHeader
      window={data && today ? formatDayRange(data.team.daily[0]?.date ?? today, today) : undefined}
      fresh={data ? { at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: isFetching } : undefined}
    />
  );
  const failed = !data && isError;
  const periodWords = `за ${days} ${ruPlural(days, "день", "дня", "дней")}`;

  return (
    <div className="team-screen">
      {header}
      {pageLabel !== null && (
        <p className="team-note">
          Смены и продажи только на {pageLabel}: чаттер, у которого на этой странице меньше
          {" "}{formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений, здесь не показан.
        </p>
      )}
      <TeamStats data={data} failed={failed} />

      {data && <QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} />}
      {!data ? (
        isLoading ? <TableSkeleton rows={6} columns={5} /> : <NoAnswerPanel retry={refetch} />
      ) : data.shifts.length === 0 ? (
        pageLabel !== null ? (
          <StatusPanel
            title={`На ${pageLabel} ${periodWords} смен нет`}
            description="На этой странице никто не работал в расширении ChatGoose, или у чаттеров ещё старая версия расширения."
            action={<button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Показать все страницы</button>}
          />
        ) : (
          <StatusPanel
            title={`${periodWords[0]!.toUpperCase()}${periodWords.slice(1)} смен нет`}
            description="На этих страницах никто не работал в расширении ChatGoose, или у чаттеров ещё старая версия расширения."
            action={days >= 30 ? undefined : <button type="button" className="btn btn-sm" onClick={() => select("30d")}>Показать 30 дней</button>}
          />
        )
      ) : (
        <div className={`team-stack ${isFetching && !isLoading && query.isPlaceholderData ? "is-refreshing" : ""}`}>
          <ByDay data={data} />
          <ByChatter data={data} period={period} />
          <OnShiftNow shifts={data.shifts} />
          <AllShifts shifts={data.shifts} />
        </div>
      )}

      <AuthorlessCard days={Math.min(days, CHATTER_SHIFTS_MAX_WINDOW_DAYS)} page={pageLabel} />
      <HowItCounts page={pageLabel} />
    </div>
  );
}

