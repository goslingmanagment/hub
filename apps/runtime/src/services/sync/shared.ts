import {
  insertRawPayload,
  updatePageMetadata,
} from "@fansly-connect/db";
import { FANSLY_MAPPER_VERSION } from "@fansly-connect/fansly";
import { ONLYMONSTER_MAPPER_VERSION } from "@fansly-connect/onlyfans";
import { toMills } from "@fansly-connect/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  type ResolvedFanslyPageContext,
  type ResolvedOnlyFansPageContext,
  type ResolvedPageContext,
} from "../page-context.ts";
import { buildOnlyFansMetadata, getOnlyMonsterAccountId } from "../onlyfans.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function retentionDate(now = new Date()) {
  return new Date(now.getTime() + 180 * DAY_MS);
}

export function refreshPageMetadata(
  app: AppContext,
  pageContext: ResolvedFanslyPageContext,
  syncType: "light" | "followers",
): ReturnType<AppContext["adapter"]["getAccountMe"]>;
export function refreshPageMetadata(
  app: AppContext,
  pageContext: ResolvedOnlyFansPageContext,
  syncType: "light" | "followers",
): ReturnType<AppContext["onlyFansAdapter"]["getAccount"]>;
export async function refreshPageMetadata(
  app: AppContext,
  pageContext: ResolvedPageContext,
  syncType: "light" | "followers",
) {
  if (pageContext.platform === "fansly") {
    const accountMe = await app.adapter.getAccountMe({
      session: pageContext.session,
      proxy: pageContext.proxy,
    });

    await updatePageMetadata(app.db, pageContext.page.id, {
      platformAccountIdValue: accountMe.parsed.account.id,
      username: accountMe.parsed.account.username,
      displayName: accountMe.parsed.account.displayName,
      followerCount: accountMe.parsed.account.followCount,
      subscriberCount: accountMe.parsed.account.subscriberCount,
      earningsBalanceMills: toMills(accountMe.parsed.account.earningsWallet?.balance ?? 0),
      metadata: {
        walls: accountMe.parsed.account.walls ?? [],
        subscriptionTiers: accountMe.parsed.account.subscriptionTiers ?? [],
      },
      syncType,
    });

    return accountMe;
  }

  const account = await app.onlyFansAdapter.getAccount(
    {
      auth: pageContext.auth,
      proxy: pageContext.proxy,
    },
    getOnlyMonsterAccountId(pageContext.page.metadata),
  );

  await updatePageMetadata(app.db, pageContext.page.id, {
    platformAccountIdValue: account.parsed.account.platformAccountId,
    username: account.parsed.account.username,
    displayName: account.parsed.account.name,
    followerCount: 0,
    subscriberCount: 0,
    earningsBalanceMills: 0n,
    metadata: buildOnlyFansMetadata(account.parsed.account),
    syncType,
  });

  return account;
}

export async function insertFailedSyncPayload(
  app: AppContext,
  input: {
    platformAccountId: number;
    syncRunId: number;
    endpoint: string;
    message: string;
    platform: "fansly" | "onlyfans";
  },
) {
  await insertRawPayload(app.db, {
    platformAccountId: input.platformAccountId,
    syncRunId: input.syncRunId,
    endpoint: input.endpoint,
    requestParams: {},
    responsePayload: { message: input.message },
    mapperVersion: input.platform === "fansly"
      ? FANSLY_MAPPER_VERSION
      : ONLYMONSTER_MAPPER_VERSION,
    payloadKind: "failed",
    errorMessage: input.message,
    retainUntil: retentionDate(),
  });
}
