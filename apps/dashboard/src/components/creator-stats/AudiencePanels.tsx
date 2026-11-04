import { useMemo, useState } from "react";

import type { CreatorStatsAudienceResponse, StatsTagsResponse } from "@agency_hub_core/contracts";
import { ChartTable } from "@/components/charts/ChartTable";
import { ShareBar } from "@/components/charts/ShareBar";
import { Pagination } from "@/components/shared/Pagination";
import { Notice } from "@/components/ui/Notice";
import { formatCount, formatPercent } from "@/lib/format";

import { DayChart } from "./DayChart.js";
import { hourRows } from "./CreatorStatsPanels.js";
import { ChartBody, StatsCard, StatsEmpty } from "./StatsCard.js";
import { HOUR_IN_PROGRESS_NOTE, HOUR_MS, bucketInProgress, formatStatsHour, formatStatsRange, sentence, sourceColor, sourceLabel } from "./creator-stats-model.js";

type Audience = CreatorStatsAudienceResponse;
/** «Все» or one source of Fansly. */
export type SourcePick = "all" | number;

const FOR_YOU = 0;

/** Every source that any block of the answer carries, in Fansly's order. */
export function audienceSources(data: Audience): number[] {
  const sources = new Set<number>();
  for (const row of data.countries) sources.add(row.source);
  for (const row of data.tags?.rows ?? []) sources.add(row.source);
  for (const cell of data.activeHours?.cells ?? []) sources.add(cell.source);
  for (const row of data.benchmarks?.rows ?? []) sources.add(row.source);
  for (const row of data.mediaShown) sources.add(row.source);
  return [...sources].sort((a, b) => a - b);
}

const regionNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["ru"], { type: "region" }) : null;

function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

const windowNote = "Это окно Fansly: переключатель периода на него не влияет.";

// ── countries ────────────────────────────────────────────────────────────────

const COUNTRIES_PAGE = 15;

