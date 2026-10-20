import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Copy, LineChart, MessageSquare, Receipt } from "lucide-react";
import {
  PLATFORM_DISPLAY_NAME,
  resolveExternalLink,
  type ExternalLinkPlatform,
} from "@/lib/platformUrls";
import { useSpenders, useSpenderBatch } from "@/api/queries";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { buildFanProfileNavigation, resolveSpenderPeriod } from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { usePeriodStore } from "@/stores/periodStore";
import {
  SPENDER_RETENTION_ACTIVE_DAYS,
  SPENDER_RETENTION_INACTIVE_DAYS,
  formatUsdFromMills,
  resolveFanLabelForScope,
  type SpenderRetentionStatus,
} from "@agency_hub_core/shared";
import { daysRemaining, formatDate, formatDelta, formatRelativeTime, transactionStateLabel, transactionTypeLabel } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Tooltip } from "@/components/shared/Tooltip";
import { ModalShell } from "@/components/shared/ModalShell";
import { ChatPreviewPanel } from "@/components/shared/ChatPreviewPanel";
import { TransactionsPreviewPanel } from "@/components/shared/TransactionsPreviewPanel";
import { SpenderTrendPanel } from "@/components/shared/SpenderTrendPanel";
import { FanNotVisibleMark } from "@/components/shared/FanNotVisibleMark";
import type { SpenderBatchBody, SpenderListResponse } from "@agency_hub_core/contracts";
import { isPlainRowClick } from "./daily/rowClick.js";

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
type SubscriptionSummary = {
  status: "active" | "expired" | "never";
  expiresAt: string | null;
  autoRenew: boolean | null;
  autoRenewOffDetectedAt: string | null;
};

const RETENTION_FILTERS: { key: RetentionFilter; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "active", label: "Активные" },
  { key: "cooling", label: "Остывают" },
  { key: "inactive", label: "Неактивные" },
  { key: "needs_reactivation", label: "Нужно вернуть" },
];

/** A row's retention status in words, for the action cell's tooltip — the
 *  filter chips above already split the list by it. */
