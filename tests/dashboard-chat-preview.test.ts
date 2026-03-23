import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useCrmConversationPreview: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);
vi.mock("react-router", () => ({
  Link: ({ children, to, ...props }: { children?: ReactNode; to: string }) =>
    createElement("a", { href: to, ...props }, children),
}));

import { ChatPreviewPanel } from "../apps/dashboard/src/components/page/crm/ChatPreviewPanel.tsx";

function renderPanel() {
  return renderToStaticMarkup(createElement(ChatPreviewPanel, {
    pageLabel: "lana",
    platformConversationId: "crm-conv-001",
    profileHref: "/pages/lana/fans/fansly/fan-001",
  }));
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
  });
});