export function CountriesPanel({ data, source, pageLabel, periodText }: { data: Audience; source: SourcePick; pageLabel: string; periodText: string }) {
  const [offset, setOffset] = useState(0);
  const rows = useMemo(() => {
    const sources = [...new Set(data.countries.map((row) => row.source))].sort((a, b) => a - b);
    // Profile visits come with every source's answer: one source's are counted, never a sum.
    const visitsSource = source === "all" ? sources[0] : source;
    const byCountry = new Map<string, { views: number; profileVisits: number }>();
    for (const row of data.countries) {
      if (source !== "all" && row.source !== source) continue;
      const entry = byCountry.get(row.country) ?? { views: 0, profileVisits: 0 };
      entry.views += row.views ?? 0;
      if (row.source === visitsSource) entry.profileVisits += row.profileVisits ?? 0;
      byCountry.set(row.country, entry);
    }
    return [...byCountry.entries()].map(([country, value]) => ({ country, ...value })).sort((a, b) => b.views - a.views);
  }, [data.countries, source]);
  const total = rows.reduce((sum, row) => sum + row.views, 0);
  const max = rows[0]?.views ?? 0;
  const partial = data.countriesCoveredDays > 0 && data.countriesCoveredDays < data.window.days;
  const page = rows.slice(offset, offset + COUNTRIES_PAGE);
  return (
    <StatsCard
      wide
      id="stats-countries"
      title="Страны"
      description={partial
        ? `Откуда смотрят медиа: просмотры и визиты профиля. За ${data.countriesCoveredDays} из ${data.window.days} дней: остальные ещё не собраны.`
        : "Откуда смотрят медиа: просмотры и визиты профиля."}
      footer={rows.length > COUNTRIES_PAGE ? <Pagination offset={offset} limit={COUNTRIES_PAGE} total={rows.length} onPageChange={setOffset} /> : undefined}
    >
      {rows.length === 0 ? <StatsEmpty>На {pageLabel} за {periodText} стран пока нет: сбор аудитории только начался.</StatsEmpty> : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Страна</th>
                <th scope="col" className="stats-bar-col"><span className="sr-only">Доля полосой</span></th>
                <th scope="col" className="num">Просмотры</th>
                <th scope="col" className="num">Доля</th>
                <th scope="col" className="num">Визиты</th>
              </tr>
            </thead>
            <tbody>
              {page.map((row) => (
                <tr key={row.country}>
                  <td>{countryName(row.country)}</td>
                  <td className="stats-bar-col"><ShareBar value={row.views} max={max} color={source === "all" ? undefined : sourceColor(source)} /></td>
                  <td className="num">{formatCount(row.views)}</td>
                  <td className="num">{total > 0 ? formatPercent((row.views / total) * 100, { precise: true }) : "—"}</td>
                  <td className="num">{row.profileVisits > 0 ? formatCount(row.profileVisits) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StatsCard>
  );
}

// ── active hours ─────────────────────────────────────────────────────────────

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WEEKDAY_NAMES = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const MOSCOW_OFFSET_HOURS = 3;

/** Views per weekday and hour, moved from UTC to Moscow time, Monday first. */
export function ActiveHoursPanel({ data, source, pageLabel }: { data: Audience; source: SourcePick; pageLabel: string }) {
  const cells = data.activeHours?.cells ?? [];
  const grid = useMemo(() => {
    const values = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const cell of cells) {
      if (source !== "all" && cell.source !== source) continue;
      const shifted = cell.weekday * 24 + cell.hour + MOSCOW_OFFSET_HOURS;
      const weekday = Math.floor(shifted / 24) % 7; // 0 = Sunday
      const hour = shifted % 24;
      const row = (weekday + 6) % 7;
      values[row]![hour]! += cell.views ?? 0;
    }
    return values;
  }, [cells, source]);
  const max = Math.max(0, ...grid.flat());
  const span = data.activeHours ? formatStatsRange(data.activeHours.fromDay, data.activeHours.toDay) : null;
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  return (
    <StatsCard
      wide
      id="stats-hours-grid"
      title="Когда смотрят"
      description={span ? `${sentence(`Просмотры по дням недели и часам, ${span}`)} ${windowNote}` : "Просмотры по дням недели и часам."}
    >
      {cells.length === 0 || max === 0 ? <StatsEmpty>Для {pageLabel} сетка часов ещё не собрана.</StatsEmpty> : (
        <div className="card-body">
          <div className="stats-heatmap-wrap">
            <table className="stats-heatmap">
              <thead>
                <tr>
                  <th aria-hidden="true" />
                  {hours.map((hour) => <th key={hour} scope="col">{hour % 3 === 0 ? hour : ""}</th>)}
                </tr>
              </thead>
              <tbody>
                {grid.map((row, index) => (
                  <tr key={WEEKDAYS[index]}>
                    <th scope="row">{WEEKDAYS[index]}</th>
                    {row.map((value, hour) => (
                      <td key={hour} title={`${WEEKDAYS[index]}, ${hour}:00 — ${formatCount(value)} просмотров`}>
                        <span style={{ opacity: max > 0 ? 0.06 + 0.94 * (value / max) : 0.06 }} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="stats-chart-table">
            <ChartTable
              caption="Просмотры по часам и дням недели"
              rows={hours}
              rowKey={(hour) => String(hour)}
              columns={[
                { key: "hour", label: "Час", value: (hour) => `${hour}:00` },
                ...WEEKDAYS.map((day, index) => ({ key: day, label: day, num: true, value: (hour: number) => formatCount(grid[index]![hour]!) })),
              ]}
            />
          </div>
          <p className="sr-only">Дни недели: {WEEKDAY_NAMES.join(", ")}.</p>
        </div>
      )}
    </StatsCard>
  );
}

// ── tags ─────────────────────────────────────────────────────────────────────

const TAGS_PAGE = 25;

interface TagRow {
  key: string;
  tag: string;
  named: boolean;
  views: number | null;
  completedViews: number | null;
  lift: number | null;
  color: string;
}

type PlatformTag = StatsTagsResponse["platformTags"][number];

/** A name or a number: a number Fansly sent instead of a name is never shown. */
function isNamed(tag: string): boolean {
  return !/^\d+$/.test(tag);
}

function formatLift(points: number): string {
  const text = Math.abs(points).toFixed(1).replace(".", ",");
  return points > 0 ? `+${text}` : points < 0 ? `−${text}` : "0";
}

export function TagsPanel({ data, source, totals, pageLabel, onPick }: {
  data: Audience;
  source: SourcePick;
  totals: { data: StatsTagsResponse | undefined; isError: boolean; refetch: () => unknown };
  pageLabel: string;
  onPick: (source: SourcePick) => void;
}) {
  const [offset, setOffset] = useState(0);
  const all = data.tags?.rows ?? [];
  const rows = useMemo<TagRow[]>(() => {
    const groups = new Map<string, Array<(typeof all)[number]>>();
    for (const row of all) {
      if (source !== "all" && row.source !== source) continue;
      groups.set(row.tag, [...(groups.get(row.tag) ?? []), row]);
    }
    return [...groups.entries()].map(([tag, list]) => {
      const sum = (pick: (row: (typeof list)[number]) => number | null) =>
        list.every((row) => pick(row) === null) ? null : list.reduce((acc, row) => acc + (pick(row) ?? 0), 0);
      const single = list.length === 1 ? list[0]! : null;
      return {
        key: tag,
        tag,
        named: isNamed(tag),
        views: sum((row) => row.views),
        completedViews: sum((row) => row.completedViews),
        lift: single && single.liftAvailable !== false && single.liftPoints !== null ? single.liftPoints : null,
        color: source === "all" ? "var(--color-chart-blue)" : sourceColor(source),
      };
    }).sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  }, [all, source]);
  const platform = useMemo(() => {
    const byName = new Map<string, PlatformTag>();
    for (const tag of totals.data?.platformTags ?? []) {
      if (tag.tagName) byName.set(tag.tagName.toLowerCase(), tag);
      byName.set(`#ref:${tag.tagRef}`, tag);
    }
    return (tag: string) => byName.get(tag.toLowerCase()) ?? byName.get(`#ref:${tag}`) ?? null;
  }, [totals.data]);
  const max = rows[0]?.views ?? 0;
  const span = data.tags ? formatStatsRange(data.tags.fromDay, data.tags.toDay) : null;
  const page = rows.slice(offset, offset + TAGS_PAGE);
  const platformCell = (value: number | null | undefined) =>
    totals.data === undefined || value === null || value === undefined ? "—" : formatCount(value);

  return (
    <StatsCard
      wide
      id="stats-tags"
      title="Теги"
      description={span ? `${sentence(`По каким тегам находили медиа, ${span}`)} ${windowNote}` : "По каким тегам находили медиа."}
      footer={rows.length > TAGS_PAGE ? <Pagination offset={offset} limit={TAGS_PAGE} total={rows.length} onPageChange={setOffset} /> : undefined}
    >
      {all.length === 0 ? (
        <StatsEmpty>На {pageLabel} тегов за это окно пока нет.</StatsEmpty>
      ) : rows.length === 0 ? (
        <StatsEmpty action={<button type="button" className="btn btn-sm" onClick={() => onPick(FOR_YOU)}>Показать For You</button>}>
          По этому источнику Fansly тегов не отдаёт.
        </StatsEmpty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table stats-tags-table">
              <thead>
                <tr>
                  <th scope="col">Тег</th>
                  <th scope="col" className="stats-bar-col"><span className="sr-only">Доля полосой</span></th>
                  <th scope="col" className="num">Просмотры</th>
                  <th scope="col" className="num">До конца</th>
                  <th scope="col" className="num">К среднему</th>
                  <th scope="col" className="num">На всём Fansly: просмотры</th>
                  <th scope="col" className="num">На всём Fansly: посты</th>
                </tr>
              </thead>
              <tbody>
                {page.map((row) => {
                  const global = row.named ? platform(row.tag) : null;
                  return (
                    <tr key={row.key}>
                      <td>{row.named ? `#${row.tag}` : <span className="muted">Без названия</span>}</td>
                      <td className="stats-bar-col"><ShareBar value={row.views ?? 0} max={max} color={row.color} /></td>
                      <td className="num">{row.views === null ? "—" : formatCount(row.views)}</td>
                      <td className="num">{row.completedViews === null ? "—" : formatCount(row.completedViews)}</td>
                      <td className="num">
                        {row.lift === null ? "—" : <span className={row.lift > 0 ? "delta-up" : row.lift < 0 ? "delta-down" : ""}>{formatLift(row.lift)}</span>}
                      </td>
                      <td className="num">{platformCell(global?.viewCount)}</td>
                      <td className="num">{platformCell(global?.postCount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totals.isError && totals.data === undefined && (
            <div className="card-body stats-table-after">
              <Notice tone="warning" role="status" action={<button type="button" className="btn btn-sm" onClick={() => void totals.refetch()}>Повторить</button>}>
                Числа по всему Fansly не пришли. Это не ноль.
              </Notice>
            </div>
          )}
        </>
      )}
    </StatsCard>
  );
}

// ── benchmarks ───────────────────────────────────────────────────────────────

function lengthPart(ms: number): { value: number; unit: "с" | "мин" } {
  return ms < 60_000 ? { value: Math.round(ms / 1_000), unit: "с" } : { value: Math.round(ms / 60_000), unit: "мин" };
}

/** «до 15 с», «15–30 с», «30 с – 1 мин», «1–3 мин», «от 3 мин». */
export function lengthLabel(minMs: number | null, maxMs: number | null): string {
  if ((minMs === null || minMs <= 0) && maxMs !== null && maxMs > 0) {
    const max = lengthPart(maxMs);
    return `до ${max.value} ${max.unit}`;
  }
  if (minMs === null) return "—";
  const min = lengthPart(minMs);
  if (maxMs === null || maxMs <= 0) return `от ${min.value} ${min.unit}`;
  const max = lengthPart(maxMs);
  return min.unit === max.unit ? `${min.value}–${max.value} ${max.unit}` : `${min.value} ${min.unit} – ${max.value} ${max.unit}`;
}

export function BenchmarksPanel({ data, source, pageLabel }: { data: Audience; source: SourcePick; pageLabel: string }) {
  const shownSource = source === "all" ? FOR_YOU : source;
  const rows = (data.benchmarks?.rows ?? []).filter((row) => row.source === shownSource && (row.mediaCount ?? 0) > 0)
    .sort((a, b) => a.lengthBucket - b.lengthBucket);
  const maxCompletion = Math.max(0, ...rows.map((row) => row.completionRate ?? 0));
  const span = data.benchmarks ? formatStatsRange(data.benchmarks.fromDay, data.benchmarks.toDay) : null;
  const lead = source === "all" ? "Показан For You: средний досмотр между источниками не складывается. " : "";
  return (
    <StatsCard
      id="stats-benchmarks"
      title="Досмотр по длине видео"
      description={`${lead}${sentence(`Как досматривают видео разной длины${span ? `, ${span}` : ""}`)} ${windowNote}`}
    >
      {rows.length === 0 ? <StatsEmpty>Сравнения по длине для {pageLabel} ещё нет.</StatsEmpty> : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Длина</th>
                <th scope="col" className="num">Видео</th>
                <th scope="col" className="num">Средний досмотр</th>
                <th scope="col" className="stats-bar-col-sm"><span className="sr-only">До конца полосой</span></th>
                <th scope="col" className="num">До конца</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.lengthBucket}>
                  <td className="whitespace-nowrap">{lengthLabel(row.minMs, row.maxMs)}</td>
                  <td className="num">{row.mediaCount === null ? "—" : formatCount(row.mediaCount)}</td>
                  <td className="num">{row.avgWatchPercent === null ? "—" : formatPercent(row.avgWatchPercent)}</td>
                  <td className="stats-bar-col-sm"><ShareBar value={row.completionRate ?? 0} max={maxCompletion} color={sourceColor(shownSource)} /></td>
                  <td className="num">{row.completionRate === null ? "—" : formatPercent(row.completionRate * 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StatsCard>
  );
}

// ── media shown ──────────────────────────────────────────────────────────────

export function MediaShownPanel({ data, source, pageLabel }: { data: Audience; source: SourcePick; pageLabel: string }) {
  const series = useMemo(() => [...new Set(data.mediaShown.map((row) => row.source))]
    .filter((value) => source === "all" || value === source)
    .sort((a, b) => a - b)
    .map((value) => ({ key: String(value), label: sourceLabel(value), color: sourceColor(value) })), [data.mediaShown, source]);
  const rows = useMemo(
    () => hourRows(data.mediaShown.map((row) => ({ hour: row.hour, source: row.source, value: row.mediaShown })), series, (row) => row.value),
    [data.mediaShown, series],
  );
  const note = (row: Record<string, unknown>) =>
    typeof row.bucketStart === "string" && bucketInProgress(row.bucketStart, HOUR_MS) ? HOUR_IN_PROGRESS_NOTE : null;
  return (
    <StatsCard
      id="stats-media-shown"
      title="Сколько разных медиа показывали"
      description="По часам за последние 72 часа: сколько разных медиа Fansly показывал. Период на этот график не влияет."
    >
      {rows.length === 0 || series.length === 0 ? <StatsEmpty>Почасовых показов для {pageLabel} пока нет.</StatsEmpty> : (
        <ChartBody
          chart={<DayChart lines fromZero hours rows={rows} series={series} height={240} note={note} />}
          rows={rows}
          rowKey={(row) => row.bucketStart}
          caption="Сколько разных медиа показывали по часам"
          columns={[
            { key: "hour", label: "Час", value: (row) => formatStatsHour(row.bucketStart) },
            ...series.map((entry) => ({ key: entry.key, label: entry.label, num: true, value: (row: (typeof rows)[number]) => (typeof row[entry.key] === "number" ? formatCount(row[entry.key] as number) : "—") })),
          ]}
        />
      )}
    </StatsCard>
  );
}
