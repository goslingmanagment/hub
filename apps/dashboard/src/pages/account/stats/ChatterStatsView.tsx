import type { ReactNode } from "react";
import { Link } from "react-router";
import { CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES, SHIFT_REPORT_MAX_DAYS } from "@agency_hub_core/contracts";
import { sumMills } from "@agency_hub_core/shared";

import { ChartTable } from "@/components/charts/ChartTable";
import { usdAxisFormatter } from "@/components/charts/format";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { Disclosure } from "@/components/ui/Disclosure";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDayRange, formatSignedPercent } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { TEAM_STATUS } from "@/lib/statusWords";

import { ShiftRibbon } from "./ShiftRibbon.js";
import { Card, KindSplit, RankedRows, RateRows, type RateRow } from "./StatsBlocks.js";
import {
  DELAY_LABELS,
  KINDS,
  KIND_LABEL,
  PRICE_LABELS,
  PRICE_PHRASES,
  bestPriceBucket,
  change,
  count,
  dayLabel,
  duration,
  money,
  moscowOf,
  percent,
  quickReplyShare,
  recordedDays,
  replyContrast,
  share,
  shiftWhen,
  shortDay,
  timeOf,
  type Stats,
  type StatsShift,
} from "./statsView.js";

// «Статистика»: a chatter's shifts and their money, how they sell and write,
// their records. The cabinet shows the chatter's own (`self`, on «ты»); the
// console shows a chatter's to the owner and team leads with the same blocks,
// on «вы» and about the chatter in the third person.

export interface StatsViewProps {
  stats: Stats;
  /** The cabinet: the chatter's own. Else a chatter shown to the owner or a lead. */
  self: boolean;
  /** Where the shifts of these Moscow days get confirmed: the cabinet's report, the console's payouts. */
  reportTo: (from: string, to: string) => string;
  /** The console: page labels lead to the page's card. The cabinet has no console to lead to. */
  linkPages?: boolean;
  /** Under the shifts, before «Как это считается»: the console's «Подробно по сменам». */
  extra?: ReactNode;
  /** An empty period offers the month. */
  onShowMonth?: (() => void) | undefined;
  refreshing?: boolean;
}

const SHORT_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });
/** What makes a shift, in words: `2 ч работы и 50 сообщений`. */
const SHIFT_RULE = `${duration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} работы и ${CHATTER_SHIFT_MIN_MESSAGES} сообщений`;
const DAY_MS = 86_400_000;
const PLATFORM_NAME: Readonly<Record<string, string>> = { fansly: "Fansly", onlyfans: "OnlyFans", telegram: "Telegram" };

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** A shift whose report can still be confirmed: over, not confirmed, not older than the API takes. */
function confirmable(shift: StatsShift, now: number): boolean {
  return !shift.ongoing && shift.confirmedNetMills === null && now - Date.parse(shift.startedAt) <= SHIFT_REPORT_MAX_DAYS * DAY_MS;
}

function tooOld(shift: StatsShift, now: number): boolean {
  return !shift.ongoing && shift.confirmedNetMills === null && now - Date.parse(shift.startedAt) > SHIFT_REPORT_MAX_DAYS * DAY_MS;
}

/** The window's Moscow days: its first and today. */
function windowDays(stats: Stats): { from: string; to: string } {
  const today = moscowOf(Date.parse(stats.serverNow)).day;
  return { from: stats.daily[0]?.date ?? today, to: today };
}

function Delta({ value, label }: { value: number | null; label: string }) {
  if (value === null) return null;
  const whole = Math.round(value * 100);
  const tone = whole > 0 ? "delta-up" : whole < 0 ? "delta-down" : "delta-pct";
  return <span className={`delta ${tone}`}>{formatSignedPercent(value * 100)} {label}</span>;
}

function PageLabel({ label, link }: { label: string; link: boolean }) {
  return link ? <Link to={`/pages/${encodeURIComponent(label)}`} className="team-link">{label}</Link> : <>{label}</>;
}

