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
  unchecked: "Фан удалил аккаунт или заблокировал страницу.",
  probably_blocked: "Аккаунт фана существует — скорее всего, он заблокировал страницу.",
  probably_deleted: "Аккаунт фана не найден на Fansly — скорее всего, он удалён.",
};

/** The chat's banner: only an established episode has one — a chat that is
 *  still being refused may well answer on the next read. */
function ChatAccessNotice({ chatAccess, showsSocketMessages }: { chatAccess: ChatAccess | undefined; showsSocketMessages: boolean }) {
  if (chatAccess?.state !== "established") {
    return null;
  }

  return (
    <div role="note" className="notice notice-warning">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Fansly больше не отдаёт этот чат странице.</div>
        <div className="mt-0.5">
          {CHAT_ACCESS_CAUSE_COPY[chatAccess.cause]}
          {showsSocketMessages && " Новые сообщения ещё приходят в реальном времени, но Fansly их не подтверждает."}
        </div>
        <div className="mt-1 text-xs">
          С {formatDateTime(chatAccess.openedAt, { yearUnlessCurrent: true })}
        </div>
        {chatAccess.ownerNote && (
          <div className="mt-1 whitespace-pre-wrap break-words text-xs">
            <span className="font-medium">Заметка владельца:</span> {chatAccess.ownerNote}
          </div>
        )}
      </div>
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
      className="text-xs text-warning-dark"
      title={message.apiUnavailable
        ? "Этот чат исключён из сбора сообщений, поэтому Fansly никогда не подтвердит это сообщение."
        : "Сообщение пришло в реальном времени; Fansly его ещё не подтвердил."}
    >
      {message.apiUnavailable ? "Не будет подтверждено" : "Не подтверждено"}
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
      headline: "Обновите данные входа, чтобы загрузить переписку.",
      detail: "Новые сообщения появятся после обновления данных входа.",
    };
  }

  if (data.messageSyncUx.state === "off") {
    return {
      headline: "Обновление переписки приостановлено.",
      detail: "Превью останется неполным, пока сбор данных страницы не возобновится.",
    };
  }

  if (data.messageSyncUx.state === "attention") {
    return {
      headline: "Переписка сейчас может быть неполной.",
      detail: "Сбор сообщений требует внимания — после этого превью обновится.",
    };
  }

  if (previewExcluded) {
    return {
      headline: "Превью переписки для этого фана недоступно.",
      detail: "Этот чат исключён из сбора сообщений на этой странице.",
    };
  }

  if (unresolvedIdentity) {
    return {
      headline: "Превью ждёт, пока Hub определит фана.",
      detail: "Когда фан будет найден, загрузка сообщений продолжится.",
    };
  }

  if (previewCapped) {
    return {
      headline: "В превью только последние 25 сохранённых сообщений.",
      detail: "Более ранних сообщений этого чата в Hub нет.",
    };
  }

  if (previewLoading) {
    return {
      headline: "Переписка ещё загружается.",
      detail: "Превью заполнится само, когда придут сообщения.",
    };
  }

  return {
    headline: "Сообщений нет.",
    detail: null,
  };
}

function getPreviewFooterText(data: PageConversationPreviewResponse) {
  const previewLoading = data.conversation.messageCoverageStatus === "pending_backfill" ||
    PREVIEW_LOADING_STATES.has(data.messageSyncUx.state);

  if (data.messageSyncUx.requiresAction) {
    return "Обновите данные входа, чтобы переписка не отставала.";
  }

  if (data.messageSyncUx.state === "off") {
    return "Обновление переписки на этой странице приостановлено.";
  }

  if (data.messageSyncUx.state === "attention") {
    return "Превью может отставать, пока сбор сообщений не восстановится.";
  }

  if (data.conversation.messageSyncEligibility === "excluded") {
    return "Этот чат исключён из сбора сообщений.";
  }

  if (data.conversation.messageSyncEligibility === "unresolved_identity") {
    return "Превью неполное, пока Hub не определит фана.";
  }

  if (data.conversation.messageCoverageStatus === "partial_window") {
    return "Показаны только последние 25 сохранённых сообщений.";
  }

  if (previewLoading) {
    return "Превью может быть неполным, пока переписка загружается.";
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
      <div className="bg-hover-alt px-5 py-4 sm:px-6">
        <span className="text-sm text-text-secondary">Загружаем переписку…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="bg-hover-alt px-5 py-4 sm:px-6">
        <span className="text-sm text-danger">Не удалось загрузить переписку.</span>
      </div>
    );
  }

  if (!data || data.messages.length === 0) {
    const emptyState = data ? getEmptyPreviewCopy(data) : { headline: "Сообщений нет.", detail: null };

    return (
      <div className="space-y-3 bg-hover-alt px-5 py-4 sm:px-6">
        <ChatAccessNotice chatAccess={data?.conversation.chatAccess} showsSocketMessages={false} />
        <div>
          <div className="text-sm font-medium text-text-primary">{emptyState.headline}</div>
          {emptyState.detail && <div className="mt-1 text-sm text-text-secondary">{emptyState.detail}</div>}
        </div>
      </div>
    );
  }

  const footerText = getPreviewFooterText(data);

  return (
    <div className="space-y-3 bg-hover-alt px-5 py-4 sm:px-6">
      <ChatAccessNotice
        chatAccess={data.conversation.chatAccess}
        showsSocketMessages={data.messages.some((msg) => msg.source === "live")}
      />
      <div ref={messagesContainerRef} className="flex max-h-[360px] flex-col gap-2 overflow-y-auto">
        {data.messages.map((msg: PreviewMessage) => {
          const isModel = msg.senderRole === "model";
          return (
            <div
              key={msg.platformMessageId}
              className={`flex ${isModel ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-xl px-3 py-2 text-sm text-text-primary ${
                  isModel
                    ? "bg-accent-soft"
                    : "border border-border bg-card"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{normalizeDmMessageText(msg.content)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2">
                  <span className="text-xs text-text-secondary">
                    {formatRelativeTime(msg.createdAt)}
                  </span>
                  {msg.totalTipAmountCents > 0 && (
                    <span className="text-xs font-semibold text-green">
                      Чаевые {formatUsdFromCents(msg.totalTipAmountCents)}
                    </span>
                  )}
                  <SocketMessageMark message={msg} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border-light pt-3">
        {footerText ? (
          <span className="text-xs text-text-secondary">{footerText}</span>
        ) : (
          <span />
        )}
        <Link
          to={profileHref}
          onClick={(e) => e.stopPropagation()}
          className="link text-sm"
        >
          Открыть профиль
        </Link>
      </div>
    </div>
  );
}
