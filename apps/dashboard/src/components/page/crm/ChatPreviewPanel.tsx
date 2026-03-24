import { Link } from "react-router";
import type { CrmConversationPreviewResponse } from "@agency_hub_core/contracts";
import { useCrmConversationPreview } from "@/api/queries";
import { SyncUxBadge } from "@/components/shared/SyncUxBadge";
import { formatRelativeTime } from "@/lib/format";
import { formatUsdFromCents } from "@/lib/format";

interface ChatPreviewPanelProps {
  pageLabel: string;
  platformConversationId: string;
  profileHref: string;
}

export function ChatPreviewPanel({ pageLabel, platformConversationId, profileHref }: ChatPreviewPanelProps) {
  const {
    data,
    isError,
    isLoading,
  } = useCrmConversationPreview(pageLabel, platformConversationId, { limit: 10 });

  if (isLoading) {
    return (
      <div className="bg-hover/50 px-6 py-4">
        <span className="text-sm text-text-muted">Loading preview...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="bg-hover/50 px-6 py-4">
        <span className="text-sm text-text-muted">Preview failed to load.</span>
      </div>
    );
  }

  const previewSyncingStates = new Set(["syncing", "catching_up", "retrying", "setup"]);

  if (!data || data.messages.length === 0) {
    const syncing = data && previewSyncingStates.has(data.messageSyncUx.state);
    const syncRelevantEmptyState = data && data.messageSyncUx.state !== "healthy";
    const headline = syncing
      ? "Conversation history is still syncing"
      : syncRelevantEmptyState
        ? data.messageSyncUx.headline
        : "No messages to show.";
    const detail = syncing
      ? "This preview will fill in automatically as messages catch up."
      : syncRelevantEmptyState
        ? data.messageSyncUx.detail
        : null;

    return (
      <div className="bg-hover/50 px-6 py-4">
        {data && syncRelevantEmptyState && (
          <div className="mb-2">
            <SyncUxBadge summary={data.messageSyncUx} />
          </div>
        )}
        <div className="text-sm text-text-secondary">{headline}</div>
        {detail && <div className="mt-1 text-sm text-text-muted">{detail}</div>}
      </div>
    );
  }

  const previewIncomplete = !data.conversation.messageBackfillComplete || previewSyncingStates.has(data.messageSyncUx.state);
  const showFooterSync = data.messageSyncUx.requiresAction ||
    data.messageSyncUx.state === "off" ||
    previewIncomplete;
  const footerText = data.messageSyncUx.requiresAction || data.messageSyncUx.state === "off"
    ? data.messageSyncUx.headline
    : "Preview may be incomplete while messages catch up";

  return (
    <div className="bg-hover/50 px-6 py-4 space-y-2">
      <div className="flex flex-col gap-1.5 max-h-[320px] overflow-y-auto">
        {data.messages.map((msg: CrmConversationPreviewResponse["messages"][number]) => {
          const isModel = msg.senderRole === "model";
          return (
            <div
              key={msg.platformMessageId}
              className={`flex ${isModel ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[70%] rounded-lg px-3 py-2 text-[13px] ${
                  isModel
                    ? "bg-accent/15 text-text-primary"
                    : "bg-hover text-text-primary"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] text-text-muted">
                    {formatRelativeTime(msg.createdAt)}
                  </span>
                  {msg.totalTipAmountCents > 0 && (
                    <span className="text-[11px] font-semibold text-green">
                      Tip {formatUsdFromCents(msg.totalTipAmountCents)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between pt-1">
        {showFooterSync ? (
          <div className="flex flex-wrap items-center gap-2">
            <SyncUxBadge summary={data.messageSyncUx} />
            <span className="text-[11px] text-text-muted">{footerText}</span>
          </div>
        ) : (
          <span />
        )}
        <Link
          to={profileHref}
          onClick={(e) => e.stopPropagation()}
          className="text-[12px] font-medium text-accent hover:underline"
        >
          View Full Profile
        </Link>
      </div>
    </div>
  );
}
