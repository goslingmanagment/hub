import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Copy, Check, ArrowUp, ArrowDown } from "lucide-react";
import { resolveFanslyExternalLink } from "@/lib/platformUrls";
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
import { daysRemaining, formatDate, formatDelta, formatRelativeTime, formatRelativeTimeCompact, transactionTypeLabel } from "@/lib/format";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Tooltip } from "@/components/shared/Tooltip";
import { ModalShell } from "@/components/shared/ModalShell";
import { ChatPreviewPanel } from "@/components/shared/ChatPreviewPanel";
import { TransactionsPreviewPanel } from "@/components/shared/TransactionsPreviewPanel";
import { SpenderTrendPanel } from "@/components/shared/SpenderTrendPanel";
import type { SpenderBatchBody, SpenderListResponse } from "@agency_hub_core/contracts";

const LIMIT = 50;

type SortByValue = "creatorNetAmountMills" | "lastTransactionAt";
type SortDir = "asc" | "desc";
const DEFAULT_SORT_BY: SortByValue = "creatorNetAmountMills";
const DEFAULT_SORT_DIR: SortDir = "desc";
const VALID_SORT_BY: ReadonlySet<SortByValue> = new Set(["creatorNetAmountMills", "lastTransactionAt"]);
const VALID_RETENTION: ReadonlySet<string> = new Set(["all", "active", "cooling", "inactive", "needs_reactivation"]);

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

const STATUS_DOT: Record<Exclude<RetentionFilter, "all">, { color: string; label: string }> = {
  active: { color: "var(--color-green)", label: "Active" },
  cooling: { color: "var(--color-warning)", label: "Cooling" },
  inactive: { color: "var(--color-text-muted)", label: "Inactive" },
  needs_reactivation: { color: "var(--color-danger)", label: "Needs reactivation" },
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
    return (
      <Tooltip content="Whale — lifetime spend ≥ $500">
        <span className="ml-1.5 inline-flex items-center rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-bold text-blue-400">🐋 Whale</span>
      </Tooltip>
    );
  if (lifetimeScopeCreatorNetMills >= 100_000)
    return (
      <Tooltip content="VIP — lifetime spend ≥ $100">
        <span className="ml-1.5 inline-flex items-center rounded-md bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-bold text-purple-400">💎 VIP</span>
      </Tooltip>
    );
  if (lifetimeScopeCreatorNetMills >= 50_000)
    return (
      <Tooltip content="Regular — lifetime spend ≥ $50">
        <span className="ml-1.5 inline-flex items-center rounded-md bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-bold text-yellow-400">⭐ Regular</span>
      </Tooltip>
    );
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

function StatusDot({ status }: { status: RetentionFilter }) {
  if (status === "all") return null;
  const config = STATUS_DOT[status];
  return (
    <Tooltip content={config.label}>
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: config.color }}
        aria-label={config.label}
      />
    </Tooltip>
  );
}

