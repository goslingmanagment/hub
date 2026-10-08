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

    expect(html).toContain("Preview failed to load.");
    expect(html).not.toContain("No messages to show.");
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

    expect(html).toContain("No messages to show.");
    expect(html).not.toContain("Preview failed to load.");
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
    expect(html).not.toContain("Preview may be incomplete while conversation history loads.");
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

    expect(html).toContain("Tip $20.00");
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
      expect(html).toContain("Fansly no longer serves this chat to the page.");
      expect(html).toContain("The fan deleted their account or blocked the page.");
      expect(html).toContain("New messages still arrive over the socket, but they can&#x27;t be confirmed.");
      expect(html).toContain("Since Oct 6");
      expect(html).toContain("Owner&#x27;s note:</span> 06.10: the profile does not open from lora-1");

      mockPreview({ ...established, cause: "probably_blocked" }, [restMessage]);
      const blocked = renderPanel();
      expect(blocked).toContain("The fan&#x27;s account still exists — they have probably blocked this page.");
      expect(blocked).not.toContain("Owner&#x27;s note");
      expect(blocked).not.toContain("over the socket");

      mockPreview({ ...established, cause: "probably_deleted" }, [restMessage]);
      expect(renderPanel()).toContain("The fan&#x27;s account was not found on Fansly — it was probably deleted.");
    });

    it("shows the banner over an empty preview too", () => {
      mockPreview(established, []);
      const html = renderPanel();
      expect(html).toContain("Fansly no longer serves this chat to the page.");
      expect(html).toContain("No messages to show.");
    });

    it("has no banner while the chat is only being refused, nor without an episode", () => {
      mockPreview({ ...established, state: "refusing", establishedAt: null, refusals: 2 }, [restMessage, socketMessage]);
      expect(renderPanel()).not.toContain("Fansly no longer serves this chat");
      mockPreview(undefined, [restMessage, socketMessage]);
      expect(renderPanel()).not.toContain("Fansly no longer serves this chat");
    });

    it("marks every socket-only message as not confirmed, and a chat excluded from sync as API unavailable", () => {
      mockPreview(undefined, [restMessage, socketMessage, { ...socketMessage, platformMessageId: "msg-excluded", apiUnavailable: true }]);
      const html = renderPanel();
      expect(html.match(/From socket · not confirmed/g)).toHaveLength(1);
      expect(html.match(/From socket · API unavailable/g)).toHaveLength(1);
      expect(html).toContain("Fansly&#x27;s API will never confirm this message");

      mockPreview(undefined, [restMessage, { ...socketMessage, source: undefined }]);
      expect(renderPanel()).not.toContain("From socket");
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

    expect(html).toContain("Conversation history is still loading.");
    expect(html).toContain("This preview will fill in automatically as more messages arrive.");
    expect(html).not.toContain("Conversation history is still syncing");
  });
});
