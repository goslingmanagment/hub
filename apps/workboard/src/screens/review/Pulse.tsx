import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { formatCount, formatDuration, formatMills, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import type { PulseMinute, ReviewSale, Silence } from "./data.js";
import { PICK_MINUTES, REPLY_NORM_SECONDS, type ActivityState } from "./rules.js";

/**
 * The shift's pulse (spec §4.2): one thin strip of its minutes right above the
 * chats. Up — the chatter's messages; down — their fans waiting for an answer,
 * darker past the 10-minute norm; dots — money (a paid message bought, a tip);
 * grey bands — pauses; the line between — the extension: solid while the
 * chatter acted in it, faint while it was only open, none while closed. A click
 * picks ±10 minutes, a drag picks a span: the chats below narrow to it.
 */

const MINUTE_MS = 60_000;
const UP = 30;
const DOWN = 24;
const BASE = 3;
const PLOT = UP + BASE + DOWN;
const AXIS = 18;
/** At most this many columns: a column is 1, 2, 3, 5, 10 or 15 minutes. */
const MAX_COLUMNS = 150;

interface Column {
  from: number;
  to: number;
  sent: number;
  waiting: number;
  long: number;
  inherited: number;
  activity: ActivityState;
  pause: boolean;
  saleMills: number;
  sales: number;
}

const ACTIVITY_WORDS: Record<ActivityState, string> = {
  input: "работал в расширении",
  open: "расширение открыто, без действий",
  closed: "расширение закрыто",
};

function columnsOf(minutes: readonly PulseMinute[], sales: readonly ReviewSale[], pauses: ReadonlyArray<{ from: number; to: number }>, start: number, end: number): { columns: Column[]; size: number } {
  const span = Math.max(1, Math.ceil((end - start) / MINUTE_MS));
  const size = [1, 2, 3, 5, 10, 15].find((one) => span / one <= MAX_COLUMNS) ?? 15;
  const columns: Column[] = [];
  for (let first = 0; first < minutes.length; first += size) {
    const group = minutes.slice(first, first + size);
    const from = group[0]!.at;
    const to = Math.min(end, from + group.length * MINUTE_MS);
    const counts: Record<ActivityState, number> = { input: 0, open: 0, closed: 0 };
    for (const minute of group) counts[minute.activity] += 1;
    const activity: ActivityState = counts.input >= counts.open && counts.input >= counts.closed && counts.input > 0 ? "input" : counts.open >= counts.closed ? "open" : "closed";
    const paused = pauses.reduce((sum, pause) => sum + Math.max(0, Math.min(to, pause.to) - Math.max(from, pause.from)), 0);
    const inColumn = sales.filter((sale) => sale.at >= from && sale.at < to);
    columns.push({
      from,
      to,
      sent: group.reduce((sum, minute) => sum + minute.sent, 0),
      waiting: Math.max(...group.map((minute) => minute.waiting + minute.waitingOpen)),
      long: Math.max(...group.map((minute) => minute.waitingLong)),
      inherited: Math.max(...group.map((minute) => minute.waitingInherited)),
      activity,
      pause: paused * 2 >= to - from,
      saleMills: inColumn.reduce((sum, sale) => sum + sale.mills, 0),
      sales: inColumn.length,
    });
  }
  return { columns, size };
}

function hourTicks(start: number, end: number, width: number): number[] {
  const hours = (end - start) / 3_600_000;
  const step = hours / Math.max(1, width / 90) > 1 ? 2 : 1;
  const ticks: number[] = [];
  // Moscow is UTC+3 all year: whole hours fall on whole UTC hours.
  for (let at = Math.ceil(start / (step * 3_600_000)) * step * 3_600_000; at <= end; at += step * 3_600_000) ticks.push(at);
  return ticks;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function Readout({ column, ongoing }: { column: Column; ongoing: boolean }) {
  const parts: string[] = [`${formatTimeOfDay(column.from)}–${formatTimeOfDay(column.to)}`];
  if (column.pause) parts.push("пауза");
  parts.push(`${formatCount(column.sent)} ${ruPlural(column.sent, "сообщение", "сообщения", "сообщений")}`);
  if (column.waiting > 0) {
    parts.push(`${ongoing ? "ждут" : "ждали"} ответа ${formatCount(column.waiting)}${column.long > 0 ? `, из них дольше ${REPLY_NORM_SECONDS / 60} мин ${formatCount(column.long)}` : ""}`);
  } else parts.push("никто не ждал");
  if (column.sales > 0) parts.push(`${column.sales === 1 ? "покупка" : "покупки"} ${formatMills(column.saleMills)}`);
  if (!column.pause) parts.push(ACTIVITY_WORDS[column.activity]);
  return <span className="review-pulse__readout">{parts.join(" · ")}</span>;
}

function Legend() {
  return (
    <span className="review-pulse__legend" aria-hidden>
      <span><i className="review-key review-key--sent" />сообщения чаттера</span>
      <span><i className="review-key review-key--wait" />ждут ответа</span>
      <span><i className="review-key review-key--long" />дольше {REPLY_NORM_SECONDS / 60} мин</span>
      <span><i className="review-key review-key--sale" />покупка</span>
      <span><i className="review-key review-key--pause" />пауза</span>
    </span>
  );
}

export function Pulse({ minutes, sales, pauses, start, end, ongoing, span, silences, onSpan }: {
  minutes: readonly PulseMinute[];
  sales: readonly ReviewSale[];
  pauses: ReadonlyArray<{ from: number; to: number }>;
  start: number;
  end: number;
  ongoing: boolean;
  /** The picked span, ms. */
  span: { from: number; to: number } | null;
  silences: readonly Silence[];
  onSpan: (span: { from: number; to: number } | null) => void;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const { columns } = useMemo(() => columnsOf(minutes, sales, pauses, start, end), [minutes, sales, pauses, start, end]);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ anchor: number; at: number } | null>(null);

  const duration = Math.max(MINUTE_MS, end - start);
  const x = (at: number) => ((at - start) / duration) * width;
  const atOf = (px: number) => start + (Math.min(Math.max(px, 0), width) / Math.max(1, width)) * duration;
  const columnAt = (px: number) => {
    const at = atOf(px);
    const index = columns.findIndex((column) => at >= column.from && at < column.to);
    return index < 0 ? columns.length - 1 : index;
  };
  const maxSent = Math.max(4, ...columns.map((column) => column.sent));
  const maxWait = Math.max(3, ...columns.map((column) => column.waiting));
  const ticks = hourTicks(start, end, width);
  const gap = columns.length > 0 && width / columns.length > 5 ? 1.5 : 0.5;

  const pointerX = (event: ReactPointerEvent<SVGRectElement>) => event.clientX - event.currentTarget.getBoundingClientRect().left;
  const finish = (px: number) => {
    if (!drag) return;
    const at = atOf(px);
    const moved = Math.abs(x(at) - x(drag.anchor)) >= 6;
    setDrag(null);
    if (!moved) {
      onSpan({ from: Math.max(start, at - PICK_MINUTES * MINUTE_MS), to: Math.min(end, at + PICK_MINUTES * MINUTE_MS) });
      return;
    }
    onSpan({ from: Math.min(drag.anchor, at), to: Math.max(drag.anchor, at) });
  };

  const shown = drag ? { from: Math.min(drag.anchor, drag.at), to: Math.max(drag.anchor, drag.at) } : span;
  const hovered = hover === null ? null : columns[hover] ?? null;

  return (
    <section className="review-pulse" aria-label="Пульс смены">
      <div className="review-pulse__caption">
        {hovered ? <Readout column={hovered} ongoing={ongoing} /> : <Legend />}
        {!hovered && silences.length === 0 && <span className="review-pulse__hint">Нажмите или протяните по полосе — чаты этого времени</span>}
        {!hovered && silences.length > 0 && (
          <span className="review-pulse__silences">
            Тишина:{" "}
            {silences.map((one, index) => (
              <span key={one.from}>
                {index > 0 && " · "}
                <button
                  type="button"
                  className="review-linkish"
                  title={`Без сообщений ${formatDuration(one.minutes)}${one.pauseMinutes > 0 ? `, из них пауза ${formatDuration(one.pauseMinutes)}` : ""}: показать чаты этого времени`}
                  onClick={() => onSpan({ from: one.from, to: one.to })}
                >
                  {formatTimeOfDay(one.from)}, {formatDuration(one.minutes - one.pauseMinutes)}
                </button>
              </span>
            ))}
          </span>
        )}
      </div>
      <div ref={box} className="review-pulse__plot">
        {width > 0 && (
          <svg width={width} height={PLOT + AXIS} role="img" aria-label="Минуты смены: сообщения чаттера, ждущие ответа фаны, покупки, паузы">
            {pauses.map((pause) => (
              <g key={pause.from}>
                <rect className="review-pulse__pause" x={x(Math.max(start, pause.from))} y={0} width={Math.max(1, x(Math.min(end, pause.to)) - x(Math.max(start, pause.from)))} height={PLOT} rx={3} />
                {x(Math.min(end, pause.to)) - x(Math.max(start, pause.from)) > 56 && (
                  <text className="review-pulse__pause-label" x={(x(Math.max(start, pause.from)) + x(Math.min(end, pause.to))) / 2} y={UP / 2 + 5} textAnchor="middle">пауза</text>
                )}
              </g>
            ))}
            {shown && (
              <rect className="review-pulse__span" x={x(Math.max(start, shown.from))} y={0.5} width={Math.max(2, x(Math.min(end, shown.to)) - x(Math.max(start, shown.from)))} height={PLOT - 1} rx={3} />
            )}
            {columns.map((column, index) => {
              const left = x(column.from) + gap / 2;
              const w = Math.max(1, x(column.to) - x(column.from) - gap);
              const up = column.sent === 0 ? 0 : Math.max(2, (column.sent / maxSent) * (UP - 6));
              const down = column.waiting === 0 ? 0 : Math.max(2, (column.waiting / maxWait) * DOWN);
              const long = column.long === 0 ? 0 : Math.max(2, (column.long / maxWait) * DOWN);
              return (
                <g key={column.from} className={hover === index ? "review-pulse__col is-hover" : "review-pulse__col"}>
                  {up > 0 && <rect className="review-pulse__sent" x={left} y={UP - up} width={w} height={up} rx={1} />}
                  {down > 0 && <rect className="review-pulse__wait" x={left} y={UP + BASE} width={w} height={down} rx={1} />}
                  {long > 0 && <rect className="review-pulse__long" x={left} y={UP + BASE} width={w} height={long} rx={1} />}
                  {column.activity !== "closed" && !column.pause && (
                    <rect className={column.activity === "input" ? "review-pulse__on" : "review-pulse__open"} x={x(column.from)} y={UP} width={Math.max(1, x(column.to) - x(column.from))} height={BASE} />
                  )}
                </g>
              );
            })}
            {sales.map((sale, index) => (
              <circle key={`${sale.at}-${index}`} className="review-pulse__sale" cx={x(sale.at)} cy={4} r={3.5} />
            ))}
            {hover !== null && columns[hover] && (
              <line className="review-pulse__cursor" x1={x((columns[hover].from + columns[hover].to) / 2)} x2={x((columns[hover].from + columns[hover].to) / 2)} y1={0} y2={PLOT} />
            )}
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="review-pulse__tick" x1={x(tick)} x2={x(tick)} y1={PLOT} y2={PLOT + 4} />
                <text className="review-pulse__hour" x={Math.min(Math.max(x(tick), 18), width - 18)} y={PLOT + AXIS - 2} textAnchor="middle">{formatTimeOfDay(tick)}</text>
              </g>
            ))}
            <rect
              className="review-pulse__hit"
              x={0}
              y={0}
              width={width}
              height={PLOT}
              onPointerMove={(event) => {
                const px = pointerX(event);
                setHover(columnAt(px));
                if (drag) setDrag({ ...drag, at: atOf(px) });
              }}
              onPointerLeave={() => setHover(null)}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                const at = atOf(pointerX(event));
                setDrag({ anchor: at, at });
              }}
              onPointerUp={(event) => finish(pointerX(event))}
              onPointerCancel={() => setDrag(null)}
            />
          </svg>
        )}
      </div>
    </section>
  );
}
