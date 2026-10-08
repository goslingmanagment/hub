import { useEffect, useRef } from "react";
import { Link } from "react-router";
import type { PageConversationPreviewResponse } from "@agency_hub_core/contracts";
import { normalizeDmMessageText } from "@agency_hub_core/shared";
import { usePageConversationPreview } from "@/api/queries";
import { formatDateTime, formatRelativeTime, formatUsdFromCents } from "@/lib/format";

interface ChatPreviewPanelProps {
  pageLabel: string;
  platformConversationId: string;
  profileHref: string;
  limit?: number;
}

type PreviewMessage = PageConversationPreviewResponse["messages"][number];
type ChatAccess = NonNullable<PageConversationPreviewResponse["conversation"]["chatAccess"]>;

const PREVIEW_LOADING_STATES = new Set(["syncing", "catching_up", "retrying", "setup"]);

/** Why the chat is gone, as far as Hub can tell (owner's choice, arena
 *  "vanished chat" plan §8 (a)): a guess says "probably". */
const CHAT_ACCESS_CAUSE_COPY: Record<ChatAccess["cause"], string> = {
  unchecked: "The fan deleted their account or blocked the page.",
  probably_blocked: "The fan's account still exists — they have probably blocked this page.",
  probably_deleted: "The fan's account was not found on Fansly — it was probably deleted.",
};

/** The chat's banner: only an established episode has one — a chat that is
 *  still being refused may well answer on the next read. */
function ChatAccessNotice({ chatAccess, showsSocketMessages }: { chatAccess: ChatAccess | undefined; showsSocketMessages: boolean }) {
  if (chatAccess?.state !== "established") {
    return null;
  }

  return (
    <div role="note" className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[12px]">
      <div className="font-semibold text-warning-dark">Fansly no longer serves this chat to the page.</div>
      <div className="mt-0.5 text-text-secondary">
        {CHAT_ACCESS_CAUSE_COPY[chatAccess.cause]}
        {showsSocketMessages && " New messages still arrive over the socket, but they can't be confirmed."}
      </div>
      <div className="mt-1 text-[11px] text-text-muted">
        Since {formatDateTime(chatAccess.openedAt, { yearUnlessCurrent: true })}
      </div>
      {chatAccess.ownerNote && (
        <div className="mt-1 whitespace-pre-wrap break-words text-[11px] text-text-secondary">
          <span className="font-medium">Owner's note:</span> {chatAccess.ownerNote}
        </div>
      )}
    </div>
  );
}

/** A message only the page's socket delivered: Hub has no copy from Fansly's
 *  API, so its text, sender and time are provisional. */
function SocketMessageMark({ message }: { message: PreviewMessage }) {
  if (message.source !== "live") {
    return null;
  }

  return (
    <span
      className="text-[11px] text-warning-dark"
      title={message.apiUnavailable
        ? "This chat is excluded from message sync, so Fansly's API will never confirm this message."
        : "Arrived over the socket; Fansly's API has not confirmed it."}
    >
      {message.apiUnavailable ? "From socket · API unavailable" : "From socket · not confirmed"}
    </span>
  );
}

function getEmptyPreviewCopy(data: PageConversationPreviewResponse) {
  const previewLoading = data.conversation.messageCoverageStatus === "pending_backfill" ||
    PREVIEW_LOADING_STATES.has(data.messageSyncUx.state);
  const previewCapped = data.conversation.messageCoverageStatus === "partial_window";
  const previewExcluded = data.conversation.messageSyncEligibility === "excluded";
  const unresolvedIdentity = data.conversation.messageSyncEligibility === "unresolved_identity";

  if (data.messageSyncUx.requiresAction) {
    return {
      headline: "Reconnect credentials to load conversation history.",
      detail: "New messages will appear after credentials are updated.",
    };
  }

  if (data.messageSyncUx.state === "off") {
    return {
      headline: "Conversation history updates are paused.",
      detail: "This preview will stay incomplete until page updates resume.",
    };
  }

  if (data.messageSyncUx.state === "attention") {
    return {
      headline: "Conversation history may be incomplete right now.",
      detail: "Recent message updates need attention before this preview can fully refresh.",
    };
  }

  if (previewExcluded) {
    return {
      headline: "Conversation preview is unavailable for this fan.",
      detail: "This conversation is excluded from message sync on this page.",
    };
  }

  if (unresolvedIdentity) {
    return {
      headline: "Conversation preview is waiting on fan identity resolution.",
      detail: "Once the fan is matched, message backfill can continue for this conversation.",
    };
  }

  if (previewCapped) {
    return {
      headline: "Conversation preview is capped to the latest 25 stored messages.",
      detail: "Older messages are not available locally for this conversation.",
    };
  }

  if (previewLoading) {
    return {
      headline: "Conversation history is still loading.",
      detail: "This preview will fill in automatically as more messages arrive.",
    };
  }

  return {
    headline: "No messages to show.",
    detail: null,
  };
}

