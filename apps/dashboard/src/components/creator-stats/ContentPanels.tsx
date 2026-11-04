import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";

import type { CreatorStatsContentResponse } from "@agency_hub_core/contracts";
import { Pagination } from "@/components/shared/Pagination";
import { Segmented } from "@/components/ui/Segmented";
import { formatCount, formatPercent } from "@/lib/format";

import { SortHeader, type SortDir } from "./SortHeader.js";
import { StatsEmpty } from "./StatsCard.js";
import { averageWatchPercent, share } from "./creator-stats-model.js";
import { mediaLine, mediaTitle } from "./media-words.js";

export type MediaRow = CreatorStatsContentResponse["media"][number];

/** The server sends at most this many media of a window, the most viewed. */
const SERVER_LIMIT = 200;
const PAGE_SIZE = 50;

type SortKey = "postedAt" | "views" | "forYouViews" | "timelineViews" | "watch" | "completion" | "likes";
type Kind = "all" | "video" | "image";

/** The value a row sorts by; null sorts last whatever the direction. */
function sortValue(row: MediaRow, key: SortKey): number | null {
  switch (key) {
    case "watch": return averageWatchPercent(row.watchPctSum, row.videoViews);
    case "completion": return share(row.completedViews, row.videoViews);
    case "postedAt": return row.postedAt ? Date.parse(row.postedAt) : null;
    default: return row[key];
  }
}

function count(value: number | null): string {
  return value === null ? "—" : formatCount(value);
}

/** Opens a media's card from its row: a click, Enter or Space. */
export function rowOpener(open: () => void) {
  return {
    tabIndex: 0,
    role: "button",
    onClick: (event: MouseEvent<HTMLElement>) => {
      // The row itself is focusable: only a plain click on it, not on a link inside.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if ((event.target as Element).closest("a, button") !== null) return;
      open();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    },
  } as const;
}

/** «Медиа за период»: the page's media by views of the window; a row opens its card. */
export function MediaTable({ data, pageLabel, periodText, onOpen }: {
  data: CreatorStatsContentResponse;
  pageLabel: string;
  periodText: string;
  onOpen: (mediaOfferId: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>("views");
  const [dir, setDir] = useState<SortDir>("desc");
  const [kind, setKind] = useState<Kind>("all");
  const [offset, setOffset] = useState(0);

  const rows = useMemo(() => {
    const shown = data.media.filter((row) => kind === "all" || (kind === "video" ? row.mediaType === 2 : row.mediaType === 1));
    return [...shown].sort((left, right) => {
      const a = sortValue(left, sort);
      const b = sortValue(right, sort);
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return dir === "desc" ? b - a : a - b;
    });
  }, [data.media, dir, kind, sort]);

  const onSort = (key: SortKey) => {
    setOffset(0);
    if (key === sort) setDir(dir === "desc" ? "asc" : "desc");
    else {
      setSort(key);
      setDir("desc");
    }
  };
  const header = (label: string, key: SortKey, num = true) => (
    <SortHeader label={label} sortKey={key} current={sort} dir={dir} onSort={onSort} num={num} />
  );
  const page = rows.slice(offset, offset + PAGE_SIZE);
  const kindWord = kind === "video" ? "видео" : "фото";

  return (
    <section aria-labelledby="stats-media-title" className="stats-block">
      <h2 className="section-title stats-block-title" id="stats-media-title">Медиа за период</h2>
      <div className="table-toolbar">
        <Segmented
          label="Вид медиа"
          value={kind}
          onChange={(next) => {
            setKind(next);
            setOffset(0);
          }}
          options={[{ value: "all", label: "Все" }, { value: "video", label: "Видео" }, { value: "image", label: "Фото" }]}
        />
        {data.media.length >= SERVER_LIMIT && <span className="table-toolbar-note">Показаны 200 самых просматриваемых за период</span>}
      </div>
      <div className="card">
        {rows.length === 0 ? (
          kind === "all" ? (
            <StatsEmpty>На {pageLabel} за {periodText} просмотров медиа нет: обход только начался или медиа не смотрели.</StatsEmpty>
          ) : (
            <StatsEmpty action={<button type="button" className="btn btn-sm" onClick={() => setKind("all")}>Показать все</button>}>
              На {pageLabel} за {periodText} просмотренных {kindWord} нет.
            </StatsEmpty>
          )
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table data-table-sticky data-table-page stats-media-table">
                <thead>
                  <tr>
                    {header("Медиа и дата выхода", "postedAt", false)}
                    {header("Просмотры", "views")}
                    {header("For You", "forYouViews")}
                    {header("Лента подписок", "timelineViews")}
                    {header("Досмотр", "watch")}
                    {header("До конца", "completion")}
                    {header("Лайки", "likes")}
                  </tr>
                </thead>
                <tbody>
                  {page.map((row) => {
                    const watch = averageWatchPercent(row.watchPctSum, row.videoViews);
                    const completion = share(row.completedViews, row.videoViews);
                    return (
                      <tr key={row.mediaOfferId} className="stats-row-open" aria-label={`Открыть карточку: ${mediaTitle(row)}`} {...rowOpener(() => onOpen(row.mediaOfferId))}>
                        <td className="stats-media-cell">
                          <div className="stats-media-title">{mediaTitle(row)}</div>
                          <div className="stats-media-line">{mediaLine(row)}</div>
                        </td>
                        <td className="num">{count(row.views)}</td>
                        <td className="num">{count(row.forYouViews)}</td>
                        <td className="num">{count(row.timelineViews)}</td>
                        <td className="num">{watch === null ? "—" : formatPercent(watch)}</td>
                        <td className="num">{completion === null ? "—" : formatPercent(completion)}</td>
                        <td className="num">{count(row.likes)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length > PAGE_SIZE && <Pagination offset={offset} limit={PAGE_SIZE} total={rows.length} onPageChange={setOffset} />}
          </>
        )}
      </div>
    </section>
  );
}

/** «Первый проход ещё идёт: прочитано 26 из 38 медиа. Суммы пока неполные.» */
export function walkIncomplete(data: CreatorStatsContentResponse): string | null {
  return data.walk.queued > 0 && data.walk.visited < data.walk.queued
    ? `Первый проход ещё идёт: прочитано ${formatCount(data.walk.visited)} из ${formatCount(data.walk.queued)} медиа. Суммы пока неполные.`
    : null;
}
