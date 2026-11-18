import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { DayLine } from "./DayLine.js";
import type { DaySlot } from "./trafficDays.js";

export interface WeeksChartWeek {
  /** «3–9 нояб.». */
  label: string;
  /** «12 фанов». */
  text: string;
  /** «2 дня без чтения», quiet under the dates. */
  note?: string | null;
  running: boolean;
}

/**
 * Several weeks of a day line with each week's sum under it: the page of one source (the page of one link draws
 * the same parts in its own file). The plot draws the weeks and today's band; a narrow sheet scrolls it sideways,
 * opening on the latest weeks.
 */
export function WeeksChart({ slots, values, hints, max, weeks, title, format }: {
  slots: readonly DaySlot[];
  values: ReadonlyArray<number | null>;
  hints: ReadonlyArray<string | null>;
  max: number;
  weeks: readonly WeeksChartWeek[];
  title: string;
  format?: (value: number) => string;
}) {
  const todayIndex = slots.findIndex((slot) => slot.when === "today");
  const style = { "--ts-slots": slots.length, "--ts-today": todayIndex } as CSSProperties;
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && box.scrollWidth > box.clientWidth) box.scrollLeft = box.scrollWidth;
  }, []);
  return (
    <div className="tl-chart-scroll" ref={scroller}>
      <div className="tl-chart" style={style}>
        <div className="ts-plot">
          <DayLine values={values} slots={slots} max={max} size="page" labels="weekPeak" area hints={hints} title={title} {...(format ? { format } : {})} />
        </div>
        <div className="ts-plot tl-weeks">
          {weeks.map((week) => (
            <div key={week.label} className={week.running ? "tl-week tl-week-running" : "tl-week"}>
              <span className="tl-week-sum">{week.text}</span>
              <span className="tl-week-dates">{week.label}{week.running ? ", идёт" : ""}</span>
              {week.note && <span className="tl-week-note">{week.note}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
