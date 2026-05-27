import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useSpenders, useSpenderBatch } from "@/api/queries";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { buildFanProfileNavigation, buildPageSectionRoute } from "@/lib/navigation";
import { useSpenderPeriodStore } from "@/stores/spenderPeriodStore";
import {
  SPENDER_RETENTION_ACTIVE_DAYS,
  SPENDER_RETENTION_INACTIVE_DAYS,
  formatUsdFromMills,
  resolveFanLabelForScope,
  type SpenderRetentionStatus,
} from "@agency_hub_core/shared";
import { formatDelta, formatRelativeTime, transactionTypeLabel } from "@/lib/format";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import type { SpenderBatchBody, SpenderListResponse } from "@agency_hub_core/contracts";

const LIMIT = 50;

type TypeBreakdownItem = {
  canonicalType: string;
  grossAmountMills: number;
  creatorNetAmountMills: number;
  transactionCount: number;
};

type RetentionFilter = SpenderRetentionStatus;
type SpenderListItem = SpenderListResponse["items"][number];
type SpenderConversation = SpenderListItem["conversation"];
type SpenderLastTransaction = SpenderListItem["lastTransaction"];

const RETENTION_FILTERS: { key: RetentionFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "cooling", label: "Cooling" },
  { key: "inactive", label: "Inactive" },
  { key: "needs_reactivation", label: "Needs reactivation" },
];

