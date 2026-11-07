import { useMemo, useState, type ReactNode } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_ANIMATION, ChartLegend, chartGridProps, lineCursor, xAxisProps, yAxisProps } from "@/components/charts/ChartKit";
import { linearTicks } from "@/components/charts/scale";
import { formatCount, formatTimeOfDay } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import {
  PACE_WINDOW_MINUTES,
  PICK_MINUTES,
  REPLY_FAST_SECONDS,
  REPLY_NORM_SECONDS,
  REPLY_WINDOW_MINUTES,
  activityRuns,
  waitText,
  type ActivityState,
  type PulseMinute,
} from "./shiftReviewView.js";

/**
 * The shift's pulse: three bands on one time axis, each with its own scale —
 * how many messages the chatter sent in the last ten minutes, the median reply
 * of the last half hour, and how many of the chatter's fans waited — over the
 * strip of the extension's minutes. The crosshair runs through all three; the
 * line above says every value at the hovered minute and keeps its height, so
 * the bands do not move under the cursor. A click picks ±10 minutes: the chats
 * narrow to them. The reply band carries the norm as a band, 5–10 minutes.
 */

const PACE = "var(--color-chart-blue)";
const REPLY = "var(--color-chart-violet)";
const WAIT = "var(--color-chart-orange)";
const SYNC = "shift-pulse";
/** One width for every band's value axis, so the three plots line up with the strip. */
const AXIS_WIDTH = 44;
/** Room on the right for the last hour's label. */
const MARGIN = { top: 6, right: 20, left: 0, bottom: 0 } as const;
const ANSWERED_FILL = 0.28;
const OPEN_FILL = 0.75;

const ACTIVITY_WORDS: Record<ActivityState, string> = {
  input: "действия в расширении",
  open: "расширение открыто, без действий",
  closed: "расширение закрыто",
};

