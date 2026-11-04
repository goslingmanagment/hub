import { useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
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
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { AnchorNav } from "@/components/ui/PeriodStepper";
import { Segmented } from "@/components/ui/Segmented";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatCount, formatDateTime, formatDay, formatDayRange, formatDuration, formatMills, formatSignedPercent, formatTimeOfDay, weekEnd, weekStart } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { isPlainRowClick } from "@/lib/rowClick";
import { TEAM_STATUS } from "@/lib/statusWords";
import { change, dayLabel, moscowOf, shortDay } from "@/pages/account/stats/statsView";
import { AuthorlessCard } from "./AuthorlessCard.js";
import { DayBars } from "./DayBars.js";
import { ChatterLink, PageLink } from "./teamLinks.js";

/**
 * Команда → Смены → Заработок: who earned what in their shifts and when, against
 * the window before; who is on a shift now; every shift with its money
 * (`teamShiftSales`). Read-only; the owner and team leads. The period is the
 * screen's own (`?period=`, `?at=`): a calendar week, Monday to Sunday, as the
 * payout sheet reads it (a grid of chatters by day), or the last 14 or 30 days.
 * The page filter goes to the server: with a page, a shift is made of the work
 * on that page alone, and its money is that page's.
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

/** The window before in words: «к 22–28 окт.», «к прошлой неделе», or why there is nothing to compare with yet. */
function useVersus(data: Data, mode: Mode) {
  const today = moscowOf(Date.parse(data.serverNow)).day;
  const first = data.team.daily[0]?.date ?? today;
  const last = data.team.daily.at(-1)?.date ?? today;
  const days = data.team.daily.length;
  const goingOn = last >= today;
  const versus = mode === "week"
    ? (goingOn ? "к прошлой неделе на это же время" : "к прошлой неделе")
    : `к ${formatDayRange(addDays(first, -days), addDays(first, -1))}`;
  const knownDay = data.knownSince === null ? null : moscowOf(Date.parse(data.knownSince)).day;
  const waiting = data.previous === null && knownDay !== null
    ? `Сравнения нет: Hub считает смены с ${shortDay(knownDay)}, а прошлый период начался раньше`
    : null;
  // The tiles are narrow: the week's «на это же время» is said under the grid.
  const versusShort = mode === "week" ? "к прошлой неделе" : versus;
  return { today, versus, versusShort, waiting, knownDay };
}

function TeamStats({ data, failed, mode }: { data: Data | undefined; failed: boolean; mode: Mode }) {
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
  return <TeamStatsOf data={data} mode={mode} />;
}

