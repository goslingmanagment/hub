import type { CrmSummaryResponse } from "@agency_hub_core/contracts";
import { formatRelativeTime } from "@/lib/format";

interface CrmSummaryHeaderProps {
  summary: CrmSummaryResponse;
}

function isStale(iso: string | null, thresholdMs: number): boolean {
  if (!iso) return true;
  return Date.now() - new Date(iso).getTime() > thresholdMs;
}

export function CrmSummaryHeader({ summary }: CrmSummaryHeaderProps) {
  const convStale = isStale(summary.freshness.lastConversationChunkSucceededAt, 60 * 60 * 1000);
  const msgStale = isStale(summary.freshness.lastMessageChunkSucceededAt, 4 * 60 * 60 * 1000);
  const pendingBackfill = summary.coverage.pendingMessageBackfillCount > 0;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-text-muted">
      <span>
        Retention: <span className="font-semibold text-text-primary">{summary.retention.total}</span>
      </span>
      <span>
        Reactivation: <span className="font-semibold text-text-primary">{summary.reactivation.total}</span>
      </span>
      {summary.freshness.lastConversationChunkSucceededAt && (
        <span className={convStale ? "text-amber-400" : ""}>
          Conversations synced {formatRelativeTime(summary.freshness.lastConversationChunkSucceededAt)}
        </span>
      )}
      {summary.freshness.lastMessageChunkSucceededAt && (
        <span className={msgStale ? "text-amber-400" : ""}>
          Messages synced {formatRelativeTime(summary.freshness.lastMessageChunkSucceededAt)}
        </span>
      )}
      {pendingBackfill && (
        <span className="text-amber-400">
          {summary.coverage.pendingMessageBackfillCount} conversations pending message backfill
        </span>
      )}
    </div>
  );
}
