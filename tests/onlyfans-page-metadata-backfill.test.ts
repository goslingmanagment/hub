import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  findPageById: vi.fn(),
  findPageByLabel: vi.fn(),
  listPagesByPlatform: vi.fn(),
  updateOnlyFansPageIdentityFromOfapi: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);

import { backfillOnlyFansPageMetadata } from "../apps/runtime/src/services/onlyfans-page-metadata-backfill.ts";

const PUBLIC_ONLYFANS_AVATAR_URL = "https://public.onlyfans.com/files/lora/avatar.jpg";

function mappedPage(input: Partial<{
  id: number;
  label: string;
  ofapiAccountId: string | null;
  metadata: Record<string, unknown>;
}> = {}) {
  return {
    id: 8,
    label: "lora-of",
    platform: "onlyfans",
    username: "loravie",
    displayName: "loravie",
    metadata: {},
    ofapiAccountId: "acct_lora",
    ...input,
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

// Stage 18: the OnlyMonster credentials path is retired — identity backfill
// is OFAPI-only. Pages without an OFAPI mapping are recorded failures.

describe("backfillOnlyFansPageMetadata", () => {
  beforeEach(() => {
    dbMocks.findPageById.mockReset();
    dbMocks.findPageByLabel.mockReset();
    dbMocks.listPagesByPlatform.mockReset();
    dbMocks.updateOnlyFansPageIdentityFromOfapi.mockReset();
  });

  it("backfills OFAPI-only page identity from the mapped account", async () => {
    const ofapiOnlyPage = mappedPage({
      metadata: { source: "codex-ofapi-webhook-setup", ofapiOnly: true },
    });
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

    expect(dbMocks.listPagesByPlatform).toHaveBeenCalledWith(expect.anything(), "onlyfans");
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

  it("records unmapped pages as failures (OnlyMonster credentials path is retired)", async () => {
    const unmappedPage = mappedPage({
      id: 7,
      ofapiAccountId: null,
      metadata: { onlyMonsterAccountId: 42 },
    });

    dbMocks.listPagesByPlatform.mockResolvedValue([{ label: "lora-of" }]);
    dbMocks.findPageByLabel.mockResolvedValue({
      page: unmappedPage,
      credentials: { encryptedSession: "encrypted" },
      proxy: null,
    });
    dbMocks.findPageById.mockResolvedValue({
      page: unmappedPage,
      credentials: { encryptedSession: "encrypted" },
      proxy: null,
    });

    const result = await backfillOnlyFansPageMetadata({ db: {} } as never);

    expect(dbMocks.updateOnlyFansPageIdentityFromOfapi).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      totalPages: 1,
      updatedPages: 0,
      failedPages: 1,
      pages: [{
        pageId: 7,
        pageLabel: "lora-of",
        status: "failed",
        error: 'Page "lora-of" has no OFAPI account mapping',
      }],
    });
  });

  it("lists OFAPI accounts once across multiple pages", async () => {
    const first = mappedPage({ id: 8, label: "lora-of" });
    const second = mappedPage({ id: 9, label: "lora-vip-of", ofapiAccountId: "acct_vip" });

    dbMocks.findPageByLabel
      .mockResolvedValueOnce({ page: first, credentials: null, proxy: null })
      .mockResolvedValueOnce({ page: second, credentials: null, proxy: null });
    dbMocks.findPageById
      .mockResolvedValueOnce({ page: first, credentials: null, proxy: null })
      .mockResolvedValueOnce({ page: second, credentials: null, proxy: null });
    dbMocks.updateOnlyFansPageIdentityFromOfapi
      .mockImplementation(async (_db: unknown, pageId: number) =>
        pageId === 8 ? first : second,
      );
    const listAccounts = vi.fn(async () => [
      ofapiAccount(),
      ofapiAccount({ id: "acct_vip", username: "loravip", displayName: "Lora VIP" }),
    ]);

    const result = await backfillOnlyFansPageMetadata({
      db: {},
      ofapi: { listAccounts },
    } as never, {
      pageLabels: ["lora-of", "lora-vip-of"],
    });

    expect(dbMocks.listPagesByPlatform).not.toHaveBeenCalled();
    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect(result.updatedPages).toBe(2);
    expect(result.failedPages).toBe(0);
  });

  it("continues after a page failure", async () => {
    const healthyPage = mappedPage();
    const updatedPage = {
      ...healthyPage,
      displayName: "LoraVie FREE",
      metadata: { avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL },
    };

    dbMocks.findPageByLabel
      .mockResolvedValueOnce({ page: healthyPage, credentials: null, proxy: null })
      .mockResolvedValueOnce(null);
    dbMocks.findPageById.mockResolvedValueOnce({
      page: healthyPage,
      credentials: null,
      proxy: null,
    });
    dbMocks.updateOnlyFansPageIdentityFromOfapi.mockResolvedValue(updatedPage);
    const listAccounts = vi.fn(async () => [ofapiAccount()]);

    const result = await backfillOnlyFansPageMetadata({
      db: {},
      ofapi: { listAccounts },
    } as never, {
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
