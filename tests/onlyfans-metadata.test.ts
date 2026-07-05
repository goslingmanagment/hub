import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  insertRawPayload: vi.fn(),
  insertObservation: vi.fn(),
  getPageSyncExecutionContext: vi.fn(() => null),
  reserveSyncProviderRateLimit: vi.fn(),
  updatePageMetadata: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);

import type { OnlyMonsterAccount } from "@agency_hub_core/onlyfans";

import {
  buildOnlyFansMetadata,
  resolveOnlyFansDisplayName,
} from "../apps/runtime/src/services/onlyfans.ts";
import { refreshPageMetadata } from "../apps/runtime/src/services/sync/shared.ts";

const PUBLIC_ONLYFANS_AVATAR_URL = "https://public.onlyfans.com/files/lora/avatar.jpg";
const SIGNED_ONLYFANS_AVATAR_URL =
  "https://public.onlyfans.com/files/lora/avatar.jpg?Policy=ip-locked&Signature=sig&Key-Pair-Id=key";

function makeAccount(input: Partial<OnlyMonsterAccount> = {}): OnlyMonsterAccount {
  return {
    id: 42,
    platform_account_id: "of-42",
    platform: "onlyfans",
    name: "Lora OF",
    email: "lora@example.com",
    avatar: PUBLIC_ONLYFANS_AVATAR_URL,
    username: "lora_of",
    organisation_id: "org-1",
    subscribe_price: 12.5,
    subscription_expiration_date: "2026-04-01T00:00:00.000Z",
    ...input,
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

  it("keeps only portable OnlyFans avatar URLs in page metadata", () => {
    expect(buildOnlyFansMetadata(makeAccount()).avatarUrl).toBe(PUBLIC_ONLYFANS_AVATAR_URL);

    expect(buildOnlyFansMetadata(makeAccount({ avatar: "https://images.example/lora.png" })).avatarUrl)
      .toBe(null);
    expect(buildOnlyFansMetadata(makeAccount({ avatar: SIGNED_ONLYFANS_AVATAR_URL })).avatarUrl)
      .toBe(null);
  });

  it("does not downgrade an existing portable avatar when OnlyMonster returns an empty or signed URL", () => {
    expect(buildOnlyFansMetadata(makeAccount({ avatar: "" }), {
      avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL,
    }).avatarUrl).toBe(PUBLIC_ONLYFANS_AVATAR_URL);

    expect(buildOnlyFansMetadata(makeAccount({ avatar: SIGNED_ONLYFANS_AVATAR_URL }), {
      avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL,
    }).avatarUrl).toBe(PUBLIC_ONLYFANS_AVATAR_URL);
  });

  it("preserves existing rich display names when OnlyMonster falls back to username", () => {
    expect(resolveOnlyFansDisplayName(
      makeAccount({ name: "loravie", username: "loravie" }),
      { displayName: "Lora Free", username: "loravie" },
    )).toBe("Lora Free");

    expect(resolveOnlyFansDisplayName(
      makeAccount({ name: "Lora VIP", username: "loravievip" }),
      { displayName: "Lora Free", username: "loravie" },
    )).toBe("Lora VIP");
  });

  it("keeps transactionBackfillLowerBound during OnlyFans metadata refresh", async () => {
    const account = makeAccount({
      avatar: "",
      name: "lora_of",
      username: "lora_of",
    });
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
        username: "lora_of",
        displayName: "Lora OF",
        metadata: {
          avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL,
          onlyMonsterAccountId: 42,
          transactionBackfillLowerBound: "2026-02-03T00:00:00.000Z",
        },
      },
      auth: { token: "secret" },
      proxy: null,
    } as never, "light");

    expect(dbMocks.updatePageMetadata).toHaveBeenCalledWith(expect.anything(), 7, expect.objectContaining({
      displayName: "Lora OF",
      metadata: expect.objectContaining({
        avatarUrl: PUBLIC_ONLYFANS_AVATAR_URL,
        transactionBackfillLowerBound: "2026-02-03T00:00:00.000Z",
        onlyMonsterAccountId: 42,
      }),
    }));
  });
});
