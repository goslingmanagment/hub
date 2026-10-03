import { afterEach, describe, expect, it, vi } from "vitest";

const repoMocks = vi.hoisted(() => ({
  PAGE_DM_MESSAGE_HISTORY_LIMIT: 25,
  findPageById: vi.fn(),
  findPageSummaryByLabel: vi.fn(),
  getPageConversationPreview: vi.fn(),
  getPageConversationMessages: vi.fn(),
  getPageDmSyncCoverage: vi.fn(),
  listFanslyFanPageIdentityBackfillTargets: vi.fn(),
  // Step-3 legacy fences (S3-01): no page is the Fansly Sync Engine's here.
  findPageByLabel: vi.fn(async () => null),
  listEngineOwnedFanslyPages: vi.fn(async () => []),
  // Step 4 (S4-08): the store a page's DM readers read.
  readDmReaderStore: vi.fn(async () => "page_dm_messages"),
  millsToNumber: (value: bigint) => Number(value),
}));

const authMocks = vi.hoisted(() => ({
  canAccessPage: vi.fn(),
  requireDashboardUser: vi.fn(),
}));

const syncStatusMocks = vi.hoisted(() => ({
  getSyncStatusSnapshot: vi.fn(),
}));

const fanslyPageMocks = vi.hoisted(() => ({
  resolveAccessibleFanslyPage: vi.fn(),
  resolveAccessibleDmPage: vi.fn(),
}));

const pageContextMocks = vi.hoisted(() => ({
  resolvePageContext: vi.fn(),
}));

const liveOverlayMocks = vi.hoisted(() => ({
  pageReadsLiveOverlay: vi.fn(),
}));

