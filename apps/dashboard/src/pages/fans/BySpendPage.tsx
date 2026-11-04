import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { usePageSpenderAutoLists } from "@/api/queries";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Skeleton";
import { formatCount } from "@/lib/format";
import { buildPageSpenderAutoListRoute } from "@/lib/navigation";
import { ruPlural } from "@/lib/plural";
import { isPlainRowClick } from "@/lib/rowClick";
import { bucketAmount, copyFanNames } from "./copyFanNames.js";
import { periodPhrase, spenderPeriodOf } from "./fanWords.js";

/**
 * «По сумме трат» of one page: the lists by the sum a fan spent, with their names
 * to copy into the same lists on the platform. Its own period, all time by default (§6).
 */
export function BySpendPage() {
  const filter = usePageFilter();
  const pageLabel = filter.page ?? "";
  const fansly = filter.item?.platform === "fansly";
  const navigate = useNavigate();
  const { key } = useScreenPeriod();
  const period = spenderPeriodOf(key);
  const lists = usePageSpenderAutoLists(pageLabel, { period }, { enabled: pageLabel.length > 0 });
  const [copying, setCopying] = useState<string | null>(null);

  const header = (
    <PageHeader fresh={lists.data?.asOf ? { at: lists.data.asOf, onRefresh: () => void lists.refetch(), refreshing: lists.isFetching && !lists.isLoading } : undefined} />
  );
  if (!lists.data) {
    return <div className="fan-screen">{header}{lists.isError ? <NoAnswerPanel retry={lists.refetch} /> : <TableSkeleton rows={6} columns={4} />}</div>;
  }
  const data = lists.data;

  return (
    <div className="fan-screen">
      {header}
      <QueryNotice error={lists.isError} stale retry={lists.refetch} at={lists.dataUpdatedAt} />
      {data.totalEntries === 0 ? (
        <StatusPanel title={`На ${pageLabel} ${periodPhrase(key)} покупок нет`} />
      ) : (
        <section className="card" aria-labelledby="by-spend-title">
          <div className="card-header">
            <h2 id="by-spend-title" className="card-title">По сумме трат: {periodPhrase(key)}, до комиссии</h2>
            <span className="fan-card-meta">{formatCount(data.totalEntries)} {ruPlural(data.totalEntries, "фан", "фана", "фанов")}</span>
          </div>
          <div className={`table-wrap ${lists.isFetching && !lists.isLoading ? "is-refreshing" : ""}`}>
            <table className="data-table fan-table">
              <thead>
                <tr>
                  <th scope="col">Сумма</th>
                  <th scope="col" className="num">Фанов</th>
                  {fansly && <th scope="col">Список на Fansly</th>}
                  <th scope="col" className="fan-action-col"><span className="sr-only">Действие</span></th>
                </tr>
              </thead>
              <tbody>
                {data.lists.map((bucket) => {
                  const to = buildPageSpenderAutoListRoute(pageLabel, bucket.key, { period: key });
                  const amount = bucketAmount(bucket);
                  return (
                    <tr key={bucket.key} className="cursor-pointer" onClick={(event) => { if (isPlainRowClick(event)) navigate(to); }}>
                      <td><Link className="fan-link" to={to}>{amount}</Link></td>
                      <td className={`num ${bucket.entryCount === 0 ? "muted" : ""}`}>{formatCount(bucket.entryCount)}</td>
                      {fansly && <td className="muted">{bucket.label}</td>}
                      <td className="fan-action-col">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={bucket.entryCount === 0 || copying !== null}
                          onClick={() => {
                            setCopying(bucket.key);
                            void copyFanNames({ pageLabel, bucketKey: bucket.key, bucketLabel: amount, period }).finally(() => setCopying(null));
                          }}
                        >
                          {copying === bucket.key ? <><Spinner /> Копируем…</> : "Скопировать имена"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <Disclosure>
        <p>Сумма — до комиссии, как в списках на Fansly. Остальные суммы консоли — после комиссии.</p>
        <p>По умолчанию список за всё время: так его ведёт Fansly. Если выбрать период, в список попадут те, кто потратил столько за эти дни.</p>
      </Disclosure>
    </div>
  );
}
