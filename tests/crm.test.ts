import { afterEach, describe, expect, it, vi } from "vitest";

const repoMocks = vi.hoisted(() => ({
  PAGE_DM_MESSAGE_HISTORY_LIMIT: 25,
  findPageSummaryByLabel: vi.fn(),
  getCrmConversationPreview: vi.fn(),
  getCrmFreshnessCoverage: vi.fn(),
  getCrmSummary: vi.fn(),
  getPageConversationMessages: vi.fn(),
  listCrmReactivation: vi.fn(),
  listCrmRetention: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  canAccessPage: vi.fn(),
  requireDashboardUser: vi.fn(),
}));

const syncStatusMocks = vi.hoisted(() => ({
  getSyncStatusSnapshot: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => repoMocks);
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

import {
  getCrmConversationPreviewReport,
  getCrmSummaryReport,
} from "../apps/runtime/src/services/crm.ts";

describe("crm service", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds CRM summary sync UX from the DM-only helper instead of the full snapshot", async () => {
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
    repoMocks.getCrmSummary.mockResolvedValue({
      retentionTotal: 1,
      retentionCountsByTouchpoint: { "3d": 1 },
      reactivationTotal: 2,
      freshness: {
        lastConversationChunkSucceededAt: new Date("2026-03-24T11:50:00.000Z"),
        lastConversationFullSweepAt: new Date("2026-03-24T11:00:00.000Z"),
        lastMessageChunkSucceededAt: new Date("2026-03-24T11:55:00.000Z"),
        pendingMessageBackfillCount: 0,
        previewReadyConversationCount: 1,
      },
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

    const result = await getCrmSummaryReport({ db: {} } as never, {} as never, "lana");

    expect(syncStatusMocks.getSyncStatusSnapshot).toHaveBeenCalledWith(
      { db: {} },
      {
        pageIds: [7],
      },
    );
    expect(result.messageSyncUx.state).toBe("healthy");
  });

  it("uses the DM-only helper for CRM preview sync UX as well", async () => {
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
    repoMocks.getCrmFreshnessCoverage.mockResolvedValue({
      lastConversationChunkSucceededAt: new Date("2026-03-24T11:50:00.000Z"),
      lastConversationFullSweepAt: new Date("2026-03-24T11:00:00.000Z"),
      lastMessageChunkSucceededAt: new Date("2026-03-24T11:55:00.000Z"),
      pendingMessageBackfillCount: 0,
      previewReadyConversationCount: 1,
    });
    repoMocks.getCrmConversationPreview.mockResolvedValue({
      fan: null,
      conversation: {
        platformConversationId: "crm-conv-001",
        storedMessageCount: 1,
        messageBackfillComplete: true,
        lastMessageSyncAt: new Date("2026-03-24T11:55:00.000Z"),
        unreadCount: 0,
        lastMessageAt: new Date("2026-03-24T11:55:00.000Z"),
      },
      messages: [{
        platformMessageId: "msg-1",
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

    const result = await getCrmConversationPreviewReport(
      { db: {} } as never,
      {} as never,
      { pageLabel: "lana", platformConversationId: "crm-conv-001" },
      { limit: 10 },
    );

    expect(syncStatusMocks.getSyncStatusSnapshot).toHaveBeenCalledWith(
      { db: {} },
      {
        pageIds: [7],
      },
    );
    expect(result.messageSyncUx.state).toBe("healthy");
  });
});
