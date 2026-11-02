import type { ReactNode } from "react";
import { Link } from "react-router";

import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { usdAxisFormatter } from "@/components/charts/format";

import { ShiftRibbon } from "./ShiftRibbon.js";
import { Card, KindSplit, RankedRows, RateRows, type RateRow } from "./StatsBlocks.js";
import {
  DELAY_LABELS,
  KINDS,
  KIND_LABEL,
  PERIODS,
  PRICE_LABELS,
  PRICE_PHRASES,
  bestPriceBucket,
  change,
  count,
  dayLabel,
  duration,
  money,
  moneyExact,
  percent,
  plural,
  quickReplyShare,
  recordedDays,
  replyContrast,
  share,
  shiftWhen,
  shortDay,
  timeOf,
  type Stats,
} from "./statsView.js";

// «Статистика»: a chatter's shifts and their money, how they sell and write,
// their records. The cabinet shows the chatter's own (`self`); the console
// shows a chatter's to the owner and team leads with the same blocks.

export interface StatsViewProps {
  stats: Stats;
  days: number;
  onDays: (days: number) => void;
  /** The cabinet: the chatter's own. Else a chatter shown to the owner or a lead. */
  self: boolean;
  /** Where the shift report is. */
  reportTo: string;
  /** Beside the period switch: the console's chatter picker. */
  toolbar?: ReactNode;
  refreshing?: boolean;
}

const SHORT_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });

function Delta({ value, label }: { value: number | null; label: string }) {
  if (value === null) return null;
  const rounded = Math.round(value * 100);
  const direction = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  return (
    <span className="cs-delta" data-direction={direction}>
      <span aria-hidden="true">{direction === "up" ? "↑" : direction === "down" ? "↓" : "→"}</span>
      {Math.abs(rounded)}% {label}
    </span>
  );
}

function Tile({ label, value, meta }: { label: string; value: ReactNode; meta?: ReactNode }) {
  return (
    <div className="stat cs-tile">
      <p className="stat-label">{label}</p>
      <p className="cs-tile-value">{value}</p>
      {meta && <p className="stat-meta">{meta}</p>}
    </div>
  );
}

function Hero({ stats, self, reportTo }: Pick<StatsViewProps, "stats" | "self" | "reportTo">) {
  const { totals, previous } = stats;
  const live = stats.shifts[0]?.ongoing ? stats.shifts[0] : null;
  const versus = `к прошлым ${stats.days} ${plural(stats.days, ["дню", "дням", "дням"])}`;
  return (
    <section className="card cs-hero" aria-labelledby="cs-hero-title">
      <div className="cs-hero-top">
        <div className="cs-hero-figure">
          <h2 id="cs-hero-title" className="cs-hero-label">{self ? "Продажи за твои смены" : `Продажи за смены ${stats.user.username}`}</h2>
          <p className="cs-hero-number">{money(totals.salesNetMills)}</p>
          <div className="cs-hero-facts">
            <span>{count(totals.shifts)} {plural(totals.shifts, ["смена", "смены", "смен"])}</span>
            <span>{duration(totals.workedMinutes)} работы</span>
            {totals.perHourMills !== null && <span>{money(totals.perHourMills)} в час</span>}
            <Delta value={change(totals.salesNetMills, previous?.salesNetMills)} label={versus} />
          </div>
        </div>
        <div className="cs-hero-side">
          {live && (
            <div className="cs-live" role="status">
              <span className="cs-live-dot" aria-hidden="true" />
              <span>
                Смена идёт с {timeOf(live.startedAt)}: {duration(live.workedMinutes)}, {money(live.salesNetMills)}
              </span>
            </div>
          )}
          <div className="cs-confirm">
            <p>
              Подтверждено в отчётах смен: <strong>{money(totals.confirmedNetMills)}</strong>
            </p>
            {totals.unconfirmedShifts > 0 && (
              <p className="cs-confirm-wait">
                {totals.unconfirmedShifts} {plural(totals.unconfirmedShifts, ["смена ждёт", "смены ждут", "смен ждут"])} подтверждения.{" "}
                <Link to={reportTo} className="link">{self ? "Подтвердить" : "Отчёты смен"}</Link>
              </p>
            )}
          </div>
        </div>
      </div>
      {totals.overlapNetMills > 0 && (
        <p className="cs-hero-overlap">
          Из них {money(totals.overlapNetMills)} — продажи, когда страницу вёл ещё кто-то: они видны у обоих.
        </p>
      )}
      <ShiftRibbon stats={stats} />
    </section>
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
    detail: `${count(cell.bought)} из ${count(cell.sent)}`,
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
    detail: `${count(cell.replies)} ${plural(cell.replies, ["ответ", "ответа", "ответов"])}`,
  }));
}

