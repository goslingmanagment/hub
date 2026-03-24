import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queryMocks = vi.hoisted(() => ({
  useCrmConversationPreview: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { ChatPreviewPanel } from "../apps/dashboard/src/components/page/crm/ChatPreviewPanel.tsx";

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
    detail: "CRM previews are ready to use.",
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
      platformConversationId: "crm-conv-001",
      profileHref: "/pages/lana/fans/fansly/fan-001",
    }),
  ));
}

describe("ChatPreviewPanel", () => {
  beforeEach(() => {
    queryMocks.useCrmConversationPreview.mockReset();
  });

  it("renders an explicit error state when preview loading fails", () => {
    queryMocks.useCrmConversationPreview.mockReturnValue({
      data: undefined,
      isError: true,
      isLoading: false,
    });

    const html = renderPanel();

    expect(html).toContain("Preview failed to load.");
    expect(html).not.toContain("No messages to show.");
  });

  it("keeps the empty state for genuinely empty conversations", () => {
    queryMocks.useCrmConversationPreview.mockReturnValue({
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
    queryMocks.useCrmConversationPreview.mockReturnValue({
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
    expect(html).not.toContain("Preview may be incomplete while messages catch up");
  });
});
