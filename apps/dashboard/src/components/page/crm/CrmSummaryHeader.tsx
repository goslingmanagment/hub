import type { CrmSummaryResponse } from "@agency_hub_core/contracts";
import { SyncUxBadge, formatSyncUxMeta } from "@/components/shared/SyncUxBadge";
import { getSyncUxDisplayMode } from "@/components/shared/syncUxDisplay";

interface CrmSummaryHeaderProps {
  summary: CrmSummaryResponse;
}

export function CrmSummaryHeader({ summary }: CrmSummaryHeaderProps) {
  const hasIncompleteData = summary.coverage.pendingMessageBackfillCount > 0 ||
    summary.coverage.previewReadyConversationCount === 0;
  const syncMode = getSyncUxDisplayMode(summary.messageSyncUx, "crm_header", {
    hasIncompleteData,
  });
  const syncMeta = formatSyncUxMeta(summary.messageSyncUx, {
    updatedPrefix: "Updated",
    retryPrefix: "Retrying",
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-text-muted">
        <span>
          Retention: <span className="font-semibold text-text-primary">{summary.retention.total}</span>
        </span>
        <span>
          Reactivation: <span className="font-semibold text-text-primary">{summary.reactivation.total}</span>
        </span>
      </div>
      {syncMode !== "hidden" && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
          <SyncUxBadge summary={summary.messageSyncUx} />
          {syncMode !== "badge" && (
            <span className="font-medium text-text-secondary">{summary.messageSyncUx.headline}</span>
          )}
          {syncMeta && <span>{syncMeta}</span>}
        </div>
      )}
      {syncMode === "full" && summary.messageSyncUx.detail && (
        <div className="text-[12px] text-text-muted">{summary.messageSyncUx.detail}</div>
      )}
    </div>
  );
}