function Records({ stats }: { stats: Stats }) {
  const { records } = stats;
  const items: Array<{ key: string; label: string; value: string; detail: string }> = [];
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
      value: moneyExact(sale.netMills),
      detail: [KIND_LABEL[sale.kind], sale.fanName, sale.pageLabel, SHORT_DATE.format(new Date(sale.at))].filter(Boolean).join(", "),
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

function TopFans({ stats }: { stats: Stats }) {
  if (stats.topFans.length === 0) return <p className="cs-empty-line">Пока никто не платил за твои смены.</p>;
  return (
    <ol className="cs-fans">
      {stats.topFans.map((fan, index) => (
        <li key={`${fan.pageLabel}-${fan.fanName}-${index}`} className="cs-fan">
          <span className="cs-fan-rank">{index + 1}</span>
          <span className="cs-fan-name">
            <strong>{fan.fanName ?? "Фан без имени"}</strong>
            <span>{fan.pageLabel}</span>
          </span>
          <span className="cs-fan-money">
            <strong>{money(fan.netMills)}</strong>
            <span>{fan.sales} {plural(fan.sales, ["покупка", "покупки", "покупок"])}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Shifts({ stats, reportTo, self }: { stats: Stats; reportTo: string; self: boolean }) {
  if (stats.shifts.length === 0) return <p className="cs-empty-line">За эти дни смен не было.</p>;
  return (
    <div className="table-wrap cs-shifts">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Смена</th>
            <th scope="col" className="cs-num">Работа</th>
            <th scope="col" className="cs-num">Продажи</th>
            <th scope="col" className="cs-num">Сообщений</th>
            <th scope="col" className="cs-num">Фаны</th>
            <th scope="col">Отчёт</th>
          </tr>
        </thead>
        <tbody>
          {stats.shifts.map((shift) => (
            <tr key={shift.startedAt}>
              <td>
                <span className="cs-shift-when">{shiftWhen(shift)}</span>
                <span className="cs-shift-meta">
                  {shift.pages.join(", ")}
                  {shift.together.length > 0 && ` — вместе с ${shift.together.join(", ")}`}
                </span>
              </td>
              <td className="cs-num">{duration(shift.workedMinutes)}</td>
              <td className="cs-num"><strong>{money(shift.salesNetMills)}</strong></td>
              <td className="cs-num">{count(shift.messages)}{shift.ppvSent > 0 && <span className="cs-shift-meta">PPV {shift.ppvSent}</span>}</td>
              <td className="cs-num">{count(shift.fansWritten)}<span className="cs-shift-meta">заплатили {shift.fansPaid}</span></td>
              <td>
                {shift.ongoing
                  ? <span className="badge badge-info">идёт</span>
                  : shift.confirmedNetMills !== null
                    ? <span className="badge badge-success">подтверждён, {money(shift.confirmedNetMills)}</span>
                    : <Link to={reportTo} className="link">{self ? "подтвердить" : "не подтверждён"}</Link>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChatterStatsView({ stats, days, onDays, self, reportTo, toolbar, refreshing = false }: StatsViewProps) {
  const { totals } = stats;
  // A day before Hub had the chatter's shifts carries no values: the chart says «no data», never a zero.
  // The days before Hub had the chatter's shifts are not drawn at all: unknown, not empty.
  const known = recordedDays(stats);
  const daily = stats.daily.filter((day) => known.has(day.date)).map((day) => ({ date: day.date, ...day.byKind }));
  const trimmedFrom = daily.length < stats.daily.length && daily.length > 0 ? shortDay(daily[0]!.date) : null;
  const best = bestPriceBucket(stats.ppv.byPrice);
  const contrast = replyContrast(stats.replies.byDelay);
  const quick = quickReplyShare(stats.replies.byDelay);
  const composedTotal = Object.values(stats.composed).reduce((sum, value) => sum + value, 0);
  const since = stats.activitySince === null ? null : SHORT_DATE.format(new Date(stats.activitySince));
  const empty = totals.shifts === 0;

  return (
    <div className="cs-page" data-refreshing={refreshing || undefined}>
      <div className="cs-toolbar">
        {toolbar ?? <h1 className="cs-greeting">Привет, {stats.user.username}</h1>}
        <div className="segmented" role="group" aria-label="Период">
          {PERIODS.map((period) => (
            <button key={period.days} type="button" className="segment" aria-pressed={days === period.days} onClick={() => onDays(period.days)}>
              {period.label}
            </button>
          ))}
        </div>
      </div>

      <Hero stats={stats} self={self} reportTo={reportTo} />

      {empty ? (
        <section className="card cs-card">
          <div className="empty">
            <p className="empty-title">За эти дни смен нет</p>
            <p className="empty-text">
              Смена считается, пока открыто расширение ChatGoose под {self ? "твоим" : "своим"} входом и {self ? "ты работаешь" : "чаттер работает"} в нём.
              {since ? ` Смены видны с ${since}.` : ""}
            </p>
          </div>
        </section>
      ) : (
        <>
          <div className="stat-grid cs-tiles">
            <Tile
              label="В час"
              value={totals.perHourMills === null ? "—" : money(totals.perHourMills)}
              meta={change(totals.perHourMills ?? 0, stats.previous?.perHourMills) === null
                ? `за ${duration(totals.workedMinutes)} работы`
                : <Delta value={change(totals.perHourMills ?? 0, stats.previous?.perHourMills)} label="к прошлому периоду" />}
            />
            <Tile
              label="PPV купили"
              value={<>{count(stats.ppv.bought)} <span className="cs-tile-of">из {count(stats.ppv.sent)}</span></>}
              meta={stats.ppv.sent > 0 ? `${percent(share(stats.ppv.bought, stats.ppv.sent))}, принесли ${money(stats.ppv.netMills)}` : "PPV за период не было"}
            />
            <Tile
              label="Ответ за 15 минут"
              value={percent(quick)}
              meta={stats.replies.replies > 0 ? `из ${count(stats.replies.replies)} ${plural(stats.replies.replies, ["ответа", "ответов", "ответов"])} ждущим фанам` : "ответов пока нет"}
            />
            <Tile
              label="Фаны заплатили"
              value={<>{count(totals.fansPaid)} <span className="cs-tile-of">из {count(totals.fansWritten)}</span></>}
              meta="кому писал в смене — заплатили до её конца"
            />
          </div>

          <div className="cs-grid cs-grid-daily">
            <Card
              title="По дням"
              note={`Деньги смены — в день, когда она началась, как в таблице выплат.${trimmedFrom ? ` Смены записываются с ${trimmedFrom}` : ""}`}
            >
              <StackedBarChart
                title=""
                data={daily}
                xKey="date"
                series={KINDS.map((kind) => ({ key: kind.key, label: kind.label, color: kind.color }))}
                xTickFormatter={shortDay}
                valueFormatter={money}
                tooltipValueFormatter={moneyExact}
                axisFormatter={usdAxisFormatter}
                height={240}
              />
            </Card>
            <Card title="Из чего продажи">
              <KindSplit byKind={totals.byKind} />
            </Card>
          </div>

          <div className="cs-grid cs-grid-halves">
            <Card
              title="Цена PPV и покупки"
              note={best
                ? <>Лучше всего покупают {PRICE_PHRASES[best.bucket]}: {percent(best.rate)}. Серая метка — команда на тех же страницах.</>
                : "Сколько из отправленных PPV купили. Серая метка — команда на тех же страницах."}
            >
              <RateRows rows={priceRows(stats)} empty="Личных PPV за период не было." baseWord="PPV" />
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
              <TopFans stats={stats} />
            </Card>
            <Card title="Страницы">
              <RankedRows
                empty="Продаж за период нет."
                rows={stats.pages.filter((page) => page.salesNetMills > 0 || page.activeMinutes >= 15).map((page) => ({
                  key: page.pageLabel,
                  label: <>{page.pageLabel} <span className={`platform-tag platform-${page.platform}`}>{page.platform === "onlyfans" ? "OF" : "Fansly"}</span></>,
                  value: page.salesNetMills,
                  valueText: money(page.salesNetMills),
                  detail: duration(page.activeMinutes),
                }))}
              />
            </Card>
            <Card title="Как пишешь" note={`${count(composedTotal)} ${plural(composedTotal, ["сообщение", "сообщения", "сообщений"])} за период.`}>
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
            <Card title="Рекорды" note={`За ${stats.days} ${plural(stats.days, ["день", "дня", "дней"])}.`}>
              <Records stats={stats} />
            </Card>
            <Card title="Смены" note="Новые сверху.">
              <Shifts stats={stats} reportTo={reportTo} self={self} />
            </Card>
          </div>
        </>
      )}

      <p className="cs-footnote">
        Деньги — net, после комиссии площадки: продажи на странице, которая была открыта {self ? "у тебя" : "у чаттера"} в расширении во время смены.
        Если в этот момент страницу вёл ещё кто-то, продажа видна у обоих. Это ориентир, а не расчёт зарплаты: к выплате идут подтверждённые отчёты смен и таблица.
        {since ? ` Смены считаются по расширению с ${since}` : " Смены считаются по расширению"}; время московское, обновлено в {timeOf(stats.serverNow)}.
      </p>
    </div>
  );
}

