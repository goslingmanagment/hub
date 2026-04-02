import { afterEach, describe, expect, it, vi } from "vitest";

const repoMocks = vi.hoisted(() => ({
  PAGE_DM_MESSAGE_HISTORY_LIMIT: 25,
  findPageSummaryByLabel: vi.fn(),
  getPageConversationPreview: vi.fn(),
  getPageConversationMessages: vi.fn(),
  getPageDmSyncCoverage: vi.fn(),
  listWorkboardSubscribers: vi.fn(),
  listWorkboardActiveSpenders: vi.fn(),
  listWorkboardAllSpenders: vi.fn(),
  listWorkboardSnoozed: vi.fn(),
  millsToNumber: (value: bigint) => Number(value),
}));

const authMocks = vi.hoisted(() => ({
  canAccessPage: vi.fn(),
  requireDashboardUser: vi.fn(),
}));

const syncStatusMocks = vi.hoisted(() => ({
  getSyncStatusSnapshot: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => repoMocks);
vi.mock("@agency_hub_core/shared", async () => {
  const actual = await vi.importActual("@agency_hub_core/shared");
  return {
    ...actual,
    millsToNumber: repoMocks.millsToNumber,
  };
});
vi.mock("../apps/runtime/src/services/auth.ts", () => ({
  canAccessPage: authMocks.canAccessPage,
  requireDashboardUser: authMocks.requireDashboardUser,
}));
vi.mock("../apps/runtime/src/services/sync-status.ts", () => ({
  getSyncStatusSnapshot: syncStatusMocks.getSyncStatusSnapshot,
  mapDomainBlockToSyncUx: (block: {
    state: "up_to_date" | "failed";
    error?: { code: string | null; summary: string | null } | null;
  }) => ({
    state: block.state === "failed" ? "attention" : "healthy",
    label: block.state === "failed" ? "Needs attention" : "Up to date",
    headline: block.state === "failed" ? "Sync needs attention" : "Up to date",
    detail: block.error?.summary ?? "Sync is current.",
    progressLabel: null,
    nextRetryAt: null,
    updatedAt: "2026-03-24T11:55:00.000Z",
    requiresAction: false,
  }),
}));

import { getPageConversationPreviewReport } from "../apps/runtime/src/services/conversations.ts";
import { getWorkboardReport } from "../apps/runtime/src/services/workboard.ts";

describe("runtime page services", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds preview sync UX from the DM-only helper instead of page-wide sync state", async () => {
    authMocks.canAccessPage.mockReturnValue(true);
    repoMocks.findPageSummaryByLabel.mockResolvedValue({
      id: 7,
      label: "lana",
      platform: "fansly",
      username: "lana_page",
      displayName: "Lana",
      followerCount: 10,
      subscriberCount: 20,
      lastLightSyncAt: new Date("2026-03-24T11:00:00.000Z"),
      lastFollowerSyncAt: new Date("2026-03-24T11:00:00.000Z"),
      modelSlug: "lana",
      modelName: "Lana",
    });
    repoMocks.getPageDmSyncCoverage.mockResolvedValue({
      lastConversationChunkSucceededAt: new Date("2026-03-24T11:50:00.000Z"),
      lastConversationFullSweepAt: new Date("2026-03-24T11:00:00.000Z"),
      lastMessageChunkSucceededAt: new Date("2026-03-24T11:55:00.000Z"),
      pendingMessageBackfillCount: 0,
      partialWindowConversationCount: 0,
      excludedConversationCount: 0,
      unresolvedConversationCount: 0,
      previewReadyConversationCount: 1,
    });
    repoMocks.getPageConversationPreview.mockResolvedValue({
      fan: null,
      conversation: {
        platformConversationId: "conversation-001",
        storedMessageCount: 1,
        messageCoverageStatus: "complete",
        messageBackfillComplete: true,
        messageSyncEligibility: "eligible",
        messageSyncExcludedReason: null,
        lastMessageSyncAt: new Date("2026-03-24T11:55:00.000Z"),
        unreadCount: 0,
        lastMessageAt: new Date("2026-03-24T11:55:00.000Z"),
      },
      messages: [{
        platformMessageId: "message-1",
        senderPlatformUserId: null,
        senderRole: "fan",
        createdAt: new Date("2026-03-24T11:55:00.000Z"),
        content: "hey",
        totalTipAmountCents: 0,
      }],
    });
    syncStatusMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-24T12:00:00.000Z",
      pages: [{
        pageId: 7,
        blocks: {
          messages_live: { state: "up_to_date", error: null },
          messages_history: { state: "up_to_date", error: null },
        },
      }],
    });

    const result = await getPageConversationPreviewReport(
      { db: {} } as never,
      {} as never,
      { pageLabel: "lana", platformConversationId: "conversation-001" },
      { limit: 10 },
    );

    expect(syncStatusMocks.getSyncStatusSnapshot).toHaveBeenCalledWith(
      { db: {} },
      {
        pageIds: [7],
      },
    );
    expect(repoMocks.getPageConversationPreview).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        platformAccountId: 7,
        platformConversationId: "conversation-001",
        limit: 10,
      }),
    );
    expect(result.messageSyncUx.state).toBe("healthy");
    expect(result.conversation.messageCoverageStatus).toBe("complete");
  });

  it("uses workboard-specific unsupported-page errors", async () => {
    authMocks.canAccessPage.mockReturnValue(true);
    repoMocks.findPageSummaryByLabel.mockResolvedValue({
      id: 8,
      label: "lana-of",
      platform: "onlyfans",
      username: "lana_of",
      displayName: "Lana OF",
      followerCount: 10,
      subscriberCount: 20,
      lastLightSyncAt: null,
      lastFollowerSyncAt: null,
      modelSlug: "lana",
      modelName: "Lana",
    });

    await expect(getWorkboardReport(
      { db: {} } as never,
      {} as never,
      "lana-of",
    )).rejects.toMatchObject({
      message: "Workboard is only supported for Fansly pages",
      statusCode: 400,
    });
  });
});