function Pages({ pages, link }: { pages: readonly string[]; link: boolean }) {
  return (
    <>
      {pages.map((page, index) => (
        <span key={page}>{index > 0 && ", "}<PageLabel label={page} link={link} /></span>
      ))}
    </>
  );
}

function Hero({ stats, self, reportTo }: Pick<StatsViewProps, "stats" | "self" | "reportTo">) {
  const { totals, previous } = stats;
  const now = Date.parse(stats.serverNow);
  const live = stats.shifts.find((shift) => shift.ongoing) ?? null;
  const first = stats.daily[0]?.date;
  // The cabinet has no dates in its header: the change names the days by their count.
  const versus = self || first === undefined
    ? `к прошлым ${stats.days} ${ruPlural(stats.days, "дню", "дням", "дням")}`
    : `к ${formatDayRange(addDays(first, -stats.days), addDays(first, -1))}`;
  const waiting = stats.shifts.filter((shift) => confirmable(shift, now)).length;
  const late = stats.shifts.filter((shift) => tooOld(shift, now)).length;
  const window = windowDays(stats);
  return (
    <section className="card cs-hero" aria-labelledby="cs-hero-title">
      <div className="cs-hero-top">
        <div className="cs-hero-figure">
          <h2 id="cs-hero-title" className="cs-hero-label">{self ? "Продажи за твои смены" : `Продажи за смены ${stats.user.username}`}</h2>
          <p className="cs-hero-number">{money(totals.salesNetMills)}</p>
          <p className="cs-hero-facts">
            <span>{count(totals.shifts)} {ruPlural(totals.shifts, "смена", "смены", "смен")}</span>
            <span>{duration(totals.workedMinutes)} работы</span>
            {totals.perHourMills !== null && <span>{money(totals.perHourMills)} в час</span>}
            <Delta value={change(totals.salesNetMills, previous?.salesNetMills)} label={versus} />
          </p>
        </div>
        <div className="cs-hero-side">
          <h2 className="cs-hero-label">Подтверждено к выплате</h2>
          <p className="cs-hero-second">{money(totals.confirmedNetMills)}</p>
          {waiting > 0 && (
            <p className="cs-hero-note">
              {waiting} {ruPlural(waiting, "смена ждёт", "смены ждут", "смен ждут")} подтверждения.{" "}
              <Link to={reportTo(window.from, window.to)} className="link">{self ? "Подтвердить" : "Выплаты"}</Link>
            </p>
          )}
          {late > 0 && (
            <p className="cs-hero-note">
              {late} {ruPlural(late, "смена", "смены", "смен")} старше {SHIFT_REPORT_MAX_DAYS} дней: подтвердить уже нельзя
            </p>
          )}
        </div>
      </div>
      {live && (
        <p className="cs-hero-live" role="status">
          <StatusBadge status={TEAM_STATUS.onShift} />
          <span>с {timeOf(live.startedAt)}: {duration(live.workedMinutes)}, {money(live.salesNetMills)}</span>
        </p>
      )}
      {totals.overlapNetMills > 0 && (
        <p className="cs-hero-overlap">
          Из них {money(totals.overlapNetMills)} видны и у коллег: страницу вели двое, а этим фанам никто из них не писал.
        </p>
      )}
      {stats.visits.length > 0 && <VisitsLine visits={stats.visits} />}
      <ShiftRibbon stats={stats} />
    </section>
  );
}

function VisitsLine({ visits }: { visits: Stats["visits"] }) {
  const minutes = visits.reduce((sum, visit) => sum + visit.workedMinutes, 0);
  const net = sumMills(visits.map((visit) => visit.salesNetMills));
  return (
    <p className="cs-hero-overlap">
      Вне смен: {count(visits.length)} {ruPlural(visits.length, "раз", "раза", "раз")}, {duration(minutes)}
      {net > 0n && <>, продажи {money(Number(net))}</>}. В сумме выше их нет: смена — от {SHIFT_RULE}.
    </p>
  );
}