function getPreviewFooterText(data: PageConversationPreviewResponse) {
  const previewLoading = data.conversation.messageCoverageStatus === "pending_backfill" ||
    PREVIEW_LOADING_STATES.has(data.messageSyncUx.state);

  if (data.messageSyncUx.requiresAction) {
    return "Reconnect credentials to keep conversation history current.";
  }

  if (data.messageSyncUx.state === "off") {
    return "Conversation history updates are paused for this page.";
  }

  if (data.messageSyncUx.state === "attention") {
    return "Preview may be outdated while message updates recover.";
  }

  if (data.conversation.messageSyncEligibility === "excluded") {
    return "Preview unavailable because this conversation is excluded from message sync.";
  }

  if (data.conversation.messageSyncEligibility === "unresolved_identity") {
    return "Preview unavailable until the fan identity for this conversation is resolved.";
  }

  if (data.conversation.messageCoverageStatus === "partial_window") {
    return "Preview is capped to the latest 25 stored messages for this conversation.";
  }

  if (previewLoading) {
    return "Preview may be incomplete while conversation history loads.";
  }

  return null;
}

export function ChatPreviewPanel({ pageLabel, platformConversationId, profileHref, limit = 10 }: ChatPreviewPanelProps) {
  const {
    data,
    isError,
    isLoading,
  } = usePageConversationPreview(pageLabel, platformConversationId, { limit });
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const hasAutoScrolledRef = useRef(false);

  useEffect(() => {
    hasAutoScrolledRef.current = false;
  }, [platformConversationId]);

  useEffect(() => {
    if (!data || data.messages.length === 0 || hasAutoScrolledRef.current) {
      return;
    }

    const container = messagesContainerRef.current;
    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
    hasAutoScrolledRef.current = true;
  }, [platformConversationId, data?.messages.length]);

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
    const emptyState = data ? getEmptyPreviewCopy(data) : { headline: "No messages to show.", detail: null };

    return (
      <div className="bg-hover/50 px-6 py-4 space-y-2">
        <ChatAccessNotice chatAccess={data?.conversation.chatAccess} showsSocketMessages={false} />
        <div>
          <div className="text-sm text-text-secondary">{emptyState.headline}</div>
          {emptyState.detail && <div className="mt-1 text-sm text-text-muted">{emptyState.detail}</div>}
        </div>
      </div>
    );
  }

  const footerText = getPreviewFooterText(data);

  return (
    <div className="bg-hover/50 px-6 py-4 space-y-2">
      <ChatAccessNotice
        chatAccess={data.conversation.chatAccess}
        showsSocketMessages={data.messages.some((msg) => msg.source === "live")}
      />
      <div ref={messagesContainerRef} className="flex flex-col gap-1.5 max-h-[320px] overflow-y-auto">
        {data.messages.map((msg: PreviewMessage) => {
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
                <p className="whitespace-pre-wrap break-words">{normalizeDmMessageText(msg.content)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2">
                  <span className="text-[11px] text-text-muted">
                    {formatRelativeTime(msg.createdAt)}
                  </span>
                  {msg.totalTipAmountCents > 0 && (
                    <span className="text-[11px] font-semibold text-green">
                      Tip {formatUsdFromCents(msg.totalTipAmountCents)}
                    </span>
                  )}
                  <SocketMessageMark message={msg} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between pt-1">
        {footerText ? (
          <div className="flex flex-wrap items-center gap-2">
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
