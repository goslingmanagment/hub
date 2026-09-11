import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Copy, Check, ArrowUp, ArrowDown } from "lucide-react";
import {
  PLATFORM_DISPLAY_NAME,
  resolveExternalLink,
  type ExternalLinkPlatform,
} from "@/lib/platformUrls";
import { useSpenders, useSpenderBatch } from "@/api/queries";
import { Pagination } from "@/components/shared/Pagination";
import { SearchInput } from "@/components/shared/SearchInput";
import { audiencePaginationLabels, audiencePeriod, buildAudienceFanNavigation } from "@/lib/audienceNavigation";
import { listOffset } from "@/lib/overviewNavigation";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
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
  { key: "all", label: "Все" },
  { key: "active", label: "Активные" },
  { key: "cooling", label: "Остывают" },
  { key: "inactive", label: "Неактивные" },
  { key: "needs_reactivation", label: "Нужен возврат" },
];

const STATUS_DOT: Record<Exclude<RetentionFilter, "all">, { color: string; label: string }> = {
  active: { color: "var(--color-green)", label: "Активные" },
  cooling: { color: "var(--color-warning)", label: "Остывают" },
  inactive: { color: "var(--color-text-muted)", label: "Неактивные" },
  needs_reactivation: { color: "var(--color-danger)", label: "Нужен возврат" },
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
      <Tooltip content="Whale — доход автора за всё время от $500">
        <span className="ml-1.5 inline-flex items-center rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-bold text-blue-400">🐋 Whale</span>
      </Tooltip>
    );
  if (lifetimeScopeCreatorNetMills >= 100_000)
    return (
      <Tooltip content="VIP — доход автора за всё время от $100">
        <span className="ml-1.5 inline-flex items-center rounded-md bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-bold text-purple-400">💎 VIP</span>
      </Tooltip>
    );
  if (lifetimeScopeCreatorNetMills >= 50_000)
    return (
      <Tooltip content="Постоянный — доход автора за всё время от $50">
        <span className="ml-1.5 inline-flex items-center rounded-md bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-bold text-yellow-400">⭐ Постоянный</span>
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
  spent: number | null;
  tips: number;
  subs: number;
  purchases: number;
  ready: boolean;
}) {
  const formatted = spent === null ? "—" : formatUsdFromMills(spent);
  if (!ready || tips + subs + purchases === 0) {
    return <span>{formatted}</span>;
  }
  const tooltipContent = (
    <div className="space-y-0.5 tabular-nums">
      <div className="flex justify-between gap-4">
        <span className="text-white/70">Чаевые</span>
        <span>{formatUsdFromMills(tips)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-white/70">Подписки</span>
        <span>{formatUsdFromMills(subs)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-white/70">Покупки</span>
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
    return <span className="text-xs text-text-muted">Нет переписки</span>;
  }

  const unanswered = isUnansweredConversation(conversation);

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-text-primary">
          {conversation.lastMessageAt ? formatRelativeTime(conversation.lastMessageAt) : "загружено"}
        </span>
        {unanswered && (
          <Tooltip content="Без ответа — фан написал последним">
            <span
              aria-label="Без ответа"
              className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-warning/20 text-[10px] font-bold text-warning-dark"
            >
              ⚠
            </span>
          </Tooltip>
        )}
        {conversation.unreadCount > 0 && (
          <Tooltip content={`Непрочитанных сообщений: ${conversation.unreadCount}`}>
            <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white tabular-nums">
              {conversation.unreadCount}
            </span>
          </Tooltip>
        )}
      </div>
      <div className="text-[11px] text-text-muted tabular-nums">
        Фан {conversation.lastFanMessageAt ? formatRelativeTimeCompact(conversation.lastFanMessageAt) : "—"}
        <span className="mx-1 text-border">·</span>
        Модель {conversation.lastModelMessageAt ? formatRelativeTimeCompact(conversation.lastModelMessageAt) : "—"}
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
            <Tooltip content={`Состояние операции: ${transaction.transactionState}`}>
              <span className="font-medium text-warning-dark">{transaction.transactionState}</span>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}

function SubCell({ subscription, ready, loading }: {
  subscription: {
    status: "active" | "expired" | "never";
    expiresAt: string | null;
    autoRenew: boolean | null;
    autoRenewOffDetectedAt: string | null;
  } | null;
  ready: boolean;
  loading: boolean;
}) {
  if (!ready) {
    return <span className="text-xs text-text-muted">{loading ? "Загрузка…" : "Неизвестно"}</span>;
  }
  if (!subscription || subscription.status === "never") {
    return <span className="text-xs text-text-muted">—</span>;
  }
  if (subscription.status === "expired") {
    return (
      <Tooltip content="Подписка истекла">
        <span className="inline-flex items-center rounded-md bg-text-muted/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-text-muted">
          Истекла
        </span>
      </Tooltip>
    );
  }
  const days = subscription.expiresAt ? daysRemaining(subscription.expiresAt) : null;
  const renewLabel = subscription.autoRenew === true
    ? "Продление включено"
    : subscription.autoRenew === false
      ? "Продление выключено"
      : null;
  const tooltipContent = (
    <div className="space-y-0.5">
      <div>Подписка активна</div>
      {days !== null && <div className="text-white/70">Осталось {days} дн.</div>}
      {renewLabel && <div className="text-white/70">{renewLabel}</div>}
      {subscription.autoRenew === false && subscription.autoRenewOffDetectedAt && (
        <div className="text-white/70">
          Замечено {formatDate(subscription.autoRenewOffDetectedAt, { includeYear: true })}
        </div>
      )}
    </div>
  );
  return (
    <Tooltip content={tooltipContent}>
      <span className="inline-flex items-center gap-1 rounded-md bg-green/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-green">
        Активна
        {subscription.autoRenew === false && (
          <span className="text-warning-dark normal-case font-medium">· без продления</span>
        )}
      </span>
    </Tooltip>
  );
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

  const platformName = PLATFORM_DISPLAY_NAME[platform];
  const tooltipLabel = link.kind === "chat"
    ? `Скопировать ссылку на чат ${platformName}`
    : `Скопировать ссылку на профиль ${platformName}`;

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
        label: `Подписка ${days} дн.`,
        description: `До конца подписки ${days} дн.${subscription.autoRenew === false ? " · продление выключено" : ""}`,
        className: "bg-warning/15 text-warning-dark",
      };
    }
  }

  // 2. High-value gone quiet
  if (item.retentionStatus === "needs_reactivation") {
    return {
      label: "Вернуть",
      description: "Ценный спендер давно не покупал — свяжитесь с ним",
      className: "bg-danger/15 text-danger",
    };
  }

  // 3. Unanswered chat (fan messaged last)
  if (isUnansweredConversation(item.conversation)) {
    return {
      label: "Ответить",
      description: "Фан написал последним — нужен ответ",
      className: "bg-accent/15 text-accent",
    };
  }

  // 4. Cooling — check in
  if (item.retentionStatus === "cooling") {
    return {
      label: "Напомнить",
      description: "Покупок давно не было — пора напомнить о себе",
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
  const location = useLocation();
  const storedPeriod = useSpenderPeriodStore((s) => s.topSupportersPeriod);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedPeriod = audiencePeriod(searchParams.get("period"), storedPeriod);
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
    });
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

  const { data: spenders, isError, refetch } = useSpenders(spenderParams);

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

  const { data: batchData, isError: batchError, isFetching: batchFetching, refetch: refetchBatch } = useSpenderBatch(batchBody);

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
    let hasAmounts = true;
    let hasBreakdown = true;
    let tips = 0;
    let subs = 0;
    let purchases = 0;
    for (const item of spenders.items) {
      const itemSpent = isLifetime
        ? item.metrics.lifetime.scopeCreatorNetAmountMills
        : item.metrics.window?.creatorNetAmountMills;
      if (itemSpent === undefined) hasAmounts = false;
      else spent += itemSpent;
      const batch = batchByPlatformUserId.get(item.fan.platformUserId);
      if (!batch?.typeBreakdown) hasBreakdown = false;
      if (batch?.typeBreakdown) {
        tips += sumBreakdownTypes(batch.typeBreakdown, ["tip", "stream_tip"]);
        subs += sumBreakdownTypes(batch.typeBreakdown, ["subscription"]);
        purchases += sumBreakdownTypes(batch.typeBreakdown, ["message_purchase", "post_purchase"]);
      }
    }
    return { spent: hasAmounts ? spent : null, tips, subs, purchases, hasBreakdown };
  }, [spenders, spenderPeriod, batchByPlatformUserId, batchData]);

  const total = spenders?.total;
  const isLifetime = spenderPeriod === "lifetime";
  const columnCount = isLifetime ? 7 : 8;
  const subtitle = describeRetentionSubtitle(retentionFilter);
  const hasFilters = retentionFilter !== "all" || searchQuery.length > 0;
  const incompleteBatch = Boolean(batchData) && items.some((item) => {
    const batch = batchByPlatformUserId.get(item.fan.platformUserId);
    return !batch?.typeBreakdown || !batch.subscription;
  });

  return (
    <div className="min-w-0 p-4 md:p-0">
      <div className="mb-4">
        <h1 className="text-xl font-extrabold text-text-primary">
          Топ спендеров &mdash; {pageLabel}
        </h1>
        <p className="text-sm text-text-muted mt-1">
          {total === undefined ? "Число записей пока неизвестно" : `${total} записей в выборке`}
          {subtitle ? ` · ${subtitle}` : ""}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div role="group" aria-label="Активность покупок" className="flex flex-wrap items-center gap-1">
          {RETENTION_FILTERS.map((filter) => {
            const isActive = retentionFilter === filter.key;
            return (
              <button
                key={filter.key}
                type="button"
                aria-pressed={isActive}
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
          placeholder="Поиск спендера…"
        />
      </div>

      {hasFilters && <button type="button" className="mb-3 text-sm font-medium text-accent" onClick={() => updateParams({ filter: null, q: null, offset: null })}>Сбросить фильтры</button>}
      <p className="mb-3 text-xs text-text-muted">Рейтинг по доходу автора после комиссии за выбранный период. Категории активности учитывают последнюю покупку. Нажмите на имя, чтобы открыть карточку фана.</p>
      <QueryNotice error={isError && Boolean(spenders)} stale={Boolean(spenders)} retry={refetch} />
      {spenders && batchBody && batchError && (
        <p role="alert" className="mb-3 rounded-lg border border-warning bg-hover-alt px-3 py-2 text-xs text-text-secondary">
          Не удалось обновить сведения о подписках и разбивку дохода.
          {batchData ? " Показаны ранее полученные детали." : " Основной рейтинг доступен."}{" "}
          <button type="button" className="font-semibold text-accent underline" onClick={() => void refetchBatch()}>Повторить</button>
        </p>
      )}
      {spenders && incompleteBatch && !batchError && <p role="status" className="mb-3 text-xs text-warning-dark">Часть сведений о подписках и разбивке дохода недоступна. <button type="button" className="font-semibold text-accent" onClick={() => void refetchBatch()}>Повторить</button></p>}
      {!spenders ? (
        isError ? <StatusPanel title="Не удалось загрузить спендеров" description="Повторите запрос. Поиск и фильтры сохранены." tone="error" action={<button type="button" className="text-accent font-semibold" onClick={() => void refetch()}>Повторить</button>} />
          : <div role="status" aria-label="Загрузка спендеров"><TableSkeleton rows={8} columns={columnCount} /></div>
      ) : (
      <section className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[860px] border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              <th className="w-12 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">#</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Фан</th>
              <th className="px-3 py-2 text-right" aria-sort={sortBy === "creatorNetAmountMills" ? sortDir === "asc" ? "ascending" : "descending" : "none"}>
                <SortableHeader
                  label="Доход автора"
                  align="right"
                  sortKey="creatorNetAmountMills"
                  currentSort={sortBy}
                  currentDir={sortDir}
                  onSort={toggleSort}
                />
              </th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Подписка</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Следующий шаг</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Переписка</th>
              <th className="px-3 py-2 text-left" aria-sort={sortBy === "lastTransactionAt" ? sortDir === "asc" ? "ascending" : "descending" : "none"}>
                <SortableHeader
                  label="Последняя покупка"
                  sortKey="lastTransactionAt"
                  currentSort={sortBy}
                  currentDir={sortDir}
                  onSort={toggleSort}
                />
              </th>
              {!isLifetime && (
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">Динамика</th>
              )}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-3 py-8 text-center text-sm text-text-muted">
                  {offset > 0 ? "Эта страница больше не содержит записей." : searchQuery ? "По этому запросу спендеры не найдены." : emptyStateMessage(retentionFilter)}
                  {offset > 0 && <button type="button" className="block mx-auto mt-2 text-accent" onClick={() => setOffset(0)}>К началу списка</button>}
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
              const hasBatch = Boolean(batch?.typeBreakdown);
              const tips = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["tip", "stream_tip"]);
              const subs = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["subscription"]);
              const purchases = sumBreakdownTypes(batch?.typeBreakdown ?? null, ["message_purchase", "post_purchase"]);

              const fanNavigation = buildAudienceFanNavigation(
                pageLabel!,
                platform!,
                item.fan.platformUserId,
                location.pathname + location.search,
                fanLabel.label,
                selectedPeriod,
              );

              return (
                <tr
                  key={item.fan.platformUserId}
                  className="border-t border-border transition-colors hover:bg-hover"
                >
                  <td className="px-3 py-2.5 align-middle">
                    <div className="flex items-center gap-2">
                      <StatusDot status={item.retentionStatus} />
                      <span className="text-sm text-text-secondary tabular-nums">{offset + index + 1}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <div className="flex items-center">
                      <Link to={fanNavigation.to} state={fanNavigation.state} className="text-sm font-semibold text-text-primary hover:text-accent">
                        {fanLabel.label}
                      </Link>
                      {whaleBadge(lifetimeNet)}
                      {fanLabel.secondaryPlatformHandle && (
                        <span className="ml-2 text-xs text-text-muted">@{fanLabel.secondaryPlatformHandle}</span>
                      )}
                      <CopyExternalLinkButton
                        platform={platform!}
                        username={item.fan.username}
                        platformConversationId={item.conversation.platformConversationId}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-middle text-right text-sm font-medium tabular-nums text-text-primary">
                    <button type="button" className="w-full rounded py-1 text-right hover:text-accent focus-visible:outline-2" aria-label={`Динамика дохода · ${fanLabel.label}`} onClick={() => setTrendPreview({ platformUserId: item.fan.platformUserId, fanLabel: fanLabel.label, profileHref: fanNavigation.to })}>
                      <SpentCell spent={spent} tips={tips} subs={subs} purchases={purchases} ready={hasBatch} />
                    </button>
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <SubCell subscription={batch?.subscription ?? null} ready={Boolean(batch?.subscription)} loading={Boolean(batchFetching)} />
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <NextActionCell action={computeNextAction(item, batch?.subscription ?? null)} />
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    {item.conversation.platformConversationId ? (
                      <button type="button" className="w-full rounded py-1 text-left hover:bg-hover-alt focus-visible:outline-2" aria-label={`Открыть переписку · ${fanLabel.label}`} onClick={() => setChatPreview({ platformConversationId: item.conversation.platformConversationId!, fanLabel: fanLabel.label, profileHref: fanNavigation.to })}>
                        <ChatCell conversation={item.conversation} />
                      </button>
                    ) : <ChatCell conversation={item.conversation} />}
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    {item.lastTransaction ? (
                      <button type="button" className="w-full rounded py-1 text-left hover:bg-hover-alt focus-visible:outline-2" aria-label={`Открыть операции · ${fanLabel.label}`} onClick={() => setTxnPreview({ platformUserId: item.fan.platformUserId, fanLabel: fanLabel.label, profileHref: fanNavigation.to })}>
                        <LastTransactionCell transaction={item.lastTransaction} />
                      </button>
                    ) : <LastTransactionCell transaction={item.lastTransaction} />}
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
              {items.length} из {total} на экране · Доход автора <span className="font-semibold text-text-primary tabular-nums">{visibleTotals.spent === null ? "—" : formatUsdFromMills(visibleTotals.spent)}</span>
            </div>
            {visibleTotals.hasBreakdown && (
              <div className="tabular-nums">
                Чаевые <span className="text-text-secondary">{formatUsdFromMills(visibleTotals.tips)}</span>
                <span className="mx-1.5 text-border">·</span>
                Подписки <span className="text-text-secondary">{formatUsdFromMills(visibleTotals.subs)}</span>
                <span className="mx-1.5 text-border">·</span>
                Покупки <span className="text-text-secondary">{formatUsdFromMills(visibleTotals.purchases)}</span>
              </div>
            )}
          </div>
        )}

        <Pagination
          offset={offset}
          limit={LIMIT}
          total={spenders.total}
          onPageChange={setOffset}
          {...audiencePaginationLabels}
        />
      </section>
      )}

      {chatPreview && (
        <ModalShell
          title={`Переписка · ${chatPreview.fanLabel}`}
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
          title={`Операции · ${txnPreview.fanLabel}`}
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
          title={`Динамика дохода · ${trendPreview.fanLabel}`}
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
      return `покупали за последние ${SPENDER_RETENTION_ACTIVE_DAYS} дней`;
    case "cooling":
      return `без покупок ${SPENDER_RETENTION_ACTIVE_DAYS}–${SPENDER_RETENTION_INACTIVE_DAYS} дней`;
    case "inactive":
      return `без покупок более ${SPENDER_RETENTION_INACTIVE_DAYS} дней`;
    case "needs_reactivation":
      return `ценные спендеры без покупок более ${SPENDER_RETENTION_INACTIVE_DAYS} дней`;
    default:
      return "";
  }
}

function emptyStateMessage(filter: RetentionFilter): string {
  if (filter === "all") return "За выбранный период спендеры не найдены.";
  if (filter === "needs_reactivation") return "В этом сегменте нет спендеров, которым нужен возврат.";
  return `В сегменте «${RETENTION_FILTERS.find((f) => f.key === filter)?.label ?? filter}» спендеров нет.`;
}
