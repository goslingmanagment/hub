import {
  insertRawPayload,
  updatePageMetadata,
} from "@fansly-connect/db";
import { FANSLY_MAPPER_VERSION } from "@fansly-connect/fansly";
import { toMills } from "@fansly-connect/shared";

import type { AppContext } from "../../bootstrap.ts";
import { resolvePageContext } from "../page-context.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

export type ResolvedPageContext = Awaited<ReturnType<typeof resolvePageContext>>;

export function retentionDate(now = new Date()) {
  return new Date(now.getTime() + 180 * DAY_MS);
}

export async function refreshPageMetadata(
  app: AppContext,
  pageContext: ResolvedPageContext,
  syncType: "light" | "followers",
) {
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

export async function insertFailedSyncPayload(
  app: AppContext,
  input: {
    platformAccountId: number;
    syncRunId: number;
    endpoint: string;
    message: string;
  },
) {
  await insertRawPayload(app.db, {
    platformAccountId: input.platformAccountId,
    syncRunId: input.syncRunId,
    endpoint: input.endpoint,
    requestParams: {},
    responsePayload: { message: input.message },
    mapperVersion: FANSLY_MAPPER_VERSION,
    payloadKind: "failed",
    errorMessage: input.message,
    retainUntil: retentionDate(),
  });
}