const fanHydrationMocks = vi.hoisted(() => ({
  upsertHydratedFansForPage: vi.fn(),
  upsertHydratedFansForPageDetailed: vi.fn(),
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
vi.mock("../apps/runtime/src/services/fansly-page.ts", () => ({
  resolveAccessibleFanslyPage: fanslyPageMocks.resolveAccessibleFanslyPage,
  resolveAccessibleDmPage: fanslyPageMocks.resolveAccessibleDmPage,
}));
vi.mock("../apps/runtime/src/services/live-overlay-read.ts", () => ({
  pageReadsLiveOverlay: liveOverlayMocks.pageReadsLiveOverlay,
}));
vi.mock("../apps/runtime/src/services/page-context.ts", () => ({
  resolvePageContext: pageContextMocks.resolvePageContext,
}));
vi.mock("../apps/runtime/src/services/sync/fan-hydration.ts", () => ({
  upsertHydratedFansForPage: fanHydrationMocks.upsertHydratedFansForPage,
  upsertHydratedFansForPageDetailed: fanHydrationMocks.upsertHydratedFansForPageDetailed,
}));

import { backfillFanslyPageAliases } from "../apps/runtime/src/services/fansly-page-alias-backfill.ts";
import {
  getPageConversationMessagesReport,
  getPageConversationPreviewReport,
} from "../apps/runtime/src/services/conversations.ts";

describe("runtime page services", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds preview sync UX from the DM-only helper instead of page-wide sync state", async () => {
    authMocks.canAccessPage.mockReturnValue(true);
    liveOverlayMocks.pageReadsLiveOverlay.mockResolvedValue(false);
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
        monitorStreams: ["dm_conversations", "dm_messages"],
      },
    );
    expect(repoMocks.getPageConversationPreview).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        platformAccountId: 7,
        platformConversationId: "conversation-001",
        limit: 10,
        liveOverlay: false,
        store: "page_dm_messages",
      }),
    );
    expect(result.messageSyncUx.state).toBe("healthy");
    expect(result.conversation.messageCoverageStatus).toBe("complete");
    // A page outside the live overlay switch: the confirmed-only shape, no provenance.
    expect(result.messages).toEqual([{
      platformMessageId: "message-1",
      senderPlatformUserId: null,
      senderRole: "fan",
      createdAt: "2026-03-24T11:55:00.000Z",
      content: "hey",
      totalTipAmountCents: 0,
    }]);
  });

  it("asks the repository for the live union and serializes each row's provenance on a listed page", async () => {
    authMocks.canAccessPage.mockReturnValue(true);
    liveOverlayMocks.pageReadsLiveOverlay.mockResolvedValue(true);
    // A page the Fansly Sync Engine runs live reads the archive (S4-08).
    repoMocks.readDmReaderStore.mockResolvedValueOnce("message_archive");
    const page = {
      id: 7, label: "ari-1", platform: "fansly", username: null, displayName: null, followerCount: null,
      subscriberCount: null, lastLightSyncAt: null, lastFollowerSyncAt: null, modelSlug: "ari", modelName: "Ari",
    };
    repoMocks.findPageSummaryByLabel.mockResolvedValue(page);
    const conversation = {
      platformConversationId: "800", storedMessageCount: 1, messageCoverageStatus: "complete",
      messageBackfillComplete: true, messageSyncEligibility: "excluded",
      messageSyncExcludedReason: "partner_missing_from_aggregation_accounts", lastMessageSyncAt: null,
      unreadCount: 0, lastMessageAt: null,
    };
    repoMocks.getPageConversationMessages.mockResolvedValue({
      conversationId: "800",
      conversation,
      messages: [
        { messageId: "2", senderRole: "fan", content: "<b>live</b>", createdAt: new Date("2026-10-01T12:00:01.000Z"),
          tipAmountCents: 0, provenance: { source: "live", apiUnavailable: true } },
        { messageId: "1", senderRole: "model", content: "rest", createdAt: new Date("2026-10-01T12:00:00.000Z"),
          tipAmountCents: 300, provenance: { source: "rest" } },
      ],
    });

    const result = await getPageConversationMessagesReport(
      { db: {} } as never,
      {} as never,
      { pageLabel: "ari-1", conversationId: "800" },
      { limit: 25 },
    );

    expect(liveOverlayMocks.pageReadsLiveOverlay).toHaveBeenCalledWith({ db: {} }, page);
    expect(repoMocks.readDmReaderStore).toHaveBeenCalledWith({}, 7);
    expect(repoMocks.getPageConversationMessages).toHaveBeenCalledWith(
      {},
      { platformAccountId: 7, platformConversationId: "800", limit: 25, liveOverlay: true, store: "message_archive" },
    );
    expect(result.messages).toEqual([
      { messageId: "2", senderRole: "fan", content: "live", createdAt: "2026-10-01T12:00:01.000Z",
        tipAmountCents: 0, source: "live", apiUnavailable: true },
      { messageId: "1", senderRole: "model", content: "rest", createdAt: "2026-10-01T12:00:00.000Z",
        tipAmountCents: 300, source: "rest" },
    ]);
  });

  it("allows OnlyFans conversation previews", async () => {
    authMocks.canAccessPage.mockReturnValue(true);
    repoMocks.findPageSummaryByLabel.mockResolvedValue({
      id: 9,
      label: "lora-vip",
      platform: "onlyfans",
      username: "loravievip",
      displayName: "Lora VIP",
      followerCount: null,
      subscriberCount: null,
      lastLightSyncAt: new Date("2026-03-24T11:00:00.000Z"),
      lastFollowerSyncAt: null,
      modelSlug: "lora",
      modelName: "Lora",
    });
    repoMocks.getPageDmSyncCoverage.mockResolvedValue({
      lastConversationChunkSucceededAt: new Date("2026-03-24T11:50:00.000Z"),
      lastConversationFullSweepAt: null,
      lastMessageChunkSucceededAt: new Date("2026-03-24T11:55:00.000Z"),
      pendingMessageBackfillCount: 0,
      partialWindowConversationCount: 0,
      excludedConversationCount: 0,
      unresolvedConversationCount: 0,
      previewReadyConversationCount: 1,
    });
    repoMocks.getPageConversationPreview.mockResolvedValue({
      fan: {
        id: 42,
        platformUserId: "87790113",
        pageAlias: null,
        username: null,
        displayName: null,
      },
      conversation: {
        platformConversationId: "87790113",
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
        platformMessageId: "of-message-1",
        senderPlatformUserId: "87790113",
        senderRole: "fan",
        createdAt: new Date("2026-03-24T11:55:00.000Z"),
        content: "<p>hey &amp; hi</p>",
        totalTipAmountCents: 0,
      }],
    });
    syncStatusMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-24T12:00:00.000Z",
      pages: [{
        pageId: 9,
        blocks: {
          messages_live: { state: "up_to_date", error: null },
          messages_history: { state: "up_to_date", error: null },
        },
      }],
    });

    const result = await getPageConversationPreviewReport(
      { db: {} } as never,
      {} as never,
      { pageLabel: "lora-vip", platformConversationId: "87790113" },
      { limit: 10 },
    );

    expect(result.page.platform).toBe("onlyfans");
    expect(syncStatusMocks.getSyncStatusSnapshot).toHaveBeenCalledWith(
      { db: {} },
      { pageIds: [9], monitorStreams: ["dm_conversations", "dm_messages"] },
    );
    expect(result.fan).toMatchObject({
      platform: "onlyfans",
      platformUserId: "87790113",
    });
    expect(result.messages[0]).toMatchObject({
      platformMessageId: "of-message-1",
      content: "hey & hi",
    });
  });


  it("passes custom egress keys into Fansly page alias backfills", async () => {
    const pageContext = {
      platform: "fansly",
      page: {
        id: 7,
        label: "lana",
        platformAccountId: "acct-1",
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: { url: "socks5://proxy.example" },
      egressKey: "shared-proxy-pool",
    };
    let observedContext: Record<string, unknown> | null = null;
    pageContextMocks.resolvePageContext.mockResolvedValue(pageContext);
    repoMocks.listFanslyFanPageIdentityBackfillTargets.mockResolvedValue([{
      platformAccountId: 7,
      pageLabel: "lana",
      platformUserId: "fan-1",
    }]);
    fanHydrationMocks.upsertHydratedFansForPageDetailed.mockResolvedValue({
      reconciledAccountCount: 1,
      noteCount: 0,
      upsertedNoteCount: 0,
      deactivatedNoteCount: 0,
      aliasesSet: 0,
      aliasesCleared: 0,
    });

    await backfillFanslyPageAliases(
      {
        db: {},
        adapter: {
          async getAccountsByIdsPage(context: Record<string, unknown>) {
            observedContext = context;
            return {
              parsed: [{
                id: "fan-1",
                username: "fan_1",
                displayName: "Fan 1",
                createdAt: 1_770_000_000_000,
              }],
            };
          },
        },
      } as never,
      { pageLabels: ["lana"], chunkSize: 1 },
    );

    expect(observedContext).toMatchObject({
      egressKey: "shared-proxy-pool",
      proxy: { url: "socks5://proxy.example" },
    });
  });

});
