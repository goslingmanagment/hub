import { describe, expect, it, vi } from "vitest";

import type { OnlyMonsterAccount } from "@agency_hub_core/onlyfans";

import { findOnlyFansAccountByUsername } from "../apps/runtime/src/services/onlyfans.ts";

function makeAccount(input: Partial<OnlyMonsterAccount> = {}): OnlyMonsterAccount {
  return {
    id: 42,
    platform_account_id: "of-acct-42",
    platform: "onlyfans",
    name: "Lora OF",
    email: null,
    avatar: "https://example.com/lora.png",
    username: "lora_of",
    organisation_id: "org-1",
    subscribe_price: null,
    subscription_expiration_date: null,
    ...input,
  };
}

describe("findOnlyFansAccountByUsername", () => {
  it("returns the first username match without paginating further", async () => {
    const listAccountsPage = vi.fn(async (_context: unknown, params?: {
      cursor?: string | null;
      limit?: number;
      pageIndex?: number;
    }) => {
      expect(params).toMatchObject({
        cursor: null,
        limit: 100,
        pageIndex: 0,
      });

      return {
        parsed: {
          accounts: [makeAccount()],
          nextCursor: "cursor-2",
        },
        raw: {},
      };
    });

    const account = await findOnlyFansAccountByUsername(
      { listAccountsPage } as never,
      { auth: { token: "om-token" } } as never,
      "lora_of",
    );

    expect(account.id).toBe(42);
    expect(listAccountsPage).toHaveBeenCalledTimes(1);
  });
});