function TeamStatsOf({ data, mode }: { data: Data; mode: Mode }) {
  const { team, previous } = data;
  const { versusShort: versus, waiting } = useVersus(data, mode);
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
function ByDay({ data, mode }: { data: Data; mode: Mode }) {
  const { today, knownDay } = useVersus(data, mode);
  const blank = (date: string) => (knownDay !== null && date < knownDay) || date > today;
  // A day before Hub counted shifts carries no value: «нет данных», never a zero.
  const rows = data.team.daily.map((day): Record<string, string | number> => {
    const row: Record<string, string | number> = { date: day.date };
    if (!blank(day.date)) row.sales = day.salesNetMills;
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
        {date > today && <div>День ещё впереди.</div>}
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
          xTickFormatter={mode === "week" ? dayLabel : shortDay}
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
            { key: "date", label: "День", value: (day) => dayLabel(day.date) },
            { key: "sales", label: "Продажи", num: true, value: (day) => (blank(day.date) ? "—" : formatMills(day.salesNetMills)) },
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
  // No shifts now: what there was, not «−100 %».
  if (current === null) return <span className="team-sub team-faint">было {formatMills(before)}</span>;
  const value = change(current ?? 0, before);
  if (value === null) return <span className="team-sub team-faint">было {formatMills(before)}</span>;
  return <span className="team-sub"><Delta value={value} /></span>;
}

/** В: one row a chatter: their days on the team's one scale, money, per hour, against the window before. */
function ByChatter({ data, period, mode }: { data: Data; period: string; mode: Mode }) {
  const navigate = useNavigate();
  const { today, versus, waiting } = useVersus(data, mode);
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

const WEEKDAY = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
const DAY_OF_MONTH = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

/** A cell's tint: one hue, the stronger the more money, on the week's one scale. */
function tintOf(value: number, max: number): CSSProperties | undefined {
  if (max <= 0 || value <= 0) return undefined;
  return { background: `color-mix(in srgb, var(--color-chart-blue) ${Math.round(4 + (22 * value) / max)}%, transparent)` };
}

/** В (a week): a row a chatter, a column a day, the week's money at the end — as the payout sheet reads. */
function WeekGrid({ data, period }: { data: Data; period: string }) {
  const navigate = useNavigate();
  const { today, versus, waiting } = useVersus(data, "week");
  const dates = data.team.daily.map((day) => day.date);
  const max = Math.max(0, ...data.chatters.flatMap((chatter) => chatter.daily.map((day) => day.salesNetMills)));
  const isNew = (chatter: Chatter) => data.previous !== null && chatter.previous === null;
  const dayCell = (day: { date: string; salesNetMills: number; shifts: number; workedMinutes: number }, strong = false) => {
    if (day.date > today) return <td key={day.date} className="num team-week-future" />;
    if (day.shifts === 0) return <td key={day.date} className="num team-faint">—</td>;
    return (
      <td
        key={day.date}
        className={`num team-week-cell ${strong ? "font-medium" : ""}`}
        style={tintOf(day.salesNetMills, strong ? 0 : max)}
        title={`${dayLabel(day.date)}: ${day.shifts} ${ruPlural(day.shifts, "смена", "смены", "смен")}, ${formatDuration(day.workedMinutes)}`}
      >
        {formatMills(day.salesNetMills)}
      </td>
    );
  };
  return (
    <section className="card" aria-labelledby="shifts-week">
      <header className="card-header">
        <div>
          <h2 id="shifts-week" className="card-title">Кто сколько заработал за неделю</h2>
          <p className="card-description">
            Продажи за смены по дням, после комиссии; чем ярче клетка, тем больше денег. Наведите на клетку — сколько смен и часов.
            {data.previous !== null ? ` Проценты — ${versus}.` : waiting ? ` ${waiting}.` : ""}
          </p>
        </div>
      </header>
      <div className="table-wrap">
        <table className="data-table team-sticky-first team-week">
          <thead>
            <tr>
              <th scope="col">Чаттер</th>
              {dates.map((date) => {
                const at = new Date(`${date}T12:00:00Z`);
                return (
                  <th key={date} scope="col" className={`num ${date === today ? "team-week-today" : ""} ${date > today ? "team-week-future" : ""}`}>
                    <span className="team-line">{WEEKDAY.format(at)}</span>
                    <span className="team-sub">{date === today ? "сегодня" : DAY_OF_MONTH.format(at)}</span>
                  </th>
                );
              })}
              <th scope="col" className="num">За неделю</th>
              <th scope="col" className="num">В час</th>
            </tr>
          </thead>
          <tbody>
            {data.chatters.map((chatter) => (
              <tr
                key={chatter.userId}
                className={`team-row-link align-top ${chatter.shifts === 0 ? "team-off-row" : ""}`}
                onClick={(event) => { if (isPlainRowClick(event)) navigate(`/team/chatters/${chatter.userId}?period=${period}`); }}
              >
                <td>
                  <ChatterLink userId={chatter.userId} username={chatter.username} period={period} />
                  <span className="team-sub whitespace-nowrap">
                    {chatter.shifts === 0
                      ? "смен не было"
                      : `${formatCount(chatter.shifts)} ${ruPlural(chatter.shifts, "смена", "смены", "смен")}, ${formatDuration(chatter.workedMinutes)}`}
                  </span>
                </td>
                {chatter.daily.map((day) => dayCell(day))}
                <td className="num">
                  <span className="font-semibold">{chatter.shifts === 0 ? "—" : formatMills(chatter.salesNetMills)}</span>
                  <ChangeCell current={chatter.shifts === 0 ? null : chatter.salesNetMills} before={chatter.previous?.salesNetMills} isNew={isNew(chatter)} />
                </td>
                <td className="num">
                  {chatter.perHourMills === null ? "—" : formatMills(chatter.perHourMills)}
                  {chatter.shifts > 0 && <ChangeCell current={chatter.perHourMills} before={chatter.previous?.perHourMills} isNew={false} />}
                </td>
              </tr>
            ))}
            <tr className="row-total align-top">
              <td>Вся команда</td>
              {data.team.daily.map((day) => dayCell(day, true))}
              <td className="num">
                <span className="font-semibold">{formatMills(data.team.salesNetMills)}</span>
                {data.previous && <span className="team-sub"><Delta value={change(data.team.salesNetMills, data.previous.salesNetMills)} /></span>}
              </td>
              <td className="num">
                {data.team.perHourMills === null ? "—" : formatMills(data.team.perHourMills)}
                {data.previous && <span className="team-sub"><Delta value={change(data.team.perHourMills ?? 0, data.previous.perHourMills)} /></span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
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

type Mode = "week" | "14d" | "30d";

const MODES: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: "week", label: "Неделя" },
  { value: "14d", label: "14 дней" },
  { value: "30d", label: "30 дней" },
];

/** `?period=` of the screen: a calendar week unless 14 or 30 days are asked (old 24h · 3d · 7d read as the week). */
function modeOf(value: string | null): Mode {
  return value === "14d" || value === "30d" ? value : "week";
}

export function TeamShiftsPage() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const filter = usePageFilter();
  const pageLabel = filter.page;
  const today = moscowOf(Date.now()).day;
  const mode = modeOf(search.get("period"));
  const asked = search.get("at");
  // The week is named by its Monday: the arrows step whole weeks and stop at this one.
  const monday = weekStart(asked !== null && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= today ? asked : today);
  const days = mode === "week" ? 7 : mode === "14d" ? 14 : 30;
  const params = { days, ...(mode === "week" ? { until: weekEnd(monday) } : {}), ...(pageLabel === null ? {} : { pageLabel }) };
  const query = useTeamShiftSales(params);
  const { data, isLoading, isFetching, isError, refetch, dataUpdatedAt } = query;
  // The chatter's screen knows 7, 14 and 30 days.
  const chatterPeriod = mode === "week" ? "7d" : mode;

  function go(next: { mode?: Mode; at?: string }) {
    const query = new URLSearchParams(search);
    const nextMode = next.mode ?? mode;
    if (nextMode === "week") query.delete("period");
    else query.set("period", nextMode);
    const at = next.at ?? monday;
    if (nextMode !== "week" || at === weekStart(today)) query.delete("at");
    else query.set("at", at);
    setSearch(query, { state: location.state });
  }

  const header = (
    <PageHeader
      actions={(
        <>
          {mode === "week" && <AnchorNav anchor={monday} mode="week" today={today} onChange={(at) => go({ at: weekStart(at) })} />}
          <Segmented label="Период" value={mode} onChange={(value) => go({ mode: value })} options={MODES} />
        </>
      )}
      window={data ? formatDayRange(data.team.daily[0]?.date ?? today, data.team.daily.at(-1)?.date ?? today) : undefined}
      fresh={data ? { at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: isFetching } : undefined}
    />
  );
  const failed = !data && isError;
  const periodWords = mode === "week" ? "за эту неделю" : `за ${days} ${ruPlural(days, "день", "дня", "дней")}`;

  return (
    <div className="team-screen">
      {header}
      {pageLabel !== null && (
        <p className="team-note">
          Смены и продажи только на {pageLabel}: чаттер, у которого на этой странице меньше
          {" "}{formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений, здесь не показан.
        </p>
      )}
      <TeamStats data={data} failed={failed} mode={mode} />

      {data && <QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} />}
      {!data ? (
        isLoading ? <TableSkeleton rows={6} columns={9} /> : <NoAnswerPanel retry={refetch} />
      ) : data.shifts.length === 0 && data.chatters.length === 0 ? (
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
            action={mode === "30d" ? undefined : <button type="button" className="btn btn-sm" onClick={() => go({ mode: "30d" })}>Показать 30 дней</button>}
          />
        )
      ) : (
        <div className={`team-stack ${isFetching && !isLoading && query.isPlaceholderData ? "is-refreshing" : ""}`}>
          {mode === "week" && <WeekGrid data={data} period={chatterPeriod} />}
          <ByDay data={data} mode={mode} />
          {mode !== "week" && <ByChatter data={data} period={chatterPeriod} mode={mode} />}
          <OnShiftNow shifts={data.shifts} />
          {data.shifts.length > 0 && <AllShifts shifts={data.shifts} />}
        </div>
      )}

      <AuthorlessCard days={Math.min(days, CHATTER_SHIFTS_MAX_WINDOW_DAYS)} page={pageLabel} />
      <HowItCounts page={pageLabel} />
    </div>
  );
}