const RETENTION_LABEL: Record<Exclude<RetentionFilter, "all">, string> = {
  active: "активный",
  cooling: "остывает",
  inactive: "неактивный",
  needs_reactivation: "ценный, но замолчал",
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

/** One neutral tier mark from the fan's lifetime spend on this page,
 *  whatever period the list shows. */
function TierBadge({ lifetimeScopeCreatorNetMills }: { lifetimeScopeCreatorNetMills: number }) {
  const tier = lifetimeScopeCreatorNetMills >= 500_000
    ? { label: "Кит", hint: "Кит — за всё время потратил от $500", className: "badge badge-accent" }
    : lifetimeScopeCreatorNetMills >= 100_000
      ? { label: "VIP", hint: "VIP — за всё время потратил от $100", className: "badge" }
      : lifetimeScopeCreatorNetMills >= 50_000
        ? { label: "Постоянный", hint: "Постоянный — за всё время потратил от $50", className: "badge" }
        : null;
  if (!tier) return null;
  return (
    <Tooltip content={tier.hint}>
      <span className={tier.className}>{tier.label}</span>
    </Tooltip>
  );
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

function SpentCell({ spent, tips, subs, purchases, ready }: {
  spent: number | null;
  tips: number;
  subs: number;
  purchases: number;
  ready: boolean;
}) {
  const formatted = spent === null ? "—" : formatUsdFromMills(spent);
  if (spent === null || !ready || tips + subs + purchases === 0) {
    return <span>{formatted}</span>;
  }
  const tooltipContent = (
    <div className="space-y-0.5 tabular-nums">
      {[
        { label: "Чаевые", value: tips },
        { label: "Подписки", value: subs },
        { label: "Покупки", value: purchases },
      ].map(({ label, value }) => (
        <div key={label} className="flex justify-between gap-4">
          <span className="opacity-75">{label}</span>
          <span>{formatUsdFromMills(value)}</span>
        </div>
      ))}
    </div>
  );
  return (
    <Tooltip content={tooltipContent}>
      <span className="cursor-help underline decoration-dotted decoration-text-muted underline-offset-4">
        {formatted}
      </span>
    </Tooltip>
  );
}

function ChatCell({ conversation, fanLabel, onOpen }: {
  conversation: SpenderConversation;
  fanLabel: string;
  onOpen: (() => void) | null;
}) {
  const hasAnyMessage = conversation.lastMessageAt !== null ||
    conversation.lastFanMessageAt !== null ||
    conversation.lastModelMessageAt !== null;

  if (!onOpen && !hasAnyMessage) {
    return <span className="text-text-muted">Нет переписки</span>;
  }

  const unanswered = isUnansweredConversation(conversation);
  const when = conversation.lastMessageAt ? formatRelativeTime(conversation.lastMessageAt) : "есть переписка";
  const details = [
    `Фан писал: ${conversation.lastFanMessageAt ? formatRelativeTime(conversation.lastFanMessageAt) : "—"}`,
    `модель: ${conversation.lastModelMessageAt ? formatRelativeTime(conversation.lastModelMessageAt) : "—"}`,
  ].join(" · ");
  const marks = (
    <>
      {unanswered && <span className="status-dot status-dot-warn" title="Фан написал последним — ждёт ответа" aria-hidden="true" />}
      {conversation.unreadCount > 0 && (
        <span className="badge badge-accent tabular-nums" aria-hidden="true">{conversation.unreadCount}</span>
      )}
    </>
  );
  const summary = [
    unanswered ? "фан ждёт ответа" : null,
    conversation.unreadCount > 0
      ? `${conversation.unreadCount} ${ruPlural(conversation.unreadCount, "непрочитанное", "непрочитанных", "непрочитанных")}`
      : null,
  ].filter(Boolean).join(", ");

  if (!onOpen) {
    return (
      <span className="inline-flex items-center gap-1.5" title={details}>
        {when}
        {marks}
        {summary && <span className="sr-only">{summary}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="btn btn-ghost btn-sm -ml-2.5 px-2.5 text-text-primary"
      title={`Открыть переписку. ${details}`}
      aria-label={`Открыть переписку с ${fanLabel}${summary ? `: ${summary}` : ""}`}
    >
      <MessageSquare size={14} className="text-text-muted" aria-hidden="true" />
      {when}
      {marks}
    </button>
  );
}

function LastTransactionCell({ transaction, fanLabel, onOpen }: {
  transaction: SpenderLastTransaction;
  fanLabel: string;
  onOpen: () => void;
}) {
  if (!transaction) {
    return <span className="text-text-muted">—</span>;
  }
  const isPending = transaction.transactionState !== "posted";
  return (
    <div>
      <button
        type="button"
        onClick={onOpen}
        className="btn btn-ghost btn-sm -ml-2.5 px-2.5 text-text-primary"
        aria-label={`Показать операции фана ${fanLabel}`}
        title="Показать операции"
      >
        <Receipt size={14} className="text-text-muted" aria-hidden="true" />
        {formatRelativeTime(transaction.occurredAt)}
      </button>
      <div className="text-xs text-text-secondary tabular-nums">
        {transactionTypeLabel(transaction.canonicalType)} · {formatUsdFromMills(transaction.creatorNetAmountMills)}
        {isPending && (
          <span className="text-warning-dark"> · {transactionStateLabel(transaction.transactionState).toLowerCase()}</span>
        )}
      </div>
    </div>
  );
}

function SubCell({ subscription, ready }: {
  subscription: SubscriptionSummary | null;
  ready: boolean;
}) {
  if (!ready) {
    return <span className="text-text-muted">…</span>;
  }
  if (!subscription || subscription.status === "never") {
    return <span className="text-text-muted">—</span>;
  }
  if (subscription.status === "expired") {
    return <span className="badge">Истекла</span>;
  }
  const days = subscription.expiresAt ? daysRemaining(subscription.expiresAt) : null;
  const tooltipContent = (
    <div className="space-y-0.5">
      <div>Подписка активна</div>
      {days !== null && <div className="opacity-75">Закончится через {days} дн</div>}
      {subscription.autoRenew === true && <div className="opacity-75">Автопродление вкл.</div>}
      {subscription.autoRenew === false && (
        <div className="opacity-75">
          Автопродление выкл.
          {subscription.autoRenewOffDetectedAt && ` с ${formatDate(subscription.autoRenewOffDetectedAt, { includeYear: true })}`}
        </div>
      )}
    </div>
  );
  return (
    <Tooltip content={tooltipContent}>
      <span className="inline-flex flex-col items-start gap-0.5">
        <span className="badge badge-success">Подписан</span>
        {subscription.autoRenew === false && (
          <span className="text-xs text-warning-dark">без автопродления</span>
        )}
      </span>
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
  subscription: SubscriptionSummary | null,
): NextAction | null {
  // 1. Sub renewal urgency
  if (subscription?.status === "active" && subscription.expiresAt) {
    const days = daysRemaining(subscription.expiresAt);
    if (days <= 7) {
      return {
        label: days === 0 ? "Продлить сегодня" : `Продлить через ${days} дн`,
        description: `Подписка заканчивается через ${days} ${ruPlural(days, "день", "дня", "дней")}${subscription.autoRenew === false ? " · автопродление выключено" : ""}`,
        className: "badge badge-warning",
      };
    }
  }

  // 2. High-value gone quiet
  if (item.retentionStatus === "needs_reactivation") {
    return {
      label: "Вернуть",
      description: "Ценный фан давно не покупал — напишите ему",
      className: "badge badge-danger",
    };
  }

  // 3. Unanswered chat (fan messaged last)
  if (isUnansweredConversation(item.conversation)) {
    return {
      label: "Ответить",
      description: "Фан написал последним — нужен ответ",
      className: "badge badge-accent",
    };
  }

  // 4. Cooling — check in
  if (item.retentionStatus === "cooling") {
    return {
      label: "Напомнить о себе",
      description: "Фан остывает — напомните о себе",
      className: "badge badge-warning",
    };
  }

  return null;
}

function NextActionCell({ action, retention }: { action: NextAction | null; retention: RetentionFilter }) {
  const status = retention === "all" ? null : `Статус: ${RETENTION_LABEL[retention]}`;
  if (!action) {
    return <span className="text-text-muted" title={status ?? undefined}>—</span>;
  }
  return (
    <Tooltip content={<div className="space-y-0.5"><div>{action.description}</div>{status && <div className="opacity-75">{status}</div>}</div>}>
      <span className={action.className}>{action.label}</span>
    </Tooltip>
  );
}

function SortableHeader({
  label,
  sortKey,
  currentSort,
  currentDir,
  onSort,
}: {
  label: string;
  sortKey: SortByValue;
  currentSort: SortByValue;
  currentDir: SortDir;
  onSort: (key: SortByValue) => void;
}) {
  const isActive = currentSort === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`inline-flex items-center gap-1 font-medium transition-colors hover:text-text-primary ${isActive ? "text-text-primary" : ""}`}
    >
      {label}
      {isActive
        ? currentDir === "desc"
          ? <ArrowDown size={12} aria-hidden="true" />
          : <ArrowUp size={12} aria-hidden="true" />
        : <ArrowUpDown size={12} className="opacity-50" aria-hidden="true" />}
    </button>
  );
}

function ariaSort(sortKey: SortByValue, currentSort: SortByValue, currentDir: SortDir) {
  if (sortKey !== currentSort) return undefined;
  return currentDir === "desc" ? "descending" as const : "ascending" as const;
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
  return <span className={`tabular-nums ${className}`}>{text}</span>;
}

function CopyExternalLinkButton({
  platform,
  username,
  platformConversationId,
}: {
  platform: ExternalLinkPlatform;
  username: string | null;
  platformConversationId: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const link = resolveExternalLink(platform, { username, platformConversationId });
  if (!link) return null;

  const handleClick = async () => {
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

  const platformName = PLATFORM_DISPLAY_NAME[platform];
  const label = link.kind === "chat"
    ? `Скопировать ссылку на чат ${platformName}`
    : `Скопировать ссылку на профиль ${platformName}`;

  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={() => void handleClick()}
        className="btn btn-ghost btn-icon"
        aria-label={label}
      >
        {copied ? <Check size={15} className="text-green" aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      </button>
    </Tooltip>
  );
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
  const location = useLocation();
  const { period: storedPeriod } = usePeriodStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedPeriod = resolveSpenderPeriod(searchParams.get("period"), storedPeriod);
  const [chatPreview, setChatPreview] = useState<ChatPreviewState | null>(null);
  const [txnPreview, setTxnPreview] = useState<TxnPreviewState | null>(null);
  const [trendPreview, setTrendPreview] = useState<TrendPreviewState | null>(null);

  const rawFilter = searchParams.get("filter") ?? "all";
  const retentionFilter: RetentionFilter = (VALID_RETENTION.has(rawFilter) ? rawFilter : "all") as RetentionFilter;
  const searchQuery = searchParams.get("q") ?? "";
  const offset = listOffset(searchParams.get("offset"));
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
    setChatPreview(null);
    setTxnPreview(null);
    setTrendPreview(null);
  }, [pageLabel]);

  const spenderParams = useMemo(() => ({
    scope: "page" as const,
    ...(pageLabel === undefined ? {} : { pageLabel }),
    period: spenderPeriod,
    limit: LIMIT,
    offset,
    sortBy,
    sortDir,
    ...(searchQuery ? { query: searchQuery } : {}),
    retentionStatus: retentionFilter,
  }), [pageLabel, spenderPeriod, offset, sortBy, sortDir, searchQuery, retentionFilter]);

  const { data: spenders, isLoading, isError, refetch } = useSpenders(spenderParams);

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

  const { data: batchData, isError: batchError, isFetching: batchFetching, refetch: retryBatch } = useSpenderBatch(batchBody);

  const batchByPlatformUserId = useMemo(() => {
    const map = new Map<string, {
      typeBreakdown: TypeBreakdownItem[] | null;
      subscription: SubscriptionSummary | null;
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
    let spentComplete = true;
    let tips = 0;
    let subs = 0;
    let purchases = 0;
    for (const item of spenders.items) {
      const itemSpent = isLifetime
        ? item.metrics.lifetime.scopeCreatorNetAmountMills
        : (item.metrics.window?.creatorNetAmountMills ?? null);
      if (itemSpent === null) spentComplete = false;
      else spent += itemSpent;
      const batch = batchByPlatformUserId.get(item.fan.platformUserId);
      if (batch?.typeBreakdown) {
        tips += sumBreakdownTypes(batch.typeBreakdown, ["tip", "stream_tip"]);
        subs += sumBreakdownTypes(batch.typeBreakdown, ["subscription"]);
        purchases += sumBreakdownTypes(batch.typeBreakdown, ["message_purchase", "post_purchase"]);
      }
    }
    return { spent: spentComplete ? spent : null, tips, subs, purchases, hasBreakdown: spenders.items.every((item) => batchByPlatformUserId.get(item.fan.platformUserId)?.typeBreakdown != null) };
  }, [spenders, spenderPeriod, batchByPlatformUserId, batchData]);

  if (isError && !spenders) {
    return <StatusPanel title="Топ фанов: не удалось загрузить" description="Список недоступен — это не значит, что трат нет." tone="error" action={<button type="button" onClick={() => void refetch()}>Повторить</button>} />;
  }
  if (isLoading || !spenders) {
    return <TableSkeleton rows={8} columns={spenderPeriod === "lifetime" ? 8 : 9} />;
  }

  const total = spenders.total;
  const isLifetime = spenderPeriod === "lifetime";
  const columnCount = isLifetime ? 8 : 9;
  const subtitle = describeRetentionSubtitle(retentionFilter);
  const countLine = offset > 0 && items.length === 0
    ? "Число записей в фильтре пока недоступно"
    : `${total} ${ruPlural(total, "фан", "фана", "фанов")}${subtitle ? ` · ${subtitle}` : ""}`;

  return (
    <div>
      <QueryNotice error={isError} stale={Boolean(spenders)} retry={refetch} />
      {batchError && (
        <div className="mb-3">
          <p className="mb-1 text-[13px] text-text-secondary">Детали подписок и разбивка расходов:</p>
          <QueryNotice error stale={Boolean(batchData)} retry={retryBatch} />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <FilterButtons
          filters={RETENTION_FILTERS}
          active={retentionFilter}
          onChange={(key) => setRetentionFilter(key as RetentionFilter)}
        />
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Поиск фана"
        />
      </div>

      <p className="mb-3 text-[13px] text-text-secondary tabular-nums">{countLine}</p>

      <section className="card overflow-hidden" aria-label="Топ фанов">
        {/* `relative`: the screen-reader-only header text is positioned and
            must scroll with the table instead of widening the page. */}
        <div className="relative overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th>Фан</th>
                <th className="num" aria-sort={ariaSort("creatorNetAmountMills", sortBy, sortDir)}>
                  <SortableHeader
                    label="Потратил"
                    sortKey="creatorNetAmountMills"
                    currentSort={sortBy}
                    currentDir={sortDir}
                    onSort={toggleSort}
                  />
                </th>
                <th>Подписка</th>
                <th>Действие</th>
                <th>Переписка</th>
                <th aria-sort={ariaSort("lastTransactionAt", sortBy, sortDir)}>
                  <SortableHeader
                    label="Последняя трата"
                    sortKey="lastTransactionAt"
                    currentSort={sortBy}
                    currentDir={sortDir}
                    onSort={toggleSort}
                  />
                </th>
                {!isLifetime && <th className="num">К прошлому периоду</th>}
                <th><span className="sr-only">Действия со строкой</span></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={columnCount} className="py-8 text-center text-text-secondary">
                    {offset > 0 ? "На этой странице списка записей нет." : emptyStateMessage(retentionFilter)}
                    {offset > 0 && <button type="button" className="link ml-2" onClick={() => setOffset(0)}>К началу списка</button>}
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
                  : (windowMetrics?.creatorNetAmountMills ?? null);

                const batch = batchByPlatformUserId.get(item.fan.platformUserId);
                const hasBatch = batch != null;
                const tips = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["tip", "stream_tip"]);
                const subs = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["subscription"]);
                const purchases = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["message_purchase", "post_purchase"]);

                const fanNavigation = buildFanProfileNavigation(
                  pageLabel!,
                  platform!,
                  item.fan.platformUserId,
                  `${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(searchParams), period: selectedPeriod })}`,
                  fanLabel.label,
                );

                fanNavigation.to += `?${new URLSearchParams({ period: selectedPeriod })}`;
                const conversationId = item.conversation.platformConversationId;
                return (
                  <tr
                    key={item.fan.platformUserId}
                    onClick={(event) => {
                      if (!isPlainRowClick(event)) return;
                      navigate(fanNavigation.to, { state: fanNavigation.state });
                    }}
                    className="cursor-pointer"
                  >
                    <td className="muted tabular-nums">{offset + index + 1}</td>
                    <td>
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <Link to={fanNavigation.to} state={fanNavigation.state} className="font-medium text-text-primary hover:text-accent hover:underline underline-offset-2">
                          {fanLabel.label}
                        </Link>
                        <TierBadge lifetimeScopeCreatorNetMills={lifetimeNet} />
                        <FanNotVisibleMark missAt={item.accountLookupMissAt} />
                      </div>
                      {fanLabel.secondaryPlatformHandle && (
                        <div className="text-xs text-text-secondary">@{fanLabel.secondaryPlatformHandle}</div>
                      )}
                    </td>
                    <td className="num font-medium">
                      <SpentCell spent={spent} tips={tips} subs={subs} purchases={purchases} ready={hasBatch} />
                    </td>
                    <td>
                      {!hasBatch && !batchFetching && (batchError || batchData) ? <span className="text-text-muted">Недоступно</span> : <SubCell subscription={batch?.subscription ?? null} ready={hasBatch} />}
                    </td>
                    <td>
                      <NextActionCell action={computeNextAction(item, batch?.subscription ?? null)} retention={item.retentionStatus} />
                    </td>
                    <td>
                      <ChatCell
                        conversation={item.conversation}
                        fanLabel={fanLabel.label}
                        onOpen={conversationId
                          ? () => setChatPreview({
                            platformConversationId: conversationId,
                            fanLabel: fanLabel.label,
                            profileHref: fanNavigation.to,
                          })
                          : null}
                      />
                    </td>
                    <td>
                      <LastTransactionCell
                        transaction={item.lastTransaction}
                        fanLabel={fanLabel.label}
                        onOpen={() => setTxnPreview({
                          platformUserId: item.fan.platformUserId,
                          fanLabel: fanLabel.label,
                          profileHref: fanNavigation.to,
                        })}
                      />
                    </td>
                    {!isLifetime && (
                      <td className="num">
                        <TrendCell deltaPct={comparison?.deltaPct ?? null} />
                      </td>
                    )}
                    <td className="text-right">
                      {platform && (
                        <div className="inline-flex items-center gap-0.5">
                          <Tooltip content="Динамика трат">
                            <button
                              type="button"
                              onClick={() => setTrendPreview({
                                platformUserId: item.fan.platformUserId,
                                fanLabel: fanLabel.label,
                                profileHref: fanNavigation.to,
                              })}
                              className="btn btn-ghost btn-icon"
                              aria-label={`Динамика трат фана ${fanLabel.label}`}
                            >
                              <LineChart size={15} aria-hidden="true" />
                            </button>
                          </Tooltip>
                          <CopyExternalLinkButton
                            platform={platform}
                            username={item.fan.username}
                            platformConversationId={conversationId}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {visibleTotals && items.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border-light bg-hover-alt px-4 py-2.5 text-[13px] text-text-secondary">
            <div className="tabular-nums">
              Показано {items.length} из {total} · потратили <span className="font-semibold text-text-primary">{visibleTotals.spent === null ? "—" : formatUsdFromMills(visibleTotals.spent)}</span>
            </div>
            {visibleTotals.hasBreakdown && (
              <div className="tabular-nums">
                Чаевые {formatUsdFromMills(visibleTotals.tips)} · Подписки {formatUsdFromMills(visibleTotals.subs)} · Покупки {formatUsdFromMills(visibleTotals.purchases)}
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

      <details className="help mt-4">
        <summary>Как это считается</summary>
        <div className="help-body">
          <p>«Потратил» — доход от фана после комиссии платформы за выбранный период. Наведите на сумму, чтобы увидеть разбивку.</p>
          <p>«Действие» — подсказка по сохранённым сигналам (подписка, переписка, давность покупок), а не подтверждение того, что фан ждёт сообщения.</p>
          <p>Уровни считаются по тратам за всё время: Кит — от $500, VIP — от $100, Постоянный — от $50.</p>
        </div>
      </details>

      {chatPreview && (
        <ModalShell
          title={`Переписка с ${chatPreview.fanLabel}`}
          onClose={() => setChatPreview(null)}
        >
          <div className="-mx-5 -mb-5 overflow-hidden rounded-b-2xl sm:-mx-6 sm:-mb-6">
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
          title={`Операции — ${txnPreview.fanLabel}`}
          onClose={() => setTxnPreview(null)}
        >
          <div className="-mx-5 -mb-5 overflow-hidden rounded-b-2xl sm:-mx-6 sm:-mb-6">
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
          title={`Динамика трат — ${trendPreview.fanLabel}`}
          onClose={() => setTrendPreview(null)}
        >
          <div className="-mx-5 -mb-5 overflow-hidden rounded-b-2xl sm:-mx-6 sm:-mb-6">
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
      return `покупали за последние ${SPENDER_RETENTION_ACTIVE_DAYS} дн`;
    case "cooling":
      return `не покупали ${SPENDER_RETENTION_ACTIVE_DAYS}–${SPENDER_RETENTION_INACTIVE_DAYS} дн`;
    case "inactive":
      return `не покупали больше ${SPENDER_RETENTION_INACTIVE_DAYS} дн`;
    case "needs_reactivation":
      return `ценные фаны, не покупали больше ${SPENDER_RETENTION_INACTIVE_DAYS} дн`;
    default:
      return "";
  }
}

function emptyStateMessage(filter: RetentionFilter): string {
  if (filter === "all") return "За этот период трат нет.";
  if (filter === "needs_reactivation") return "Ценных фанов, которые замолчали, нет — возвращать некого.";
  return `В сегменте «${RETENTION_FILTERS.find((f) => f.key === filter)?.label ?? filter}» фанов нет.`;
}
