import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import {
  KIND_COLOR,
  KIND_LABEL,
  KINDS,
  beadRadius,
  dayLabel,
  duration,
  money,
  moscowOf,
  RIBBON_STEP_HOURS,
  ribbonDays,
  ribbonRowOf,
  ribbonRowStart,
  ribbonClock,
  recordedDays,
  shiftWhen,
  shortDay,
  timeOf,
  type RibbonSale,
  type Stats,
} from "./statsView.js";

// The signature of «Статистика»: the window's days as rows on a 24-hour clock
// (Moscow) that starts where the chatter's shifts leave it free, so a shift is
// one bar in the row of its day, an evening over midnight too; each sale a bead
// on it — the bigger the bead, the more money. A hollow bead: the sale counts for
// a colleague too. A thin line: work outside a shift. A mark tells its numbers on
// hover, on a tap and from the keyboard; a tap elsewhere closes it.

const DAY_MINUTES = 1440;
/** The hour marks across a row: the row's start, every RIBBON_STEP_HOURS, its end. */
const MARKS = Array.from({ length: 24 / RIBBON_STEP_HOURS + 1 }, (_, index) => index * RIBBON_STEP_HOURS * 60);

type HoverTarget = { kind: "sale"; sale: RibbonSale } | { kind: "shift"; shift: number } | { kind: "visit"; visit: number };
type Hover = HoverTarget & { x: number; y: number };

function position(minute: number): string {
  return `${(Math.min(Math.max(minute, 0), DAY_MINUTES) / DAY_MINUTES) * 100}%`;
}

