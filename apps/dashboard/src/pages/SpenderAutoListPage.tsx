import { useMemo } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { usePageSpenderAutoList } from "@/api/queries";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import {
  buildFanProfileNavigation,
  resolveSpenderPeriod,
} from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { formatDate, formatDateTime } from "@/lib/format";
import { useSpenderPeriodStore } from "@/stores/spenderPeriodStore";
import { formatUsdFromMills, resolveFanLabelForScope } from "@agency_hub_core/shared";

const LIMIT = 50;

function statusBadgeClass(tone: "green" | "danger" | "warning" | "muted") {
  if (tone === "green") return "bg-green/15 text-green";
  if (tone === "danger") return "bg-danger/15 text-danger";
  if (tone === "warning") return "bg-warning/15 text-warning-dark";
  return "bg-hover-alt text-text-muted";
}

function StatusBadge({ tone, children }: { tone: "green" | "danger" | "warning" | "muted"; children: string }) {
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${statusBadgeClass(tone)}`}>
      {children}
    </span>
  );
}

export function SpenderAutoListPage() {
  const { pageLabel, bucketKey } = useParams<{ pageLabel: string; bucketKey: string }>();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const storedPeriod = useSpenderPeriodStore((s) => s.period);
  const selectedPeriod = resolveSpenderPeriod(search.get("period"), storedPeriod);
  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;
  const searchQuery = search.get("query") ?? "";
  const excludeNonFollowers = search.get("followersOnly") === "true";
  const offset = listOffset(search.get("offset"));
  function update(key: string, value: string) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value); else next.delete(key);
      if (key !== "offset") next.delete("offset");
      return next;
    });
  }
  const params = useMemo(() => ({
    limit: LIMIT,
    offset,
    ...(searchQuery ? { query: searchQuery } : {}),
    ...(excludeNonFollowers ? { excludeNonFollowers: true } : {}),
    period: spenderPeriod,
  }), [excludeNonFollowers, offset, searchQuery, spenderPeriod]);

  const { data, isLoading, isError, refetch } = usePageSpenderAutoList(
    pageLabel ?? "",
    bucketKey ?? "",
    params,
    { enabled: Boolean(pageLabel && bucketKey) },
  );

  if (isLoading || !data) {
    if (isError) {
      return (
        <StatusPanel
          title="Auto list failed to load"
          description="The spender auto-list could not be fetched for this page."
          tone="error"
          action={<button type="button" onClick={() => void refetch()}>Повторить</button>}
        />
      );
    }
    return <TableSkeleton rows={6} columns={5} />;
  }

  const pageRoute = `${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(search), period: selectedPeriod })}`;

  return (
    <div>
      <QueryNotice error={isError} stale={Boolean(data)} retry={refetch} />
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          {data.bucket.label}
        </h1>
        <p className="text-sm text-text-muted mt-1">
          {offset > 0 && data.items.length === 0 ? "Число записей в фильтре пока недоступно" : `${data.total} entries`} on {pageLabel}
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-semibold text-text-secondary">
          <input
            type="checkbox"
            checked={excludeNonFollowers}
            onChange={(event) => update("followersOnly", event.target.checked ? "true" : "")}
            className="h-4 w-4 accent-accent"
          />
          Exclude non-followers
        </label>
        <SearchInput
          value={searchQuery}
          onChange={(value) => update("query", value)}
          placeholder="Search fan..."
        />
      </div>

      <section className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[680px] border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {[
                { label: "Fan", align: "text-left" },
                { label: "Status", align: "text-left" },
                { label: "Gross Spent", align: "text-right" },
                { label: "Creator Net", align: "text-right" },
                { label: "Last Txn", align: "text-left" },
              ].map((col) => (
                <th
                  key={col.label}
                  className={`px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-text-muted ${col.align}`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-text-muted">
                  {offset > 0 ? "На этой странице списка записей нет." : "No fans found in this auto list."}
                  {offset > 0 && <button type="button" className="ml-2 text-accent" onClick={() => update("offset", "")}>К началу списка</button>}
                </td>
              </tr>
            )}
            {data.items.map((item) => {
              const fanLabel = resolveFanLabelForScope(item.fan, "page");
              const fanNavigation = buildFanProfileNavigation(
                pageLabel!,
                data.page.platform,
                item.fan.platformUserId,
                pageRoute,
                fanLabel.label,
              );

              return (
                <tr
                  key={item.fan.platformUserId}
                  className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
                >
                  <td className="px-4 py-3">
                    <Link to={`${fanNavigation.to}?${new URLSearchParams({ period: selectedPeriod })}`} state={fanNavigation.state} className="text-[15px] font-semibold text-text-primary hover:text-accent">
                      {fanLabel.label}
                    </Link>
                    {fanLabel.secondaryPlatformHandle && (
                      <div className="text-xs text-text-muted">@{fanLabel.secondaryPlatformHandle}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {item.isFollower ? (
                        <StatusBadge tone="green">Follower</StatusBadge>
                      ) : (
                        <StatusBadge tone="danger">Non-follower</StatusBadge>
                      )}
                      {item.subscriptionStatus === "active" && (
                        <StatusBadge tone="green">Active sub</StatusBadge>
                      )}
                      {item.subscriptionStatus === "expired" && (
                        <StatusBadge tone="warning">Expired sub</StatusBadge>
                      )}
                      {item.subscriptionStatus === "never" && (
                        <StatusBadge tone="muted">No sub</StatusBadge>
                      )}
                    </div>
                    {item.subscriptionStatus === "expired" && item.lastSubscriptionEndedAt && (
                      <div className="mt-1 text-xs text-text-muted">
                        Ended {formatDate(item.lastSubscriptionEndedAt, { includeYear: true })}
                      </div>
                    )}
                    {item.subscriptionStatus === "active" && item.subscriptionExpiresAt && (
                      <div className="mt-1 text-xs text-text-muted">
                        Expires {formatDate(item.subscriptionExpiresAt, { includeYear: true })}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-text-primary">
                    {formatUsdFromMills(item.grossAmountMills)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums text-text-secondary">
                    {formatUsdFromMills(item.creatorNetAmountMills)}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {item.lastTransactionAt ? formatDateTime(item.lastTransactionAt) : "\u2014"}
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
          onPageChange={(value) => update("offset", String(value))}
        />
      </section>
    </div>
  );
}
