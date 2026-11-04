import { useEffect, useRef } from "react";
import { Link } from "react-router";
import type { PageConversationPreviewResponse } from "@agency_hub_core/contracts";
import { normalizeDmMessageText } from "@agency_hub_core/shared";
import { usePageConversationPreview } from "@/api/queries";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { Skeleton } from "@/components/ui/Skeleton";
import { buildPageSectionRoute } from "@/lib/navigation";
import { formatDateTime, formatUsdFromCents } from "@/lib/format";

interface ChatPreviewPanelProps {
  pageLabel: string;
  platformConversationId: string;
  /** «Открыть карточку», in the list's panel only. */
  profileHref?: string | undefined;
  /** An OnlyFans chat comes from the ChatSpace feed: the login, pause and reading branches speak of the API, not of it. */
  platform?: string | undefined;
  /** The owner gets «Войти в Fansly» beside «войдите». */
  owner?: boolean | undefined;
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
      <div className="notice-body">
        Fansly больше не отдаёт этот чат странице.
        <small>
          {CHAT_ACCESS_CAUSE_COPY[chatAccess.cause]}
          {showsSocketMessages && " Новые сообщения ещё приходят в реальном времени, но Fansly их не подтверждает."}
        </small>
        <small>С {formatDateTime(chatAccess.openedAt, { yearUnlessCurrent: true })}</small>
        {chatAccess.ownerNote && <small className="whitespace-pre-wrap break-words">Заметка владельца: {chatAccess.ownerNote}</small>}
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
      className="chat-mark"
      title={message.apiUnavailable
        ? "Этот чат исключён из сбора сообщений, поэтому Fansly никогда не подтвердит это сообщение."
        : "Сообщение пришло в реальном времени; Fansly его ещё не подтвердил."}
    >
      {message.apiUnavailable ? "Не будет подтверждено" : "Не подтверждено"}
    </span>
  );
}

/** On OnlyFans the login, pause and reading signs speak of the switched-off API, not of the feed. */
function syncSigns(data: PageConversationPreviewResponse, platform: string | undefined) {
  const api = platform !== "onlyfans";
  return {
    login: api && data.messageSyncUx.requiresAction,
    paused: api && data.messageSyncUx.state === "off",
    attention: api && data.messageSyncUx.state === "attention",
  };
}

function getEmptyPreviewCopy(data: PageConversationPreviewResponse, platform: string | undefined) {
  const previewLoading = data.conversation.messageCoverageStatus === "pending_backfill" ||
    PREVIEW_LOADING_STATES.has(data.messageSyncUx.state);
  const previewCapped = data.conversation.messageCoverageStatus === "partial_window";
  const previewExcluded = data.conversation.messageSyncEligibility === "excluded";
  const unresolvedIdentity = data.conversation.messageSyncEligibility === "unresolved_identity";

  const signs = syncSigns(data, platform);
  if (signs.login) {
    return {
      headline: "Войдите в Fansly, чтобы загрузить переписку.",
      detail: "Новые сообщения появятся после входа.",
      login: true,
    };
  }

  if (signs.paused) {
    return {
      headline: "Сбор переписки этой страницы на паузе.",
      detail: "Превью останется неполным, пока сбор не возобновится.",
    };
  }

  if (signs.attention) {
    return {
      headline: "Переписка сейчас может быть неполной.",
      detail: "Сбор сообщений не читается: после починки превью обновится.",
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

type EmptyCopy = { headline: string; detail: string | null; login?: boolean };

function getPreviewFooterText(data: PageConversationPreviewResponse, platform: string | undefined) {
  const previewLoading = data.conversation.messageCoverageStatus === "pending_backfill" ||
    PREVIEW_LOADING_STATES.has(data.messageSyncUx.state);
  const signs = syncSigns(data, platform);

  if (signs.login) {
    return "Войдите в Fansly, чтобы переписка не отставала.";
  }

  if (signs.paused) {
    return "Сбор переписки этой страницы на паузе.";
  }

  if (signs.attention) {
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

export function ChatPreviewPanel({ pageLabel, platformConversationId, profileHref, platform, owner = false, limit = 25 }: ChatPreviewPanelProps) {
  const {
    data,
    isError,
    isLoading,
    refetch,
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

  const loginLink = owner && platform !== "onlyfans"
    ? <Link to={buildPageSectionRoute(pageLabel, "browser-login")} className="btn btn-sm">Войти в Fansly</Link>
    : null;
  const cardLink = profileHref ? <Link to={profileHref} className="link">Открыть карточку</Link> : null;

  if (isLoading) {
    return (
      <div className="chat-preview" aria-busy="true">
        {[62, 48, 70, 40].map((width, index) => (
          <div key={index} className={`chat-row ${index % 2 ? "chat-row-model" : ""}`}><Skeleton width={`${width}%`} className="!h-10" /></div>
        ))}
      </div>
    );
  }

  if (isError && !data) {
    return <NoAnswerPanel retry={refetch} />;
  }

  if (!data || data.messages.length === 0) {
    const emptyState: EmptyCopy = data ? getEmptyPreviewCopy(data, platform) : { headline: "Сообщений нет.", detail: null };

    return (
      <div className="chat-preview">
        <ChatAccessNotice chatAccess={data?.conversation.chatAccess} showsSocketMessages={false} />
        <div className="empty">
          <p className="empty-title">{emptyState.headline}</p>
          {emptyState.detail && <p className="empty-text">{emptyState.detail}</p>}
          {emptyState.login && loginLink && <div className="empty-actions">{loginLink}</div>}
        </div>
        {cardLink && <div className="chat-foot"><span />{cardLink}</div>}
      </div>
    );
  }

  const footerText = getPreviewFooterText(data, platform);
  const footerLogin = syncSigns(data, platform).login ? loginLink : null;

  return (
    <div className="chat-preview">
      <ChatAccessNotice
        chatAccess={data.conversation.chatAccess}
        showsSocketMessages={data.messages.some((msg) => msg.source === "live")}
      />
      <div ref={messagesContainerRef} className="chat-messages">
        {data.messages.map((msg: PreviewMessage) => {
          const isModel = msg.senderRole === "model";
          return (
            <div key={msg.platformMessageId} className={`chat-row ${isModel ? "chat-row-model" : ""}`}>
              <div className={`chat-bubble ${isModel ? "chat-bubble-model" : ""}`}>
                <p className="whitespace-pre-wrap break-words">{normalizeDmMessageText(msg.content)}</p>
                <div className="chat-meta">
                  <span>{formatDateTime(msg.createdAt, { yearUnlessCurrent: true })}</span>
                  {msg.totalTipAmountCents > 0 && (
                    <span className="chat-tip">Чаевые {formatUsdFromCents(msg.totalTipAmountCents)}</span>
                  )}
                  <SocketMessageMark message={msg} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {(footerText || cardLink) && (
        <div className="chat-foot">
          <span className="chat-foot-text">{footerText}{footerLogin && <> {footerLogin}</>}</span>
          {cardLink}
        </div>
      )}
    </div>
  );
}