export function ShiftRibbon({ stats }: { stats: Stats }) {
  const clock = useMemo(() => ribbonClock(stats.shifts), [stats]);
  const days = useMemo(() => ribbonDays(stats, clock), [stats, clock]);
  const { startHour } = clock;
  const maxSale = useMemo(() => Math.max(0, ...stats.shifts.flatMap((shift) => shift.sales.map((sale) => sale.netMills))), [stats]);
  const frame = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const nowAt = Date.parse(stats.serverNow);
  const today = moscowOf(nowAt).day;
  const nowRow = ribbonRowOf(nowAt, clock);
  const nowMinute = (nowAt - ribbonRowStart(nowRow, clock)) / 60_000;
  const density = days.length > 20 ? "dense" : days.length > 10 ? "medium" : "roomy";
  const hasOverlap = stats.shifts.some((shift) => shift.sales.some((sale) => sale.overlap));
  // The window reaches back before Hub had the chatter's shifts: say so instead of drawing empty days.
  const known = recordedDays(stats);
  const unknownBefore = known.size < stats.daily.length && known.size > 0 ? shortDay([...known].sort()[0]!) : null;

  const show = (target: HTMLElement, next: HoverTarget) => {
    const box = frame.current?.getBoundingClientRect();
    const mark = target.getBoundingClientRect();
    if (!box) return;
    setHover({ ...next, x: mark.left + mark.width / 2 - box.left, y: mark.top - box.top });
  };
  /** The handlers of one mark: the mouse over it, a tap on it, the keyboard on it. */
  const markProps = (next: HoverTarget) => ({
    "data-mark": true,
    tabIndex: 0,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => { if (event.pointerType === "mouse") show(event.currentTarget, next); },
    onClick: (event: { currentTarget: HTMLElement }) => show(event.currentTarget, next),
    onFocus: (event: { currentTarget: HTMLElement }) => show(event.currentTarget, next),
    onBlur: () => setHover(null),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => { if (event.key === "Escape") setHover(null); },
  });

  // A tap outside a mark closes its numbers.
  useEffect(() => {
    if (hover === null) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.("[data-mark]")) setHover(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [hover]);

  return (
    <div className="cs-ribbon" data-density={density} ref={frame} onPointerLeave={(event) => { if (event.pointerType === "mouse") setHover(null); }}>
      <div className="cs-ribbon-row cs-ribbon-head" aria-hidden="true">
        <span />
        <div className="cs-ribbon-hours">
          {MARKS.map((minute) => (
            <span key={minute} style={{ left: position(minute) }} data-edge={minute === 0 ? "start" : minute === DAY_MINUTES ? "end" : undefined}>
              {String((startHour + minute / 60) % 24).padStart(2, "0")}
            </span>
          ))}
        </div>
        <span className="cs-ribbon-total-head">за день</span>
      </div>

      <ol className="cs-ribbon-days" aria-label="Смены и продажи по дням, московское время">
        {days.map((day) => {
          const label = dayLabel(day.day);
          return (
            <li key={day.day} className="cs-ribbon-row" data-today={day.day === today || undefined}>
              <span className="cs-ribbon-day">{label}</span>
              <div className="cs-ribbon-track">
                {MARKS.slice(1, -1).map((minute) => <span key={minute} className="cs-ribbon-grid" style={{ left: position(minute) }} />)}
                {day.day === nowRow && <span className="cs-ribbon-now" style={{ left: position(nowMinute) }} />}
                {day.visits.map((visit) => (
                  <span
                    key={visit.visit}
                    className="cs-ribbon-visit"
                    style={{ left: position(visit.from), width: `${((visit.to - visit.from) / DAY_MINUTES) * 100}%` }}
                    aria-label="Работа вне смены"
                    {...markProps({ kind: "visit", visit: visit.visit })}
                  />
                ))}
                {day.pieces.map((piece) => (
                  <span
                    key={`${piece.shift}-${piece.from}`}
                    className="cs-ribbon-shift"
                    data-live={piece.live || undefined}
                    style={{ left: position(piece.from), width: `${((piece.to - piece.from) / DAY_MINUTES) * 100}%` }}
                    aria-label="Смена"
                    {...markProps({ kind: "shift", shift: piece.shift })}
                  >
                    {piece.pauses.map((pause) => (
                      <span
                        key={pause.from}
                        className="cs-ribbon-pause"
                        style={{
                          left: `${((pause.from - piece.from) / (piece.to - piece.from)) * 100}%`,
                          width: `${((pause.to - pause.from) / (piece.to - piece.from)) * 100}%`,
                        }}
                      />
                    ))}
                  </span>
                ))}
                {day.sales.map((sale, index) => {
                  const radius = beadRadius(sale.netMills, maxSale);
                  return (
                    <span
                      key={`${sale.at}-${index}`}
                      className="cs-ribbon-sale"
                      data-overlap={sale.overlap || undefined}
                      style={{ left: position(sale.minute), ["--bead" as string]: `${radius * 2}px`, ["--kind" as string]: KIND_COLOR[sale.kind] }}
                      aria-label={`${KIND_LABEL[sale.kind]}, ${money(sale.netMills)}`}
                      {...markProps({ kind: "sale", sale })}
                    >
                      <span className="cs-ribbon-bead" />
                    </span>
                  );
                })}
              </div>
              <span className="cs-ribbon-total">{day.hasShift ? money(day.totalMills) : ""}</span>
            </li>
          );
        })}
      </ol>
      {unknownBefore && (
        <p className="cs-ribbon-before">Раньше {unknownBefore} смены не записывались: расширение начало их считать в этот день.</p>
      )}

      <div className="cs-ribbon-legend">
        <ul aria-label="Легенда" className="chart-legend">
          {KINDS.map((kind) => (
            <li key={kind.key} className="chart-legend-item">
              <span aria-hidden="true" className="cs-legend-bead" style={{ background: kind.color }} />
              {kind.label}
            </li>
          ))}
          {hasOverlap && (
            <li className="chart-legend-item">
              <span aria-hidden="true" className="cs-legend-bead cs-legend-bead-hollow" />
              продажа видна и у коллеги
            </li>
          )}
          <li className="chart-legend-item">
            <span aria-hidden="true" className="cs-legend-shift"><span /></span>
            смена, светлее — пауза
          </li>
          {stats.visits.length > 0 && (
            <li className="chart-legend-item">
              <span aria-hidden="true" className="cs-legend-visit" />
              работа вне смены
            </li>
          )}
        </ul>
      </div>

      {hover && <RibbonTooltip hover={hover} stats={stats} />}
    </div>
  );
}

function RibbonTooltip({ hover, stats }: { hover: Hover; stats: Stats }) {
  const style = { left: hover.x, top: hover.y };
  if (hover.kind === "sale") {
    const { sale } = hover;
    return (
      <div className="chart-tooltip cs-ribbon-tooltip" style={style} role="status">
        <div className="chart-tooltip-row">
          <span aria-hidden="true" className="chart-tooltip-key" style={{ background: KIND_COLOR[sale.kind] }} />
          <span className="chart-tooltip-name">{KIND_LABEL[sale.kind]}</span>
          <span className="chart-tooltip-value">{money(sale.netMills)}</span>
        </div>
        <div className="chart-tooltip-note">
          {timeOf(sale.at)}, {sale.pageLabel}{sale.fanName ? `, ${sale.fanName}` : ""}
        </div>
        {sale.overlap && <div className="chart-tooltip-note">Страницу вели двое, фану никто из них не писал: видна у обоих</div>}
      </div>
    );
  }
  if (hover.kind === "visit") {
    const visit = stats.visits[hover.visit];
    if (visit === undefined) return null;
    return (
      <div className="chart-tooltip cs-ribbon-tooltip" style={style} role="status">
        <div className="chart-tooltip-label">Работа вне смены, {timeOf(visit.startedAt)}–{timeOf(visit.endedAt)}</div>
        <div className="chart-tooltip-row">
          <span aria-hidden="true" />
          <span className="chart-tooltip-name">Работа</span>
          <span className="chart-tooltip-value">{duration(visit.workedMinutes)}</span>
        </div>
        <div className="chart-tooltip-row">
          <span aria-hidden="true" />
          <span className="chart-tooltip-name">Сообщений</span>
          <span className="chart-tooltip-value">{visit.messages}</span>
        </div>
        <div className="chart-tooltip-note">Не смена: в сумму не входит</div>
      </div>
    );
  }
  const shift = stats.shifts[hover.shift];
  if (shift === undefined) return null;
  return (
    <div className="chart-tooltip cs-ribbon-tooltip" style={style} role="status">
      <div className="chart-tooltip-label">{shiftWhen(shift)}</div>
      <div className="chart-tooltip-row">
        <span aria-hidden="true" />
        <span className="chart-tooltip-name">Продажи</span>
        <span className="chart-tooltip-value">{money(shift.salesNetMills)}</span>
      </div>
      <div className="chart-tooltip-row">
        <span aria-hidden="true" />
        <span className="chart-tooltip-name">Работа</span>
        <span className="chart-tooltip-value">{duration(shift.workedMinutes)}</span>
      </div>
      <div className="chart-tooltip-note">{shift.pages.join(", ")}</div>
    </div>
  );
}
