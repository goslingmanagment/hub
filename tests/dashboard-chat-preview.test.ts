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
