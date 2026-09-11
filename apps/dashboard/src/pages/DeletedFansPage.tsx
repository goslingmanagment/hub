import { useParams, useSearchParams } from "react-router";
import { audiencePaginationLabels, updateAudienceSearch } from "@/lib/audienceNavigation";
import { listOffset } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { usePageDeletedFans } from "@/api/queries";
import { Pagination } from "@/components/shared/Pagination";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatDateTime } from "@/lib/format";

const LIMIT = 50;

function joinAliases(values: Array<string | null>) {
  const unique = [...new Set(values.filter(Boolean))] as string[];
  return unique.length > 0 ? unique.join(" / ") : null;
}

export function DeletedFansPage() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const [search, setSearch] = useSearchParams();
  const offset = listOffset(search.get("offset"));
  function setOffset(value: number) {
    setSearch((previous) => updateAudienceSearch(previous, { offset: value ? String(value) : null }, false));
  }

  const { data, isError, refetch } = usePageDeletedFans(
    pageLabel ?? "",
    { limit: LIMIT, offset },
    { enabled: Boolean(pageLabel) },
  );

  return (
    <div className="min-w-0 p-4 md:p-0">
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Удалённые аккаунты фанов &mdash; {pageLabel}
        </h1>
        <p className="mt-1 text-sm text-text-muted">{data ? `${data.total} записей` : "Число записей пока неизвестно"}</p>
      </div>

      <p className="mb-3 text-xs text-text-muted">История обнаружения удалённых аккаунтов на платформе. Прежние имена и связанные операции сохраняются в Hub.</p>
      <QueryNotice error={isError && Boolean(data)} stale={Boolean(data)} retry={refetch} />
      {!data ? (
        isError ? <StatusPanel title="Не удалось загрузить удалённые аккаунты" description="Повторите запрос, чтобы увидеть историю обнаружения." tone="error" action={<button type="button" className="text-accent font-semibold" onClick={() => void refetch()}>Повторить</button>} />
          : <div role="status" aria-label="Загрузка удалённых аккаунтов"><TableSkeleton rows={6} columns={5} /></div>
      ) : (
      <section className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[700px] border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {[
                "Последнее имя",
                "ID платформы",
                "Прежние имена",
                "Первое обнаружение",
                "Последнее подтверждение",
              ].map((col) => (
                <th
                  key={col}
                  className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-text-muted">
                  {offset > 0 ? "Эта страница больше не содержит записей." : "Удалённые аккаунты пока не обнаружены."}
                  {offset > 0 && <button type="button" className="block mx-auto mt-2 text-accent" onClick={() => setOffset(0)}>К началу списка</button>}
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
              ]);

              return (
                <tr key={item.platformUserId} className="border-t border-border">
                  <td className="px-4 py-3">
                    <div className="text-[15px] font-semibold text-text-primary">
                      {item.latestKnownLabel ?? item.platformUserId}
                    </div>
                    {item.latestKnownLabel && (
                      <div className="text-xs text-text-muted">{item.platformUserId}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary tabular-nums">
                    {item.platformUserId}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {aliases ?? "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {formatDateTime(item.deletedDetectedAt)}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {item.deletedLastDetectedAt ? formatDateTime(item.deletedLastDetectedAt) : "\u2014"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <Pagination
          offset={offset}
          limit={LIMIT}
          total={data.total}
          onPageChange={setOffset}
          {...audiencePaginationLabels}
        />
      </section>
      )}
    </div>
  );
}
