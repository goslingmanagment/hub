import { Fragment } from "react";
import type { ReactivationRowVm } from "@/pages/crm/viewModel";
import { ChatPreviewPanel } from "./ChatPreviewPanel";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { SearchInput } from "@/components/shared/SearchInput";
import { Pagination } from "@/components/shared/Pagination";

type SortField = "reactivationScore" | "lifetimeSpendUsd" | "silenceDays" | "lastContactAt";

interface ReactivationTableProps {
  items: ReactivationRowVm[];
  total: number;
  limit: number;
  offset: number;
  expandedConversationId: string | null;
  silenceFilter: string;
  minSpendUsd: string;
  noDmHistoryOnly: boolean;
  unreadOnly: boolean;
  subscriberState: string;
  searchQuery: string;
  sortBy: string;
  sortDir: string;
  pageLabel: string;
  onSilenceChange: (value: string) => void;
  onMinSpendChange: (value: string) => void;
  onNoDmHistoryChange: (value: boolean) => void;
  onUnreadOnlyChange: (value: boolean) => void;
  onSubscriberStateChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  onSortChange: (field: SortField) => void;
  onExpand: (conversationId: string | null) => void;
  onPageChange: (offset: number) => void;
}

function SortHeader({
  label,
  field,
  currentSort,
  currentDir,
  onSort,
  align = "text-left",
}: {
  label: string;
  field: SortField;
  currentSort: string;
  currentDir: string;
  onSort: (field: SortField) => void;
  align?: string;
}) {
  const active = currentSort === field;
  const arrow = active ? (currentDir === "asc" ? " \u2191" : " \u2193") : "";
  return (
    <th
      className={`px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-text-muted cursor-pointer select-none hover:text-text-secondary ${align}`}
      onClick={() => onSort(field)}
    >
      {label}{arrow}
    </th>
  );
}

const SUB_STATUS_STYLE: Record<string, string> = {
  Active: "text-green",
  Expired: "text-text-muted",
  Never: "text-text-muted",
};

export function ReactivationTable({
  items,
  total,
  limit,
  offset,
  expandedConversationId,
  silenceFilter,
  minSpendUsd,
  noDmHistoryOnly,
  unreadOnly,
  subscriberState,
  searchQuery,
  sortBy,
  sortDir,
  pageLabel,
  onSilenceChange,
  onMinSpendChange,
  onNoDmHistoryChange,
  onUnreadOnlyChange,
  onSubscriberStateChange,
  onSearchChange,
  onSortChange,
  onExpand,
  onPageChange,
}: ReactivationTableProps) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <FilterButtons
          filters={[
            { key: "all", label: "All" },
            { key: "7", label: "7d+" },
            { key: "14", label: "14d+" },
            { key: "30", label: "30d+" },
          ]}
          active={silenceFilter}
          onChange={onSilenceChange}
        />
        <input
          type="number"
          min={0}
          placeholder="Min Spend $"
          value={minSpendUsd}
          onChange={(e) => onMinSpendChange(e.target.value)}
          className="w-[110px] rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent"
        />
        <button
          type="button"
          onClick={() => onNoDmHistoryChange(!noDmHistoryOnly)}
          className={`rounded-button px-3 py-1.5 text-[13px] font-medium transition-colors ${
            noDmHistoryOnly
              ? "bg-[#1a1a1a] text-white"
              : "border border-border bg-card text-text-secondary hover:bg-hover"
          }`}
        >
          No DM History
        </button>
        <button
          type="button"
          onClick={() => onUnreadOnlyChange(!unreadOnly)}
          className={`rounded-button px-3 py-1.5 text-[13px] font-medium transition-colors ${
            unreadOnly
              ? "bg-[#1a1a1a] text-white"
              : "border border-border bg-card text-text-secondary hover:bg-hover"
          }`}
        >
          Unread Only
        </button>
        <select
          value={subscriberState}
          onChange={(e) => onSubscriberStateChange(e.target.value)}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] text-text-primary outline-none transition-colors focus:border-accent"
        >
          <option value="">All Subscribers</option>
          <option value="current">Current</option>
          <option value="former">Former</option>
          <option value="never">Never</option>
        </select>
        <div className="ml-auto">
          <SearchInput value={searchQuery} onChange={onSearchChange} placeholder="Search fan..." />
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              <th className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted">Fan</th>
              <SortHeader label="Spend" field="lifetimeSpendUsd" currentSort={sortBy} currentDir={sortDir} onSort={onSortChange} align="text-right" />
              <SortHeader label="Last Message" field="lastContactAt" currentSort={sortBy} currentDir={sortDir} onSort={onSortChange} />
              <SortHeader label="Silent" field="silenceDays" currentSort={sortBy} currentDir={sortDir} onSort={onSortChange} />
              <SortHeader label="Score" field="reactivationScore" currentSort={sortBy} currentDir={sortDir} onSort={onSortChange} align="text-right" />
              <th className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted">Sub Status</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-text-muted">
                  No reactivation items found.
                </td>
              </tr>
            )}
            {items.map((row) => {
              const isExpanded = expandedConversationId === row.platformConversationId;

              return (
                <Fragment key={row.platformConversationId ?? row.profileHref}>
                  <tr
                    className={`border-t border-border transition-colors hover:bg-hover ${
                      row.canPreview ? "cursor-pointer" : ""
                    }`}
                    onClick={() => {
                      if (!row.canPreview) return;
                      onExpand(isExpanded ? null : row.platformConversationId);
                    }}
                  >
                    <td className="px-4 py-3">
                      <div className="text-[14px] font-semibold text-text-primary">{row.fanLabel}</div>
                      {row.fanSubLabel && (
                        <div className="text-[12px] text-text-muted">{row.fanSubLabel}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-text-primary">
                      {row.spendLabel}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {row.lastMessageLabel ? (
                        <span className="flex items-center gap-1">
                          {row.lastMessageDirection === "inbound" && <span className="text-green" title="From fan">&#8601;</span>}
                          {row.lastMessageDirection === "outbound" && <span className="text-accent" title="From model">&#8599;</span>}
                          {row.lastMessageLabel}
                          {row.unreadCount > 0 && (
                            <span className="ml-1 inline-flex items-center rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-bold text-accent">
                              {row.unreadCount}
                            </span>
                          )}
                        </span>
                      ) : row.noDmHistory ? (
                        <span className="inline-flex items-center rounded-md bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-bold text-zinc-400">
                          Never Messaged
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary tabular-nums">
                      {row.silenceDaysLabel}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-text-primary">
                      {row.scoreLabel}
                    </td>
                    <td className={`px-4 py-3 text-sm font-medium ${SUB_STATUS_STYLE[row.subscriptionStatusLabel] ?? ""}`}>
                      {row.subscriptionStatusLabel}
                    </td>
                  </tr>
                  {isExpanded && row.platformConversationId && (
                    <tr>
                      <td colSpan={6} className="p-0">
                        <ChatPreviewPanel
                          pageLabel={pageLabel}
                          platformConversationId={row.platformConversationId}
                          profileHref={row.profileHref}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        <Pagination
          offset={offset}
          limit={limit}
          total={total}
          onPageChange={onPageChange}
        />
      </section>
    </div>
  );
}
