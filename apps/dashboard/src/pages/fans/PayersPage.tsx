import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  SPENDER_RETENTION_ACTIVE_DAYS,
  SPENDER_RETENTION_INACTIVE_DAYS,
  type SpenderRetentionStatus,
} from "@agency_hub_core/shared";
import type { SpenderBatchBody, SpenderListResponse } from "@agency_hub_core/contracts";
import { useSpenderBatch, useSpenders } from "@/api/queries";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { MoneyDelta } from "@/components/money/Delta";
import { Pagination } from "@/components/shared/Pagination";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { SearchInput } from "@/components/shared/SearchInput";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { RowMenu, type RowMenuItem } from "@/components/ui/RowMenu";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatCount, formatDateTime, formatDayRange, formatMills } from "@/lib/format";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { listOffset } from "@/lib/overviewNavigation";
import { pathSegment } from "@/lib/path";
import { PLATFORM_DISPLAY_NAME, resolveExternalLink, type ExternalLinkPlatform } from "@/lib/platformUrls";
import { ruPlural } from "@/lib/plural";
import { isPlainRowClick } from "@/lib/rowClick";
import { AwaitingNote, FanCell, GoneMark, TierMark } from "./FanCell.js";
import { awaitingWords, fanName, isAwaitingReply, lastPurchaseKind, periodColumn, periodPhrase, spenderPeriodOf, subscriptionWords, type SubscriptionState } from "./fanWords.js";
import { EmptyRow, FeedNote, PastTheEnd, useListParams, useViewerOfapi } from "./listParts.js";
import { FanPanel, panelKind, type PanelFan } from "./panels/FanPanel.js";
import { useAllPayers, type PayerRow } from "./useAllPayers.js";

const LIMIT = 50;

type Row = SpenderListResponse["items"][number];
type SortBy = "creatorNetAmountMills" | "lifetimeCreatorNetAmountMills" | "lastTransactionAt";
type Platform = "fansly" | "onlyfans";

const FILTERS: ReadonlyArray<{ value: SpenderRetentionStatus; label: string }> = [
  { value: "all", label: "Все" },
  { value: "active", label: "Покупают" },
  { value: "cooling", label: "Реже покупают" },
  { value: "inactive", label: "Не покупают" },
  { value: "needs_reactivation", label: "Вернуть" },
];
const FILTER_KEYS: ReadonlySet<string> = new Set(FILTERS.map((item) => item.value));
const SORTS: ReadonlySet<string> = new Set(["creatorNetAmountMills", "lifetimeCreatorNetAmountMills", "lastTransactionAt"]);

function fansWord(count: number): string {
  return `${formatCount(count)} ${ruPlural(count, "фан", "фана", "фанов")}`;
}

/** What the count line says after the number. */
function filterNote(filter: SpenderRetentionStatus): string | null {
  switch (filter) {
    case "active": return `покупали за последние ${SPENDER_RETENTION_ACTIVE_DAYS} дней`;
    case "cooling": return `не покупали ${SPENDER_RETENTION_ACTIVE_DAYS}–${SPENDER_RETENTION_INACTIVE_DAYS} дней`;
    case "inactive": return `не покупали больше ${SPENDER_RETENTION_INACTIVE_DAYS} дней`;
    case "needs_reactivation": return `ценные, не покупали больше ${SPENDER_RETENTION_INACTIVE_DAYS} дней, им ещё можно написать`;
    default: return null;
  }
}

interface BatchItem {
  subscription: SubscriptionState | null;
  pages: ReadonlyArray<{ pageLabel: string; creatorNetAmountMills: number }> | null;
  typeBreakdown: ReadonlyArray<{ canonicalType: string; creatorNetAmountMills: number }> | null;
}

/**
 * «Платящие»: who brings the money, who buys less often, whom to bring back. Every
 * page at once (one platform) or one page. A list of reads: the row menu opens
 * panels and copies links, nothing is written (design/screens/fans-page.md §2).
 */