const ROW_STATUS_BADGES: Record<Exclude<RetentionFilter, "all">, { label: string; className: string }> = {
  active: {
    label: "ACTIVE",
    className: "bg-green/15 text-green",
  },
  cooling: {
    label: "COOLING",
    className: "bg-warning/15 text-warning-dark",
  },
  inactive: {
    label: "INACTIVE",
    className: "bg-text-muted/15 text-text-muted",
  },
  needs_reactivation: {
    label: "REACTIVATE",
    className: "bg-danger/15 text-danger",
  },
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

function timestampMs(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function isUnansweredConversation(conversation: SpenderConversation) {
  const fanAt = timestampMs(conversation.lastFanMessageAt);
  if (fanAt === null) return false;
  const modelAt = timestampMs(conversation.lastModelMessageAt);
  return modelAt === null || fanAt > modelAt;
}

function ChatCell({ conversation }: { conversation: SpenderConversation }) {
  const hasConversation = conversation.platformConversationId !== null;
  const hasAnyMessage = conversation.lastMessageAt !== null ||
    conversation.lastFanMessageAt !== null ||
    conversation.lastModelMessageAt !== null;

  if (!hasConversation && !hasAnyMessage) {
    return <span className="text-text-muted">No DM</span>;
  }

  const unanswered = isUnansweredConversation(conversation);

  return (
    <div className="max-w-[280px] space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-text-primary">
          {conversation.lastMessageAt ? formatRelativeTime(conversation.lastMessageAt) : "DM synced"}
        </span>
        {unanswered && (
          <span className="inline-flex rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-warning-dark">
            Unanswered
          </span>
        )}
        {conversation.unreadCount > 0 && (
          <span className="inline-flex rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent">
            {conversation.unreadCount} unread
          </span>
        )}
      </div>
      <div className="text-xs text-text-muted">
        Fan {conversation.lastFanMessageAt ? formatRelativeTime(conversation.lastFanMessageAt) : "never"}
        <span className="mx-1 text-border">·</span>
        Model {conversation.lastModelMessageAt ? formatRelativeTime(conversation.lastModelMessageAt) : "never"}
      </div>
      {conversation.lastMessagePreview && (
        <div className="truncate text-xs text-text-muted">
          {conversation.lastMessagePreview}
        </div>
      )}
    </div>
  );
}

function LastTransactionCell({ transaction }: { transaction: SpenderLastTransaction }) {
  if (!transaction) {
    return <span className="text-text-muted">—</span>;
  }

  return (
    <div className="space-y-1">
      <div className="font-medium text-text-primary">
        {formatRelativeTime(transaction.occurredAt)}
      </div>
      <div className="flex flex-wrap items-center justify-start gap-1.5 text-xs text-text-muted">
        <span>{transactionTypeLabel(transaction.canonicalType)}</span>
        <span className="text-border">·</span>
        <span className="tabular-nums">{formatUsdFromMills(transaction.creatorNetAmountMills)}</span>
        {transaction.transactionState !== "posted" && (
          <span className="inline-flex rounded-md bg-hover-alt px-1.5 py-0.5 text-[10px] font-bold uppercase text-text-muted">
            {transaction.transactionState}
          </span>
        )}
      </div>
    </div>
  );
}

export function TopSupportersPage() {
  const { pageLabel } = useParams();
  const navigate = useNavigate();
  const selectedPeriod = useSpenderPeriodStore((s) => s.topSupportersPeriod);
  const [searchQuery, setSearchQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [retentionFilter, setRetentionFilter] = useState<RetentionFilter>("all");

  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;

  useEffect(() => {
    setOffset(0);
  }, [pageLabel, searchQuery, spenderPeriod, retentionFilter]);

  const spenderParams = useMemo(() => ({
    scope: "page" as const,
    pageLabel,
    period: spenderPeriod,
    limit: LIMIT,
    offset,
    sortBy: "creatorNetAmountMills" as const,
    sortDir: "desc" as const,
    query: searchQuery || undefined,
    retentionStatus: retentionFilter,
  }), [pageLabel, spenderPeriod, offset, searchQuery, retentionFilter]);

  const { data: spenders, isLoading } = useSpenders(spenderParams);

  const platform = spenders?.scope?.page?.platform;
  const items = spenders?.items ?? [];

  const batchBody: SpenderBatchBody | null = useMemo(() => {
    if (!platform || !pageLabel || items.length === 0) return null;
    return {
      scope: "page",
      pageLabel,
      period: spenderPeriod,
      fans: items.map((item) => ({
        platform,
        platformUserId: item.fan.platformUserId,
      })),
    };
  }, [platform, pageLabel, items, spenderPeriod]);

  const { data: batchData } = useSpenderBatch(batchBody);

  const batchByPlatformUserId = useMemo(() => {
    const map = new Map<string, {
      typeBreakdown: TypeBreakdownItem[] | null;
    }>();
    if (!batchData) return map;
    for (const item of batchData.items) {
      if (item.found) {
        map.set(item.requestedFan.platformUserId, {
          typeBreakdown: item.typeBreakdown,
        });
      }
    }
    return map;
  }, [batchData]);

  if (isLoading || !spenders) {
    return <TableSkeleton rows={6} columns={spenderPeriod === "lifetime" ? 9 : 10} />;
  }

  const total = spenders.total;
  const isLifetime = spenderPeriod === "lifetime";
  const columnCount = isLifetime ? 9 : 10;
  const subtitle = describeRetentionSubtitle(retentionFilter);

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold text-text-primary">
          Top Supporters &mdash; {pageLabel}
        </h1>
        <p className="text-sm text-text-muted mt-1">
          {total} {retentionFilter === "all" ? "total" : "match"}
          {subtitle ? ` · ${subtitle}` : ""}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div role="tablist" aria-label="Retention filter" className="flex flex-wrap items-center gap-1">
          {RETENTION_FILTERS.map((filter) => {
            const isActive = retentionFilter === filter.key;
            return (
              <button
                key={filter.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setRetentionFilter(filter.key)}
                className={`rounded-button px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  isActive
                    ? "bg-accent text-white"
                    : "border border-border bg-card text-text-secondary hover:bg-hover"
                }`}
              >
                {filter.label}
              </button>
            );
          })}
        </div>
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search supporter..."
        />
      </div>

      <section className="overflow-x-auto rounded-xl border border-border bg-card">
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
                { label: "Last Chat", align: "text-left" },
                { label: "Last Spend", align: "text-left" },
                ...(!isLifetime ? [{ label: "Trend", align: "text-left" }] : []),
                { label: "Status", align: "text-left" },
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
                <td colSpan={columnCount} className="px-4 py-8 text-center text-sm text-text-muted">
                  {emptyStateMessage(retentionFilter)}
                </td>
              </tr>
            )}
            {items.map((item, index) => {
              const fanLabel = resolveFanLabelForScope(item.fan, "page");
              const lifetimeNet = item.metrics.lifetime.scopeCreatorNetAmountMills;
              const windowMetrics = item.metrics.window;
              const comparison = item.metrics.comparison;
              const spent = isLifetime
                ? lifetimeNet
                : (windowMetrics?.creatorNetAmountMills ?? 0);

              const batch = batchByPlatformUserId.get(item.fan.platformUserId);
              const hasBatch = !!batchData;
              const tips = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["tip", "stream_tip"]);
              const subs = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["subscription"]);
              const purchases = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["message_purchase", "post_purchase"]);

              const rowStatus = item.retentionStatus;
              const statusBadge = ROW_STATUS_BADGES[rowStatus];

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
                    <ChatCell conversation={item.conversation} />
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    <LastTransactionCell transaction={item.lastTransaction} />
                  </td>
                  {!isLifetime && (
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      <TrendCell deltaPct={comparison?.deltaPct ?? null} />
                    </td>
                  )}
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    <span
                      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold ${statusBadge.className}`}
                    >
                      {statusBadge.label}
                    </span>
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

function describeRetentionSubtitle(filter: RetentionFilter): string {
  switch (filter) {
    case "active":
      return `bought within ${SPENDER_RETENTION_ACTIVE_DAYS} days`;
    case "cooling":
      return `quiet ${SPENDER_RETENTION_ACTIVE_DAYS}–${SPENDER_RETENTION_INACTIVE_DAYS} days`;
    case "inactive":
      return `quiet > ${SPENDER_RETENTION_INACTIVE_DAYS} days`;
    case "needs_reactivation":
      return `high-value, quiet > ${SPENDER_RETENTION_INACTIVE_DAYS} days`;
    default:
      return "";
  }
}

function emptyStateMessage(filter: RetentionFilter): string {
  if (filter === "all") return "No supporters found for this period.";
  if (filter === "needs_reactivation") return "No high-value supporters have gone quiet — nothing to reactivate.";
  return `No supporters in the "${RETENTION_FILTERS.find((f) => f.key === filter)?.label ?? filter}" segment.`;
}

function TrendCell({ deltaPct }: { deltaPct: number | null }) {
  if (deltaPct === null) {
    return <span className="text-text-muted">—</span>;
  }
  const { text, direction } = formatDelta(deltaPct);
  const className = direction === "up"
    ? "text-green"
    : direction === "down"
      ? "text-danger"
      : "text-text-muted";
  return <span className={`tabular-nums text-sm ${className}`}>{text}</span>;
}
