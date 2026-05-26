import { useState } from "react";
import { useParams } from "react-router";
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
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isError } = usePageDeletedFans(
    pageLabel ?? "",
    { limit: LIMIT, offset },
    { enabled: Boolean(pageLabel) },
  );

  if (isLoading || !data) {
    if (isError) {
      return (
        <StatusPanel
          title="Deleted fans failed to load"
          description="The deleted fan audit could not be fetched for this page."
          tone="error"
        />
      );
    }
    return <TableSkeleton rows={6} columns={5} />;
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Deleted Fans &mdash; {pageLabel}
        </h1>
        <p className="mt-1 text-sm text-text-muted">{data.total} total</p>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {[
                "Last Known",
                "Platform ID",
                "Aliases",
                "First Detected",
                "Last Confirmed",
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
                  No deleted fans recorded.
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
          emptyLabel="0 fans"
        />
      </section>
    </div>
  );
}
