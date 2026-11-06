import { useMemo, useState, type ReactNode } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_ANIMATION, ChartLegend, chartGridProps, lineCursor, xAxisProps, yAxisProps } from "@/components/charts/ChartKit";
import { linearTicks } from "@/components/charts/scale";
import { formatCount, formatTimeOfDay } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import {
  PACE_WINDOW_MINUTES,
  PICK_MINUTES,
  REPLY_NORM_SECONDS,
  REPLY_WINDOW_MINUTES,
  activityRuns,
  type ActivityState,
  type PulseMinute,
} from "./shiftReviewView.js";

/**
 * The shift's pulse: three bands on one time axis, each with its own scale —
 * how many messages the chatter sent in the last ten minutes, the median reply
 * of the last half hour, and how many fans waited — over the strip of the
 * extension's minutes. The crosshair runs through all three; the line above
 * says every value at the hovered minute. A click picks ±10 minutes: the chats
 * below narrow to them.
 */

const PACE = "var(--color-chart-blue)";
const REPLY = "var(--color-chart-violet)";
const WAIT = "var(--color-chart-orange)";
const SYNC = "shift-pulse";
const MINUTE_MS = 60_000;
/** One width for every band's value axis, so the three plots line up with the strip. */
const AXIS_WIDTH = 44;
const MARGIN = { top: 6, right: 12, left: 0, bottom: 0 } as const;

const ACTIVITY_WORDS: Record<ActivityState, string> = {
  input: "работал в расширении",
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

function minutesText(value: number): string {
  if (value < 1) return `${Math.round(value * 60)} с`;
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} мин`;
}

function Readout({ minute, average }: { minute: PulseMinute | null; average: number }) {
  if (minute === null) {
    return (
      <p className="sr-readout sr-readout-hint">
        Наведите на график: темп, ответ и кто ждал в каждую минуту. Клик выбирает ±{PICK_MINUTES} минут — чаты ниже покажут только их.
        {" "}В среднем за смену — {average.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} сообщ. за {PACE_WINDOW_MINUTES} мин.
      </p>
    );
  }
  return (
    <dl className="sr-readout">
      <div><dt>Время</dt><dd className="font-medium">{formatTimeOfDay(minute.at)}</dd></div>
      <div><dt><span className="sr-key" style={{ background: PACE }} />За {PACE_WINDOW_MINUTES} мин</dt><dd>{formatCount(minute.pace)} {ruPlural(minute.pace, "сообщение", "сообщения", "сообщений")}</dd></div>
      <div>
        <dt><span className="sr-key" style={{ background: REPLY }} />Ответ, медиана за {REPLY_WINDOW_MINUTES} мин</dt>
        <dd>{minute.replyMedian === null ? "ответов не было" : `${minutesText(minute.replyMedian)} · ${formatCount(minute.replies)} ${ruPlural(minute.replies, "ответ", "ответа", "ответов")}`}</dd>
      </div>
      <div>
        <dt><span className="sr-key" style={{ background: WAIT }} />Ждут ответа</dt>
        <dd>
          {formatCount(minute.waiting)} получат ответ, {formatCount(minute.waitingOpen)} без ответа до конца
          {minute.waitingLong > 0 && <> · дольше {REPLY_NORM_SECONDS / 60} мин — {formatCount(minute.waitingLong)}</>}
          {minute.waitingInherited > 0 && <span className="team-faint"> · ещё {formatCount(minute.waitingInherited)} с прошлых смен</span>}
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
      <div className="sr-strip" style={{ marginRight: MARGIN.right }} role="img" aria-label="Активность в расширении по минутам">
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
  picked: number | null;
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
          margin={MARGIN}
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
            tickFormatter={(value: number) => formatTimeOfDay(value)}
            hide={!last}
            height={last ? 24 : 0}
          />
          <YAxis
            {...yAxisProps}
            width={AXIS_WIDTH}
            domain={axis.domain}
            ticks={axis.ticks}
            allowDataOverflow
            tickFormatter={axis.format}
          />
          {pauses.map((pause) => (
            <ReferenceArea key={pause.from} x1={pause.from} x2={pause.to} fill="var(--color-track)" fillOpacity={0.9} ifOverflow="hidden" />
          ))}
          {picked !== null && (
            <ReferenceArea
              x1={Math.max(start, picked - PICK_MINUTES * MINUTE_MS)}
              x2={Math.min(end, picked + PICK_MINUTES * MINUTE_MS)}
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

export function ShiftPulse({ pulse, start, end, pauses, picked, onPick }: {
  pulse: readonly PulseMinute[];
  start: number;
  end: number;
  pauses: ReadonlyArray<{ from: number; to: number }>;
  picked: number | null;
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
    return linearTicks(0, Math.min(60, Math.max(REPLY_NORM_SECONDS / 60 + 2, high)), { integer: true, target: 3 });
  }, [pulse]);
  const waitAxis = useMemo(() => linearTicks(0, Math.max(3, ...pulse.map((minute) => minute.waiting + minute.waitingOpen)), { integer: true, target: 3 }), [pulse]);
  const shared = { pulse, start, end, pauses, picked, onHover: setHovered, onPick };
  const dataMinute = hovered === null ? null : pulse[hovered] ?? null;

  return (
    <div className="sr-pulse">
      <Readout minute={dataMinute} average={average} />
      <Band {...shared} height={132} label={`Темп: сообщений за последние ${PACE_WINDOW_MINUTES} минут`} axis={paceAxis}>
        <ReferenceLine y={average} stroke="var(--color-chart-compare)" strokeDasharray="4 4" ifOverflow="extendDomain" />
        <Area type="monotone" dataKey="pace" stroke={PACE} strokeWidth={2} fill={PACE} fillOpacity={0.14} dot={false} activeDot={false} {...CHART_ANIMATION} />
      </Band>
      <ActivityStrip pulse={pulse} start={start} end={end} />
      <Band {...shared} height={96} label={`Ответ фану: медиана за последние ${REPLY_WINDOW_MINUTES} минут, мин`} axis={replyAxis}>
        <ReferenceLine y={REPLY_NORM_SECONDS / 60} stroke="var(--color-chart-compare)" strokeDasharray="4 4" />
        <Line type="monotone" dataKey="replyMedian" stroke={REPLY} strokeWidth={2} dot={false} activeDot={false} connectNulls={false} {...CHART_ANIMATION} />
      </Band>
      <Band
        {...shared}
        height={112}
        label="Ждут ответа, фанов"
        axis={waitAxis}
        last
        legend={<ChartLegend series={[
          { key: "waiting", label: "Потом получили ответ", color: WAIT, fillOpacity: 0.8 },
          { key: "waitingOpen", label: "Без ответа до конца смены", color: WAIT, fillOpacity: 0.25 },
        ]} />}
      >
        <Area type="stepAfter" dataKey="waiting" stackId="wait" stroke={WAIT} strokeWidth={1.5} fill={WAIT} fillOpacity={0.5} dot={false} activeDot={false} {...CHART_ANIMATION} />
        <Area type="stepAfter" dataKey="waitingOpen" stackId="wait" stroke="none" fill={WAIT} fillOpacity={0.16} dot={false} activeDot={false} {...CHART_ANIMATION} />
      </Band>
      <p className="sr-foot">
        Пунктир на темпе — среднее за смену, на ответе — норма {REPLY_NORM_SECONDS / 60} минут. Серые полосы — паузы смены.
        {" "}Полоса «актив.»: тёмная — действия в расширении, светлая — открыто без действий, пусто — закрыто.
      </p>
    </div>
  );
}
