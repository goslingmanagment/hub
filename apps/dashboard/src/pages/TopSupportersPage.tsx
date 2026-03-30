import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useSpenders, useSpenderBatch } from "@/api/queries";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { buildFanProfileNavigation, buildPageSectionRoute } from "@/lib/navigation";
import { usePeriodStore } from "@/stores/periodStore";
import { formatUsdFromMills, resolveFanLabelForScope } from "@agency_hub_core/shared";
import { formatRelativeTime } from "@/lib/format";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import type { SpenderBatchBody } from "@agency_hub_core/contracts";

const LIMIT = 50;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

type TypeBreakdownItem = {
  canonicalType: string;
  grossAmountMills: number;
  creatorNetAmountMills: number;
  transactionCount: number;
};

function sumBreakdownTypes(
  breakdown: TypeBreakdownItem[] | null,
  types: string[],
): number {
  if (!breakdown) return 0;
  return breakdown
    .filter((b) => types.includes(b.canonicalType))
    .reduce((sum, b) => sum + b.creatorNetAmountMills, 0);
}

function whaleBadge(lifetimeScopeCreatorNetMills: number) {
  if (lifetimeScopeCreatorNetMills >= 500_000)
    return <span className="ml-1.5 inline-flex items-center rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-bold text-blue-400">🐋 Whale</span>;
  if (lifetimeScopeCreatorNetMills >= 100_000)
    return <span className="ml-1.5 inline-flex items-center rounded-md bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-bold text-purple-400">💎 VIP</span>;
  if (lifetimeScopeCreatorNetMills >= 50_000)
    return <span className="ml-1.5 inline-flex items-center rounded-md bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-bold text-yellow-400">⭐ Regular</span>;
  return null;
}

export function TopSupportersPage() {
  const { pageLabel } = useParams();
  const navigate = useNavigate();
  const selectedPeriod = usePeriodStore((s) => s.period);
  const customFrom = usePeriodStore((s) => s.customFrom);
  const customTo = usePeriodStore((s) => s.customTo);
  const [searchQuery, setSearchQuery] = useState("");
  const [offset, setOffset] = useState(0);

  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;

  useEffect(() => {
    setOffset(0);
  }, [searchQuery, spenderPeriod]);

  const spenderParams = useMemo(() => ({
    scope: "page" as const,
    pageLabel,
    period: spenderPeriod,
    limit: LIMIT,
    offset,
    sortBy: "creatorNetAmountMills" as const,
    sortDir: "desc" as const,
    query: searchQuery || undefined,
    from: spenderPeriod === "custom" ? customFrom : undefined,
    to: spenderPeriod === "custom" ? customTo : undefined,
  }), [pageLabel, spenderPeriod, offset, searchQuery, customFrom, customTo]);

  const { data: spenders, isLoading } = useSpenders(spenderParams);

  const platform = spenders?.scope?.page?.platform;
  const items = spenders?.items ?? [];

  const batchBody: SpenderBatchBody | null = useMemo(() => {
    if (!platform || !pageLabel || items.length === 0) return null;
    return {
      scope: "page",
      pageLabel,
      period: spenderPeriod === "custom" ? "custom" : spenderPeriod,
      from: spenderPeriod === "custom" ? customFrom : undefined,
      to: spenderPeriod === "custom" ? customTo : undefined,
      fans: items.map((item) => ({
        platform,
        platformUserId: item.fan.platformUserId,
      })),
    };
  }, [platform, pageLabel, items, spenderPeriod, customFrom, customTo]);

  const { data: batchData } = useSpenderBatch(batchBody);

  const batchByPlatformUserId = useMemo(() => {
    const map = new Map<string, {
      typeBreakdown: TypeBreakdownItem[] | null;
      lifetimeLastTransactionAt: string | null;
    }>();
    if (!batchData) return map;
    for (const item of batchData.items) {
      if (item.found) {
        map.set(item.requestedFan.platformUserId, {
          typeBreakdown: item.typeBreakdown,
          lifetimeLastTransactionAt: item.lifetimeLastTransactionAt,
        });
      }
    }
    return map;
  }, [batchData]);

  if (isLoading || !spenders) {
    return <TableSkeleton rows={6} columns={7} />;
  }

  const total = spenders.total;

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Top Supporters &mdash; {pageLabel}
        </h1>
        <p className="text-sm text-text-muted mt-1">{total} total</p>
      </div>

      <div className="flex items-center justify-end mb-4">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search supporter..."
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {[
                { label: "Rank", align: "text-left" },
                { label: "Fan", align: "text-left" },
                { label: "Spent", align: "text-right" },
                { label: "Tips", align: "text-right" },
                { label: "Subs", align: "text-right" },
                { label: "Purchases", align: "text-right" },
                { label: "Last Active", align: "text-left" },
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
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-text-muted">
                  No supporters found for this period.
                </td>
              </tr>
            )}
            {items.map((item, index) => {
              const fanLabel = resolveFanLabelForScope(item.fan, "page");
              const lifetimeNet = item.metrics.lifetime.scopeCreatorNetAmountMills;
              const windowMetrics = item.metrics.window;
              const spent = spenderPeriod === "lifetime"
                ? lifetimeNet
                : (windowMetrics?.creatorNetAmountMills ?? 0);

              const batch = batchByPlatformUserId.get(item.fan.platformUserId);
              const hasBatch = !!batchData;
              const tips = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["tip", "stream_tip"]);
              const subs = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["subscription"]);
              const purchases = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["message_purchase", "post_purchase"]);

              const lastActive = batch?.lifetimeLastTransactionAt;
              const isInactive = lastActive
                ? Date.now() - new Date(lastActive).getTime() > FOURTEEN_DAYS_MS
                : false;
              const fanNavigation = buildFanProfileNavigation(
                pageLabel!,
                platform!,
                item.fan.platformUserId,
                buildPageSectionRoute(pageLabel!, "top-supporters"),
                fanLabel.label,
              );

              return (
                <tr
                  key={item.fan.platformUserId}
                  onClick={() => navigate(fanNavigation.to, { state: fanNavigation.state })}
                  className="cursor-pointer border-t border-border transition-colors hover:bg-hover"
                >
                  <td className="px-4 py-3 text-sm text-text-secondary tabular-nums">
                    {offset + index + 1}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center">
                      <span className="text-[15px] font-semibold text-text-primary">
                        {fanLabel.label}
                      </span>
                      {whaleBadge(lifetimeNet)}
                    </div>
                    {fanLabel.secondaryPlatformHandle && (
                      <div className="text-xs text-text-muted">@{fanLabel.secondaryPlatformHandle}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-text-primary">
                    {formatUsdFromMills(spent)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums text-text-secondary">
                    {hasBatch ? formatUsdFromMills(tips) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums text-text-secondary">
                    {hasBatch ? formatUsdFromMills(subs) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums text-text-secondary">
                    {hasBatch ? formatUsdFromMills(purchases) : "—"}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {!hasBatch ? (
                      "—"
                    ) : lastActive ? (
                      <span className="flex items-center gap-1.5">
                        {formatRelativeTime(lastActive)}
                        {isInactive && (
                          <span className="inline-flex items-center rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-bold text-danger">
                            INACTIVE
                          </span>
                        )}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <Pagination
          offset={offset}
          limit={LIMIT}
          total={total}
          onPageChange={setOffset}
        />
      </section>
    </div>
  );
}
