import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  insertRawPayload: vi.fn(),
  reserveSyncProviderRateLimit: vi.fn(),
  updatePageMetadata: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);

import type { OnlyMonsterAccount } from "@agency_hub_core/onlyfans";

import { buildOnlyFansMetadata } from "../apps/runtime/src/services/onlyfans.ts";
import { refreshPageMetadata } from "../apps/runtime/src/services/sync/shared.ts";

function makeAccount(): OnlyMonsterAccount {
  return {
    id: 42,
    platform_account_id: "of-42",
    platform: "onlyfans",
    name: "Lora OF",
    email: "lora@example.com",
    avatar: "https://example.com/lora.png",
    username: "lora_of",
    organisation_id: "org-1",
    subscribe_price: 12.5,
    subscription_expiration_date: "2026-04-01T00:00:00.000Z",
  };
}

describe("OnlyFans metadata helpers", () => {
  beforeEach(() => {
    dbMocks.insertRawPayload.mockReset();
    dbMocks.reserveSyncProviderRateLimit.mockReset();
    dbMocks.updatePageMetadata.mockReset();
    dbMocks.updatePageMetadata.mockResolvedValue(undefined);
  });

  it("preserves internal sync metadata when rebuilding OM metadata", () => {
    const metadata = buildOnlyFansMetadata(makeAccount(), {
      accountCreatedAt: "2025-01-01T00:00:00.000Z",
      transactionBackfillLowerBound: "2026-02-03T00:00:00.000Z",
      ignoredKey: "drop-me",
    });

    expect(metadata).toMatchObject({
      accountCreatedAt: "2025-01-01T00:00:00.000Z",
      transactionBackfillLowerBound: "2026-02-03T00:00:00.000Z",
      onlyMonsterAccountId: 42,
      subscribePriceMills: 12500,
    });
    expect(metadata).not.toHaveProperty("ignoredKey");
  });

  it("keeps transactionBackfillLowerBound during OnlyFans metadata refresh", async () => {
    const account = makeAccount();
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
      onlyFansAdapter: {
        getAccount: vi.fn(async () => ({
          parsed: {
            account,
          },
        })),
      },
    } as never;

    await refreshPageMetadata(app, {
      platform: "onlyfans",
      page: {
        id: 7,
        metadata: {
          onlyMonsterAccountId: 42,
          transactionBackfillLowerBound: "2026-02-03T00:00:00.000Z",
        },
      },
      auth: { token: "secret" },
      proxy: null,
    } as never, "light");

    expect(dbMocks.updatePageMetadata).toHaveBeenCalledWith(expect.anything(), 7, expect.objectContaining({
      metadata: expect.objectContaining({
        transactionBackfillLowerBound: "2026-02-03T00:00:00.000Z",
        onlyMonsterAccountId: 42,
      }),
    }));
  });
});
