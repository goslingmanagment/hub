import { useCallback } from "react";
import { useSearchParams } from "react-router";

import { useCreatorStatsAudience } from "@/api/creator-stats";
import { useFanslyTagTotals } from "@/api/insights";
import {
  ActiveHoursPanel,
  BenchmarksPanel,
  CountriesPanel,
  MediaShownPanel,
  TagsPanel,
  audienceSources,
  type SourcePick,
} from "@/components/creator-stats/AudiencePanels";
import { expectedWindow, newestUpdate, sourceLabel } from "@/components/creator-stats/creator-stats-model";
import { Segmented } from "@/components/ui/Segmented";
import { PERIOD_LABELS } from "@/lib/period";

import { CardSkeleton, HowCounted, QueryGate, StatsHeader, StatsNotices } from "./StatsScreen.js";
import { useStatsPage } from "./useStatsPage.js";

function sourceFrom(raw: string | null): SourcePick {
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : "all";
}

/** «Аудитория»: where from and when they watch, by which tags they find the page. `?source=` is the filter. */
export function StatsAudiencePage() {
  const { pageLabel, days, periodKey, substituted } = useStatsPage();
  const [search, setSearch] = useSearchParams();
  const audience = useCreatorStatsAudience(pageLabel, days);
  const totals = useFanslyTagTotals(pageLabel);
  const data = audience.data;
  const window = data?.window ?? expectedWindow(days);
  const updatedAt = newestUpdate(totals.data?.coverage.filter((row) => row.plane === "creator_stats_audience") ?? []);
  const periodText = PERIOD_LABELS[periodKey].toLowerCase();
  const source = sourceFrom(search.get("source"));

  const pick = useCallback((next: SourcePick) => {
    const query = new URLSearchParams(globalThis.location.search);
    if (next === "all") query.delete("source");
    else query.set("source", String(next));
    setSearch(query, { replace: true });
  }, [setSearch]);

  return (
    <div className="stats-screen">
      <StatsHeader
        window={window}
        updatedAt={updatedAt}
        refreshing={audience.isFetching || totals.isFetching}
        onRefresh={() => {
          void audience.refetch();
          void totals.refetch();
        }}
      />
      <StatsNotices pageLabel={pageLabel} updatedAt={updatedAt} incomplete={null} substituted={substituted} />
      <QueryGate
        query={audience}
        pageLabel={pageLabel}
        skeleton={<div className="stats-stack"><CardSkeleton wide /><CardSkeleton wide /></div>}
      >
        {(data) => {
          const sources = audienceSources(data);
          const shown: SourcePick = source === "all" || sources.includes(source) ? source : "all";
          return (
            <div className="stats-stack">
              {sources.length > 1 && (
                <div className="table-toolbar stats-source-bar">
                  <div className="stats-source-pick">
                    <span className="stats-source-label" id="stats-source-label">Откуда пришли</span>
                    <Segmented
                      label="Откуда пришли"
                      value={String(shown)}
                      onChange={(value) => pick(value === "all" ? "all" : Number(value))}
                      options={[{ value: "all", label: "Все" }, ...sources.map((value) => ({ value: String(value), label: sourceLabel(value) }))]}
                    />
                  </div>
                </div>
              )}
              <CountriesPanel key={`countries-${shown}`} data={data} source={shown} pageLabel={pageLabel} periodText={periodText} />
              <ActiveHoursPanel data={data} source={shown} pageLabel={pageLabel} />
              <TagsPanel key={`tags-${shown}`} data={data} source={shown} totals={totals} pageLabel={pageLabel} onPick={pick} />
              <div className="stats-grid">
                <BenchmarksPanel data={data} source={shown} pageLabel={pageLabel} />
                <MediaShownPanel data={data} source={shown} pageLabel={pageLabel} />
              </div>
            </div>
          );
        }}
      </QueryGate>
      <HowCounted>
        <p>Страны — просмотры за выбранный период. Fansly отдаёт их окнами: если часть дней ещё не собрана, в описании написано, за сколько дней.</p>
        <p>Теги и длина видео — окна Fansly в 30 дней, часы — в 90, графики по часам — 72 часа. Переключатель периода на них не влияет. Сейчас Fansly отдаёт теги только для For You.</p>
        <p>«К среднему» — на сколько пунктов досмотр медиа с этим тегом выше среднего по странице. Считает Fansly, есть не всегда.</p>
        <p>«На всём Fansly» — цифры тега по всей площадке, а не только этой страницы, на вчера. Большой тег с малым числом просмотров страницы и малый тег с большим — разные возможности. «Без названия» — Fansly не прислал имя тега, Hub его не выдумывает.</p>
        <p>Все часы — по Москве. «До конца» — сколько просмотров дошло до конца видео.</p>
      </HowCounted>
    </div>
  );
}