function priceRows(stats: Stats): RateRow[] {
  return stats.ppv.byPrice.map((cell) => ({
    key: cell.bucket,
    label: PRICE_LABELS[cell.bucket] ?? cell.bucket,
    hits: cell.bought,
    base: cell.sent,
    teamHits: cell.teamBought,
    teamBase: cell.teamSent,
    detail: `${count(cell.bought)} из ${count(cell.sent)}${cell.bought > 0 ? `, ${money(cell.netMills)}` : ""}`,
  }));
}

function replyRows(stats: Stats): RateRow[] {
  return stats.replies.byDelay.map((cell) => ({
    key: cell.bucket,
    label: DELAY_LABELS[cell.bucket] ?? cell.bucket,
    hits: cell.bought,
    base: cell.replies,
    teamHits: cell.teamBought,
    teamBase: cell.teamReplies,
    detail: `${count(cell.bought)} из ${count(cell.replies)}`,
  }));
}

function Records({ stats, linkPages }: { stats: Stats; linkPages: boolean }) {
  const { records } = stats;
  const items: Array<{ key: string; label: string; value: string; detail: ReactNode }> = [];
  if (records.bestShift) {
    const shift = stats.shifts.find((one) => one.startedAt === records.bestShift!.startedAt);
    items.push({ key: "shift", label: "Лучшая смена", value: money(records.bestShift.salesNetMills), detail: shift ? shiftWhen(shift) : "" });
  }
  if (records.bestDay) items.push({ key: "day", label: "Лучший день", value: money(records.bestDay.salesNetMills), detail: dayLabel(records.bestDay.date) });
  if (records.biggestSale) {
    const sale = records.biggestSale;
    items.push({
      key: "sale",
      label: "Самая крупная продажа",
      value: money(sale.netMills),
      detail: (
        <>
          {[KIND_LABEL[sale.kind], sale.fanName].filter(Boolean).join(", ")}, <PageLabel label={sale.pageLabel} link={linkPages} />, {SHORT_DATE.format(new Date(sale.at))}
        </>
      ),
    });
  }
  items.push({
    key: "streak",
    label: "Дней подряд со сменой",
    value: count(records.streakDays),
    detail: records.longestStreakDays > records.streakDays ? `рекорд — ${records.longestStreakDays}` : records.streakDays > 1 ? "это рекорд" : "",
  });
  return (
    <dl className="cs-records">
      {items.map((item) => (
        <div key={item.key} className="cs-record">
          <dt>{item.label}</dt>
          <dd>
            <strong>{item.value}</strong>
            {item.detail && <span>{item.detail}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TopFans({ stats, self, linkPages }: { stats: Stats; self: boolean; linkPages: boolean }) {
  if (stats.topFans.length === 0) {
    return <p className="cs-empty-line">{self ? "Пока никто не платил за твои смены." : "Пока никто не платил за смены этого чаттера."}</p>;
  }
  return (
    <ol className="cs-fans">
      {stats.topFans.map((fan, index) => (
        <li key={`${fan.pageLabel}-${fan.fanName}-${index}`} className="cs-fan">
          <span className="cs-fan-rank">{index + 1}</span>
          <span className="cs-fan-name">
            <strong>{fan.fanName ?? "Фан без имени"}</strong>
            <span><PageLabel label={fan.pageLabel} link={linkPages} /></span>
          </span>
          <span className="cs-fan-money">
            <strong>{money(fan.netMills)}</strong>
            <span>{fan.sales} {ruPlural(fan.sales, "покупка", "покупки", "покупок")}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function ReportCell({ shift, now, self, reportTo }: { shift: StatsShift; now: number; self: boolean; reportTo: StatsViewProps["reportTo"] }) {
  if (shift.ongoing) return <StatusBadge status={TEAM_STATUS.onShift} />;
  if (shift.confirmedNetMills !== null) {
    return <StatusBadge tone="good">{`Подтверждён, ${money(shift.confirmedNetMills)}`}</StatusBadge>;
  }
  if (tooOld(shift, now)) return <StatusBadge tone="off" bare>Срок прошёл</StatusBadge>;
  if (self) return <Link to={reportTo(shift.date, shift.date)} className="link">Подтвердить</Link>;
  return (
    <Link to={reportTo(shift.date, shift.date)} className="team-link" title="Открыть в выплатах">
      <StatusBadge status={TEAM_STATUS.reportNotConfirmed} bare />
    </Link>
  );
}

function Shifts({ stats, reportTo, self, linkPages }: { stats: Stats; reportTo: StatsViewProps["reportTo"]; self: boolean; linkPages: boolean }) {
  const now = Date.parse(stats.serverNow);
  if (stats.shifts.length === 0) return <p className="cs-empty-line">За эти дни смен не было.</p>;
  return (
    <div className="table-wrap cs-shifts">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Смена</th>
            <th scope="col" className="num">Работа</th>
            <th scope="col" className="num">Продажи</th>
            <th scope="col" className="num">Сообщений</th>
            <th scope="col" className="num">Фаны</th>
            <th scope="col">Отчёт</th>
          </tr>
        </thead>
        <tbody>
          {stats.shifts.map((shift) => (
            <tr key={shift.startedAt}>
              <td>
                <span className="cs-shift-when">{shiftWhen(shift)}</span>
                <span className="cs-shift-meta">
                  <Pages pages={shift.pages} link={linkPages} />
                  {shift.together.length > 0 && <>, вместе с {shift.together.join(", ")}</>}
                </span>
              </td>
              <td className="num">{duration(shift.workedMinutes)}</td>
              <td className="num"><strong className="font-semibold">{money(shift.salesNetMills)}</strong></td>
              <td className="num">
                {count(shift.messages)}
                {shift.ppvSent > 0 && <span className="cs-shift-meta">платных {count(shift.ppvSent)}</span>}
              </td>
              <td className="num">
                {count(shift.fansWritten)}
                <span className="cs-shift-meta">заплатили {count(shift.fansPaid)}</span>
              </td>
              <td><ReportCell shift={shift} now={now} self={self} reportTo={reportTo} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HowItCounts({ stats, self }: { stats: Stats; self: boolean }) {
  const since = stats.activitySince === null ? null : SHORT_DATE.format(new Date(stats.activitySince));
  return (
    <Disclosure>
      <p>Смена — минимум {SHIFT_RULE} подряд: перерыв до часа и перезапуск браузера её не прерывают.</p>
      <p>
        Продажи — деньги после комиссии площадки за смены, на страницах, где {self ? "ты писал" : "чаттер писал"} в смене,
        с {self ? "твоего" : "его"} первого действия на странице. Если страницу в это время вели двое, продажа у того, кто
        последним писал этому фану; если никто из них не писал, она видна у обоих.
      </p>
      <p>Подтверждено к выплате — суммы из подтверждённых отчётов смен. Подтвердить отчёт можно {SHIFT_REPORT_MAX_DAYS} дней.</p>
      <p>
        {self
          ? "Это ориентир, а не расчёт зарплаты: к выплате идут подтверждённые отчёты смен и таблица."
          : "Это ориентир, а не основание для оплаты: к выплате идут подтверждённые отчёты смен и таблица."}
      </p>
      <p>
        {since ? `Смены считаются по расширению с ${since}` : "Смены считаются по расширению"}; время московское, обновлено в {timeOf(stats.serverNow)}.
      </p>
    </Disclosure>
  );
}

export function ChatterStatsView({ stats, self, reportTo, linkPages = false, extra, onShowMonth, refreshing = false }: StatsViewProps) {
  const { totals } = stats;
  // The days before Hub had the chatter's shifts are not drawn at all: unknown, not empty.
  const known = recordedDays(stats);
  const knownDays = stats.daily.filter((day) => known.has(day.date));
  const daily = knownDays.map((day) => ({ date: day.date, ...day.byKind }));
  const trimmedFrom = daily.length < stats.daily.length && daily.length > 0 ? shortDay(daily[0]!.date) : null;
  const best = bestPriceBucket(stats.ppv.byPrice);
  const contrast = replyContrast(stats.replies.byDelay);
  const quick = quickReplyShare(stats.replies.byDelay);
  const composedTotal = Object.values(stats.composed).reduce((sum, value) => sum + value, 0);
  const since = stats.activitySince === null ? null : SHORT_DATE.format(new Date(stats.activitySince));
  const empty = totals.shifts === 0;
  const perHourChange = change(totals.perHourMills ?? 0, stats.previous?.perHourMills);

  return (
    <div className="cs-page" data-refreshing={refreshing || undefined}>
      <Hero stats={stats} self={self} reportTo={reportTo} />

      {empty ? (
        <section className="status-panel empty">
          <p className="empty-title">За эти дни смен нет</p>
          <p className="empty-text">
            Смена — минимум {SHIFT_RULE} подряд в расширении ChatGoose под {self ? "твоим" : "своим"} входом.
            {since ? ` Смены видны с ${since}.` : ""}
          </p>
          {onShowMonth && stats.days < 30 && (
            <div className="empty-actions">
              <button type="button" className="btn btn-sm" onClick={onShowMonth}>Показать 30 дней</button>
            </div>
          )}
        </section>
      ) : (
        <>
          <StatGrid>
            <Stat
              label="В час"
              value={totals.perHourMills === null ? "—" : money(totals.perHourMills)}
              meta={perHourChange === null
                ? `за ${duration(totals.workedMinutes)} работы`
                : <Delta value={perHourChange} label="к прошлому периоду" />}
            />
            <Stat
              label="Платные сообщения"
              value={<>{count(stats.ppv.bought)} <span className="cs-tile-of">из {count(stats.ppv.sent)}</span></>}
              meta={stats.ppv.sent > 0
                ? `купили ${percent(share(stats.ppv.bought, stats.ppv.sent))}, принесли ${money(stats.ppv.netMills)}`
                : "платных сообщений за период не было"}
            />
            <Stat
              label="Ответ за 15 минут"
              value={percent(quick)}
              meta={stats.replies.replies > 0 ? `из ${count(stats.replies.replies)} ${ruPlural(stats.replies.replies, "ответа", "ответов", "ответов")} ждущим фанам` : "ответов пока нет"}
            />
            <Stat
              label="Фаны заплатили"
              value={<>{count(totals.fansPaid)} <span className="cs-tile-of">из {count(totals.fansWritten)}</span></>}
              meta={self ? "кому писал в смене, заплатили до её конца" : "кому чаттер писал в смене, заплатили до её конца"}
            />
          </StatGrid>

          <div className="cs-grid cs-grid-daily">
            <Card
              title="По дням"
              note={`Деньги смены — в день, на который пришлась большая её часть, как в таблице выплат.${trimmedFrom ? ` Смены записываются с ${trimmedFrom}.` : ""}`}
            >
              <StackedBarChart
                title=""
                data={daily}
                xKey="date"
                series={KINDS.map((kind) => ({ key: kind.key, label: kind.label, color: kind.color }))}
                xTickFormatter={shortDay}
                valueFormatter={money}
                tooltipValueFormatter={money}
                axisFormatter={usdAxisFormatter}
                totalLabel="Всего"
                height={240}
              />
              <div className="mt-3">
                <ChartTable
                  caption="Продажи по дням"
                  rows={knownDays}
                  rowKey={(day) => day.date}
                  columns={[
                    { key: "date", label: "День", value: (day) => dayLabel(day.date) },
                    ...KINDS.map((kind) => ({ key: kind.key, label: kind.label, num: true, value: (day: Stats["daily"][number]) => money(day.byKind[kind.key]) })),
                    { key: "total", label: "Всего", num: true, value: (day) => money(day.salesNetMills) },
                  ]}
                />
              </div>
            </Card>
            <Card title="Из чего продажи">
              <KindSplit byKind={totals.byKind} />
            </Card>
          </div>

          <div className="cs-grid cs-grid-halves">
            <Card
              title="Цена платных сообщений и покупки"
              note={best
                ? <>Лучше всего покупают {PRICE_PHRASES[best.bucket]}: {percent(best.rate)}. Серая метка — команда на тех же страницах.</>
                : "Сколько из отправленных платных сообщений купили. Серая метка — команда на тех же страницах."}
            >
              <RateRows rows={priceRows(stats)} empty="Личных платных сообщений за период не было." baseWord="платных" />
            </Card>
            <Card
              title="Скорость ответа и покупки"
              note={contrast
                ? <>После ответа до 5 минут фан покупал в течение суток в {percent(contrast.fast)} случаев, после ответа через час и дольше — в {percent(contrast.slow)}.</>
                : "Как часто фан покупал в течение суток после ответа, по тому, как быстро ответили."}
            >
              <RateRows rows={replyRows(stats)} empty="Ответов ждущим фанам пока нет: считаются ответы старше суток." baseWord="ответов" />
            </Card>
          </div>

          <div className="cs-grid cs-grid-thirds">
            <Card title="Лучшие фаны" note="Кто больше всех принёс за смены периода.">
              <TopFans stats={stats} self={self} linkPages={linkPages} />
            </Card>
            <Card title="Страницы" note="Продажи и время работы на странице.">
              <RankedRows
                empty="Продаж за период нет."
                rows={stats.pages.filter((page) => page.salesNetMills > 0 || page.activeMinutes >= 15).map((page) => ({
                  key: page.pageLabel,
                  label: <><PageLabel label={page.pageLabel} link={linkPages} /> <span className="platform-tag">{PLATFORM_NAME[page.platform] ?? page.platform}</span></>,
                  value: page.salesNetMills,
                  valueText: money(page.salesNetMills),
                  detail: duration(page.activeMinutes),
                }))}
              />
            </Card>
            <Card
              title={self ? "Как пишешь" : "Как пишет"}
              note={`${count(composedTotal)} ${ruPlural(composedTotal, "сообщение", "сообщения", "сообщений")} за период. Reply, Fix, Hi и Ping — кнопки расширения.`}
            >
              <RankedRows
                empty="Сообщений за период нет."
                rows={[
                  { key: "hand", label: "Руками", value: stats.composed.hand },
                  { key: "reply", label: "Reply", value: stats.composed.reply },
                  { key: "fix", label: "Fix", value: stats.composed.fix },
                  { key: "greet", label: "Hi и Ping", value: stats.composed.greet },
                  { key: "other", label: "Другое", value: stats.composed.other },
                ]
                  .sort((a, b) => b.value - a.value)
                  .map((row) => ({ ...row, valueText: percent(share(row.value, composedTotal)), detail: count(row.value) }))}
              />
            </Card>
          </div>

          <div className="cs-grid cs-grid-shifts">
            <Card title="Рекорды" note={`За ${stats.days} ${ruPlural(stats.days, "день", "дня", "дней")}.`}>
              <Records stats={stats} linkPages={linkPages} />
            </Card>
            <Card title="Смены" note="Новые сверху.">
              <Shifts stats={stats} reportTo={reportTo} self={self} linkPages={linkPages} />
            </Card>
          </div>
        </>
      )}

      {extra}
      <HowItCounts stats={stats} self={self} />
    </div>
  );
}
