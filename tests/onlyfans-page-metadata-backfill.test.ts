import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  findPageById: vi.fn(),
  findPageByLabel: vi.fn(),
  listPagesByPlatform: vi.fn(),
  updateOnlyFansPageIdentityFromOfapi: vi.fn(),
}));
const pageContextMocks = vi.hoisted(() => ({
  resolvePageContext: vi.fn(),
}));
const syncMocks = vi.hoisted(() => ({
  refreshPageMetadata: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/services/page-context.ts", () => pageContextMocks);
vi.mock("../apps/runtime/src/services/sync/shared.ts", () => syncMocks);

import { backfillOnlyFansPageMetadata } from "../apps/runtime/src/services/onlyfans-page-metadata-backfill.ts";

const PUBLIC_ONLYFANS_AVATAR_URL = "https://public.onlyfans.com/files/lora/avatar.jpg";

function pageContext(label = "lora-of") {
  return {
    platform: "onlyfans",
    page: {
      id: 7,
      label,
      platform: "onlyfans",
      username: "loravie",
      displayName: "loravie",
      metadata: { onlyMonsterAccountId: 42 },
      ofapiAccountId: null,
    },
    auth: { token: "secret" },
    proxy: null,
    egressKey: "direct",
  };
}

function ofapiAccount(input: Partial<{
  id: string;
  username: string | null;
  displayName: string | null;
  onlyfansName: string | null;
  onlyfansUserId: string | null;
  avatarUrl: string | null;
}> = {}) {
  return {
    id: "acct_lora",
    username: "loravie",
    displayName: "LoraVie FREE",
    onlyfansName: "Lora Vie",
    onlyfansUserId: "123",
    avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL,
    ...input,
  };
}

describe("backfillOnlyFansPageMetadata", () => {
  beforeEach(() => {
    dbMocks.findPageById.mockReset();
    dbMocks.findPageByLabel.mockReset();
    dbMocks.listPagesByPlatform.mockReset();
    dbMocks.updateOnlyFansPageIdentityFromOfapi.mockReset();
    pageContextMocks.resolvePageContext.mockReset();
    syncMocks.refreshPageMetadata.mockReset();
  });

  it("refreshes credentialed OnlyFans pages and reports the updated account identity", async () => {
    dbMocks.listPagesByPlatform.mockResolvedValue([{ label: "lora-of" }]);
    dbMocks.findPageByLabel.mockResolvedValue({
      page: pageContext().page,
      credentials: { encryptedSession: "encrypted" },
      proxy: null,
    });
    pageContextMocks.resolvePageContext.mockResolvedValue(pageContext());
    syncMocks.refreshPageMetadata.mockResolvedValue(undefined);
    dbMocks.findPageById
      .mockResolvedValueOnce({
        page: pageContext().page,
        credentials: { encryptedSession: "encrypted" },
        proxy: null,
      })
      .mockResolvedValueOnce({
        page: {
          ...pageContext().page,
          displayName: "Lora Free",
          metadata: { avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL },
        },
        credentials: { encryptedSession: "encrypted" },
        proxy: null,
      });

    const result = await backfillOnlyFansPageMetadata({ db: {} } as never);

    expect(dbMocks.listPagesByPlatform).toHaveBeenCalledWith(expect.anything(), "onlyfans");
    expect(syncMocks.refreshPageMetadata).toHaveBeenCalledWith(expect.anything(), pageContext(), "light");
    expect(dbMocks.updateOnlyFansPageIdentityFromOfapi).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      totalPages: 1,
      updatedPages: 1,
      failedPages: 0,
      pages: [{
        pageId: 7,
        pageLabel: "lora-of",
        status: "updated",
        username: "loravie",
        displayName: "Lora Free",
        avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL,
        error: null,
      }],
    });
  });

  it("backfills OFAPI-only page identity from the mapped account", async () => {
    const ofapiOnlyPage = {
      id: 8,
      label: "lora-of",
      platform: "onlyfans",
      username: "loravie",
      displayName: "loravie",
      metadata: { source: "codex-ofapi-webhook-setup", ofapiOnly: true },
      ofapiAccountId: "acct_lora",
    };
    const updatedPage = {
      ...ofapiOnlyPage,
      displayName: "LoraVie FREE",
      metadata: {
        ...ofapiOnlyPage.metadata,
        avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL,
      },
    };

    dbMocks.listPagesByPlatform.mockResolvedValue([{ label: "lora-of" }]);
    dbMocks.findPageByLabel.mockResolvedValue({
      page: ofapiOnlyPage,
      credentials: null,
      proxy: null,
    });
    dbMocks.findPageById.mockResolvedValue({
      page: ofapiOnlyPage,
      credentials: null,
      proxy: null,
    });
    dbMocks.updateOnlyFansPageIdentityFromOfapi.mockResolvedValue(updatedPage);
    const listAccounts = vi.fn(async () => [ofapiAccount()]);

    const result = await backfillOnlyFansPageMetadata({
      db: {},
      ofapi: { listAccounts },
    } as never);

    expect(syncMocks.refreshPageMetadata).not.toHaveBeenCalled();
    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateOnlyFansPageIdentityFromOfapi).toHaveBeenCalledWith(
      expect.anything(),
      8,
      {
        ofapiAccountId: "acct_lora",
        username: "loravie",
        displayName: "LoraVie FREE",
        metadata: {
          source: "codex-ofapi-webhook-setup",
          ofapiOnly: true,
          avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL,
        },
      },
    );
    expect(result).toMatchObject({
      totalPages: 1,
      updatedPages: 1,
      failedPages: 0,
      pages: [{
        pageId: 8,
        pageLabel: "lora-of",
        status: "updated",
        username: "loravie",
        displayName: "LoraVie FREE",
        avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL,
        error: null,
      }],
    });
  });

  it("falls back to OFAPI identity when credential refresh fails on a mapped page", async () => {
    const storedPage = {
      id: 7,
      label: "lora-of",
      platform: "onlyfans",
      username: "loravie",
      displayName: "loravie",
      metadata: {},
      ofapiAccountId: "acct_lora",
    };
    const updatedPage = {
      ...storedPage,
      displayName: "LoraVie FREE",
      metadata: { avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL },
    };

    dbMocks.findPageByLabel.mockResolvedValue({
      page: storedPage,
      credentials: { encryptedSession: "encrypted" },
      proxy: null,
    });
    dbMocks.findPageById.mockResolvedValue({
      page: storedPage,
      credentials: { encryptedSession: "encrypted" },
      proxy: null,
    });
    pageContextMocks.resolvePageContext.mockRejectedValue(new Error("OnlyMonster timeout"));
    dbMocks.updateOnlyFansPageIdentityFromOfapi.mockResolvedValue(updatedPage);
    const listAccounts = vi.fn(async () => [ofapiAccount()]);

    const result = await backfillOnlyFansPageMetadata({
      db: {},
      ofapi: { listAccounts },
    } as never, {
      pageLabels: ["lora-of"],
    });

    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateOnlyFansPageIdentityFromOfapi).toHaveBeenCalled();
    expect(result.updatedPages).toBe(1);
    expect(result.failedPages).toBe(0);
  });

  it("continues after a page refresh failure", async () => {
    dbMocks.findPageByLabel
      .mockResolvedValueOnce({
        page: pageContext("lora-of").page,
        credentials: { encryptedSession: "encrypted" },
        proxy: null,
      })
      .mockResolvedValueOnce(null);
    pageContextMocks.resolvePageContext.mockResolvedValueOnce(pageContext("lora-of"));
    syncMocks.refreshPageMetadata.mockResolvedValue(undefined);
    dbMocks.findPageById
      .mockResolvedValueOnce({
        page: pageContext("lora-of").page,
        credentials: { encryptedSession: "encrypted" },
        proxy: null,
      })
      .mockResolvedValueOnce({
        page: {
          ...pageContext("lora-of").page,
          displayName: "Lora Free",
          metadata: { avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL },
        },
        credentials: { encryptedSession: "encrypted" },
        proxy: null,
      });

    const result = await backfillOnlyFansPageMetadata({ db: {} } as never, {
      pageLabels: ["lora-of", "broken-of"],
    });

    expect(dbMocks.listPagesByPlatform).not.toHaveBeenCalled();
    expect(result.updatedPages).toBe(1);
    expect(result.failedPages).toBe(1);
    expect(result.pages[1]).toMatchObject({
      pageId: null,
      pageLabel: "broken-of",
      status: "failed",
      error: 'Page "broken-of" was not found',
    });
  });
});
