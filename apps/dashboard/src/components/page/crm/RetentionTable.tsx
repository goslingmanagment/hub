import { Fragment } from "react";
import type { CrmSummaryResponse } from "@agency_hub_core/contracts";
import type { RetentionRowVm } from "@/pages/crm/viewModel";
import { TouchpointBadge } from "./TouchpointBadge";
import { ChatPreviewPanel } from "./ChatPreviewPanel";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { SearchInput } from "@/components/shared/SearchInput";
import { Pagination } from "@/components/shared/Pagination";

type SortField = "touchpoint" | "subscriptionExpiresAt" | "lifetimeSpendUsd" | "lastContactAt";

interface RetentionTableProps {
  items: RetentionRowVm[];
  total: number;
  limit: number;
  offset: number;
  expandedConversationId: string | null;
  touchpointFilter: string[];
  autoRenewFilter: string;
  showHandled: boolean;
  unreadOnly: boolean;
  searchQuery: string;
  sortBy: string;
  sortDir: string;
  summary: CrmSummaryResponse | undefined;
  pageLabel: string;
  onTouchpointChange: (codes: string[]) => void;
  onAutoRenewChange: (value: string) => void;
  onShowHandledChange: (value: boolean) => void;
  onUnreadOnlyChange: (value: boolean) => void;
  onSearchChange: (value: string) => void;
  onSortChange: (field: SortField) => void;
  onExpand: (conversationId: string | null) => void;
  onPageChange: (offset: number) => void;
}

const TOUCHPOINT_CODES = ["21d", "14d", "7d", "5d", "3d", "1d"] as const;

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

export function RetentionTable({
  items,
  total,
  limit,
  offset,
  expandedConversationId,
  touchpointFilter,
  autoRenewFilter,
  showHandled,
  unreadOnly,
  searchQuery,
  sortBy,
  sortDir,
  summary,
  pageLabel,
  onTouchpointChange,
  onAutoRenewChange,
  onShowHandledChange,
  onUnreadOnlyChange,
  onSearchChange,
  onSortChange,
  onExpand,
  onPageChange,
}: RetentionTableProps) {
  const counts = summary?.retention.countsByTouchpoint;
  const touchpointFilters = [
    { key: "all", label: "All", count: summary?.retention.total },
    ...TOUCHPOINT_CODES.map((code) => ({
      key: code,
      label: code,
      count: counts?.[code],
    })),
  ];

  const activeTouchpointKey = touchpointFilter.length === 0 ? "all" : touchpointFilter.length === 1 ? touchpointFilter[0] : "all";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <FilterButtons
          filters={touchpointFilters}
          active={activeTouchpointKey}
          onChange={(key) => onTouchpointChange(key === "all" ? [] : [key])}
        />
        <FilterButtons
          filters={[
            { key: "all", label: "Auto-Renew: All" },
            { key: "on", label: "On" },
            { key: "off", label: "Off" },
          ]}
          active={autoRenewFilter}
          onChange={onAutoRenewChange}
        />
        <button
          type="button"
          onClick={() => onShowHandledChange(!showHandled)}
          className={`rounded-button px-3 py-1.5 text-[13px] font-medium transition-colors ${
            showHandled
              ? "bg-[#1a1a1a] text-white"
              : "border border-border bg-card text-text-secondary hover:bg-hover"
          }`}
        >
          Show Handled
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
              <SortHeader label="Expires" field="subscriptionExpiresAt" currentSort={sortBy} currentDir={sortDir} onSort={onSortChange} />
              <SortHeader label="Touchpoint" field="touchpoint" currentSort={sortBy} currentDir={sortDir} onSort={onSortChange} />
              <th className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted">Auto-Renew</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-text-muted">
                  No retention items found.
                </td>
              </tr>
            )}
            {items.map((row) => {
              const isExpanded = expandedConversationId === row.platformConversationId;
              const rowOpacity = row.isHandled ? "opacity-50" : row.isAutoRenewOn ? "opacity-60" : "";

              return (
                <Fragment key={row.platformConversationId ?? row.profileHref}>
                  <tr
                    className={`border-t border-border transition-colors hover:bg-hover ${
                      row.canPreview ? "cursor-pointer" : ""
                    } ${rowOpacity}`}
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
                      ) : (
                        <span className="inline-flex items-center rounded-md bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-bold text-zinc-400">
                          Never Messaged
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                      <span>{row.expiryLabel}</span>
                      <span className="ml-1 text-text-muted text-[12px]">{row.expiryRelativeLabel}</span>
                    </td>
                    <td className="px-4 py-3">
                      <TouchpointBadge touchpointCode={row.touchpointCode} touchpointLabel={row.touchpointLabel} />
                      {row.isHandled && (
                        <span className="ml-1.5 inline-flex items-center rounded-md bg-green/15 px-1.5 py-0.5 text-[10px] font-bold text-green">
                          Contacted
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {row.isAutoRenewOn ? (
                        <span className="text-green">On</span>
                      ) : (
                        <span className="text-text-muted">Off</span>
                      )}
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
