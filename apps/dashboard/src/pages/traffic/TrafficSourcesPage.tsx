import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { useOfLinkChannels } from "@/api/ofLinks";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import { formatMills } from "@/lib/format";
import { SLOT_COUNT, sourcesRange, sourcesView, type DaySlot, type SourceRow, type SourceView } from "./sourcesView";

/**
 * Трафик → Источники: for each source of the OnlyFans pages, which of its
 * links brought fans and on which day, over this week and the last. Two local
 * reads of the link series (`ofLinksChannelsGet`): no request reaches
 * OnlyFans. What is drawn comes from sourcesView.ts; this file only draws it.
 */
export function TrafficSourcesPage() {
  const today = moscowToday();
  const range = sourcesRange(today);
  const recent = useOfLinkChannels({ ...range, days: true });
  const allTime = useOfLinkChannels({});
  const [refreshing, setRefreshing] = useState(false);

  if (!recent.data) {
    return recent.isError ? <NoAnswerPanel retry={recent.refetch} /> : <TableSkeleton rows={8} columns={3} />;
  }
  const view = sourcesView(recent.data, allTime.data, today);
  const todayIndex = view.slots.findIndex((slot) => slot.when === "today");
  const plotStyle = { "--ts-today": todayIndex } as CSSProperties;

  return (
    <div className="ts-screen">
      <PageHeader
        fresh={{
          at: view.dataAt ?? recent.data.generatedAt,
          refreshing,
          onRefresh: () => {
            setRefreshing(true);
            void Promise.all([recent.refetch(), allTime.refetch()]).finally(() => setRefreshing(false));
          },
        }}
      />
      <QueryNotice error={recent.isError || allTime.isError} stale retry={() => Promise.all([recent.refetch(), allTime.refetch()])} at={recent.dataUpdatedAt} />
      <div className="ts-sheet card" style={plotStyle}>
        <div className="ts-scroll">
          <div className="ts-grid ts-top">
            <span className="ts-top-label">Новых фанов в день</span>
            <div className="ts-weeks">
              <span><b>Прошлая неделя</b> {view.lastWeek}</span>
              <span><b>Эта неделя</b> {view.thisWeek}</span>
            </div>
            <span className="ts-total ts-top-label">за 2 нед.</span>
          </div>
        </div>
        {view.sources.length === 0 && <StatusPanel title="Источников пока нет" />}
        {view.sources.map((source) => <Source key={source.key} source={source} slots={view.slots} />)}
        {(view.unbound || view.idle.length > 0) && (
          <div className="ts-rest">
            {view.unbound && (
              <p className="ts-rest-line"><span className="ts-rest-label">Без источника</span><span>{view.unbound}</span></p>
            )}
            {view.idle.length > 0 && (
              <p className="ts-rest-line"><span className="ts-rest-label">Без движения</span><span>{view.idle.join(" · ")}</span></p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Source({ source, slots }: { source: SourceView; slots: readonly DaySlot[] }) {
  // A narrow screen scrolls the plot sideways: it opens on the latest days, today at the right edge.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    const today = box?.querySelector(".ts-day-today");
    if (!box || !today || box.scrollWidth <= box.clientWidth) return;
    const boxLeft = box.getBoundingClientRect().left;
    const plot = box.querySelector(".ts-day-labels");
    const name = box.querySelector(".ts-name");
    if (!plot || !name) return;
    const want = box.scrollLeft + today.getBoundingClientRect().right - box.getBoundingClientRect().right + 16;
    if (want <= 0) return;
    // Snapped to a whole day: the first day beside the names is never half under them.
    const plotLeft = plot.getBoundingClientRect().left - boxLeft + box.scrollLeft;
    const slot = plot.getBoundingClientRect().width / SLOT_COUNT;
    const covered = name.getBoundingClientRect().width;
    box.scrollLeft = Math.max(0, plotLeft + Math.ceil((want + covered - plotLeft) / slot) * slot - covered);
  }, []);
  return (
    <section className="ts-source" aria-label={source.title}>
      <header className="ts-source-head">
        <h2 className="ts-source-title">{source.title}</h2>
        {source.contractor && <span className="ts-source-contractor">{source.contractor}</span>}
        {source.attention && <span className="ts-source-attention">{source.attention}</span>}
        {source.broughtMills !== null && (
          <span className="ts-source-brought">принесли <b>{formatMills(source.broughtMills)}</b></span>
        )}
      </header>
      <div className="ts-scroll" ref={scroller}>
        <div className="ts-grid ts-days" aria-hidden="true">
          <span className="ts-name" />
          <div className="ts-plot ts-day-labels">
            {slots.map((slot) => <span key={slot.date} className={`ts-day ts-day-${slot.when}`}>{slot.label}</span>)}
          </div>
          <span />
        </div>
        {source.rows.map((row) => (
          <div key={row.key} className={`ts-grid ts-row${row.large ? " ts-row-large" : ""}`}>
            <span className="ts-name">{row.name}</span>
            <div className="ts-plot">
              <DayLine row={row} slots={slots} max={row.large ? Math.max(1, ...row.fans.map((value) => value ?? 0)) : source.smallMax} />
            </div>
            <span className="ts-total">{row.total}</span>
          </div>
        ))}
      </div>
      {source.quiet && <p className="ts-quiet">{source.quiet}</p>}
    </section>
  );
}

const LARGE = { height: 132, top: 26, bottom: 10 };
const SMALL = { height: 62, top: 25, bottom: 9 };
const LABEL_GAP = 9;

/** One row's new fans per day: straight segments between known days, a point
 *  on each, its value above it (below in a valley of the large chart). A day
 *  that is unknown breaks the line; a day to come has nothing. */
function DayLine({ row, slots, max }: { row: SourceRow; slots: readonly DaySlot[]; max: number }) {
  const box = row.large ? LARGE : SMALL;
  const span = box.height - box.top - box.bottom;
  const yOf = (value: number) => box.top + (1 - Math.min(value, max) / max) * span;
  const xPct = (index: number) => `${((index + 0.5) / SLOT_COUNT) * 100}%`;
  const points = row.fans.map((value, index) => (value === null ? null : { index, value, y: yOf(value) }));
  // Runs of consecutive known days: a line inside each, nothing across a gap.
  const runs: Array<Array<{ index: number; y: number }>> = [];
  let run: Array<{ index: number; y: number }> = [];
  for (const point of points) {
    if (point === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push(point);
    }
  }
  if (run.length > 0) runs.push(run);
  const base = box.height - box.bottom;
  const closed = <T extends { index: number }>(part: T[]) => (slots[part.at(-1)!.index]?.when === "today" ? part.slice(0, -1) : part);
  const described = slots.map((slot, index) => `${slot.label}: ${row.fans[index] ?? "нет данных"}`).join(", ");

  return (
    <svg className="ts-chart" width="100%" height={box.height} role="img" aria-label={`${row.name}, новых фанов по дням. ${described}`}>
      <svg viewBox={`0 0 ${SLOT_COUNT} ${box.height}`} preserveAspectRatio="none" width="100%" height={box.height} aria-hidden="true">
        {/* The area stops at the last finished day: today's step is not an arrival yet. */}
        {row.large && runs.map(closed).filter((part) => part.length > 1).map((part) => (
          <polygon
            key={`a${part[0]!.index}`}
            className="ts-area"
            points={[
              `${part[0]!.index + 0.5},${base}`,
              ...part.map((point) => `${point.index + 0.5},${point.y}`),
              `${part.at(-1)!.index + 0.5},${base}`,
            ].join(" ")}
          />
        ))}
        {runs.map((part) => {
          // Today is not over: the step into it is dashed.
          const open = slots[part.at(-1)!.index]?.when === "today" && part.length > 1;
          const solid = open ? part.slice(0, -1) : part;
          const xy = (point: { index: number; y: number }) => `${point.index + 0.5},${point.y}`;
          return (
            <g key={`l${part[0]!.index}`}>
              {solid.length > 1 && <polyline className="ts-line" vectorEffect="non-scaling-stroke" points={solid.map(xy).join(" ")} />}
              {open && <polyline className="ts-line ts-line-open" vectorEffect="non-scaling-stroke" points={part.slice(-2).map(xy).join(" ")} />}
            </g>
          );
        })}
      </svg>
      {points.map((point) => {
        if (point === null) return null;
        const today = slots[point.index]?.when === "today";
        const before = points[point.index - 1];
        const after = points[point.index + 1];
        const valley = row.large && before && after && point.value < before.value && point.value < after.value;
        const below = valley && point.y + LABEL_GAP + 13 <= box.height;
        return (
          <g key={point.index}>
            <circle className={today ? "ts-dot ts-dot-today" : "ts-dot"} cx={xPct(point.index)} cy={point.y} r={today ? 3.5 : 3} />
            <text
              className={point.value === 0 ? "ts-value ts-value-zero" : "ts-value"}
              x={xPct(point.index)}
              y={below ? point.y + LABEL_GAP + 10 : point.y - LABEL_GAP}
              textAnchor="middle"
            >
              {point.value}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
