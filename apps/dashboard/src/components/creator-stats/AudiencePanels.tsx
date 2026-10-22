import { useMemo, useState } from "react";

import type { CreatorStatsAudienceResponse } from "@agency_hub_core/contracts";

import {
  ANALYTICS_TABLE_WRAP,
  AnalyticsEmpty,
  AnalyticsPanel,
} from "@/components/analytics/AnalyticsPanel";
import { formatBucketDay, formatCount, formatDurationMs, formatPercent } from "@/components/analytics/analytics-words";

import { DayChart } from "./DayChart.js";
import { sourceColor, sourceLabel, type DayPoint } from "./creator-stats-model.js";

type Audience = CreatorStatsAudienceResponse;

const regionNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["ru"], { type: "region" }) : null;

function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

function SourcePicker({ sources, value, onChange }: { sources: readonly number[]; value: number | "all"; onChange: (value: number | "all") => void }) {
  return (
    <div className="segmented" role="group" aria-label="Источник">
      <button type="button" className="segment" aria-pressed={value === "all"} onClick={() => onChange("all")}>Все</button>
      {sources.map((source) => (
        <button key={source} type="button" className="segment" aria-pressed={value === source} onClick={() => onChange(source)}>{sourceLabel(source)}</button>
      ))}
    </div>
  );
}

/** A bar inside a table cell: the share of the largest value. */
function ShareBar({ value, max, color = "var(--color-chart-blue)" }: { value: number; max: number; color?: string }) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full rounded-full bg-hover" aria-hidden="true">
      <div className="h-1.5 rounded-full" style={{ width: `${width}%`, background: color }} />
    </div>
  );
}

