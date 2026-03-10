import { dollarsToMills, millsToNumber } from "@fansly-connect/shared";
import type {
  OnlyFansAdapter,
  OnlyFansRequestContext,
  OnlyMonsterAccount,
} from "@fansly-connect/onlyfans";

export function buildOnlyFansMetadata(account: OnlyMonsterAccount) {
  return {
    provider: "onlymonster",
    onlyMonsterAccountId: account.id,
    platform: account.platform,
    avatarUrl: account.avatar,
    email: account.email,
    organisationId: account.organisation_id,
    subscribePriceMills: account.subscribe_price === null
      ? null
      : millsToNumber(dollarsToMills(account.subscribe_price)),
    subscriptionExpirationDate: account.subscription_expiration_date,
  };
}

export function getOnlyMonsterAccountId(metadata: Record<string, unknown>) {
  const raw = metadata.onlyMonsterAccountId;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  throw new Error("OnlyFans page metadata is missing onlyMonsterAccountId");
}

export async function findOnlyFansAccountByUsername(
  adapter: Pick<OnlyFansAdapter, "listAccountsPage">,
  context: OnlyFansRequestContext,
  username: string,
) {
  let cursor: string | null = null;
  let pageIndex = 0;
  const matches: OnlyMonsterAccount[] = [];

  do {
    const response = await adapter.listAccountsPage(context, {
      cursor,
      limit: 100,
      pageIndex,
    });

    matches.push(
      ...response.parsed.accounts.filter((account) => account.username === username),
    );

    cursor = response.parsed.nextCursor ?? null;
    pageIndex += 1;
  } while (cursor);

  if (matches.length === 0) {
    throw new Error(`OnlyMonster account "${username}" was not found for this token`);
  }

  if (matches.length > 1) {
    throw new Error(
      `OnlyMonster username "${username}" matched multiple accounts; use a unique username`,
    );
  }

  return matches[0]!;
}
