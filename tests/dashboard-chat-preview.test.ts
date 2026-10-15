import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queryMocks = vi.hoisted(() => ({
  usePageConversationPreview: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { ChatPreviewPanel } from "../apps/dashboard/src/components/shared/ChatPreviewPanel.tsx";

function buildSyncUx(
  overrides: Partial<{
    state: "healthy" | "syncing" | "catching_up" | "retrying" | "attention" | "setup" | "off";
    label: string;
    headline: string;
    detail: string | null;
    progressLabel: string | null;
    nextRetryAt: string | null;
    updatedAt: string | null;
    requiresAction: boolean;
  }> = {},
) {
  return {
    state: "healthy" as const,
    label: "Up to date",
    headline: "Conversation history is ready",
    detail: "Conversation previews are ready to use.",
    progressLabel: null,
    nextRetryAt: null,
    updatedAt: "2026-03-24T11:55:00.000Z",
    requiresAction: false,
    ...overrides,
  };
}

function renderPanel() {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    undefined,
    createElement(ChatPreviewPanel, {
      pageLabel: "lana",
      platformConversationId: "conversation-001",
      profileHref: "/pages/lana/fans/fansly/fan-001",
    }),
  ));
}

describe("ChatPreviewPanel", () => {
  beforeEach(() => {
    queryMocks.usePageConversationPreview.mockReset();
  });

  it("renders an explicit error state when preview loading fails", () => {
    queryMocks.usePageConversationPreview.mockReturnValue({
      data: undefined,
      isError: true,
      isLoading: false,
    });

    const html = renderPanel();

    expect(html).toContain("Не удалось загрузить переписку.");
    expect(html).not.toContain("Сообщений нет.");
  });

  it("keeps the empty state for genuinely empty conversations", () => {
    queryMocks.usePageConversationPreview.mockReturnValue({
      data: {
        messageSyncUx: buildSyncUx(),
        conversation: {
          messageBackfillComplete: true,
        },
        messages: [],
      },
      isError: false,
      isLoading: false,
    });

    const html = renderPanel();

    expect(html).toContain("Сообщений нет.");
    expect(html).not.toContain("Не удалось загрузить переписку.");
    expect(html).not.toContain("Conversation history is ready");
  });

  it("hides the healthy sync footer once preview messages are ready", () => {
    queryMocks.usePageConversationPreview.mockReturnValue({
      data: {
        messageSyncUx: buildSyncUx(),
        conversation: {
          messageBackfillComplete: true,
        },
        messages: [{
          platformMessageId: "msg-1",
          senderRole: "fan",
          createdAt: "2026-03-24T11:55:00.000Z",
          content: "hey",
          totalTipAmountCents: 0,
        }],
      },
      isError: false,
      isLoading: false,
    });

    const html = renderPanel();

    expect(html).not.toContain("Conversation history is ready");
    expect(html).not.toContain("Превью может быть неполным, пока переписка загружается.");
  });

  it("formats stored tip amounts as cents in the preview bubble", () => {
    queryMocks.usePageConversationPreview.mockReturnValue({
      data: {
        messageSyncUx: buildSyncUx(),
        conversation: {
          messageBackfillComplete: true,
        },
        messages: [{
          platformMessageId: "msg-tip",
          senderRole: "fan",
          createdAt: "2026-03-24T11:55:00.000Z",
          content: "thank you",
          totalTipAmountCents: 2000,
        }],
      },
      isError: false,
      isLoading: false,
    });

    const html = renderPanel();

    expect(html).toContain("Чаевые $20.00");
  });

  it("renders stored HTML message bodies as plain text", () => {
    queryMocks.usePageConversationPreview.mockReturnValue({
      data: {
        messageSyncUx: buildSyncUx(),
        conversation: {
          messageBackfillComplete: true,
        },
        messages: [{
          platformMessageId: "msg-html",
          senderRole: "model",
          createdAt: "2026-03-24T11:55:00.000Z",
          content: "<p>Privet Sladkiy, how its going?</p>",
          totalTipAmountCents: 0,
        }],
      },
      isError: false,
      isLoading: false,
    });

    const html = renderPanel();

    expect(html).toContain("Privet Sladkiy, how its going?");
    expect(html).not.toContain("&lt;p&gt;");
  });

  describe("a chat Fansly no longer serves to the page (arena vanished chat, plan §5)", () => {
    const established = {
      state: "established" as const,
      openedAt: "2026-10-06T12:14:00.000Z",
      establishedAt: "2026-10-07T05:25:00.000Z",
      lastRefusalAt: "2026-10-08T05:30:00.000Z",
      refusals: 8,
      ownerNote: null as string | null,
      cause: "unchecked" as "unchecked" | "probably_blocked" | "probably_deleted",
    };
    const socketMessage = {
      platformMessageId: "msg-live",
      senderRole: "fan",
      createdAt: "2026-10-08T11:55:00.000Z",
      content: "enjoy baby",
      totalTipAmountCents: 0,
      source: "live",
      apiUnavailable: false,
    };
    const restMessage = {
      platformMessageId: "msg-rest",
      senderRole: "model",
      createdAt: "2026-10-06T11:55:00.000Z",
      content: "hi there",
      totalTipAmountCents: 0,
      source: "rest",
    };

    function mockPreview(chatAccess: unknown, messages: unknown[]) {
      queryMocks.usePageConversationPreview.mockReturnValue({
        data: {
          messageSyncUx: buildSyncUx(),
          conversation: { messageBackfillComplete: true, ...(chatAccess === undefined ? {} : { chatAccess }) },
          messages,
        },
        isError: false,
        isLoading: false,
      });
    }

    it("shows an established episode's banner, keyed by its cause, with since when and the owner's note", () => {
      mockPreview({ ...established, ownerNote: "06.10: the profile does not open from lora-1" }, [restMessage, socketMessage]);
      const html = renderPanel();
      expect(html).toContain('role="note"');
      expect(html).toContain("Fansly больше не отдаёт этот чат странице.");
      expect(html).toContain("Фан удалил аккаунт или заблокировал страницу.");
      expect(html).toContain("Новые сообщения ещё приходят в реальном времени, но Fansly их не подтверждает.");
      expect(html).toContain("С 6 окт.");
      expect(html).toContain("Заметка владельца:</span> 06.10: the profile does not open from lora-1");

      mockPreview({ ...established, cause: "probably_blocked" }, [restMessage]);
      const blocked = renderPanel();
      expect(blocked).toContain("Аккаунт фана существует — скорее всего, он заблокировал страницу.");
      expect(blocked).not.toContain("Заметка владельца");
      expect(blocked).not.toContain("в реальном времени");

      mockPreview({ ...established, cause: "probably_deleted" }, [restMessage]);
      expect(renderPanel()).toContain("Аккаунт фана не найден на Fansly — скорее всего, он удалён.");
    });

    it("shows the banner over an empty preview too", () => {
      mockPreview(established, []);
      const html = renderPanel();
      expect(html).toContain("Fansly больше не отдаёт этот чат странице.");
      expect(html).toContain("Сообщений нет.");
    });

    it("has no banner while the chat is only being refused, nor without an episode", () => {
      mockPreview({ ...established, state: "refusing", establishedAt: null, refusals: 2 }, [restMessage, socketMessage]);
      expect(renderPanel()).not.toContain("Fansly больше не отдаёт этот чат");
      mockPreview(undefined, [restMessage, socketMessage]);
      expect(renderPanel()).not.toContain("Fansly больше не отдаёт этот чат");
    });

    it("marks every socket-only message as not confirmed, and a chat excluded from sync as API unavailable", () => {
      mockPreview(undefined, [restMessage, socketMessage, { ...socketMessage, platformMessageId: "msg-excluded", apiUnavailable: true }]);
      const html = renderPanel();
      expect(html.match(/>Не подтверждено</g)).toHaveLength(1);
      expect(html.match(/>Не будет подтверждено</g)).toHaveLength(1);
      expect(html).toContain("Fansly никогда не подтвердит это сообщение");

      mockPreview(undefined, [restMessage, { ...socketMessage, source: undefined }]);
      expect(renderPanel()).not.toContain("подтверждено");
    });
  });

  it("uses data-loading language for transient empty previews", () => {
    queryMocks.usePageConversationPreview.mockReturnValue({
      data: {
        messageSyncUx: buildSyncUx({
          state: "retrying",
          headline: "Conversation history is still syncing",
        }),
        conversation: {
          messageBackfillComplete: false,
        },
        messages: [],
      },
      isError: false,
      isLoading: false,
    });

    const html = renderPanel();

    expect(html).toContain("Переписка ещё загружается.");
    expect(html).toContain("Превью заполнится само, когда придут сообщения.");
    expect(html).not.toContain("Conversation history is still syncing");
  });
});
