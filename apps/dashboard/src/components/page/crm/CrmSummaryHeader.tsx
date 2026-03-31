import type { CrmSummaryResponse } from "@agency_hub_core/contracts";
import { getSyncUxDisplayMode } from "@/components/shared/syncUxDisplay";

interface CrmSummaryHeaderProps {
  summary: CrmSummaryResponse;
}

function getCrmHeaderMessage(summary: CrmSummaryResponse) {
  if (summary.messageSyncUx.requiresAction) {
    return "Reconnect credentials to keep conversation history current.";
  }

  if (summary.messageSyncUx.state === "off") {
    return "Conversation history updates are paused for this page.";
  }

  const messages: string[] = [];

  if (summary.coverage.pendingMessageBackfillCount > 0) {
    const count = summary.coverage.pendingMessageBackfillCount;
    messages.push(
      `${count} ${count === 1 ? "conversation is" : "conversations are"} still loading. Previews will fill in automatically.`,
    );
  }

  if (summary.coverage.partialWindowConversationCount > 0) {
    const count = summary.coverage.partialWindowConversationCount;
    messages.push(
      `${count} ${count === 1 ? "conversation preview is" : "conversation previews are"} capped to the latest 25 stored messages.`,
    );
  }

  if (summary.coverage.excludedConversationCount > 0) {
    const count = summary.coverage.excludedConversationCount;
    messages.push(
      `${count} ${count === 1 ? "conversation is" : "conversations are"} excluded from message sync.`,
    );
  }

  if (summary.coverage.unresolvedConversationCount > 0) {
    const count = summary.coverage.unresolvedConversationCount;
    messages.push(
      `${count} ${count === 1 ? "conversation needs" : "conversations need"} fan identity resolution before previews can load.`,
    );
  }

  if (messages.length > 0) {
    return messages.join(" ");
  }

  if (summary.coverage.previewReadyConversationCount === 0) {
    return "Conversation history is still loading for this page.";
  }

  return null;
}

export function CrmSummaryHeader({ summary }: CrmSummaryHeaderProps) {
  const hasIncompleteData = summary.coverage.pendingMessageBackfillCount > 0 ||
    summary.coverage.partialWindowConversationCount > 0 ||
    summary.coverage.excludedConversationCount > 0 ||
    summary.coverage.unresolvedConversationCount > 0 ||
    summary.coverage.previewReadyConversationCount === 0;
  const syncMode = getSyncUxDisplayMode(summary.messageSyncUx, "crm_header", {
    hasIncompleteData,
  });
  const helperText = syncMode === "exception" ? getCrmHeaderMessage(summary) : null;
  const helperClassName = summary.messageSyncUx.requiresAction
    ? "text-danger"
    : summary.messageSyncUx.state === "off"
      ? "text-text-secondary"
      : "text-text-muted";

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
      {helperText && (
        <div className={`text-[12px] ${helperClassName}`}>{helperText}</div>
      )}
    </div>
  );
}
