import { Link } from "react-router";
import { useCrmConversationPreview } from "@/api/queries";
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

  if (!data || data.messages.length === 0) {
    return (
      <div className="bg-hover/50 px-6 py-4">
        <span className="text-sm text-text-muted">No messages to show.</span>
      </div>
    );
  }

  const syncing = !data.conversation.messageBackfillComplete;

  return (
    <div className="bg-hover/50 px-6 py-4 space-y-2">
      <div className="flex flex-col gap-1.5 max-h-[320px] overflow-y-auto">
        {data.messages.map((msg) => {
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
        <span className="text-[11px] text-text-muted">
          {syncing ? "Message backfill in progress" : "Messages may be up to 2 hours old"}
        </span>
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
