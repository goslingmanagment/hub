import { useMemo, useRef, useState } from "react";

import {
  KIND_COLOR,
  KIND_LABEL,
  KINDS,
  beadRadius,
  dayLabel,
  duration,
  money,
  moneyExact,
  moscowOf,
  ribbonDays,
  shiftWhen,
  shortDay,
  timeOf,
  type RibbonSale,
  type Stats,
} from "./statsView.js";

// The signature of «Статистика»: the window's days as rows on a 24-hour clock
// (Moscow), each shift a bar and each sale a bead on it — the bigger the bead,
// the more money. A hollow bead: another chatter had the page open then too.

const HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24];
const DAY_MINUTES = 1440;

type HoverTarget = { kind: "sale"; sale: RibbonSale } | { kind: "shift"; shift: number };
type Hover = HoverTarget & { x: number; y: number };

function position(minute: number): string {
  return `${(Math.min(Math.max(minute, 0), DAY_MINUTES) / DAY_MINUTES) * 100}%`;
}

export function ShiftRibbon({ stats }: { stats: Stats }) {
  const days = useMemo(() => ribbonDays(stats), [stats]);
  const maxSale = useMemo(() => Math.max(0, ...stats.shifts.flatMap((shift) => shift.sales.map((sale) => sale.netMills))), [stats]);
  const frame = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const now = moscowOf(Date.parse(stats.serverNow));
  const density = days.length > 20 ? "dense" : days.length > 10 ? "medium" : "roomy";
  const hasOverlap = stats.shifts.some((shift) => shift.sales.some((sale) => sale.overlap));
  // The window reaches back before Hub had the chatter's shifts: say so instead of drawing empty days.
  const unknownBefore = days.length < stats.daily.length && days.length > 0 ? shortDay(days[days.length - 1]!.day) : null;

  const show = (target: HTMLElement, next: HoverTarget) => {
    const box = frame.current?.getBoundingClientRect();
    const mark = target.getBoundingClientRect();
    if (!box) return;
    setHover({ ...next, x: mark.left + mark.width / 2 - box.left, y: mark.top - box.top });
  };

  return (
    <div className="cs-ribbon" data-density={density} ref={frame} onPointerLeave={() => setHover(null)}>
      <div className="cs-ribbon-row cs-ribbon-head" aria-hidden="true">
        <span />
        <div className="cs-ribbon-hours">
          {HOURS.map((hour) => (
            <span key={hour} style={{ left: position(hour * 60) }} data-edge={hour === 0 ? "start" : hour === 24 ? "end" : undefined}>
              {String(hour).padStart(2, "0")}
            </span>
          ))}
        </div>
        <span className="cs-ribbon-total-head">за день</span>
      </div>

      <ol className="cs-ribbon-days" aria-label="Смены и продажи по дням, московское время">
        {days.map((day) => {
          const today = day.day === now.day;
          const label = dayLabel(day.day);
          return (
            <li key={day.day} className="cs-ribbon-row" data-today={today || undefined}>
              <span className="cs-ribbon-day">{label}</span>
              <div className="cs-ribbon-track">
                {HOURS.slice(1, -1).map((hour) => <span key={hour} className="cs-ribbon-grid" style={{ left: position(hour * 60) }} />)}
                {today && <span className="cs-ribbon-now" style={{ left: position(now.minute) }} />}
                {day.pieces.map((piece) => (
                  <span
                    key={`${piece.shift}-${piece.from}`}
                    className="cs-ribbon-shift"
                    data-live={piece.live || undefined}
                    style={{ left: position(piece.from), width: `${((piece.to - piece.from) / DAY_MINUTES) * 100}%` }}
                    onPointerEnter={(event) => show(event.currentTarget, { kind: "shift", shift: piece.shift })}
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
                      onPointerEnter={(event) => show(event.currentTarget, { kind: "sale", sale })}
                    >
                      <span className="cs-ribbon-bead" />
                    </span>
                  );
                })}
              </div>
              <span className="cs-ribbon-total">{day.started ? money(day.totalMills) : ""}</span>
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
              страницу вёл ещё кто-то
            </li>
          )}
          <li className="chart-legend-item">
            <span aria-hidden="true" className="cs-legend-shift" />
            смена, светлее — пауза
          </li>
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
          <span className="chart-tooltip-value">{moneyExact(sale.netMills)}</span>
        </div>
        <div className="chart-tooltip-note">
          {timeOf(sale.at)}, {sale.pageLabel}{sale.fanName ? `, ${sale.fanName}` : ""}
        </div>
        {sale.overlap && <div className="chart-tooltip-note">Страницу в этот момент вёл ещё кто-то</div>}
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
