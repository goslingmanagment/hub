import { useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { usePageDeletedFans } from "@/api/queries";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { Pagination } from "@/components/shared/Pagination";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Segmented } from "@/components/ui/Segmented";
import { formatCount, formatDateTime, formatMills } from "@/lib/format";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { ruPlural } from "@/lib/plural";
import { isPlainRowClick } from "@/lib/rowClick";
import { FanCell } from "./FanCell.js";
import { fanName, lastPurchaseKind } from "./fanWords.js";
import { EmptyRow, PastTheEnd, useListParams, useViewerOfapi } from "./listParts.js";
import { useAllPayers } from "./useAllPayers.js";

const LIMIT = 50;

type Reason = "deleted" | "hidden";

function joinNames(values: Array<string | null>, exclude: string | null): string | null {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value) && value !== exclude))];
  return unique.length > 0 ? unique.join(" / ") : null;
}

function accountsWord(count: number): string {
  return `${formatCount(count)} ${ruPlural(count, "аккаунт", "аккаунта", "аккаунтов")}`;
}

/**
 * «Ушли»: who deleted the account, and who the page no longer sees, and what they
 * brought. A deleted account has no card: its rows open nothing (§5).
 */
export function GonePage() {
  const filter = usePageFilter();
  const pageLabel = filter.page ?? "";
  const platform = filter.item?.platform ?? "fansly";
  const { search, update } = useListParams();
  const reason: Reason = search.get("reason") === "hidden" ? "hidden" : "deleted";
  const offset = listOffset(search.get("offset"));
  const deleted = usePageDeletedFans(pageLabel, { limit: LIMIT, offset }, { enabled: pageLabel.length > 0 && reason === "deleted" });
  const deletedCount = usePageDeletedFans(pageLabel, { limit: 1 }, { enabled: pageLabel.length > 0 });
  const payers = useAllPayers(pageLabel, { enabled: reason === "hidden" });
  const hidden = useMemo(() => payers.data?.items.filter((row) => row.accountLookupMissAt !== null) ?? null, [payers.data]);

  return (
    <div className="fan-screen">
      <div className="table-toolbar fan-toolbar">
        <Segmented
          label="Почему ушли"
          value={reason}
          onChange={(next) => update({ reason: next === "deleted" ? null : next })}
          options={[
            { value: "deleted", label: "Удалили аккаунт", count: deletedCount.data === undefined ? undefined : formatCount(deletedCount.data.total) },
            { value: "hidden", label: "Не видны странице", count: hidden === null ? undefined : formatCount(hidden.length) },
          ]}
        />
      </div>
      {reason === "deleted"
        ? <DeletedList pageLabel={pageLabel} offset={offset} query={deleted} onOffset={(next) => update({ offset: next === 0 ? null : String(next) })} />
        : <HiddenList pageLabel={pageLabel} platform={platform} offset={offset} query={payers} rows={hidden} onOffset={(next) => update({ offset: next === 0 ? null : String(next) })} />}
    </div>
  );
}