export function PayersPage() {
  const filter = usePageFilter();
  const { pages } = useDashboardShell();
  const { role } = useViewerOfapi();
  const location = useLocation();
  const navigate = useNavigate();
  const { key: periodKey } = useScreenPeriod();
  const { search, update } = useListParams();

  const pageLabel = filter.page;
  const pagePlatform = (filter.item?.platform ?? null) as Platform | "telegram" | null;
  const platforms = useMemo(() => (["fansly", "onlyfans"] as const).filter((one) => pages.some((page) => page.platform === one)), [pages]);
  const askedPlatform = search.get("platform");
  const allPlatform: Platform = askedPlatform === "onlyfans" && platforms.includes("onlyfans") ? "onlyfans" : platforms.includes("fansly") ? "fansly" : (platforms[0] ?? "fansly");
  const platform: Platform = pageLabel ? (pagePlatform === "onlyfans" ? "onlyfans" : "fansly") : allPlatform;

  const rawFilter = search.get("filter") ?? "all";
  const retention = (FILTER_KEYS.has(rawFilter) ? rawFilter : "all") as SpenderRetentionStatus;
  const awaiting = pageLabel !== null && search.get("awaiting") === "1";
  const query = search.get("q") ?? "";
  const offset = listOffset(search.get("offset"));
  const rawSort = search.get("sortBy") ?? "creatorNetAmountMills";
  const sortBy = (SORTS.has(rawSort) ? rawSort : "creatorNetAmountMills") as SortBy;
  const sortDir = search.get("dir") === "asc" ? "asc" : "desc";
  const lifetime = periodKey === "all";
  const spenderPeriod = spenderPeriodOf(periodKey);
  const shownKind = panelKind(search.get("show"));
  const shownFan = search.get("fan");

  // «Ждут ответа» is of one page only.
  useEffect(() => {
    if (pageLabel === null && search.get("awaiting") === "1") update({ awaiting: null }, { keepPosition: true });
  }, [pageLabel, search, update]);

  const listQuery = useSpenders({
    scope: pageLabel ? "page" : "agency",
    ...(pageLabel ? { pageLabel } : { platform }),
    period: spenderPeriod,
    limit: LIMIT,
    offset,
    sortBy,
    sortDir,
    ...(query ? { query } : {}),
    retentionStatus: retention,
  }, { enabled: !awaiting });
  const payers = useAllPayers(pageLabel ?? "", { enabled: awaiting });

  const awaitingRows = useMemo(() => {
    if (!awaiting || !payers.data) return null;
    const lower = query.trim().toLowerCase();
    return payers.data.items
      .filter((row) => isAwaitingReply(row.conversation))
      .filter((row) => retention === "all" || row.retentionStatus === retention)
      .filter((row) => lower === "" || [row.fan.username, row.fan.displayName, row.fan.pageAlias, row.fan.platformUserId].some((part) => part?.toLowerCase().includes(lower)));
  }, [awaiting, payers.data, query, retention]);

  const items: Row[] = awaiting ? (awaitingRows ?? []).slice(offset, offset + LIMIT) : listQuery.data?.items ?? [];
  const total = awaiting ? awaitingRows?.length ?? 0 : listQuery.data?.total ?? 0;

  const batchBody: SpenderBatchBody | null = useMemo(() => {
    if (items.length === 0) return null;
    return {
      scope: pageLabel ? "page" : "agency",
      ...(pageLabel ? { pageLabel } : { platform }),
      period: spenderPeriod,
      fans: items.map((item) => ({ platform, platformUserId: item.fan.platformUserId })),
    } as SpenderBatchBody;
  }, [items, pageLabel, platform, spenderPeriod]);
  const batch = useSpenderBatch(batchBody);
  const batchByFan = useMemo(() => {
    const map = new Map<string, BatchItem>();
    for (const item of batch.data?.items ?? []) {
      if (!item.found) continue;
      map.set(item.requestedFan.platformUserId, {
        subscription: item.subscription,
        pages: item.pages ?? null,
        typeBreakdown: item.typeBreakdown,
      });
    }
    return map;
  }, [batch.data]);
  const batchSettled = batch.data !== undefined || batch.isError;

  const backTo = `${location.pathname}${location.search}`;
  const cardOf = useCallback((row: Row) => {
    const name = fanName(row.fan, pageLabel ? "page" : "global").label;
    const nav = pageLabel
      ? buildFanProfileNavigation(pageLabel, platform, row.fan.platformUserId, backTo, name)
      : { to: `/fans/${pathSegment(platform)}/${pathSegment(row.fan.platformUserId)}`, state: { backTo, fanLabel: name } };
    return { to: `${nav.to}?${new URLSearchParams({ period: periodKey })}`, state: nav.state };
  }, [backTo, pageLabel, periodKey, platform]);

  const openPanel = (row: Row, kind: "chat" | "operations" | "trend") => update({ fan: row.fan.platformUserId, show: kind }, { keepPosition: true });
  const closePanel = useCallback(() => update({ fan: null, show: null }, { keepPosition: true }), [update]);

  const status = awaiting ? payers : listQuery;
  const window = listQuery.data?.period;
  const asOf = awaiting ? null : listQuery.data?.period.asOf ?? null;

  const header = (
    <PageHeader
      window={!awaiting && !lifetime && window?.fromBusinessDate && window.toBusinessDateInclusive
        ? formatDayRange(window.fromBusinessDate, window.toBusinessDateInclusive)
        : undefined}
      fresh={asOf ? { at: asOf, onRefresh: () => void listQuery.refetch(), refreshing: listQuery.isFetching && !listQuery.isLoading } : undefined}
    />
  );

  const toolbar = (
    <div className="table-toolbar fan-toolbar">
      <div className="fan-toolbar-filters">
        {!pageLabel && platforms.length > 1 && (
          <Segmented
            label="Площадка"
            value={platform}
            onChange={(next) => update({ platform: next === "fansly" ? null : next, fan: null, show: null })}
            options={platforms.map((one) => ({ value: one, label: PLATFORM_DISPLAY_NAME[one] }))}
          />
        )}
        <Segmented
          label="Фильтр"
          value={retention}
          onChange={(next) => update({ filter: next === "all" ? null : next, fan: null, show: null })}
          options={FILTERS}
          className="fan-segments"
        />
        <label className="fan-check" title={pageLabel ? undefined : "Только на одной странице"}>
          <input
            type="checkbox"
            checked={awaiting}
            disabled={!pageLabel}
            onChange={(event) => update({ awaiting: event.target.checked ? "1" : null, fan: null, show: null })}
          />
          Ждут ответа
          {!pageLabel && <span className="fan-check-note">только на одной странице</span>}
        </label>
      </div>
      <SearchInput value={query} onChange={(value) => update({ q: value || null, fan: null, show: null })} placeholder="Найти фана" />
    </div>
  );

  const firstLoad = status.data === undefined;
  if (firstLoad) {
    return (
      <div className="fan-screen">
        {header}
        {toolbar}
        {status.isError ? <NoAnswerPanel retry={status.refetch} /> : <TableSkeleton rows={10} columns={7} />}
      </div>
    );
  }

  const where = pageLabel ? `На ${pageLabel} ` : "";
  const filterLabel = FILTERS.find((item) => item.value === retention)?.label ?? "";
  const countLine = awaiting
    ? `${formatCount(total)} из ${formatCount(payers.data?.total ?? 0)} ${ruPlural(payers.data?.total ?? 0, "платящего", "платящих", "платящих")}`
    : [fansWord(total), filterNote(retention)].filter(Boolean).join(" · ");

  const showPages = !pageLabel;
  const showWindow = !lifetime;
  const showSubscription = Boolean(pageLabel);
  const columns = 1 + 1 + (showPages ? 1 : 0) + (showWindow ? 1 : 0) + 1 + (showSubscription ? 1 : 0) + 1 + 1;
  const sortable = !awaiting;

  const empty = (): ReactNode => {
    if (offset > 0) return <PastTheEnd colSpan={columns} onBack={() => update({ offset: null })} />;
    if (query) {
      return <EmptyRow colSpan={columns} title={`По запросу «${query}» никого нет.`} action={<button type="button" className="btn btn-sm" onClick={() => update({ q: null })}>Сбросить поиск</button>} />;
    }
    if (awaiting) return <EmptyRow colSpan={columns} title={`${where}никто из платящих не ждёт ответа.`.replace(/^н/, "Н")} />;
    if (retention === "needs_reactivation") {
      return <EmptyRow colSpan={columns} title={`${where}некого возвращать: ценных фанов, которые замолчали, нет.`.replace(/^н/, "Н")} />;
    }
    if (retention !== "all") return <EmptyRow colSpan={columns} title={`${where}нет фанов в фильтре «${filterLabel}».`.replace(/^н/, "Н")} />;
    if (pageLabel) {
      return <EmptyRow colSpan={columns} title={`На ${pageLabel} ${periodPhrase(periodKey)} покупок нет.`} action={<button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Показать все страницы</button>} />;
    }
    return (
      <EmptyRow
        colSpan={columns}
        title={`${periodColumn(periodKey)} покупок нет.`}
        action={periodKey !== "30d" && periodKey !== "all" ? <Link className="btn btn-sm" to={`?${new URLSearchParams({ ...Object.fromEntries(search), period: "30d" })}`}>Показать 30 дней</Link> : undefined}
      />
    );
  };

  const panelRow = shownFan ? items.find((row) => row.fan.platformUserId === shownFan) ?? null : null;
  const panelFan: PanelFan | null = panelRow && shownKind ? (() => {
    const card = cardOf(panelRow);
    const item = batchByFan.get(panelRow.fan.platformUserId);
    return {
      platformUserId: panelRow.fan.platformUserId,
      name: fanName(panelRow.fan, pageLabel ? "page" : "global").label,
      platform,
      pageLabel,
      conversationId: panelRow.conversation.platformConversationId,
      cardHref: card.to,
      cardState: card.state,
      windowMills: panelRow.metrics.window?.creatorNetAmountMills ?? null,
      windowCount: panelRow.metrics.window?.transactionCount ?? null,
      lifetimeMills: panelRow.metrics.lifetime.scopeCreatorNetAmountMills,
      breakdown: item?.typeBreakdown ?? null,
    };
  })() : null;

  return (
    <div className="fan-screen">
      {header}
      {toolbar}
      <QueryNotice error={status.isError} stale retry={status.refetch} at={status.dataUpdatedAt} />
      {batch.isError && items.length > 0 && (
        <Notice tone="warning" action={<button type="button" className="btn btn-sm" onClick={() => void batch.refetch()}>Повторить</button>}>
          Подписки и разбивка не пришли. Суммы показаны.
        </Notice>
      )}
      {awaiting && payers.data?.capped && <p className="table-toolbar-note">Показаны первые {formatCount(payers.data.items.length)} платящих.</p>}
      <p className="fan-count">{countLine}</p>
      <section className="card" aria-label="Платящие">
        <div className={`table-wrap ${status.isFetching && !status.isLoading ? "is-refreshing" : ""}`}>
          <table className="data-table data-table-sticky fan-table">
            <thead>
              <tr>
                <th scope="col" className="num fan-rank">#</th>
                <th scope="col">Фан</th>
                {showPages && <th scope="col">Страницы</th>}
                {showWindow && <SortHeader label={periodColumn(periodKey)} sortKey="creatorNetAmountMills" sortBy={sortBy} dir={sortDir} enabled={sortable} onSort={(key, dir) => update({ sortBy: key === "creatorNetAmountMills" ? null : key, dir: dir === "desc" ? null : dir })} />}
                <SortHeader label="За всё время" sortKey={lifetime ? "creatorNetAmountMills" : "lifetimeCreatorNetAmountMills"} sortBy={lifetime && sortBy === "lifetimeCreatorNetAmountMills" ? "creatorNetAmountMills" : sortBy} dir={sortDir} enabled={sortable} onSort={(key, dir) => update({ sortBy: key === "creatorNetAmountMills" ? null : key, dir: dir === "desc" ? null : dir })} />
                {showSubscription && <th scope="col">Подписка</th>}
                <SortHeader label="Последняя покупка" sortKey="lastTransactionAt" sortBy={sortBy} dir={sortDir} enabled={sortable} align="left" onSort={(key, dir) => update({ sortBy: key, dir: dir === "desc" ? null : dir })} />
                <th scope="col" className="fan-menu-col"><span className="sr-only">Действия со строкой</span></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && empty()}
              {items.map((row, index) => {
                const name = fanName(row.fan, pageLabel ? "page" : "global");
                const card = cardOf(row);
                const item = batchByFan.get(row.fan.platformUserId);
                const conversationId = row.conversation.platformConversationId;
                return (
                  <tr
                    key={row.fan.platformUserId}
                    className={`cursor-pointer ${shownFan === row.fan.platformUserId ? "is-selected" : ""}`}
                    onClick={(event) => {
                      if (!isPlainRowClick(event)) return;
                      navigate(card.to, { state: card.state });
                    }}
                  >
                    <td className="num muted fan-rank">{offset + index + 1}</td>
                    <td>
                      <FanCell
                        name={name.label}
                        to={card.to}
                        state={card.state}
                        handle={name.handle}
                        marks={<><TierMark lifetimeNetMills={row.metrics.lifetime.scopeCreatorNetAmountMills} />{pageLabel && <GoneMark missAt={row.accountLookupMissAt} />}</>}
                        note={awaitingWords(row.conversation) ? <AwaitingNote words={awaitingWords(row.conversation)} /> : null}
                      />
                    </td>
                    {showPages && <td><PagesCell pages={item?.pages ?? null} settled={batchSettled} platform={platform} platformUserId={row.fan.platformUserId} backTo={backTo} period={periodKey} /></td>}
                    {showWindow && (
                      <td className="num">
                        <div>{row.metrics.window ? formatMills(row.metrics.window.creatorNetAmountMills) : "—"}</div>
                        <div className="fan-cell-sub">
                          {periodKey === "today" || !row.metrics.comparison
                            ? "—"
                            : <MoneyDelta mills={row.metrics.comparison.deltaCreatorNetAmountMills} pct={row.metrics.comparison.deltaPct} />}
                        </div>
                      </td>
                    )}
                    <td className="num">{formatMills(row.metrics.lifetime.scopeCreatorNetAmountMills)}</td>
                    {showSubscription && <td><SubscriptionCell state={item?.subscription ?? null} settled={batchSettled} failed={batch.isError} /></td>}
                    <td><LastPurchase row={row} /></td>
                    <td className="fan-menu-col">
                      <RowMenu label={`Действия: ${name.label}`} items={menuItems(row, {
                        pageLabel,
                        platform,
                        open: () => navigate(card.to, { state: card.state }),
                        panel: (kind) => openPanel(row, kind),
                        conversationId,
                      })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {total > 0 && <Pagination offset={offset} limit={LIMIT} total={total} onPageChange={(next) => update({ offset: next === 0 ? null : String(next) })} />}
      </section>
      {platform === "onlyfans" && <FeedNote />}
      <Disclosure>
        <p>{lifetime ? "" : `«${periodColumn(periodKey)}» — доход от фана после комиссии площадки за эти даты. `}«За всё время» — всё, что фан принёс этой странице, а при «Все страницы» всем страницам выбранной площадки.</p>
        <p>«Кит» — от $500 за всё время после комиссии, «VIP» — от $100, «Постоянный» — от $50.</p>
        <p>«Покупают» — последняя покупка за {SPENDER_RETENTION_ACTIVE_DAYS} дней. «Реже покупают» — {SPENDER_RETENTION_ACTIVE_DAYS}–{SPENDER_RETENTION_INACTIVE_DAYS} дней назад. «Не покупают» — больше {SPENDER_RETENTION_INACTIVE_DAYS} дней. «Вернуть» — больше {SPENDER_RETENTION_INACTIVE_DAYS} дней, потрачено от $100, и страница ещё может написать.</p>
        <p>«Ждут ответа» — фан написал последним. Массовая рассылка здесь считается ответом, поэтому в расширении у чаттера такой фан может быть в очереди, а здесь нет.</p>
        <p>«Обновлено» — когда Hub в последний раз получил все деньги этих страниц.</p>
      </Disclosure>
      {shownKind && panelFan && <FanPanel kind={shownKind} fan={panelFan} period={periodKey} owner={role === "owner"} onClose={closePanel} />}
    </div>
  );
}

function SortHeader({ label, sortKey, sortBy, dir, enabled, align = "right", onSort }: {
  label: string;
  sortKey: SortBy;
  sortBy: SortBy;
  dir: "asc" | "desc";
  enabled: boolean;
  align?: "left" | "right";
  onSort: (key: SortBy, dir: "asc" | "desc") => void;
}) {
  const active = enabled && sortBy === sortKey;
  const className = `${align === "right" ? "num" : ""} ${active ? "is-sorted" : ""}`.trim() || undefined;
  if (!enabled) return <th scope="col" className={className}>{label}</th>;
  return (
    <th scope="col" className={className} aria-sort={active ? (dir === "desc" ? "descending" : "ascending") : undefined}>
      <button type="button" className="sort fan-sort" onClick={() => onSort(sortKey, active && dir === "desc" ? "asc" : "desc")}>
        {label}
        {active ? (dir === "desc" ? <ArrowDown size={16} aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />) : <ArrowDown size={16} aria-hidden="true" className="fan-sort-idle" />}
      </button>
    </th>
  );
}

function SubscriptionCell({ state, settled, failed }: { state: SubscriptionState | null; settled: boolean; failed: boolean }) {
  if (!settled) return <Skeleton width={96} />;
  if (failed || state === null) return <span className="text-text-muted">—</span>;
  const words = subscriptionWords(state);
  return (
    <div>
      <div className={words.first === "—" ? "text-text-muted" : undefined}>{words.first}</div>
      {words.second && <div className="fan-cell-sub">{words.second}</div>}
    </div>
  );
}

function LastPurchase({ row }: { row: Row }) {
  const last = row.lastTransaction;
  if (!last) return <span className="text-text-muted">—</span>;
  return (
    <div>
      <div className="tabular-nums">{formatDateTime(last.occurredAt, { yearUnlessCurrent: true })}</div>
      <div className="fan-cell-sub">
        {lastPurchaseKind(last.canonicalType)} · <span className="tabular-nums">{formatMills(last.creatorNetAmountMills)}</span>
        {last.transactionState === "pending" && " · ожидает"}
      </div>
    </div>
  );
}

/** Up to three pages, the most money first, each opening the fan there; then «+2». */
function PagesCell({ pages, settled, platform, platformUserId, backTo, period }: {
  pages: BatchItem["pages"];
  settled: boolean;
  platform: string;
  platformUserId: string;
  backTo: string;
  period: string;
}) {
  if (!settled) return <Skeleton width={120} />;
  if (!pages || pages.length === 0) return <span className="text-text-muted">—</span>;
  const shown = pages.slice(0, 3);
  const rest = pages.length - shown.length;
  return (
    <div className="fan-pages">
      {shown.map((page) => {
        const nav = buildFanProfileNavigation(page.pageLabel, platform, platformUserId, backTo);
        return <Link key={page.pageLabel} className="fan-page-link" to={`${nav.to}?${new URLSearchParams({ period })}`} state={nav.state}>{page.pageLabel}</Link>;
      })}
      {rest > 0 && <Link className="fan-page-link" to={`/fans/${pathSegment(platform)}/${pathSegment(platformUserId)}?${new URLSearchParams({ period })}`} state={{ backTo }}>+{rest}</Link>}
    </div>
  );
}

async function copyLink(url: string, kind: "chat" | "profile") {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    toast.error("Буфер обмена недоступен");
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast.success(kind === "chat" ? "Ссылка на чат скопирована" : "Ссылка на профиль скопирована");
  } catch {
    toast.error("Не удалось скопировать");
  }
}

function menuItems(row: PayerRow, input: {
  pageLabel: string | null;
  platform: string;
  open: () => void;
  panel: (kind: "chat" | "operations" | "trend") => void;
  conversationId: string | null;
}): RowMenuItem[] {
  const platform = input.platform as ExternalLinkPlatform;
  const site = PLATFORM_DISPLAY_NAME[platform] ?? input.platform;
  // On «Все страницы» the chat's number may be another page's: the profile only.
  const chatId = input.pageLabel ? input.conversationId : null;
  const link = resolveExternalLink(platform, { username: row.fan.username, platformConversationId: chatId });
  const items: RowMenuItem[] = [
    { label: "Открыть карточку", onSelect: input.open },
    input.pageLabel && input.conversationId
      ? { label: "Переписка", onSelect: () => input.panel("chat") }
      : { label: "Переписка", onSelect: () => undefined, disabled: true, hint: input.pageLabel ? "Переписки нет" : "Только на одной странице" },
    { label: "Операции", onSelect: () => input.panel("operations") },
    { label: "Траты по дням", onSelect: () => input.panel("trend") },
  ];
  if (link) {
    items.push({
      label: link.kind === "chat" ? `Скопировать ссылку на чат ${site}` : `Скопировать ссылку на профиль ${site}`,
      onSelect: () => void copyLink(link.url, link.kind),
    });
  }
  return items;
}
