import type { CrmSummaryResponse } from "@agency_hub_core/contracts";
import { SyncUxBadge, formatSyncUxMeta } from "@/components/shared/SyncUxBadge";

interface CrmSummaryHeaderProps {
  summary: CrmSummaryResponse;
}

export function CrmSummaryHeader({ summary }: CrmSummaryHeaderProps) {
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
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
        <SyncUxBadge summary={summary.messageSyncUx} />
        <span className="font-medium text-text-secondary">{summary.messageSyncUx.headline}</span>
        {syncMeta && <span>{syncMeta}</span>}
      </div>
      {summary.messageSyncUx.detail && (
        <div className="text-[12px] text-text-muted">{summary.messageSyncUx.detail}</div>
      )}
    </div>
  );
}