function DeletedList({ pageLabel, offset, query, onOffset }: {
  pageLabel: string;
  offset: number;
  query: ReturnType<typeof usePageDeletedFans>;
  onOffset: (offset: number) => void;
}) {
  if (!query.data) return query.isError ? <NoAnswerPanel retry={query.refetch} /> : <TableSkeleton rows={8} columns={5} />;
  const { items, total } = query.data;
  return (
    <>
      <QueryNotice error={query.isError} stale retry={query.refetch} at={query.dataUpdatedAt} />
      <div className="fan-count-row">
        <p className="fan-count">
          {accountsWord(total)}. Даты показывают, когда Hub заметил удаление, а не точное время. Операции этих фанов остаются в истории.
        </p>
        <Link className="link" to={`/money/transactions?${new URLSearchParams({ page: pageLabel })}`}>Все операции страницы</Link>
      </div>
      <section className="card" aria-label="Удалили аккаунт">
        <div className="table-wrap">
          <table className="data-table data-table-sticky fan-table">
            <thead>
              <tr>
                <th scope="col">Фан</th>
                <th scope="col">Другие имена</th>
                <th scope="col" className="num">Потратил за всё время</th>
                <th scope="col">Замечено</th>
                <th scope="col">Последняя проверка</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (offset > 0
                ? <PastTheEnd colSpan={5} onBack={() => onOffset(0)} />
                : <EmptyRow colSpan={5} title={`На ${pageLabel} удалённых аккаунтов не найдено.`} />)}
              {items.map((item) => {
                const label = item.latestKnownLabel ?? `Удалённый аккаунт · ${item.platformUserId.slice(-8)}`;
                const others = joinNames([item.pageAlias, item.displayName, item.username, item.latestHistoricalPageAlias, item.latestHistoricalUsername], item.latestKnownLabel);
                return (
                  <tr key={item.platformUserId}>
                    <td><FanCell name={label} title={`Номер на площадке: ${item.platformUserId}`} /></td>
                    <td className={others ? undefined : "muted"}>{others ?? "—"}</td>
                    <td className={`num ${item.totalCreatorNetMills === 0 ? "muted" : ""}`}>{formatMills(item.totalCreatorNetMills)}</td>
                    <td>{formatDateTime(item.deletedDetectedAt, { yearUnlessCurrent: true })}</td>
                    <td className={item.deletedLastDetectedAt ? undefined : "muted"}>{item.deletedLastDetectedAt ? formatDateTime(item.deletedLastDetectedAt, { yearUnlessCurrent: true }) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {total > 0 && <Pagination offset={offset} limit={LIMIT} total={total} onPageChange={onOffset} />}
      </section>
    </>
  );
}

function HiddenList({ pageLabel, platform, offset, query, rows, onOffset }: {
  pageLabel: string;
  platform: string;
  offset: number;
  query: ReturnType<typeof useAllPayers>;
  rows: NonNullable<ReturnType<typeof useAllPayers>["data"]>["items"] | null;
  onOffset: (offset: number) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { ofapi } = useViewerOfapi();
  if (!rows) return query.isError ? <NoAnswerPanel retry={query.refetch} /> : <TableSkeleton rows={8} columns={4} />;
  const shown = rows.slice(offset, offset + LIMIT);
  const here = `${location.pathname}${location.search}`;
  return (
    <>
      <QueryNotice error={query.isError} stale retry={query.refetch} at={query.dataUpdatedAt} />
      <div className="fan-count-row">
        <p className="fan-count">
          Страница больше не видит аккаунт: скорее всего, фан заблокировал страницу или удалил аккаунт. Показаны только фаны с покупками.
          {platform === "onlyfans" && ofapi === "off" && " Проверка шла через OnlyFans API: по 1 ноября."}
          {query.data?.capped && ` Проверены первые ${formatCount(query.data.items.length)} платящих.`}
        </p>
      </div>
      <section className="card" aria-label="Не видны странице">
        <div className="table-wrap">
          <table className="data-table data-table-sticky fan-table">
            <thead>
              <tr>
                <th scope="col">Фан</th>
                <th scope="col" className="num">Потратил за всё время</th>
                <th scope="col">Последняя покупка</th>
                <th scope="col">Проверено</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (offset > 0
                ? <PastTheEnd colSpan={4} onBack={() => onOffset(0)} />
                : <EmptyRow colSpan={4} title={`Страница ${pageLabel} видит всех своих платящих.`} />)}
              {shown.map((row) => {
                const name = fanName(row.fan);
                const nav = buildFanProfileNavigation(pageLabel, platform, row.fan.platformUserId, here, name.label);
                const last = row.lastTransaction;
                return (
                  <tr key={row.fan.platformUserId} className="cursor-pointer" onClick={(event) => { if (isPlainRowClick(event)) navigate(nav.to, { state: nav.state }); }}>
                    <td><FanCell name={name.label} to={nav.to} state={nav.state} handle={name.handle} /></td>
                    <td className="num">{formatMills(row.metrics.lifetime.scopeCreatorNetAmountMills)}</td>
                    <td>
                      {last ? (
                        <>
                          <div>{formatDateTime(last.occurredAt, { yearUnlessCurrent: true })}</div>
                          <div className="fan-cell-sub">{lastPurchaseKind(last.canonicalType)} · {formatMills(last.creatorNetAmountMills)}</div>
                        </>
                      ) : "—"}
                    </td>
                    <td>{row.accountLookupMissAt ? formatDateTime(row.accountLookupMissAt, { yearUnlessCurrent: true }) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > 0 && <Pagination offset={offset} limit={LIMIT} total={rows.length} onPageChange={onOffset} />}
      </section>
    </>
  );
}