export function CountriesPanel({ data }: { data: Audience }) {
  const sources = [...new Set(data.countries.map((row) => row.source))].sort((a, b) => a - b);
  const [source, setSource] = useState<number | "all">("all");
  const rows = useMemo(() => {
    const byCountry = new Map<string, { views: number; watchMs: number; profileVisits: number }>();
    for (const row of data.countries) {
      if (source !== "all" && row.source !== source) continue;
      const entry = byCountry.get(row.country) ?? { views: 0, watchMs: 0, profileVisits: 0 };
      entry.views += row.views ?? 0;
      entry.watchMs += row.watchMs ?? 0;
      // Profile visits come with every surface's answer: count one surface's.
      if (row.source === (source === "all" ? sources[0] : source)) entry.profileVisits += row.profileVisits ?? 0;
      byCountry.set(row.country, entry);
    }
    return [...byCountry.entries()].map(([country, value]) => ({ country, ...value })).sort((a, b) => b.views - a.views);
  }, [data.countries, source, sources]);
  const total = rows.reduce((sum, row) => sum + row.views, 0);
  const max = rows[0]?.views ?? 0;
  return (
    <AnalyticsPanel
      title="Страны"
      description="Откуда смотрят медиа: просмотры и визиты профиля по странам."
      headerExtra={sources.length > 1 ? <SourcePicker sources={sources} value={source} onChange={setSource} /> : undefined}
    >
      {rows.length === 0 ? <AnalyticsEmpty reason="Стран за этот период ещё нет: сбор аудитории только начался." /> : (
        <div className={ANALYTICS_TABLE_WRAP}>
          <table className="data-table">
            <thead><tr><th>Страна</th><th className="w-[38%]" aria-label="Доля" /><th className="num">Просмотры</th><th className="num">Доля</th><th className="num">Визиты</th></tr></thead>
            <tbody>
              {rows.slice(0, 15).map((row) => (
                <tr key={row.country}>
                  <td>{countryName(row.country)}</td>
                  <td><ShareBar value={row.views} max={max} /></td>
                  <td className="num">{formatCount(row.views)}</td>
                  <td className="num">{total > 0 ? formatPercent((row.views / total) * 100) : "—"}</td>
                  <td className="num">{row.profileVisits > 0 ? formatCount(row.profileVisits) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

export function TagsPanel({ data }: { data: Audience }) {
  const rowsAll = data.tags?.rows ?? [];
  const sources = [...new Set(rowsAll.map((row) => row.source))].sort((a, b) => a - b);
  const [source, setSource] = useState<number>(sources[0] ?? 0);
  const rows = rowsAll.filter((row) => row.source === source).slice(0, 25);
  const max = rows[0]?.views ?? 0;
  return (
    <AnalyticsPanel
      title="Теги"
      description={data.tags ? `По каким тегам находили медиа, ${formatBucketDay(data.tags.fromDay)} — ${formatBucketDay(data.tags.toDay)}.` : "По каким тегам находили медиа."}
      headerExtra={sources.length > 1 ? (
        <div className="segmented" role="group" aria-label="Источник">
          {sources.map((value) => <button key={value} type="button" className="segment" aria-pressed={source === value} onClick={() => setSource(value)}>{sourceLabel(value)}</button>)}
        </div>
      ) : undefined}
      help={<p>«Прирост» — на сколько пунктов досмотр медиа с этим тегом выше среднего по странице (считает Fansly; доступен не всегда).</p>}
    >
      {rows.length === 0 ? <AnalyticsEmpty reason="Тегов за этот период ещё нет." /> : (
        <div className={ANALYTICS_TABLE_WRAP}>
          <table className="data-table">
            <thead><tr><th>Тег</th><th className="w-[34%]" aria-label="Доля" /><th className="num">Просмотры</th><th className="num">Досмотрели</th><th className="num">Прирост</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.tag}-${row.source}`}>
                  <td>#{row.tag}</td>
                  <td><ShareBar value={row.views ?? 0} max={max} color={sourceColor(row.source)} /></td>
                  <td className="num">{row.views === null ? "—" : formatCount(row.views)}</td>
                  <td className="num">{row.completedViews === null ? "—" : formatCount(row.completedViews)}</td>
                  <td className={`num ${row.liftPoints !== null && row.liftPoints > 0 ? "text-green" : row.liftPoints !== null && row.liftPoints < 0 ? "text-danger" : ""}`}>
                    {row.liftAvailable === false || row.liftPoints === null ? "—" : `${row.liftPoints > 0 ? "+" : ""}${row.liftPoints.toFixed(1)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MOSCOW_OFFSET_HOURS = 3;

/** Views per weekday and hour, moved from UTC to Moscow time. */
export function ActiveHoursPanel({ data }: { data: Audience }) {
  const cells = data.activeHours?.cells ?? [];
  const sources = [...new Set(cells.map((cell) => cell.source))].sort((a, b) => a - b);
  const [source, setSource] = useState<number | "all">("all");
  const grid = useMemo(() => {
    const values = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const cell of cells) {
      if (source !== "all" && cell.source !== source) continue;
      const shifted = cell.weekday * 24 + cell.hour + MOSCOW_OFFSET_HOURS;
      const weekday = Math.floor(shifted / 24) % 7; // 0 = Sunday
      const hour = shifted % 24;
      const row = (weekday + 6) % 7; // Monday first
      values[row]![hour]! += cell.views ?? 0;
    }
    return values;
  }, [cells, source]);
  const max = Math.max(0, ...grid.flat());
  return (
    <AnalyticsPanel
      wide
      title="Когда смотрят"
      description={data.activeHours
        ? `Просмотры по дням недели и часам (время московское), ${formatBucketDay(data.activeHours.fromDay)} — ${formatBucketDay(data.activeHours.toDay)}.`
        : "Просмотры по дням недели и часам (время московское)."}
      headerExtra={sources.length > 1 ? <SourcePicker sources={sources} value={source} onChange={setSource} /> : undefined}
    >
      {cells.length === 0 || max === 0 ? <AnalyticsEmpty reason="Сетка часов ещё не собрана." /> : (
        <div className="card-body overflow-x-auto">
          <table className="w-full border-separate" style={{ borderSpacing: 3 }}>
            <thead>
              <tr>
                <th />
                {Array.from({ length: 24 }, (_, hour) => (
                  <th key={hour} className="text-[11px] font-normal text-text-muted">{hour % 3 === 0 ? hour : ""}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((row, index) => (
                <tr key={WEEKDAYS[index]}>
                  <th className="pr-2 text-left text-[12px] font-medium text-text-secondary">{WEEKDAYS[index]}</th>
                  {row.map((value, hour) => (
                    <td
                      key={hour}
                      title={`${WEEKDAYS[index]}, ${hour}:00 — ${formatCount(value)} просмотров`}
                      className="h-6 min-w-[18px] rounded-[4px]"
                      style={{ background: "var(--color-chart-blue)", opacity: max > 0 ? 0.08 + 0.92 * (value / max) : 0.08 }}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

function lengthLabel(minMs: number | null, maxMs: number | null): string {
  if (minMs === null && maxMs === null) return "—";
  if (maxMs === null || maxMs <= 0) return `от ${formatDurationMs(minMs ?? 0)}`;
  return `${formatDurationMs(minMs ?? 0)} – ${formatDurationMs(maxMs)}`;
}

export function BenchmarksPanel({ data }: { data: Audience }) {
  const rowsAll = data.benchmarks?.rows ?? [];
  const sources = [...new Set(rowsAll.map((row) => row.source))].sort((a, b) => a - b);
  const [source, setSource] = useState<number>(sources[0] ?? 0);
  const rows = rowsAll.filter((row) => row.source === source && (row.mediaCount ?? 0) > 0);
  const maxCompletion = Math.max(0, ...rows.map((row) => row.completionRate ?? 0));
  return (
    <AnalyticsPanel
      title="Досмотр по длине видео"
      description="Как досматривают видео разной длины — подсказка, какой хронометраж работает."
      headerExtra={sources.length > 1 ? (
        <div className="segmented" role="group" aria-label="Источник">
          {sources.map((value) => <button key={value} type="button" className="segment" aria-pressed={source === value} onClick={() => setSource(value)}>{sourceLabel(value)}</button>)}
        </div>
      ) : undefined}
    >
      {rows.length === 0 ? <AnalyticsEmpty reason="Сравнения по длине ещё нет." /> : (
        <div className={ANALYTICS_TABLE_WRAP}>
          <table className="data-table">
            <thead><tr><th>Длина</th><th className="num">Видео</th><th className="num">Средний досмотр</th><th className="w-[30%]" aria-label="До конца" /><th className="num">До конца</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.lengthBucket}>
                  <td>{lengthLabel(row.minMs, row.maxMs)}</td>
                  <td className="num">{row.mediaCount === null ? "—" : formatCount(row.mediaCount)}</td>
                  <td className="num">{row.avgWatchPercent === null ? "—" : formatPercent(row.avgWatchPercent)}</td>
                  <td><ShareBar value={row.completionRate ?? 0} max={maxCompletion} color={sourceColor(source)} /></td>
                  <td className="num">{row.completionRate === null ? "—" : formatPercent(row.completionRate * 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}

/** How many different media each surface showed per hour, last 72 h. */
export function MediaShownPanel({ data }: { data: Audience }) {
  const sources = [...new Set(data.mediaShown.map((row) => row.source))].sort((a, b) => a - b);
  const rows = useMemo(() => {
    const hours = [...new Set(data.mediaShown.map((row) => row.hour))].sort();
    return hours.map((hour) => {
      const point: DayPoint = { bucketStart: hour };
      for (const source of sources) point[String(source)] = data.mediaShown.find((row) => row.hour === hour && row.source === source)?.mediaShown ?? 0;
      return point;
    });
  }, [data.mediaShown, sources]);
  return (
    <AnalyticsPanel wide title="Сколько разных медиа показывали" description="По часам за последние 72 часа (время московское): широта охвата каталога.">
      {rows.length === 0 ? <AnalyticsEmpty reason="Почасовых показов пока нет: они копятся с 22 октября." /> : (
        <div className="card-body">
          <DayChart lines hours rows={rows} series={sources.map((source) => ({ key: String(source), label: sourceLabel(source), color: sourceColor(source) }))} height={220} />
        </div>
      )}
    </AnalyticsPanel>
  );
}
