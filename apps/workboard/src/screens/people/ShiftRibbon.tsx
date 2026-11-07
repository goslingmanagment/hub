import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { Money } from "@agency_hub_core/ui";
import { formatDuration, formatMills, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { ShiftLink, shiftPath } from "@/shared/links";
import type { PersonShift, PersonVisit, ReadState } from "./data.js";
import { beadSize, ribbonClock, ribbonDays, ribbonRowOf, ribbonRowStart, RIBBON_STEP_HOURS, type RibbonSale } from "./ribbon.js";
import { dayWords, KIND_OF, KINDS, timeRange } from "./words.js";

/**
 * The person's shifts by the hour (kept from the console's «Статистика» — the
 * owner's favourite block): a row per day of the period, a bar per shift
 * (lighter where it paused), a bead per sale — the bigger, the more money; a
 * hollow bead also counts for a colleague; a thin line is work outside a
 * shift. A bar opens that shift's review. Hover or focus tells the numbers.
 */

const DAY_MINUTES = 1440;
const MARKS = Array.from({ length: 24 / RIBBON_STEP_HOURS + 1 }, (_, index) => index * RIBBON_STEP_HOURS * 60);

type Target = { kind: "shift"; shift: number } | { kind: "sale"; sale: RibbonSale } | { kind: "visit"; visit: number };
type Hover = Target & { x: number; y: number; below: boolean };

function left(minute: number): string {
  return `${(Math.min(Math.max(minute, 0), DAY_MINUTES) / DAY_MINUTES) * 100}%`;
}

function width(from: number, to: number): string {
  return `${(Math.max(to - from, 0) / DAY_MINUTES) * 100}%`;
}

export function ShiftRibbon({ userId, backLabel, shifts, visits, days, unknownBefore, salesRead, today }: {
  userId: number;
  /** The review's «←» comes back here under this name. */
  backLabel: string;
  shifts: readonly PersonShift[];
  visits: readonly PersonVisit[];
  /** The days to draw (known ones only), any order. */
  days: readonly string[];
  /** The first day Hub has the person's shifts, when the period starts before it. */
  unknownBefore: string | null;
  /** Whether the sales (the beads) were read. */
  salesRead: ReadState;
  today: string;
}) {
  const clock = useMemo(() => ribbonClock(shifts), [shifts]);
  const rows = useMemo(() => ribbonDays(days, shifts, visits, clock), [days, shifts, visits, clock]);
  const maxSale = useMemo(() => Math.max(0, ...shifts.flatMap((shift) => (shift.saleList ?? []).map((sale) => sale.netMills))), [shifts]);
  const density = rows.length > 20 ? "dense" : rows.length > 10 ? "medium" : "roomy";
  const frame = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const nowAt = Date.now();
  const nowRow = ribbonRowOf(nowAt, clock);
  const nowMinute = (nowAt - ribbonRowStart(nowRow, clock)) / 60_000;
  const live = shifts.some((shift) => shift.ongoing);
  const hasOverlap = shifts.some((shift) => (shift.saleList ?? []).some((sale) => sale.overlap));
  const kindsShown = KINDS.filter((kind) => shifts.some((shift) => (shift.saleList ?? []).some((sale) => sale.kind === kind.kind)));

  const show = (element: HTMLElement, target: Target) => {
    const box = frame.current?.getBoundingClientRect();
    const mark = element.getBoundingClientRect();
    if (!box) return;
    const y = mark.top - box.top;
    setHover({ ...target, x: mark.left + mark.width / 2 - box.left, y: y < 120 ? mark.bottom - box.top : y, below: y < 120 });
  };
  const hoverProps = (target: Target) => ({
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => { if (event.pointerType === "mouse") show(event.currentTarget, target); },
    onFocus: (event: { currentTarget: HTMLElement }) => show(event.currentTarget, target),
    onBlur: () => setHover(null),
  });
  const openShift = (index: number) => {
    const shift = shifts[index];
    if (!shift) return;
    navigate(shiftPath(userId, shift.startedAt, location.search), { state: { back: { to: `${location.pathname}${location.search}`, label: backLabel } } });
  };

  // A tap outside a mark closes its numbers; so does Esc.
  useEffect(() => {
    if (hover === null) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.("[data-ribbon-mark]")) setHover(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setHover(null); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [hover]);

  return (
    <div
      className="people-ribbon"
      data-density={density}
      ref={frame}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") setHover(null); }}
    >
      <div className="people-ribbon__row people-ribbon__head" aria-hidden>
        <span />
        <div className="people-ribbon__hours">
          {MARKS.map((minute) => (
            <span key={minute} style={{ left: left(minute) }} data-edge={minute === 0 ? "start" : minute === DAY_MINUTES ? "end" : undefined}>
              {String((clock.startHour + minute / 60) % 24).padStart(2, "0")}
            </span>
          ))}
        </div>
        <span className="people-ribbon__total-head">за день</span>
      </div>

      <ol className="people-ribbon__days" aria-label="Смены по дням и часам, московское время">
        {rows.map((row) => (
          <li key={row.day} className="people-ribbon__row" data-today={row.day === today || undefined}>
            <span className="people-ribbon__day">{dayWords(row.day)}</span>
            <div className="people-ribbon__track">
              {MARKS.slice(1, -1).map((minute) => <span key={minute} className="people-ribbon__grid" style={{ left: left(minute) }} />)}
              {row.visits.map((visit) => (
                <span
                  key={`visit-${visit.visit}`}
                  className="people-ribbon__visit"
                  style={{ left: left(visit.from), width: width(visit.from, visit.to) }}
                  data-ribbon-mark
                  tabIndex={-1}
                  {...hoverProps({ kind: "visit", visit: visit.visit })}
                />
              ))}
              {row.pieces.map((piece) => {
                const shift = shifts[piece.shift]!;
                const label = `${dayWords(shift.date)}, ${timeRange(shift)}: продажи ${formatMills(shift.salesNetMills)}. Открыть разбор`;
                return (
                  <span
                    key={`${piece.shift}-${piece.from}`}
                    className="people-ribbon__piece"
                    data-live={piece.live || undefined}
                    style={{ left: left(piece.from), width: width(piece.from, piece.to) }}
                    data-ribbon-mark
                    {...hoverProps({ kind: "shift", shift: piece.shift })}
                  >
                    <ShiftLink userId={userId} startedAt={shift.startedAt} backLabel={backLabel} className="people-ribbon__shift">
                      <span className="ui-sr-only">{label}</span>
                      {piece.pauses.map((pause) => (
                        <span
                          key={pause.from}
                          className="people-ribbon__pause"
                          style={{
                            left: `${((pause.from - piece.from) / Math.max(piece.to - piece.from, 1)) * 100}%`,
                            width: `${((pause.to - pause.from) / Math.max(piece.to - piece.from, 1)) * 100}%`,
                          }}
                        />
                      ))}
                    </ShiftLink>
                  </span>
                );
              })}
              {row.sales.map((sale, index) => {
                const size = beadSize(sale.netMills, maxSale, density);
                return (
                  <span
                    key={`${sale.at}-${index}`}
                    className="people-ribbon__sale"
                    data-overlap={sale.overlap || undefined}
                    data-ribbon-mark
                    style={{ left: left(sale.minute), ["--bead" as string]: `${size}px`, ["--kind" as string]: KIND_OF[sale.kind].color }}
                    onClick={() => openShift(sale.shift)}
                    {...hoverProps({ kind: "sale", sale })}
                  />
                );
              })}
              {row.day === nowRow && live && <span className="people-ribbon__now" style={{ left: left(nowMinute) }} aria-hidden />}
            </div>
            <span className="people-ribbon__total">{row.totalMills === null ? "" : <Money mills={row.totalMills} />}</span>
          </li>
        ))}
      </ol>

      <div className="people-ribbon__foot">
        <ul className="people-ribbon__legend" aria-label="Обозначения">
          {kindsShown.map((kind) => (
            <li key={kind.kind}>
              <span aria-hidden className="people-ribbon__key-bead" style={{ background: kind.color }} />
              {kind.label}
            </li>
          ))}
          {hasOverlap && (
            <li>
              <span aria-hidden className="people-ribbon__key-bead people-ribbon__key-bead--hollow" />
              видна и у коллеги
            </li>
          )}
          <li>
            <span aria-hidden className="people-ribbon__key-shift"><span /></span>
            смена, бледнее — пауза
          </li>
          {visits.length > 0 && (
            <li>
              <span aria-hidden className="people-ribbon__key-visit" />
              работа вне смены
            </li>
          )}
        </ul>
        {salesRead === "off" && <p className="people-ribbon__note">Продажи точками Hub показывает только за последний 31 день.</p>}
        {salesRead === "failed" && <p className="people-ribbon__note">Продажи по минутам не пришли: на ленте только смены.</p>}
        {unknownBefore && <p className="people-ribbon__note">Раньше {unknownBefore} смены не записывались: расширение начало их считать в этот день.</p>}
      </div>

      {hover && <RibbonTip hover={hover} shifts={shifts} visits={visits} />}
    </div>
  );
}

function RibbonTip({ hover, shifts, visits }: { hover: Hover; shifts: readonly PersonShift[]; visits: readonly PersonVisit[] }) {
  const style = { left: hover.x, top: hover.y };
  const className = `people-ribbon__tip${hover.below ? " people-ribbon__tip--below" : ""}`;
  if (hover.kind === "sale") {
    const { sale } = hover;
    const kind = KIND_OF[sale.kind];
    return (
      <div className={className} style={style} role="status">
        <div className="people-ribbon__tip-row">
          <span aria-hidden className="people-ribbon__key-bead" style={{ background: kind.color }} />
          <span className="people-ribbon__tip-name">{kind.one}</span>
          <Money mills={sale.netMills} strong />
        </div>
        <div className="people-ribbon__tip-note">{formatTimeOfDay(sale.at)} · {sale.pageLabel}{sale.fanName ? ` · ${sale.fanName}` : ""}</div>
        {sale.overlap && <div className="people-ribbon__tip-note">Страницу вели двое, этому фану никто из них не писал: продажа видна у обоих.</div>}
      </div>
    );
  }
  if (hover.kind === "visit") {
    const visit = visits[hover.visit];
    if (!visit) return null;
    return (
      <div className={className} style={style} role="status">
        <div className="people-ribbon__tip-title">Работа вне смены, {formatTimeOfDay(visit.startedAt)}–{formatTimeOfDay(visit.endedAt)}</div>
        <div className="people-ribbon__tip-note">
          {formatDuration(visit.workedMinutes)}, {visit.messages} {ruPlural(visit.messages, "сообщение", "сообщения", "сообщений")}. Не смена: в продажи не входит.
        </div>
      </div>
    );
  }
  const shift = shifts[hover.shift];
  if (!shift) return null;
  return (
    <div className={className} style={style} role="status">
      <div className="people-ribbon__tip-title">{dayWords(shift.date)}, {timeRange(shift)}</div>
      <div className="people-ribbon__tip-row">
        <span className="people-ribbon__tip-name">Продажи</span>
        <Money mills={shift.salesNetMills} strong />
      </div>
      <div className="people-ribbon__tip-row">
        <span className="people-ribbon__tip-name">Работа</span>
        <span>{formatDuration(shift.workedMinutes)}</span>
      </div>
      <div className="people-ribbon__tip-note">{shift.pages.join(", ")}</div>
      <div className="people-ribbon__tip-hint">Нажмите — откроется разбор смены</div>
    </div>
  );
}
