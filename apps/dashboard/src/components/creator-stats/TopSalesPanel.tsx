import { useState } from "react";

import type { CreatorStatsContentResponse } from "@agency_hub_core/contracts";
import { Pagination } from "@/components/shared/Pagination";
import { formatCount, formatMills } from "@/lib/format";

import { rowOpener } from "./ContentPanels.js";
import { StatsCard, StatsEmpty } from "./StatsCard.js";
import { mediaLine, mediaTitle } from "./media-words.js";

/** Fifty at most from the server: twenty a page keeps the tab short. */
const PAGE_SIZE = 20;

type SoldRow = CreatorStatsContentResponse["topSales"][number];

function money(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : formatMills(value);
}

/**
 * «Что покупают»: the page's media by net sales, whatever their views. Fansly
 * serves sales only as an all-time total, so this list has no period; most sold
 * in messages, without a post or a caption, and are known by kind, length, date.
 * The order is the server's (by net, fixed).
 */
export function TopSalesPanel({ data, pageLabel, onOpen }: {
  data: CreatorStatsContentResponse;
  pageLabel: string;
  onOpen: (mediaOfferId: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const rows: readonly SoldRow[] = data.topSales;
  const page = rows.slice(offset, offset + PAGE_SIZE);
  const more = data.topSalesTotal > rows.length;
  return (
    <StatsCard
      id="stats-top-sales"
      title="Что покупают"
      description="За всё время, не за выбранный период: Fansly отдаёт продажи только итогом."
      footer={rows.length > PAGE_SIZE ? (
        <Pagination
          offset={offset}
          limit={PAGE_SIZE}
          total={rows.length}
          onPageChange={setOffset}
          formatRange={(start, end, total) => `${start}–${end} из ${total}${more ? `, а всего проданных ${formatCount(data.topSalesTotal)}` : ""}`}
        />
      ) : more && rows.length > 0 ? (
        <div className="card-footer">
          <span className="tabular-nums">Показаны {formatCount(rows.length)} из {formatCount(data.topSalesTotal)} проданных</span>
        </div>
      ) : undefined}
    >
      {rows.length === 0 ? (
        <StatsEmpty>На {pageLabel} проданных медиа нет.</StatsEmpty>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Медиа</th>
                <th scope="col" className="num">Цена</th>
                <th scope="col" className="num">Продано</th>
                <th scope="col" className="num">Доход после комиссии</th>
                <th scope="col" className="num">До комиссии, расчёт</th>
                <th scope="col" className="num">Просмотры за период</th>
              </tr>
            </thead>
            <tbody>
              {page.map((row) => (
                <tr key={row.mediaOfferId} className="stats-row-open" aria-label={`Открыть карточку: ${mediaTitle(row)}`} {...rowOpener(() => onOpen(row.mediaOfferId))}>
                  <td className="stats-media-cell">
                    <div className="stats-media-title">{mediaTitle(row)}</div>
                    <div className="stats-media-line">{mediaLine(row)}</div>
                  </td>
                  <td className="num">{money(row.priceMills)}</td>
                  <td className="num">{row.sales.count === null ? "—" : formatCount(row.sales.count)}</td>
                  <td className="num">{money(row.sales.netMills)}</td>
                  <td className="num muted">{money(row.sales.grossMills?.value)}</td>
                  <td className="num">{row.windowViews === null ? "—" : formatCount(row.windowViews)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StatsCard>
  );
}
