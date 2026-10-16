import { useLocation, useParams, useSearchParams } from "react-router";
import { listOffset } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { usePageDeletedFans } from "@/api/queries";
import { Pagination } from "@/components/shared/Pagination";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatDateTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";

const LIMIT = 50;

function joinAliases(values: Array<string | null>, exclude: string | null) {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value) && value !== exclude))];
  return unique.length > 0 ? unique.join(" / ") : null;
}

export function DeletedFansPage() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const offset = listOffset(search.get("offset"));
  function setOffset(value: number) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set("offset", String(value)); else next.delete("offset");
      return next;
    }, { state: location.state });
  }

  const { data, isLoading, isError, refetch } = usePageDeletedFans(
    pageLabel ?? "",
    { limit: LIMIT, offset },
    { enabled: Boolean(pageLabel) },
  );

  if (isLoading || !data) {
    if (isError) {
      return (
        <StatusPanel
          title="Не удалось загрузить удалённых фанов"
          description="Список удалённых аккаунтов этой страницы сейчас недоступен."
          tone="error"
          action={<button type="button" onClick={() => void refetch()}>Повторить</button>}
        />
      );
    }
    return <TableSkeleton rows={6} columns={4} />;
  }

  return (
    <div>
      <QueryNotice error={isError} stale={Boolean(data)} retry={refetch} />
      <div className="mb-3 text-[13px] text-text-secondary">
        <p className="tabular-nums">
          {offset > 0 && data.items.length === 0
            ? "Число записей пока недоступно"
            : `${data.total} ${ruPlural(data.total, "аккаунт", "аккаунта", "аккаунтов")}`}
        </p>
        <p className="mt-1">Даты показывают, когда Hub заметил удаление, а не точное время. Операции этих фанов остаются в истории.</p>
      </div>

      <section className="card overflow-hidden" aria-label="Удалённые фаны">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Фан</th>
                <th>Другие имена</th>
                <th>Замечено</th>
                <th>Последняя проверка</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-text-secondary">
                    {offset > 0 ? "На этой странице списка записей нет." : "Удалённых аккаунтов не найдено."}
                    {offset > 0 && <button type="button" className="link ml-2" onClick={() => setOffset(0)}>К началу списка</button>}
                  </td>
                </tr>
              )}
              {data.items.map((item) => {
                const aliases = joinAliases([
                  item.latestHistoricalPageAlias,
                  item.latestHistoricalUsername,
                  item.pageAlias,
                  item.displayName,
                  item.username,
                ], item.latestKnownLabel);

                return (
                  <tr key={item.platformUserId}>
                    <td>
                      {item.latestKnownLabel ? (
                        <>
                          <div className="font-medium">{item.latestKnownLabel}</div>
                          <div className="text-xs text-text-muted tabular-nums" title="ID на площадке">{item.platformUserId}</div>
                        </>
                      ) : (
                        <div className="text-text-secondary tabular-nums" title="ID на площадке">{item.platformUserId}</div>
                      )}
                    </td>
                    <td className="muted">{aliases ?? "—"}</td>
                    <td className="muted">{formatDateTime(item.deletedDetectedAt)}</td>
                    <td className="muted">
                      {item.deletedLastDetectedAt ? formatDateTime(item.deletedLastDetectedAt) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Pagination
          offset={offset}
          limit={LIMIT}
          total={data.total}
          onPageChange={setOffset}
        />
      </section>
    </div>
  );
}