function SpentCell({ spent, tips, subs, purchases, ready }: {
  spent: number;
  tips: number;
  subs: number;
  purchases: number;
  ready: boolean;
}) {
  const formatted = formatUsdFromMills(spent);
  if (!ready || tips + subs + purchases === 0) {
    return <span>{formatted}</span>;
  }
  const tooltipContent = (
    <div className="space-y-0.5 tabular-nums">
      <div className="flex justify-between gap-4">
        <span className="text-white/70">Tips</span>
        <span>{formatUsdFromMills(tips)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-white/70">Subs</span>
        <span>{formatUsdFromMills(subs)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-white/70">Purchases</span>
        <span>{formatUsdFromMills(purchases)}</span>
      </div>
    </div>
  );
  return (
    <Tooltip content={tooltipContent}>
      <span className="cursor-help decoration-dotted decoration-text-muted underline-offset-4 hover:underline">
        {formatted}
      </span>
    </Tooltip>
  );
}

function ChatCell({ conversation }: { conversation: SpenderConversation }) {
  const hasConversation = conversation.platformConversationId !== null;
  const hasAnyMessage = conversation.lastMessageAt !== null ||
    conversation.lastFanMessageAt !== null ||
    conversation.lastModelMessageAt !== null;

  if (!hasConversation && !hasAnyMessage) {
    return <span className="text-xs text-text-muted">No DM</span>;
  }

  const unanswered = isUnansweredConversation(conversation);

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-text-primary">
          {conversation.lastMessageAt ? formatRelativeTime(conversation.lastMessageAt) : "synced"}
        </span>
        {unanswered && (
          <Tooltip content="Unanswered — fan messaged last">
            <span
              aria-label="Unanswered"
              className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-warning/20 text-[10px] font-bold text-warning-dark"
            >
              ⚠
            </span>
          </Tooltip>
        )}
        {conversation.unreadCount > 0 && (
          <Tooltip content={`${conversation.unreadCount} unread message${conversation.unreadCount === 1 ? "" : "s"}`}>
            <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white tabular-nums">
              {conversation.unreadCount}
            </span>
          </Tooltip>
        )}
      </div>
      <div className="text-[11px] text-text-muted tabular-nums">
        F {conversation.lastFanMessageAt ? formatRelativeTimeCompact(conversation.lastFanMessageAt) : "—"}
        <span className="mx-1 text-border">·</span>
        M {conversation.lastModelMessageAt ? formatRelativeTimeCompact(conversation.lastModelMessageAt) : "—"}
      </div>
    </div>
  );
}

function LastTransactionCell({ transaction }: { transaction: SpenderLastTransaction }) {
  if (!transaction) {
    return <span className="text-xs text-text-muted">—</span>;
  }
  const isPending = transaction.transactionState !== "posted";
  return (
    <div className="space-y-0.5">
      <div className="text-sm font-medium text-text-primary">
        {formatRelativeTime(transaction.occurredAt)}
      </div>
      <div className="text-[11px] text-text-muted tabular-nums">
        {transactionTypeLabel(transaction.canonicalType)}
        <span className="mx-1 text-border">·</span>
        {formatUsdFromMills(transaction.creatorNetAmountMills)}
        {isPending && (
          <>
            <span className="mx-1 text-border">·</span>
            <Tooltip content={`Transaction state: ${transaction.transactionState}`}>
              <span className="font-medium text-warning-dark">{transaction.transactionState}</span>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}

function SubCell({ subscription, ready }: {
  subscription: {
    status: "active" | "expired" | "never";
    expiresAt: string | null;
    autoRenew: boolean | null;
    autoRenewOffDetectedAt: string | null;
  } | null;
  ready: boolean;
}) {
  if (!ready) {
    return <span className="text-xs text-text-muted">…</span>;
  }
  if (!subscription || subscription.status === "never") {
    return <span className="text-xs text-text-muted">—</span>;
  }
  if (subscription.status === "expired") {
    return (
      <Tooltip content="Subscription expired">
        <span className="inline-flex items-center rounded-md bg-text-muted/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-text-muted">
          Expired
        </span>
      </Tooltip>
    );
  }
  const days = subscription.expiresAt ? daysRemaining(subscription.expiresAt) : null;
  const renewLabel = subscription.autoRenew === true
    ? "Auto-renew on"
    : subscription.autoRenew === false
      ? "Auto-renew off"
      : null;
  const tooltipContent = (
    <div className="space-y-0.5">
      <div>Active subscriber</div>
      {days !== null && <div className="text-white/70">Ends in {days}d</div>}
      {renewLabel && <div className="text-white/70">{renewLabel}</div>}
      {subscription.autoRenew === false && subscription.autoRenewOffDetectedAt && (
        <div className="text-white/70">
          Detected {formatDate(subscription.autoRenewOffDetectedAt, { includeYear: true })}
        </div>
      )}
    </div>
  );
  return (
    <Tooltip content={tooltipContent}>
      <span className="inline-flex items-center gap-1 rounded-md bg-green/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-green">
        Active
        {subscription.autoRenew === false && (
          <span className="text-warning-dark normal-case font-medium">· no renew</span>
        )}
      </span>
    </Tooltip>
  );
}

function CopyFanslyLinkButton({
  username,
  platformConversationId,
}: {
  username: string | null;
  platformConversationId: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const link = resolveFanslyExternalLink({ username, platformConversationId });
  if (!link) return null;

  const handleClick = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast.error("Буфер обмена недоступен");
      return;
    }
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      toast.success(link.kind === "chat" ? "Ссылка на чат скопирована" : "Ссылка на профиль скопирована");
      globalThis.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Не удалось скопировать");
    }
  };

  const tooltipLabel = link.kind === "chat" ? "Скопировать ссылку на чат Fansly" : "Скопировать ссылку на профиль Fansly";

  return (
    <Tooltip content={tooltipLabel}>
      <button
        type="button"
        onClick={handleClick}
        className="ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
        aria-label={tooltipLabel}
      >
        {copied ? <Check size={12} className="text-green" /> : <Copy size={12} />}
      </button>
    </Tooltip>
  );
}

type NextAction = {
  label: string;
  description: string;
  className: string;
};

function computeNextAction(
  item: SpenderListItem,
  subscription: {
    status: "active" | "expired" | "never";
    expiresAt: string | null;
    autoRenew: boolean | null;
    autoRenewOffDetectedAt: string | null;
  } | null,
): NextAction | null {
  // 1. Sub renewal urgency
  if (subscription?.status === "active" && subscription.expiresAt) {
    const days = daysRemaining(subscription.expiresAt);
    if (days <= 7) {
      return {
        label: `Sub ${days}d`,
        description: `Subscription ends in ${days} day${days === 1 ? "" : "s"}${subscription.autoRenew === false ? " · auto-renew off" : ""}`,
        className: "bg-warning/15 text-warning-dark",
      };
    }
  }

  // 2. High-value gone quiet
  if (item.retentionStatus === "needs_reactivation") {
    return {
      label: "Reactivate",
      description: "High-value supporter quiet — reach out",
      className: "bg-danger/15 text-danger",
    };
  }

  // 3. Unanswered chat (fan messaged last)
  if (isUnansweredConversation(item.conversation)) {
    return {
      label: "Reply",
      description: "Fan messaged last — needs a reply",
      className: "bg-accent/15 text-accent",
    };
  }

  // 4. Cooling — check in
  if (item.retentionStatus === "cooling") {
    return {
      label: "Check in",
      description: "Cooling — re-engage soon",
      className: "bg-warning/15 text-warning-dark",
    };
  }

  return null;
}

function NextActionCell({ action }: { action: NextAction | null }) {
  if (!action) {
    return <span className="text-xs text-text-muted">—</span>;
  }
  return (
    <Tooltip content={action.description}>
      <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase ${action.className}`}>
        {action.label}
      </span>
    </Tooltip>
  );
}

function SortableHeader({
  label,
  align = "left",
  sortKey,
  currentSort,
  currentDir,
  onSort,
}: {
  label: string;
  align?: "left" | "right";
  sortKey: SortByValue;
  currentSort: SortByValue;
  currentDir: SortDir;
  onSort: (key: SortByValue) => void;
}) {
  const isActive = currentSort === sortKey;
  const alignClass = align === "right" ? "justify-end" : "justify-start";
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wider transition-colors ${alignClass} ${isActive ? "text-text-secondary" : "text-text-muted hover:text-text-secondary"}`}
    >
      {label}
      {isActive ? (
        currentDir === "desc"
          ? <ArrowDown size={11} className="opacity-70" />
          : <ArrowUp size={11} className="opacity-70" />
      ) : (
        <span className="inline-block h-[11px] w-[11px]" />
      )}
    </button>
  );
}

function TrendCell({ deltaPct }: { deltaPct: number | null }) {
  if (deltaPct === null) {
    return <span className="text-xs text-text-muted">—</span>;
  }
  const { text, direction } = formatDelta(deltaPct);
  const className = direction === "up"
    ? "text-green"
    : direction === "down"
      ? "text-danger"
      : "text-text-muted";
  return <span className={`text-xs tabular-nums ${className}`}>{text}</span>;
}

type ChatPreviewState = {
  platformConversationId: string;
  fanLabel: string;
  profileHref: string;
};

type TxnPreviewState = {
  platformUserId: string;
  fanLabel: string;
  profileHref: string;
};

type TrendPreviewState = {
  platformUserId: string;
  fanLabel: string;
  profileHref: string;
};

export function TopSupportersPage() {
  const { pageLabel } = useParams();
  const navigate = useNavigate();
  const selectedPeriod = useSpenderPeriodStore((s) => s.topSupportersPeriod);
  const [searchParams, setSearchParams] = useSearchParams();
  const [chatPreview, setChatPreview] = useState<ChatPreviewState | null>(null);
  const [txnPreview, setTxnPreview] = useState<TxnPreviewState | null>(null);
  const [trendPreview, setTrendPreview] = useState<TrendPreviewState | null>(null);

  const rawFilter = searchParams.get("filter") ?? "all";
  const retentionFilter: RetentionFilter = (VALID_RETENTION.has(rawFilter) ? rawFilter : "all") as RetentionFilter;
  const searchQuery = searchParams.get("q") ?? "";
  const offset = Math.max(0, Number(searchParams.get("offset") ?? "0") || 0);
  const rawSortBy = searchParams.get("sortBy") ?? DEFAULT_SORT_BY;
  const sortBy: SortByValue = (VALID_SORT_BY.has(rawSortBy as SortByValue) ? rawSortBy : DEFAULT_SORT_BY) as SortByValue;
  const sortDir: SortDir = searchParams.get("dir") === "asc" ? "asc" : "desc";

  const updateParams = useCallback((changes: Record<string, string | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setRetentionFilter = useCallback((filter: RetentionFilter) => {
    updateParams({ filter: filter === "all" ? null : filter, offset: null });
  }, [updateParams]);

  const setSearchQuery = useCallback((q: string) => {
    updateParams({ q: q || null, offset: null });
  }, [updateParams]);

  const setOffset = useCallback((o: number) => {
    updateParams({ offset: o === 0 ? null : String(o) });
  }, [updateParams]);

  const toggleSort = useCallback((col: SortByValue) => {
    const newDir: SortDir = sortBy === col && sortDir === "desc" ? "asc" : "desc";
    updateParams({
      sortBy: col === DEFAULT_SORT_BY ? null : col,
      dir: newDir === DEFAULT_SORT_DIR ? null : newDir,
      offset: null,
    });
  }, [sortBy, sortDir, updateParams]);

  const spenderPeriod = selectedPeriod === "all" ? "lifetime" : selectedPeriod;

  useEffect(() => {
    if (offset !== 0) setOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageLabel, spenderPeriod]);

  const spenderParams = useMemo(() => ({
    scope: "page" as const,
    pageLabel,
    period: spenderPeriod,
    limit: LIMIT,
    offset,
    sortBy,
    sortDir,
    query: searchQuery || undefined,
    retentionStatus: retentionFilter,
  }), [pageLabel, spenderPeriod, offset, sortBy, sortDir, searchQuery, retentionFilter]);

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
      subscription: {
        status: "active" | "expired" | "never";
        expiresAt: string | null;
        autoRenew: boolean | null;
        autoRenewOffDetectedAt: string | null;
      } | null;
    }>();
    if (!batchData) return map;
    for (const item of batchData.items) {
      if (item.found) {
        map.set(item.requestedFan.platformUserId, {
          typeBreakdown: item.typeBreakdown,
          subscription: item.subscription,
        });
      }
    }
    return map;
  }, [batchData]);

  const visibleTotals = useMemo(() => {
    if (!spenders) return null;
    const isLifetime = spenderPeriod === "lifetime";
    let spent = 0;
    let tips = 0;
    let subs = 0;
    let purchases = 0;
    for (const item of spenders.items) {
      const itemSpent = isLifetime
        ? item.metrics.lifetime.scopeCreatorNetAmountMills
        : (item.metrics.window?.creatorNetAmountMills ?? 0);
      spent += itemSpent;
      const batch = batchByPlatformUserId.get(item.fan.platformUserId);
      if (batch?.typeBreakdown) {
        tips += sumBreakdownTypes(batch.typeBreakdown, ["tip", "stream_tip"]);
        subs += sumBreakdownTypes(batch.typeBreakdown, ["subscription"]);
        purchases += sumBreakdownTypes(batch.typeBreakdown, ["message_purchase", "post_purchase"]);
      }
    }
    return { spent, tips, subs, purchases, hasBreakdown: !!batchData };
  }, [spenders, spenderPeriod, batchByPlatformUserId, batchData]);

  if (isLoading || !spenders) {
    return <TableSkeleton rows={8} columns={spenderPeriod === "lifetime" ? 7 : 8} />;
  }

  const total = spenders.total;
  const isLifetime = spenderPeriod === "lifetime";
  const columnCount = isLifetime ? 7 : 8;
  const subtitle = describeRetentionSubtitle(retentionFilter);

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-extrabold text-text-primary">
          Top Supporters &mdash; {pageLabel}
        </h1>
        <p className="text-sm text-text-muted mt-1">
          {total} {retentionFilter === "all" ? "total" : "match"}
          {subtitle ? ` · ${subtitle}` : ""}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
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
              <th className="w-12 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">#</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Fan</th>
              <th className="px-3 py-2 text-right">
                <SortableHeader
                  label="Spent"
                  align="right"
                  sortKey="creatorNetAmountMills"
                  currentSort={sortBy}
                  currentDir={sortDir}
                  onSort={toggleSort}
                />
              </th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Sub</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Next</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Last Chat</th>
              <th className="px-3 py-2 text-left">
                <SortableHeader
                  label="Last Spend"
                  sortKey="lastTransactionAt"
                  currentSort={sortBy}
                  currentDir={sortDir}
                  onSort={toggleSort}
                />
              </th>
              {!isLifetime && (
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Trend</th>
              )}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-3 py-8 text-center text-sm text-text-muted">
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
                  <td className="px-3 py-2.5 align-middle">
                    <div className="flex items-center gap-2">
                      <StatusDot status={item.retentionStatus} />
                      <span className="text-sm text-text-secondary tabular-nums">{offset + index + 1}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <div className="flex items-center">
                      <span className="text-sm font-semibold text-text-primary">
                        {fanLabel.label}
                      </span>
                      {whaleBadge(lifetimeNet)}
                      {fanLabel.secondaryPlatformHandle && (
                        <span className="ml-2 text-xs text-text-muted">@{fanLabel.secondaryPlatformHandle}</span>
                      )}
                      <CopyFanslyLinkButton
                        username={item.fan.username}
                        platformConversationId={item.conversation.platformConversationId}
                      />
                    </div>
                  </td>
                  <td
                    className="px-3 py-2.5 align-middle text-right text-sm font-medium tabular-nums text-text-primary hover:bg-hover-alt"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTrendPreview({
                        platformUserId: item.fan.platformUserId,
                        fanLabel: fanLabel.label,
                        profileHref: fanNavigation.to,
                      });
                    }}
                  >
                    <SpentCell spent={spent} tips={tips} subs={subs} purchases={purchases} ready={hasBatch} />
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <SubCell subscription={batch?.subscription ?? null} ready={hasBatch} />
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <NextActionCell action={computeNextAction(item, batch?.subscription ?? null)} />
                  </td>
                  <td
                    className={`px-3 py-2.5 align-middle ${item.conversation.platformConversationId ? "hover:bg-hover-alt" : ""}`}
                    onClick={(e) => {
                      if (!item.conversation.platformConversationId) return;
                      e.stopPropagation();
                      setChatPreview({
                        platformConversationId: item.conversation.platformConversationId,
                        fanLabel: fanLabel.label,
                        profileHref: fanNavigation.to,
                      });
                    }}
                  >
                    <ChatCell conversation={item.conversation} />
                  </td>
                  <td
                    className={`px-3 py-2.5 align-middle ${item.lastTransaction ? "hover:bg-hover-alt" : ""}`}
                    onClick={(e) => {
                      if (!item.lastTransaction) return;
                      e.stopPropagation();
                      setTxnPreview({
                        platformUserId: item.fan.platformUserId,
                        fanLabel: fanLabel.label,
                        profileHref: fanNavigation.to,
                      });
                    }}
                  >
                    <LastTransactionCell transaction={item.lastTransaction} />
                  </td>
                  {!isLifetime && (
                    <td className="px-3 py-2.5 align-middle">
                      <TrendCell deltaPct={comparison?.deltaPct ?? null} />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        {visibleTotals && items.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border bg-hover-alt px-3 py-2 text-[11px] text-text-muted">
            <div>
              {items.length} visible of {total} · Spent <span className="font-semibold text-text-primary tabular-nums">{formatUsdFromMills(visibleTotals.spent)}</span>
            </div>
            {visibleTotals.hasBreakdown && (
              <div className="tabular-nums">
                Tips <span className="text-text-secondary">{formatUsdFromMills(visibleTotals.tips)}</span>
                <span className="mx-1.5 text-border">·</span>
                Subs <span className="text-text-secondary">{formatUsdFromMills(visibleTotals.subs)}</span>
                <span className="mx-1.5 text-border">·</span>
                Purchases <span className="text-text-secondary">{formatUsdFromMills(visibleTotals.purchases)}</span>
              </div>
            )}
          </div>
        )}

        <Pagination
          offset={offset}
          limit={LIMIT}
          total={total}
          onPageChange={setOffset}
        />
      </section>

      {chatPreview && (
        <ModalShell
          title={`Chat with ${chatPreview.fanLabel}`}
          onClose={() => setChatPreview(null)}
        >
          <div className="-mx-6 -mb-6 overflow-hidden rounded-b-2xl">
            <ChatPreviewPanel
              pageLabel={pageLabel!}
              platformConversationId={chatPreview.platformConversationId}
              profileHref={chatPreview.profileHref}
              limit={25}
            />
          </div>
        </ModalShell>
      )}

      {txnPreview && (
        <ModalShell
          title={`Transactions — ${txnPreview.fanLabel}`}
          onClose={() => setTxnPreview(null)}
        >
          <div className="-mx-6 -mb-6 overflow-hidden rounded-b-2xl">
            <TransactionsPreviewPanel
              pageLabel={pageLabel!}
              platformUserId={txnPreview.platformUserId}
              profileHref={txnPreview.profileHref}
              limit={15}
            />
          </div>
        </ModalShell>
      )}

      {trendPreview && platform && (
        <ModalShell
          title={`Spend trend — ${trendPreview.fanLabel}`}
          onClose={() => setTrendPreview(null)}
        >
          <div className="-mx-6 -mb-6 overflow-hidden rounded-b-2xl">
            <SpenderTrendPanel
              pageLabel={pageLabel!}
              platform={platform}
              platformUserId={trendPreview.platformUserId}
              profileHref={trendPreview.profileHref}
              period="90d"
            />
          </div>
        </ModalShell>
      )}
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
