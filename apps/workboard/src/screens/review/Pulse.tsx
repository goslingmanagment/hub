import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { formatCount, formatMills, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { PACE_WINDOW_MINUTES, PICK_MINUTES, REPLY_FAST_SECONDS, REPLY_NORM_SECONDS, REPLY_WINDOW_MINUTES, activityRuns, waitText } from "@agency_hub_core/ui/shiftReview";
import type { PulseMinute, ReviewSale } from "./data.js";

/**
 * The shift's pulse (spec §4.2): three tracks on one time axis, as the
 * console's pulse the owner liked — the pace (the chatter's messages of the
 * last 10 minutes, the dashed line its shift average), the median reply of the
 * last 30 minutes over the 5–10 minute norm, and the chatter's fans waiting
 * (dense: no answer before the end; pale: answered later). A thin strip under
 * the pace is the extension (solid: acting in it; faint: only open). Grey bands
 * through all three are pauses; green dots are money. The minute under the
 * pointer is read in one line over the tracks, right of the pace's name; the
 * line keeps its height. A click
 * picks ±10 minutes, a drag a span: the chats below narrow to it.
 */

const MINUTE_MS = 60_000;
const MOSCOW_MS = 3 * 3_600_000;
const PACE_H = 76;
const STRIP_TOP = PACE_H + 5;
const STRIP_H = 2;
/** Room above a track for its name. */
const LABEL = 22;
const REPLY_TOP = STRIP_TOP + STRIP_H + LABEL;
const REPLY_H = 56;
const WAIT_TOP = REPLY_TOP + REPLY_H + LABEL;
const WAIT_H = 52;
const PLOT = WAIT_TOP + WAIT_H;
const AXIS = 22;
/** The value scale's gutter on the left, as the console's pulse had (each track's top, the reply norm's edge; zero is the base line). */
const GUTTER = 30;
/** A sale within this many px of the pointer is read with its minute. */
const SALE_NEAR_PX = 5;

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

function hourTicks(start: number, end: number, width: number): number[] {
  const hours = (end - start) / 3_600_000;
  const step = width / Math.max(1, hours) < 130 ? 2 : 1;
  const ticks: number[] = [];
  // Moscow is UTC+3 all year: every second hour is an even Moscow hour.
  const size = step * 3_600_000;
  for (let at = Math.ceil((start + MOSCOW_MS) / size) * size - MOSCOW_MS; at <= end; at += size) ticks.push(at);
  return ticks;
}

/** A round top for a track's scale: 4, 5, 6, 8, 10, 12, 15, 20, 25, 30… */
function niceTop(value: number): number {
  for (const top of [4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100]) if (value <= top) return top;
  return Math.ceil(value / 50) * 50;
}

/** The pace's name on the left; the hovered minute's values on the right, in a row that keeps its height. */
function Head({ minute, paused, sale, ongoing }: { minute: PulseMinute | null; paused: boolean; sale: number; ongoing: boolean }) {
  const openWords = ongoing ? "пока без ответа" : "без ответа";
  const parts: ReactNode[] = [];
  if (minute !== null) {
    const waited = minute.waiting + minute.waitingOpen;
    parts.push(
      <strong key="at">{formatTimeOfDay(minute.at)}</strong>,
      <span key="pace"><i className="review-key review-key--pace" />темп {formatCount(minute.pace)}</span>,
      <span key="reply"><i className="review-key review-key--reply" />{minute.replyMedianSeconds === null ? "ответов нет" : `ответ ${waitText(minute.replyMedianSeconds)}`}</span>,
      <span key="wait">
        <i className="review-key review-key--wait" />
        <span>
          {waited === 0 ? "никто не ждал" : `ждали ${formatCount(waited)}`}
          {minute.waitingOpen > 0 && <span className="review-pulse__warm">, {openWords} {formatCount(minute.waitingOpen)}</span>}
        </span>
      </span>,
    );
    if (sale > 0) parts.push(<span key="sale"><i className="review-key review-key--sale" />{formatMills(sale)}</span>);
    const state = paused ? "пауза" : minute.activity === "input" ? null : minute.activity === "open" ? "расширение открыто" : "расширение закрыто";
    if (state) parts.push(<span key="state" className="review-pulse__quiet">{state}</span>);
  }
  return (
    <div className="review-pulse__head">
      <span className="review-pulse__name">Темп</span>
      <p className="review-pulse__readout" aria-live="polite">{parts}</p>
    </div>
  );
}

export function Pulse({ minutes, sales, pauses, start, end, ongoing, span, onSpan }: {
  minutes: readonly PulseMinute[];
  sales: readonly ReviewSale[];
  pauses: ReadonlyArray<{ from: number; to: number }>;
  start: number;
  end: number;
  ongoing: boolean;
  /** The picked span, ms. */
  span: { from: number; to: number } | null;
  onSpan: (span: { from: number; to: number } | null) => void;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ anchor: number; at: number } | null>(null);

  const duration = Math.max(MINUTE_MS, end - start);
  const plotWidth = Math.max(1, width - GUTTER);
  const x = (at: number) => GUTTER + ((at - start) / duration) * plotWidth;
  const atOf = (px: number) => start + (Math.min(Math.max(px - GUTTER, 0), plotWidth) / plotWidth) * duration;

  const scales = useMemo(() => {
    const pace = niceTop(Math.max(4, ...minutes.map((minute) => minute.pace)));
    const replies = minutes.flatMap((minute) => (minute.replyMedian === null ? [] : [minute.replyMedian])).sort((a, b) => a - b);
    const high = replies[Math.floor(replies.length * 0.97)] ?? 0;
    const reply = niceTop(Math.min(60, Math.max(REPLY_NORM_SECONDS / 60 + 5, high)));
    const wait = niceTop(Math.max(3, ...minutes.map((minute) => minute.waiting + minute.waitingOpen)));
    const sent = minutes.reduce((sum, minute) => sum + minute.sent, 0);
    const average = minutes.length === 0 ? 0 : (sent * PACE_WINDOW_MINUTES) / minutes.length;
    return { pace, reply, wait, average };
  }, [minutes]);
  const runs = useMemo(() => activityRuns(minutes), [minutes]);

  const yPace = (value: number) => PACE_H - (Math.min(value, scales.pace) / scales.pace) * (PACE_H - 8);
  const yReply = (value: number) => REPLY_TOP + REPLY_H - (Math.min(value, scales.reply) / scales.reply) * REPLY_H;
  const yWait = (value: number) => WAIT_TOP + WAIT_H - (Math.min(value, scales.wait) / scales.wait) * WAIT_H;

  const paths = useMemo(() => {
    if (width === 0 || minutes.length === 0) return null;
    const mid = (minute: PulseMinute) => x(minute.at + MINUTE_MS / 2).toFixed(1);
    const pace = minutes.map((minute, index) => `${index === 0 ? "M" : "L"}${mid(minute)},${yPace(minute.pace).toFixed(1)}`).join("");
    const first = mid(minutes[0]!);
    const last = mid(minutes.at(-1)!);
    const paceArea = `${pace}L${last},${PACE_H}L${first},${PACE_H}Z`;
    let reply = "";
    let open = false;
    for (const minute of minutes) {
      if (minute.replyMedian === null) {
        open = false;
        continue;
      }
      reply += `${open ? "L" : "M"}${mid(minute)},${yReply(minute.replyMedian).toFixed(1)}`;
      open = true;
    }
    const step = (value: (minute: PulseMinute) => number) => {
      let path = `M${x(minutes[0]!.at).toFixed(1)},${WAIT_TOP + WAIT_H}`;
      for (const minute of minutes) {
        const y = yWait(value(minute)).toFixed(1);
        path += `L${x(minute.at).toFixed(1)},${y}L${x(Math.min(end, minute.at + MINUTE_MS)).toFixed(1)},${y}`;
      }
      return `${path}L${x(Math.min(end, minutes.at(-1)!.at + MINUTE_MS)).toFixed(1)},${WAIT_TOP + WAIT_H}Z`;
    };
    return { pace, paceArea, reply, waitAll: step((minute) => minute.waiting + minute.waitingOpen), waitOpen: step((minute) => minute.waitingOpen) };
    // x and the y scales follow width, start, end and the scales.
  }, [minutes, width, start, end, scales]);

  const indexAt = (px: number) => Math.min(minutes.length - 1, Math.max(0, Math.floor((atOf(px) - minutes[0]!.at) / MINUTE_MS)));
  const pointerX = (event: ReactPointerEvent<SVGRectElement>) => event.clientX - (event.currentTarget.ownerSVGElement ?? event.currentTarget).getBoundingClientRect().left;
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
  const minute = hover === null ? null : minutes[hover] ?? null;
  const cursor = minute === null ? null : x(minute.at + MINUTE_MS / 2);
  const paused = minute !== null && pauses.some((pause) => minute.at + MINUTE_MS / 2 >= pause.from && minute.at + MINUTE_MS / 2 < pause.to);
  const sale = cursor === null ? 0 : sales.filter((one) => Math.abs(x(one.at) - cursor) <= SALE_NEAR_PX).reduce((sum, one) => sum + one.mills, 0);
  const ticks = hourTicks(start, end, width);
  const norm = { top: yReply(REPLY_NORM_SECONDS / 60), bottom: yReply(REPLY_FAST_SECONDS / 60) };

  return (
    <section className="review-pulse" aria-label="Пульс смены">
      <Head minute={drag ? null : minute} paused={paused} sale={sale} ongoing={ongoing} />
      <div ref={box} className="review-pulse__plot" style={{ height: PLOT + AXIS }}>
        {width > 0 && paths && (
          <svg width={width} height={PLOT + AXIS} role="img" aria-label="Пульс смены: темп сообщений, ответ фанам, ждавшие ответа фаны, паузы">
            {pauses.map((pause) => (
              <rect key={pause.from} className="review-pulse__pause" x={x(Math.max(start, pause.from))} y={0} width={Math.max(1, x(Math.min(end, pause.to)) - x(Math.max(start, pause.from)))} height={PLOT} />
            ))}
            {shown && (
              <rect className="review-pulse__span" x={x(Math.max(start, shown.from))} y={0} width={Math.max(2, x(Math.min(end, shown.to)) - x(Math.max(start, shown.from)))} height={PLOT} rx={2} />
            )}

            {/* Темп */}
            <line className="review-pulse__base" x1={GUTTER} x2={width} y1={PACE_H + 0.5} y2={PACE_H + 0.5} />
            <path className="review-pulse__pace-area" d={paths.paceArea} />
            <path className="review-pulse__pace" d={paths.pace} />
            <line className="review-pulse__average" x1={GUTTER} x2={width} y1={yPace(scales.average)} y2={yPace(scales.average)} />
            {runs.map((run) => (run.state === "closed" ? null : (
              <rect key={run.from} className={run.state === "input" ? "review-pulse__on" : "review-pulse__open"} x={x(run.from)} y={STRIP_TOP} width={Math.max(1, x(Math.min(end, run.to)) - x(run.from))} height={STRIP_H} />
            )))}
            {sales.map((one, index) => <circle key={`${one.at}-${index}`} className="review-pulse__sale" cx={x(one.at)} cy={3} r={2.75} />)}

            {/* Ответ, медиана: the norm's band 5–10 min under the line */}
            <rect className="review-pulse__norm" x={GUTTER} y={norm.top} width={plotWidth} height={Math.max(0, norm.bottom - norm.top)} />
            <line className="review-pulse__base" x1={GUTTER} x2={width} y1={REPLY_TOP + REPLY_H + 0.5} y2={REPLY_TOP + REPLY_H + 0.5} />
            <path className="review-pulse__reply" d={paths.reply} />

            {/* Ждали ответа: the queue answered later (pale) and left without an answer (dense) */}
            <path className="review-pulse__wait" d={paths.waitAll} />
            <path className="review-pulse__wait-open" d={paths.waitOpen} />
            <line className="review-pulse__axis" x1={GUTTER} x2={width} y1={PLOT + 0.5} y2={PLOT + 0.5} />

            <text className="review-pulse__label" x={0} y={REPLY_TOP - 8}>Ответ, медиана {REPLY_WINDOW_MINUTES} мин</text>
            <text className="review-pulse__label review-pulse__label--end" x={width} y={REPLY_TOP - 8} textAnchor="end">норма {REPLY_FAST_SECONDS / 60}–{REPLY_NORM_SECONDS / 60} мин</text>
            <text className="review-pulse__label" x={0} y={WAIT_TOP - 8}>Ждали ответа</text>

            {/* The value scales, quiet, in the gutter: the top of each track, the reply's norm edges. */}
            {[
              { y: yPace(scales.pace), value: scales.pace },
              { y: yReply(scales.reply), value: scales.reply },
              ...(scales.reply > REPLY_NORM_SECONDS / 60 + 2 ? [{ y: yReply(REPLY_NORM_SECONDS / 60), value: REPLY_NORM_SECONDS / 60 }] : []),
              { y: yWait(scales.wait), value: scales.wait },
            ].map((tick) => (
              <text key={`${tick.y}`} className="review-pulse__tick" x={GUTTER - 8} y={tick.y + 4} textAnchor="end">{tick.value}</text>
            ))}
            {[yPace(scales.pace), yReply(scales.reply), yWait(scales.wait)].map((y) => (
              <line key={`g${y}`} className="review-pulse__grid" x1={GUTTER} x2={width} y1={y + 0.5} y2={y + 0.5} />
            ))}

            {cursor !== null && minute !== null && !drag && (
              <g className="review-pulse__cursor">
                <line x1={cursor} x2={cursor} y1={0} y2={PLOT} />
                <circle className="review-pulse__dot review-pulse__dot--pace" cx={cursor} cy={yPace(minute.pace)} r={3} />
                {minute.replyMedian !== null && <circle className="review-pulse__dot review-pulse__dot--reply" cx={cursor} cy={yReply(minute.replyMedian)} r={3} />}
              </g>
            )}

            {ticks.map((tick) => (
              <text key={tick} className="review-pulse__hour" x={Math.min(Math.max(x(tick), GUTTER + 16), width - 16)} y={PLOT + 17} textAnchor="middle">{formatTimeOfDay(tick)}</text>
            ))}
            <rect
              className="review-pulse__hit"
              x={GUTTER}
              y={0}
              width={plotWidth}
              height={PLOT}
              onPointerMove={(event) => {
                const px = pointerX(event);
                setHover(indexAt(px));
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