/** recharts 3 gives the hovered row's index as a string. */
function indexOf(value: unknown): number | null {
  const index = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : Number.NaN;
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function hourTicks(start: number, end: number): number[] {
  const hours = (end - start) / 3_600_000;
  const step = hours > 10 ? 2 : 1;
  const first = Math.ceil(start / (step * 3_600_000)) * step * 3_600_000;
  const ticks: number[] = [];
  for (let at = first; at <= end; at += step * 3_600_000) ticks.push(at);
  return ticks;
}

function Readout({ minute, average, ongoing }: { minute: PulseMinute | null; average: number; ongoing: boolean }) {
  if (minute === null) {
    return (
      <div className="sr-readout sr-readout-hint">
        <p>Наведите — цифры минуты; клик — чаты ±{PICK_MINUTES} минут вокруг.</p>
        <p className="team-faint">В среднем за смену {average.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} сообщ. за {PACE_WINDOW_MINUTES} мин, паузы входят.</p>
      </div>
    );
  }
  return (
    <dl className="sr-readout" aria-live="polite">
      <div><dt>Время</dt><dd className="font-medium">{formatTimeOfDay(minute.at)}</dd></div>
      <div><dt><span className="sr-key" style={{ background: PACE }} />За {PACE_WINDOW_MINUTES} мин</dt><dd>{formatCount(minute.pace)} {ruPlural(minute.pace, "сообщение", "сообщения", "сообщений")}</dd></div>
      <div>
        <dt><span className="sr-key" style={{ background: REPLY }} />Ответ, медиана {REPLY_WINDOW_MINUTES} мин</dt>
        <dd>{minute.replyMedianSeconds === null ? "ответов не было" : `${waitText(minute.replyMedianSeconds)} · ${formatCount(minute.replies)} ${ruPlural(minute.replies, "ответ", "ответа", "ответов")}`}</dd>
      </div>
      <div>
        <dt><span className="sr-key" style={{ background: WAIT }} />Ждали ответа</dt>
        <dd>
          {formatCount(minute.waitingOpen)} {ongoing ? "пока без ответа" : "без ответа до конца"}, {formatCount(minute.waiting)} — ответ потом был
          {minute.waitingLong > 0 && <> · дольше {REPLY_NORM_SECONDS / 60} мин — {formatCount(minute.waitingLong)}</>}
          {minute.waitingInherited > 0 && <span className="team-faint"> · ещё {formatCount(minute.waitingInherited)} с прошлых смен, в смену не писали</span>}
        </dd>
      </div>
      <div><dt>Расширение</dt><dd>{ACTIVITY_WORDS[minute.activity]}</dd></div>
    </dl>
  );
}

function ActivityStrip({ pulse, start, end }: { pulse: readonly PulseMinute[]; start: number; end: number }) {
  const runs = useMemo(() => activityRuns(pulse), [pulse]);
  const span = Math.max(1, end - start);
  return (
    <div className="sr-strip-row">
      <span className="sr-strip-label" style={{ width: AXIS_WIDTH }}>актив.</span>
      <div className="sr-strip" style={{ marginRight: MARGIN.right }} role="img" aria-label="Работа в расширении по минутам: плотное — действия, бледное — открыто без действий, пусто — закрыто">
        {runs.map((run) => (
          <span
            key={run.from}
            className={`sr-strip-run sr-strip-${run.state}`}
            style={{ left: `${((run.from - start) / span) * 100}%`, width: `${((run.to - run.from) / span) * 100}%` }}
            title={`${formatTimeOfDay(run.from)}–${formatTimeOfDay(run.to)}: ${ACTIVITY_WORDS[run.state]}`}
          />
        ))}
      </div>
    </div>
  );
}

interface BandProps {
  pulse: readonly PulseMinute[];
  start: number;
  end: number;
  pauses: ReadonlyArray<{ from: number; to: number }>;
  picked: { from: number; to: number } | null;
  onHover: (index: number | null) => void;
  onPick: (at: number) => void;
}

/** What every band shares: the time axis, the pauses, the pick, the hover. */
function Band({ height, label, legend, axis, children, pulse, start, end, pauses, picked, onHover, onPick, last }: BandProps & {
  height: number;
  label: string;
  legend?: ReactNode;
  axis: { domain: [number, number]; ticks: number[]; format?: (value: number) => string };
  children: ReactNode;
  last?: boolean;
}) {
  const ticks = useMemo(() => hourTicks(start, end), [start, end]);
  return (
    <div className="sr-band">
      <div className="sr-band-head"><p className="sr-band-label">{label}</p>{legend}</div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart
          data={pulse as PulseMinute[]}
          syncId={SYNC}
          margin={last ? MARGIN : { ...MARGIN, bottom: 8 }}
          accessibilityLayer={false}
          onMouseMove={(state) => onHover(indexOf(state?.activeTooltipIndex))}
          onMouseLeave={() => onHover(null)}
          onClick={(state) => {
            const index = indexOf(state?.activeTooltipIndex);
            const minute = index === null ? undefined : pulse[index];
            if (minute) onPick(minute.at);
          }}
          style={{ cursor: "crosshair" }}
        >
          <CartesianGrid {...chartGridProps} />
          <XAxis
            {...xAxisProps}
            dataKey="at"
            type="number"
            scale="time"
            domain={[start, end]}
            ticks={ticks}
            interval={0}
            tickFormatter={(value: number) => formatTimeOfDay(value)}
            hide={!last}
            height={last ? 24 : 0}
          />
          <YAxis
            {...yAxisProps}
            width={AXIS_WIDTH}
            domain={axis.domain}
            ticks={axis.ticks}
            interval={0}
            allowDataOverflow
            tickFormatter={axis.format}
          />
          {pauses.map((pause) => (
            <ReferenceArea key={pause.from} x1={pause.from} x2={pause.to} fill="var(--color-track)" fillOpacity={0.9} ifOverflow="hidden" />
          ))}
          {picked !== null && (
            <ReferenceArea
              x1={Math.max(start, picked.from)}
              x2={Math.min(end, picked.to)}
              fill="var(--color-accent-soft)"
              fillOpacity={0.9}
              stroke="var(--color-accent-border)"
              ifOverflow="hidden"
            />
          )}
          <Tooltip content={() => null} cursor={lineCursor} isAnimationActive={false} />
          {children}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ShiftPulse({ pulse, start, end, pauses, picked, ongoing, onPick }: {
  pulse: readonly PulseMinute[];
  start: number;
  end: number;
  pauses: ReadonlyArray<{ from: number; to: number }>;
  picked: { from: number; to: number } | null;
  ongoing: boolean;
  onPick: (at: number) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const average = useMemo(() => {
    const sent = pulse.reduce((sum, minute) => sum + minute.sent, 0);
    return pulse.length === 0 ? 0 : (sent * PACE_WINDOW_MINUTES) / pulse.length;
  }, [pulse]);
  const paceAxis = useMemo(() => linearTicks(0, Math.max(4, ...pulse.map((minute) => minute.pace)), { integer: true, target: 3 }), [pulse]);
  const replyAxis = useMemo(() => {
    const values = pulse.flatMap((minute) => (minute.replyMedian === null ? [] : [minute.replyMedian])).sort((a, b) => a - b);
    const high = values[Math.floor(values.length * 0.97)] ?? 0;
    const top = Math.min(60, Math.max(REPLY_NORM_SECONDS / 60 + 5, high));
    // The norm's edges are on the axis when they fit; past 20 minutes the band's own label says them.
    const axis = linearTicks(0, top, { integer: true, target: 3 });
    return axis.domain[1] <= 20 ? { ...axis, ticks: [...new Set([0, REPLY_FAST_SECONDS / 60, REPLY_NORM_SECONDS / 60, axis.domain[1]])] } : axis;
  }, [pulse]);
  const waitAxis = useMemo(() => linearTicks(0, Math.max(3, ...pulse.map((minute) => minute.waiting + minute.waitingOpen)), { integer: true, target: 3 }), [pulse]);
  const shared = { pulse, start, end, pauses, picked, onHover: setHovered, onPick };
  const dataMinute = hovered === null ? null : pulse[hovered] ?? null;
  const openWords = ongoing ? "Пока без ответа" : "Без ответа до конца смены";

  return (
    <div className="sr-pulse">
      <Readout minute={dataMinute} average={average} ongoing={ongoing} />
      <Band {...shared} height={100} label={`Темп: сообщений за последние ${PACE_WINDOW_MINUTES} минут`} axis={paceAxis}>
        <ReferenceLine y={average} stroke="var(--color-chart-compare)" strokeDasharray="4 4" ifOverflow="extendDomain" />
        <Area type="monotone" dataKey="pace" stroke={PACE} strokeWidth={2} fill={PACE} fillOpacity={0.14} dot={false} activeDot={false} {...CHART_ANIMATION} />
      </Band>
      <ActivityStrip pulse={pulse} start={start} end={end} />
      <Band {...shared} height={92} label={`Ответ фану: медиана за последние ${REPLY_WINDOW_MINUTES} минут, мин`} axis={replyAxis}>
        <ReferenceArea
          y1={REPLY_FAST_SECONDS / 60}
          y2={REPLY_NORM_SECONDS / 60}
          fill="var(--color-chart-compare)"
          fillOpacity={0.14}
          stroke="none"
          ifOverflow="hidden"
          label={{ value: `норма ${REPLY_FAST_SECONDS / 60}–${REPLY_NORM_SECONDS / 60} мин`, position: "insideLeft", fontSize: 11, fill: "var(--color-text-muted)" }}
        />
        <Line type="monotone" dataKey="replyMedian" stroke={REPLY} strokeWidth={2} dot={false} activeDot={false} connectNulls={false} {...CHART_ANIMATION} />
      </Band>
      <Band
        {...shared}
        height={92}
        label="Фаны чаттера, ждавшие ответа"
        axis={waitAxis}
        last
        legend={<ChartLegend series={[
          { key: "waitingOpen", label: openWords, color: WAIT, fillOpacity: OPEN_FILL },
          { key: "waiting", label: "Ответ потом был", color: WAIT, fillOpacity: ANSWERED_FILL },
        ]} />}
      >
        <Area type="stepAfter" dataKey="waitingOpen" stackId="wait" stroke={WAIT} strokeWidth={1.5} fill={WAIT} fillOpacity={OPEN_FILL} dot={false} activeDot={false} {...CHART_ANIMATION} />
        <Area type="stepAfter" dataKey="waiting" stackId="wait" stroke={WAIT} strokeWidth={1} strokeOpacity={0.6} fill={WAIT} fillOpacity={ANSWERED_FILL} dot={false} activeDot={false} {...CHART_ANIMATION} />
      </Band>
      <p className="sr-foot">
        Пунктир на темпе — среднее за смену; серое — паузы; «актив.»: плотное — действия в расширении, бледное — открыто без действий.
        {" "}Ожидания, которые были у коллег, сюда не входят.
      </p>
    </div>
  );
}
